/**
 * Tests for the post-turn "capture candidate skill" completion hook.
 *
 * Target module: `./completion-hook` (does not yet exist — these tests drive
 * its impl). Surface under test:
 *
 *   captureCandidateSkill(input, settings) -> Promise<CompletionHookResult>
 *
 * Contract (load-bearing — do not relax):
 *   - STOPS AT `candidate`. Must NEVER call promoteIfVerified or flip a row
 *     to `shadow`/`active`.
 *   - Idempotent: re-capturing the same name at status=candidate overwrites
 *     disk + keeps status=candidate. Re-capturing when the row is at
 *     `shadow`/`active`/`disabled` is a no-op — we never demote or clobber
 *     a human-blessed skill.
 *   - Never throws. All failures flattened into a CaptureStatus tag.
 *   - Opt-in via settings.captureCandidateSkills (default false).
 *
 * Each test owns its own tempdir (mkdtemp + chdir) and dynamically imports
 * the hook module after the shared-db cache is reset. We capture the real
 * cwd AFTER chdir because on macOS `/var/folders/...` resolves to
 * `/private/var/folders/...` and a naive compare would bite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../../tests/helpers/rm-with-retry";
import { getSkill, upsertSkill, setStatus } from "../state/repos/skills";

const ORIG_CWD = process.cwd();

interface Workspace {
  dir: string;
  skillsRoot: string;
  hook: any;
  shared: typeof import("../state/shared-db");
}

function skillsRootOf(cwd: string): string {
  return join(cwd, ".claude", "hermes", "skills");
}

function skillDirOf(cwd: string, name: string): string {
  return join(skillsRootOf(cwd), name);
}

async function makeWorkspace(prefix: string): Promise<Workspace> {
  const raw = mkdtempSync(join(tmpdir(), `hermes-capture-${prefix}-`));
  mkdirSync(join(raw, ".claude", "hermes"), { recursive: true });
  process.chdir(raw);
  // Capture cwd AFTER chdir so /var → /private/var symlinks on macOS do not
  // break downstream path equality.
  const dir = process.cwd();

  const shared = await import("../state/shared-db");
  await shared.resetSharedDbCache();

  const hook = (await import(`./completion-hook`)) as any;
  return { dir, skillsRoot: skillsRootOf(dir), hook, shared };
}

async function teardown(ws: Workspace): Promise<void> {
  await ws.shared.resetSharedDbCache();
  process.chdir(ORIG_CWD);
  await rmWithRetry(ws.dir);
}

afterAll(() => {
  process.chdir(ORIG_CWD);
});

// Sanity: the hook module must exist so downstream tests have something to
// exercise. This `beforeAll` surfaces a clear failure if the impl agent has
// not yet created src/learning/completion-hook.ts.
beforeAll(async () => {
  const mod = (await import(`./completion-hook`)) as any;
  expect(typeof mod.captureCandidateSkill).toBe("function");
});

// A non-trivial trajectory that proposeSkillFromTrajectory accepts. The
// skill name is deterministic (slugified prompt): "run-the-test-suite-and-report-failures".
const REAL_PROMPT = "Run the test suite and report failures";
const EXPECTED_NAME = "run-the-test-suite-and-report-failures";

function realInput(overrides: Partial<{ prompt: string; reply: string; tools: any[] }> = {}) {
  return {
    prompt: overrides.prompt ?? REAL_PROMPT,
    reply: overrides.reply ?? "All green, 865 pass",
    tools: overrides.tools ?? [{ name: "Bash", ok: true }],
  };
}

describe("captureCandidateSkill — disabled setting", () => {
  test("returns skipped:disabled and creates no disk files or DB rows", async () => {
    const ws = await makeWorkspace("disabled");
    try {
      const result = await ws.hook.captureCandidateSkill(realInput(), {
        captureCandidateSkills: false,
      });

      expect(result.status).toBe("skipped:disabled");
      expect(existsSync(ws.skillsRoot)).toBe(false);

      // DB is lazy-created. If it exists, the skills table must be empty.
      // Either way, no row should surface for the expected name.
      const db = await ws.shared.getSharedDb();
      expect(getSkill(db, EXPECTED_NAME)).toBeNull();
    } finally {
      await teardown(ws);
    }
  });
});

describe("captureCandidateSkill — trivial trajectory", () => {
  test("empty reply + no tools returns skipped:trivial and writes nothing", async () => {
    const ws = await makeWorkspace("trivial");
    try {
      const result = await ws.hook.captureCandidateSkill(
        { prompt: "hi", reply: "", tools: [] },
        { captureCandidateSkills: true }
      );

      expect(result.status).toBe("skipped:trivial");
      expect(existsSync(ws.skillsRoot)).toBe(false);

      const db = await ws.shared.getSharedDb();
      const row = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM skills").get();
      expect(row?.c ?? 0).toBe(0);
    } finally {
      await teardown(ws);
    }
  });
});

describe("captureCandidateSkill — real trajectory", () => {
  test("writes SKILL.md + description.txt and upserts a row at status=candidate", async () => {
    const ws = await makeWorkspace("real");
    try {
      const result = await ws.hook.captureCandidateSkill(realInput(), {
        captureCandidateSkills: true,
      });

      expect(result.status).toBe("captured");
      expect(result.skillName).toBe(EXPECTED_NAME);

      const dir = skillDirOf(ws.dir, EXPECTED_NAME);
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, "description.txt"))).toBe(true);

      const body = readFileSync(join(dir, "SKILL.md"), "utf8");
      expect(body.length).toBeGreaterThan(0);

      const db = await ws.shared.getSharedDb();
      const row = getSkill(db, EXPECTED_NAME);
      expect(row).not.toBeNull();
      expect(row?.status).toBe("candidate");
    } finally {
      await teardown(ws);
    }
  });
});

describe("captureCandidateSkill — idempotency", () => {
  test("re-capture while existing row is candidate → captured, still candidate, disk refreshed", async () => {
    const ws = await makeWorkspace("recapture-candidate");
    try {
      // First capture seeds the row + disk.
      const first = await ws.hook.captureCandidateSkill(realInput(), {
        captureCandidateSkills: true,
      });
      expect(first.status).toBe("captured");

      // Second capture with a different reply. The on-disk SKILL.md body
      // embeds a truncation of the reply so we can observe the refresh.
      const second = await ws.hook.captureCandidateSkill(
        realInput({ reply: "Second-pass reply with a unique MARKER-TOKEN-42 inside" }),
        { captureCandidateSkills: true }
      );
      expect(second.status).toBe("captured");
      expect(second.skillName).toBe(EXPECTED_NAME);

      const db = await ws.shared.getSharedDb();
      const row = getSkill(db, EXPECTED_NAME);
      expect(row).not.toBeNull();
      // Must still be at candidate — the hook never self-promotes.
      expect(row?.status).toBe("candidate");

      const body = readFileSync(join(skillDirOf(ws.dir, EXPECTED_NAME), "SKILL.md"), "utf8");
      expect(body).toContain("MARKER-TOKEN-42");
    } finally {
      await teardown(ws);
    }
  });

  test("existing row at status=shadow → skipped:exists, row still shadow, disk untouched", async () => {
    const ws = await makeWorkspace("existing-shadow");
    try {
      const db = await ws.shared.getSharedDb();
      const skillDir = skillDirOf(ws.dir, EXPECTED_NAME);
      mkdirSync(skillDir, { recursive: true });
      const sentinelBody = "# pre-existing human-blessed body\nSENTINEL-SHADOW\n";
      writeFileSync(join(skillDir, "SKILL.md"), sentinelBody, "utf8");
      writeFileSync(join(skillDir, "description.txt"), "Use this skill as originally blessed.", "utf8");
      upsertSkill(db, {
        name: EXPECTED_NAME,
        path: join(".claude", "hermes", "skills", EXPECTED_NAME),
        status: "shadow",
      });
      setStatus(db, EXPECTED_NAME, "shadow");

      const result = await ws.hook.captureCandidateSkill(realInput(), {
        captureCandidateSkills: true,
      });

      expect(result.status).toBe("skipped:exists");
      expect(result.skillName).toBe(EXPECTED_NAME);

      const row = getSkill(db, EXPECTED_NAME);
      expect(row?.status).toBe("shadow");

      const onDisk = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      expect(onDisk).toBe(sentinelBody);
    } finally {
      await teardown(ws);
    }
  });

  test("existing row at status=active → skipped:exists, row still active", async () => {
    const ws = await makeWorkspace("existing-active");
    try {
      const db = await ws.shared.getSharedDb();
      upsertSkill(db, {
        name: EXPECTED_NAME,
        path: join(".claude", "hermes", "skills", EXPECTED_NAME),
        status: "active",
      });
      setStatus(db, EXPECTED_NAME, "active");
      expect(getSkill(db, EXPECTED_NAME)?.status).toBe("active");

      const result = await ws.hook.captureCandidateSkill(realInput(), {
        captureCandidateSkills: true,
      });

      expect(result.status).toBe("skipped:exists");
      expect(result.skillName).toBe(EXPECTED_NAME);

      const row = getSkill(db, EXPECTED_NAME);
      expect(row?.status).toBe("active");
    } finally {
      await teardown(ws);
    }
  });
});

describe("captureCandidateSkill — error swallowing", () => {
  test("writeSkill failure is swallowed → skipped:error, never throws", async () => {
    const ws = await makeWorkspace("write-fail");
    try {
      // Force writeSkill to fail by pre-creating `SKILL.md` as a DIRECTORY
      // at the target path. `fs.writeFile` on a directory raises EISDIR on
      // every platform (including Windows), so the hook's disk write must
      // throw internally — and the hook must catch + tag skipped:error.
      const skillDir = skillDirOf(ws.dir, EXPECTED_NAME);
      mkdirSync(join(skillDir, "SKILL.md"), { recursive: true });

      let threw = false;
      let result: any;
      try {
        result = await ws.hook.captureCandidateSkill(realInput(), {
          captureCandidateSkills: true,
        });
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).toBeDefined();
      expect(result.status).toBe("skipped:error");
      // `reason` should carry whatever the underlying error surfaced. It
      // must be a string so downstream logging does not fall over.
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);

      // Must not silently mutate the DB on a failed write.
      const db = await ws.shared.getSharedDb();
      const row = getSkill(db, EXPECTED_NAME);
      // Row is either absent or at candidate — never shadow/active.
      if (row !== null) {
        expect(row.status).toBe("candidate");
      }
    } finally {
      await teardown(ws);
    }
  });
});

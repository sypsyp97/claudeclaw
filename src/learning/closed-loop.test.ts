/**
 * Tests for the Voyager-style closed learning loop.
 *
 * Target module: `./closed-loop` (does not yet exist — these tests drive its
 * impl). The loop has two halves:
 *
 *   proposeSkillFromTrajectory(trajectory) -> SkillCandidate | null
 *     Reads an ordered (prompt, reply, tools) trajectory and produces a
 *     candidate skill manifest. Trivial trajectories return null.
 *
 *   promoteIfVerified(db, candidate, opts) -> Promise<PromoteResult>
 *     Validates the candidate, runs the verify gate, and writes the row to
 *     the skills repo. On success the row lands at status="shadow"; on
 *     verify failure it stays at "candidate" so a future iteration can try
 *     again. Already-active skills are never demoted by this path.
 *
 * The impl agent fills in `src/learning/closed-loop.ts` later. Since the
 * module does not exist yet, we dynamic-import it inside `beforeAll` and
 * type the namespace as `any` (mirrors `src/memory/blocks.test.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations, closeDb, type Database, openDb } from "../state";
import { getSkill, setStatus, upsertSkill } from "../state/repos/skills";

let loop: any;

let db: Database;
let tempRoot: string;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-closed-loop-"));
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
  loop = await import("./closed-loop");
});

afterAll(async () => {
  closeDb(db);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts with an empty skills/version/run table so we don't
  // leak rows across cases — promotion paths are very state-sensitive.
  db.exec("DELETE FROM skill_runs");
  db.exec("DELETE FROM skill_versions");
  db.exec("DELETE FROM skills");
});

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const IMPERATIVE_VERBS = [
  "Use",
  "Create",
  "Build",
  "Run",
  "Handle",
  "Apply",
  "Scan",
  "Generate",
  "Review",
  "Refactor",
  "Fix",
  "Add",
  "Remove",
  "Convert",
  "Parse",
  "Validate",
  "Search",
  "List",
  "Show",
  "Start",
  "Stop",
  "Debug",
  "Test",
  "Deploy",
  "Monitor",
  "Schedule",
];

function startsWithImperative(description: string): boolean {
  const first = description.trim().split(/\s+/)[0] ?? "";
  return IMPERATIVE_VERBS.includes(first);
}

describe("proposeSkillFromTrajectory", () => {
  test("happy path generates a candidate with kebab-case name + imperative description", async () => {
    const { validateSkillManifest } = await import("../skills/validate");

    const trajectory = {
      prompt: "Run the test suite and report failures",
      reply: "All green, 865 pass",
      tools: [{ name: "Bash", ok: true }],
    };

    const candidate = loop.proposeSkillFromTrajectory(trajectory);
    expect(candidate).not.toBeNull();
    expect(candidate.name).toMatch(KEBAB_RE);
    expect(candidate.description.length).toBeLessThanOrEqual(1024);
    expect(startsWithImperative(candidate.description)).toBe(true);
    expect(candidate.body.split("\n").length).toBeLessThanOrEqual(500);

    const validation = validateSkillManifest({
      name: candidate.name,
      description: candidate.description,
      body: candidate.body,
    });
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("trivial / empty trajectory returns null", () => {
    const trajectory = {
      prompt: "hi",
      reply: "ok",
      tools: [],
    };
    const candidate = loop.proposeSkillFromTrajectory(trajectory);
    expect(candidate).toBeNull();
  });

  test("large trajectory does not overflow description cap", () => {
    const hugePrompt = "Refactor the storage layer ".repeat(250); // ~6750 chars
    expect(hugePrompt.length).toBeGreaterThan(5000);

    const trajectory = {
      prompt: hugePrompt,
      reply: "Refactored 12 files, all tests still pass",
      tools: [
        { name: "Read", ok: true },
        { name: "Edit", ok: true },
        { name: "Bash", ok: true },
      ],
    };

    const candidate = loop.proposeSkillFromTrajectory(trajectory);
    expect(candidate).not.toBeNull();
    expect(candidate.description.length).toBeLessThanOrEqual(1024);
  });
});

describe("promoteIfVerified", () => {
  test("invalid candidate short-circuits with finalStatus=absent and reason=invalid-candidate", async () => {
    const verifyMock = () => {
      throw new Error("runVerify must NOT be called for an invalid candidate");
    };

    const candidate = {
      name: "Bad_Name", // fails kebab-case + ASCII validators
      description: "Use this skill to do a thing",
      body: "# body\n",
    };

    const result = await loop.promoteIfVerified(db, candidate, {
      runVerify: verifyMock,
      skillsRoot: join(tempRoot, "skills"),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid-candidate");
    expect(result.finalStatus).toBe("absent");
    expect(getSkill(db, "Bad_Name")).toBeNull();
  });

  test("valid candidate + verify success → status=shadow, reason promoted", async () => {
    const candidate = {
      name: "run-verify-suite",
      description: "Run the verify suite and report failures",
      body: "# Run verify\n\nRun `bun run verify` and surface the diff.\n",
    };

    const result = await loop.promoteIfVerified(db, candidate, {
      runVerify: async () => true,
      skillsRoot: join(tempRoot, "skills"),
    });

    expect(result.ok).toBe(true);
    expect(result.finalStatus).toBe("shadow");
    // Spec: `reason` is either omitted or "promoted".
    if (result.reason !== undefined) {
      expect(result.reason).toBe("promoted");
    }

    const row = getSkill(db, "run-verify-suite");
    expect(row).not.toBeNull();
    expect(row?.status).toBe("shadow");
  });

  test("valid candidate + verify failure → status stays at candidate, reason verify-failed", async () => {
    const candidate = {
      name: "build-docs-index",
      description: "Build the documentation index from the source tree",
      body: "# Build docs\n\nWalk `docs/` and emit an index.\n",
    };

    const result = await loop.promoteIfVerified(db, candidate, {
      runVerify: async () => false,
      skillsRoot: join(tempRoot, "skills"),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verify-failed");
    expect(result.finalStatus).toBe("candidate");

    const row = getSkill(db, "build-docs-index");
    expect(row).not.toBeNull();
    expect(row?.status).toBe("candidate");
  });

  test("verify is called exactly once for a valid candidate", async () => {
    let calls = 0;
    const candidate = {
      name: "scan-logs-for-errors",
      description: "Scan the daemon logs and surface error lines",
      body: "# Scan logs\n",
    };

    await loop.promoteIfVerified(db, candidate, {
      runVerify: async () => {
        calls += 1;
        return true;
      },
      skillsRoot: join(tempRoot, "skills"),
    });

    expect(calls).toBe(1);
  });

  test("candidate already at active is not demoted", async () => {
    const name = "deploy-staging";
    upsertSkill(db, {
      name,
      path: join(tempRoot, "skills", name, "SKILL.md"),
      status: "active",
    });
    setStatus(db, name, "active");
    expect(getSkill(db, name)?.status).toBe("active");

    let verifyCalls = 0;
    const candidate = {
      name,
      description: "Deploy the staging environment with the latest build",
      body: "# Deploy staging\n",
    };

    const result = await loop.promoteIfVerified(db, candidate, {
      runVerify: async () => {
        verifyCalls += 1;
        return true;
      },
      skillsRoot: join(tempRoot, "skills"),
    });

    // The active skill must NOT be flipped back to shadow by the loop.
    expect(result.finalStatus).toBe("active");
    expect(getSkill(db, name)?.status).toBe("active");
    // Some indication that we noticed it was already promoted.
    expect(typeof result.reason).toBe("string");
    expect(result.reason).toMatch(/already|promoted|active/i);
    // Re-verifying an already-active skill is wasted work.
    expect(verifyCalls).toBeLessThanOrEqual(1);
  });

  test("persistence failure is non-fatal to the caller", async () => {
    // Open + immediately close a DB so any subsequent query throws inside
    // the loop. The loop must catch and return a PromoteResult instead of
    // letting the exception escape.
    const brokenDb = openDb({ path: ":memory:" });
    await applyMigrations(brokenDb);
    closeDb(brokenDb);

    const candidate = {
      name: "monitor-disk-usage",
      description: "Monitor disk usage and warn before the volume fills",
      body: "# Monitor disk\n",
    };

    let result: any;
    let threw = false;
    try {
      result = await loop.promoteIfVerified(brokenDb, candidate, {
        runVerify: async () => true,
        skillsRoot: join(tempRoot, "skills"),
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result.ok).toBe(false);
    // Either "absent" (never written) or "candidate" (write attempted but
    // rolled back) — both are acceptable per spec.
    expect(["absent", "candidate"]).toContain(result.finalStatus);
  });
});

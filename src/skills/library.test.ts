/**
 * Specifies the Voyager-style skill library API: read/write skill dirs on
 * disk, append a JSONL trajectory log, and surface skills via FTS5 search
 * over `description.txt`.
 *
 * The impl agent will create `src/skills/library.ts` and a new migration
 * `003_skill_descriptions_fts.sql`. Each test owns its own tempdir and
 * dynamically imports the library module so it captures the per-test cwd.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../../tests/helpers/rm-with-retry";

const ORIG_CWD = process.cwd();

interface Workspace {
  dir: string;
  skillsRoot: string;
  library: any;
  shared: typeof import("../state/shared-db");
}

function skillsRootOf(cwd: string): string {
  return join(cwd, ".claude", "hermes", "skills");
}

function skillDirOf(cwd: string, name: string): string {
  return join(skillsRootOf(cwd), name);
}

async function makeWorkspace(prefix: string): Promise<Workspace> {
  const dir = mkdtempSync(join(tmpdir(), `hermes-library-${prefix}-`));
  mkdirSync(join(dir, ".claude", "hermes"), { recursive: true });
  process.chdir(dir);

  const shared = await import("../state/shared-db");
  // Force a fresh DB handle for this tempdir so a previous test's cached
  // handle (pointing at a now-deleted tmp) cannot resurface.
  await shared.resetSharedDbCache();

  const library = (await import("./library")) as any;
  return { dir, skillsRoot: skillsRootOf(dir), library, shared };
}

async function teardown(ws: Workspace): Promise<void> {
  await ws.shared.resetSharedDbCache();
  process.chdir(ORIG_CWD);
  await rmWithRetry(ws.dir);
}

afterAll(() => {
  process.chdir(ORIG_CWD);
});

// Sanity: the library module must exist so dynamic import does not silently
// no-op. This `beforeAll` runs once and surfaces a clear failure if the impl
// agent has not yet created src/skills/library.ts.
let LIB: any;
beforeAll(async () => {
  LIB = (await import("./library")) as any;
  expect(typeof LIB.writeSkill).toBe("function");
  expect(typeof LIB.readSkill).toBe("function");
  expect(typeof LIB.appendTrajectory).toBe("function");
  expect(typeof LIB.searchSkills).toBe("function");
});

describe("migration 003 — skill_descriptions_fts virtual table", () => {
  test("getSharedDb registers the FTS5 virtual table in sqlite_master", async () => {
    const ws = await makeWorkspace("mig");
    try {
      const db = await ws.shared.getSharedDb();
      const row = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_descriptions_fts'"
        )
        .get();
      expect(row).not.toBeNull();
      expect(row!.name).toBe("skill_descriptions_fts");
    } finally {
      await teardown(ws);
    }
  });
});

describe("writeSkill", () => {
  test("happy path writes SKILL.md, description.txt, and an empty trajectory.jsonl", async () => {
    const ws = await makeWorkspace("write-happy");
    try {
      await ws.library.writeSkill({
        name: "foo-bar",
        description: "Use this skill when the user wants foo.",
        skillMd: "# Foo\n\nbody",
      });

      const dir = skillDirOf(ws.dir, "foo-bar");
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, "description.txt"))).toBe(true);
      expect(existsSync(join(dir, "trajectory.jsonl"))).toBe(true);

      expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("# Foo\n\nbody");
      expect(readFileSync(join(dir, "description.txt"), "utf8")).toBe(
        "Use this skill when the user wants foo."
      );
      // Pinned policy: trajectory.jsonl is created empty on first writeSkill
      // so the reader never has to special-case missing-file.
      expect(readFileSync(join(dir, "trajectory.jsonl"), "utf8")).toBe("");
    } finally {
      await teardown(ws);
    }
  });

  test("invalid kebab-case name throws and writes no files", async () => {
    const ws = await makeWorkspace("write-bad-name");
    try {
      let caught: unknown = null;
      try {
        await ws.library.writeSkill({
          name: "Bad_Name",
          description: "Use this skill when the user wants bad name.",
          skillMd: "# Bad\n",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      const msg = String((caught as Error).message ?? caught).toLowerCase();
      // Either the validator's substring ("kebab-case", "ascii-only") or our
      // generic "validat" wrapper must appear so the impl agent has a clear
      // failure mode to write to.
      expect(/validat|kebab|ascii|name/.test(msg)).toBe(true);

      expect(existsSync(skillDirOf(ws.dir, "Bad_Name"))).toBe(false);
    } finally {
      await teardown(ws);
    }
  });

  test("non-imperative description throws and writes no files", async () => {
    const ws = await makeWorkspace("write-bad-desc");
    try {
      let caught: unknown = null;
      try {
        await ws.library.writeSkill({
          name: "ok-name",
          description: "not imperative at all",
          skillMd: "# Body\n",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      const msg = String((caught as Error).message ?? caught).toLowerCase();
      expect(/validat|imperative|description/.test(msg)).toBe(true);

      expect(existsSync(skillDirOf(ws.dir, "ok-name"))).toBe(false);
    } finally {
      await teardown(ws);
    }
  });

  test("FTS index is populated after writeSkill — search by description token finds the skill", async () => {
    const ws = await makeWorkspace("write-fts");
    try {
      await ws.library.writeSkill({
        name: "foo-bar",
        description: "Use this skill when the user wants foo.",
        skillMd: "# Foo\n\nbody",
      });

      const db = await ws.shared.getSharedDb();
      const hits = ws.library.searchSkills(db, "foo");
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.some((h: { name: string }) => h.name === "foo-bar")).toBe(true);
    } finally {
      await teardown(ws);
    }
  });
});

describe("readSkill", () => {
  test("returns the three parts after a successful writeSkill", async () => {
    const ws = await makeWorkspace("read-happy");
    try {
      await ws.library.writeSkill({
        name: "foo-bar",
        description: "Use this skill when the user wants foo.",
        skillMd: "# Foo\n\nbody",
      });

      const out = await ws.library.readSkill("foo-bar");
      expect(out).not.toBeNull();
      expect(out.skillMd).toBe("# Foo\n\nbody");
      expect(out.description).toBe("Use this skill when the user wants foo.");
      expect(out.trajectory).toEqual([]);
    } finally {
      await teardown(ws);
    }
  });

  test("returns null for a skill that was never written", async () => {
    const ws = await makeWorkspace("read-missing");
    try {
      const out = await ws.library.readSkill("never-written");
      expect(out).toBeNull();
    } finally {
      await teardown(ws);
    }
  });

  test("falls back to YAML frontmatter description when description.txt is missing", async () => {
    const ws = await makeWorkspace("read-frontmatter");
    try {
      const dir = skillDirOf(ws.dir, "legacy-skill");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: legacy-skill\ndescription: Use this when legacy path triggered\n---\n\nbody",
        "utf8"
      );
      // Deliberately no description.txt and no trajectory.jsonl on disk.

      const out = await ws.library.readSkill("legacy-skill");
      expect(out).not.toBeNull();
      expect(out.description).toBe("Use this when legacy path triggered");
      expect(out.trajectory).toEqual([]);
    } finally {
      await teardown(ws);
    }
  });
});

describe("appendTrajectory", () => {
  test("appends one JSONL line with a default ISO-8601 ts", async () => {
    const ws = await makeWorkspace("traj-default");
    try {
      await ws.library.writeSkill({
        name: "foo-bar",
        description: "Use this skill when the user wants foo.",
        skillMd: "# Foo\n",
      });
      await ws.library.appendTrajectory("foo-bar", { tool: "Bash", ok: true });

      const raw = readFileSync(join(skillDirOf(ws.dir, "foo-bar"), "trajectory.jsonl"), "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(1);

      const entry = JSON.parse(lines[0]!);
      expect(entry.tool).toBe("Bash");
      expect(entry.ok).toBe(true);
      expect(typeof entry.ts).toBe("string");
      // Loose ISO-8601 check: starts with YYYY-MM-DDT and parses to a valid date.
      expect(/^\d{4}-\d{2}-\d{2}T/.test(entry.ts)).toBe(true);
      expect(Number.isFinite(new Date(entry.ts).getTime())).toBe(true);
    } finally {
      await teardown(ws);
    }
  });

  test("preserves a caller-supplied ts and optional note", async () => {
    const ws = await makeWorkspace("traj-supplied");
    try {
      await ws.library.writeSkill({
        name: "foo-bar",
        description: "Use this skill when the user wants foo.",
        skillMd: "# Foo\n",
      });
      const ts = "2026-04-15T00:00:00.000Z";
      await ws.library.appendTrajectory("foo-bar", {
        ts,
        tool: "Grep",
        ok: false,
        note: "nothing found",
      });

      const raw = readFileSync(join(skillDirOf(ws.dir, "foo-bar"), "trajectory.jsonl"), "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(1);

      const entry = JSON.parse(lines[0]!);
      expect(entry.ts).toBe(ts);
      expect(entry.tool).toBe("Grep");
      expect(entry.ok).toBe(false);
      expect(entry.note).toBe("nothing found");
    } finally {
      await teardown(ws);
    }
  });

  test("throws when the skill dir does not exist", async () => {
    const ws = await makeWorkspace("traj-missing");
    try {
      let caught: unknown = null;
      try {
        await ws.library.appendTrajectory("never-written-skill", {
          tool: "Bash",
          ok: true,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      const msg = String((caught as Error).message ?? caught);
      expect(msg).toContain("never-written-skill");
    } finally {
      await teardown(ws);
    }
  });
});

describe("searchSkills", () => {
  test("matches description tokens and returns 0 for nonsense", async () => {
    const ws = await makeWorkspace("search-tokens");
    try {
      await ws.library.writeSkill({
        name: "alpha-skill",
        description: "Use the alpha-QQQ token here for matching.",
        skillMd: "# Alpha\n",
      });
      await ws.library.writeSkill({
        name: "beta-skill",
        description: "Use the beta-WWW token here for matching.",
        skillMd: "# Beta\n",
      });
      await ws.library.writeSkill({
        name: "gamma-skill",
        description: "Use the gamma-ZZZ token here for matching.",
        skillMd: "# Gamma\n",
      });

      const db = await ws.shared.getSharedDb();
      // Quote hyphenated tokens — FTS5 otherwise parses '-' as the NEAR/NOT
      // operator and the query blows up before reaching the index.
      const alphaHits = ws.library.searchSkills(db, '"alpha-QQQ"');
      expect(alphaHits.length).toBe(1);
      expect(alphaHits[0].name).toBe("alpha-skill");

      const missHits = ws.library.searchSkills(db, '"nonsense-token-NNN"');
      expect(missHits.length).toBe(0);
    } finally {
      await teardown(ws);
    }
  });

  test("limit is respected", async () => {
    const ws = await makeWorkspace("search-limit");
    try {
      for (let i = 1; i <= 5; i++) {
        await ws.library.writeSkill({
          name: `shared-skill-${i}`,
          description: `Use this shared marker for entry number ${i}.`,
          skillMd: `# S${i}\n`,
        });
      }
      const db = await ws.shared.getSharedDb();
      const hits = ws.library.searchSkills(db, "shared", { limit: 2 });
      expect(hits.length).toBe(2);
    } finally {
      await teardown(ws);
    }
  });

  test("result rows include name, description, and a numeric rank", async () => {
    const ws = await makeWorkspace("search-shape");
    try {
      await ws.library.writeSkill({
        name: "shape-skill",
        description: "Use this shape marker to inspect result shape.",
        skillMd: "# Shape\n",
      });
      const db = await ws.shared.getSharedDb();
      const hits = ws.library.searchSkills(db, "shape");
      expect(hits.length).toBeGreaterThanOrEqual(1);
      const row = hits[0];
      expect(typeof row.name).toBe("string");
      expect(typeof row.description).toBe("string");
      expect(typeof row.rank).toBe("number");
      expect(row.name).toBe("shape-skill");
      expect(row.description).toBe("Use this shape marker to inspect result shape.");
    } finally {
      await teardown(ws);
    }
  });

  test("results are sorted by ascending rank (best match first)", async () => {
    const ws = await makeWorkspace("search-rank");
    try {
      // Two skills: one mentions the token once, the other mentions it many
      // times. FTS5 ranks the heavier match better (lower rank value).
      await ws.library.writeSkill({
        name: "weak-skill",
        description: "Use the keyword once please.",
        skillMd: "# Weak\n",
      });
      await ws.library.writeSkill({
        name: "strong-skill",
        description: "Use the keyword keyword keyword keyword keyword more.",
        skillMd: "# Strong\n",
      });

      const db = await ws.shared.getSharedDb();
      const hits = ws.library.searchSkills(db, "keyword");
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits[0].rank).toBeLessThanOrEqual(hits[1].rank);
    } finally {
      await teardown(ws);
    }
  });
});

describe("writeSkill — overwrite refreshes both disk and FTS index", () => {
  test("re-writing a skill updates content and evicts the old description from FTS", async () => {
    const ws = await makeWorkspace("overwrite");
    try {
      await ws.library.writeSkill({
        name: "refresh-me",
        description: "Use the first version of this description.",
        skillMd: "# v1\n",
      });
      await ws.library.writeSkill({
        name: "refresh-me",
        description: "Use the second version of this description.",
        skillMd: "# v2\n",
      });

      const db = await ws.shared.getSharedDb();
      const secondHits = ws.library.searchSkills(db, "second");
      expect(secondHits.length).toBeGreaterThanOrEqual(1);
      expect(secondHits.some((h: { name: string }) => h.name === "refresh-me")).toBe(true);

      const firstHits = ws.library.searchSkills(db, "first");
      expect(firstHits.length).toBe(0);

      const out = await ws.library.readSkill("refresh-me");
      expect(out).not.toBeNull();
      expect(out.description).toBe("Use the second version of this description.");
      expect(out.skillMd).toBe("# v2\n");
    } finally {
      await teardown(ws);
    }
  });
});

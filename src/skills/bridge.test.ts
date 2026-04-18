/**
 * Specifies the Voyager→Claude-Code skill bridge. The bridge mirrors only
 * `active` Voyager skills into `<cwd>/.claude/skills/hermes_<name>/` so the
 * spawned Claude CLI's built-in skill discovery picks them up. Candidate /
 * shadow / disabled skills stay hidden — human review is the gate.
 *
 * The impl agent creates `src/skills/bridge.ts`. Each test owns its own
 * tempdir, chdirs into it, captures `process.cwd()` _after_ chdir (so the
 * macOS `/var`→`/private/var` symlink does not trip byte-exact comparisons),
 * and dynamically imports the bridge module so it sees the per-test cwd.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { rmWithRetry } from "../../tests/helpers/rm-with-retry";

const ORIG_CWD = process.cwd();

interface Workspace {
  dir: string;
  voyagerRoot: string; // <cwd>/.claude/hermes/skills
  mirrorRoot: string; // <cwd>/.claude/skills
  bridge: any;
  library: any;
  repo: typeof import("../state/repos/skills");
  shared: typeof import("../state/shared-db");
}

function voyagerRootOf(cwd: string): string {
  return join(cwd, ".claude", "hermes", "skills");
}

function voyagerDirOf(cwd: string, name: string): string {
  return join(voyagerRootOf(cwd), name);
}

function mirrorRootOf(cwd: string): string {
  return join(cwd, ".claude", "skills");
}

function mirrorDirOf(cwd: string, name: string): string {
  return join(mirrorRootOf(cwd), `hermes_${name}`);
}

async function makeWorkspace(prefix: string): Promise<Workspace> {
  const raw = mkdtempSync(join(tmpdir(), `hermes-bridge-${prefix}-`));
  mkdirSync(join(raw, ".claude", "hermes"), { recursive: true });
  process.chdir(raw);
  // Capture the real cwd AFTER chdir so macOS `/var`→`/private/var` symlinks
  // do not break byte-exact path comparisons.
  const dir = process.cwd();

  const shared = await import("../state/shared-db");
  await shared.resetSharedDbCache();

  const library = (await import("./library")) as any;
  const repo = await import("../state/repos/skills");
  const bridge = (await import(`./bridge`)) as any;

  return {
    dir,
    voyagerRoot: voyagerRootOf(dir),
    mirrorRoot: mirrorRootOf(dir),
    bridge,
    library,
    repo,
    shared,
  };
}

async function teardown(ws: Workspace): Promise<void> {
  await ws.shared.resetSharedDbCache();
  process.chdir(ORIG_CWD);
  await rmWithRetry(ws.dir);
}

afterAll(() => {
  process.chdir(ORIG_CWD);
});

beforeEach(() => {
  // Guard against a previous test leaving us outside ORIG_CWD after a thrown
  // assertion. Each test still chdirs into its own tempdir via makeWorkspace.
  try {
    process.chdir(ORIG_CWD);
  } catch {
    // ignore — ORIG_CWD is always valid at process start
  }
});

/**
 * Seed helper: write Voyager-side files for a skill AND the DB row. Tests
 * that want to simulate missing source files call `seedDbRowOnly` instead.
 */
async function seedActiveSkill(
  ws: Workspace,
  name: string,
  opts: { skillMd?: string; description?: string; withTrajectory?: boolean } = {}
): Promise<void> {
  const skillMd = opts.skillMd ?? `# ${name}\n\nbody for ${name}`;
  const description = opts.description ?? `Use the ${name} skill when matching.`;
  await ws.library.writeSkill({ name, description, skillMd });
  if (opts.withTrajectory) {
    await ws.library.appendTrajectory(name, { tool: "Bash", ok: true });
  }
  const db = await ws.shared.getSharedDb();
  ws.repo.upsertSkill(db, { name, path: voyagerDirOf(ws.dir, name), status: "candidate" });
  ws.repo.setStatus(db, name, "active");
}

async function seedSkillWithStatus(
  ws: Workspace,
  name: string,
  status: "candidate" | "shadow" | "active" | "disabled"
): Promise<void> {
  await ws.library.writeSkill({
    name,
    description: `Use the ${name} skill when matching.`,
    skillMd: `# ${name}\n\nbody`,
  });
  const db = await ws.shared.getSharedDb();
  ws.repo.upsertSkill(db, { name, path: voyagerDirOf(ws.dir, name), status: "candidate" });
  if (status !== "candidate") {
    ws.repo.setStatus(db, name, status);
  }
}

/** Seed a DB row only — leave the Voyager source files missing. */
function seedDbRowOnly(ws: Workspace, name: string): Promise<void> {
  return ws.shared.getSharedDb().then((db: any) => {
    ws.repo.upsertSkill(db, { name, path: voyagerDirOf(ws.dir, name), status: "candidate" });
    ws.repo.setStatus(db, name, "active");
  });
}

function listHermesMirrorDirs(ws: Workspace): string[] {
  if (!existsSync(ws.mirrorRoot)) return [];
  return readdirSync(ws.mirrorRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("hermes_"))
    .map((e) => e.name)
    .sort();
}

/** Walk a dir and return a sorted list of (relative-path, bytes-hash). */
function snapshotDir(root: string): Array<{ rel: string; bytes: string }> {
  if (!existsSync(root)) return [];
  const out: Array<{ rel: string; bytes: string }> = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const entries = readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        out.push({ rel, bytes: readFileSync(full).toString("base64") });
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

describe("syncActiveSkills — the happy-gated surface", () => {
  test("empty DB → no mirrored dirs, result is all-empty", async () => {
    const ws = await makeWorkspace("empty");
    try {
      const result = await ws.bridge.syncActiveSkills(await ws.shared.getSharedDb(), ws.dir);

      expect(result.mirrored).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.errors).toEqual([]);

      // The mirror root may or may not exist, but no hermes_* dirs may be present.
      expect(listHermesMirrorDirs(ws)).toEqual([]);
    } finally {
      await teardown(ws);
    }
  });

  test("single active skill → mirrored byte-for-byte (SKILL.md + description.txt)", async () => {
    const ws = await makeWorkspace("one-active");
    try {
      const name = "alpha-skill";
      const skillMd = "# Alpha\n\nthe body\n";
      const description = "Use the alpha-skill when you need alpha things.";
      await seedActiveSkill(ws, name, { skillMd, description });

      const result = await ws.bridge.syncActiveSkills(await ws.shared.getSharedDb(), ws.dir);

      expect(result.mirrored).toEqual([name]);
      expect(result.removed).toEqual([]);
      expect(result.errors).toEqual([]);

      const mirrorDir = mirrorDirOf(ws.dir, name);
      expect(existsSync(mirrorDir)).toBe(true);
      expect(statSync(mirrorDir).isDirectory()).toBe(true);

      const mirroredSkill = readFileSync(join(mirrorDir, "SKILL.md"));
      const sourceSkill = readFileSync(join(voyagerDirOf(ws.dir, name), "SKILL.md"));
      expect(mirroredSkill.equals(sourceSkill)).toBe(true);
      // Byte-exact against the literal we wrote.
      expect(mirroredSkill.toString("utf8")).toBe(skillMd);

      const mirroredDesc = readFileSync(join(mirrorDir, "description.txt"));
      const sourceDesc = readFileSync(join(voyagerDirOf(ws.dir, name), "description.txt"));
      expect(mirroredDesc.equals(sourceDesc)).toBe(true);
      expect(mirroredDesc.toString("utf8")).toBe(description);
    } finally {
      await teardown(ws);
    }
  });

  test("candidate + shadow skills are NOT mirrored", async () => {
    const ws = await makeWorkspace("non-active");
    try {
      await seedSkillWithStatus(ws, "cand-skill", "candidate");
      await seedSkillWithStatus(ws, "shad-skill", "shadow");

      const result = await ws.bridge.syncActiveSkills(await ws.shared.getSharedDb(), ws.dir);

      expect(result.mirrored).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(listHermesMirrorDirs(ws)).toEqual([]);
    } finally {
      await teardown(ws);
    }
  });

  test("disabled skills are NOT mirrored", async () => {
    const ws = await makeWorkspace("disabled");
    try {
      await seedSkillWithStatus(ws, "off-skill", "disabled");

      const result = await ws.bridge.syncActiveSkills(await ws.shared.getSharedDb(), ws.dir);

      expect(result.mirrored).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(listHermesMirrorDirs(ws)).toEqual([]);
    } finally {
      await teardown(ws);
    }
  });
});

describe("syncActiveSkills — demotion cleanup", () => {
  test("demoting active→shadow removes the mirror on the next sync", async () => {
    const ws = await makeWorkspace("demote");
    try {
      const name = "demoted-skill";
      await seedActiveSkill(ws, name);

      const db = await ws.shared.getSharedDb();
      const first = await ws.bridge.syncActiveSkills(db, ws.dir);
      expect(first.mirrored).toEqual([name]);
      expect(existsSync(mirrorDirOf(ws.dir, name))).toBe(true);

      // Flip status → shadow. No file on disk changes; just the DB row.
      ws.repo.setStatus(db, name, "shadow");

      const second = await ws.bridge.syncActiveSkills(db, ws.dir);
      expect(second.mirrored).toEqual([]);
      expect(second.removed).toEqual([name]);
      expect(second.errors).toEqual([]);
      expect(existsSync(mirrorDirOf(ws.dir, name))).toBe(false);
    } finally {
      await teardown(ws);
    }
  });
});

describe("syncActiveSkills — trajectory is internal", () => {
  test("trajectory.jsonl is NEVER copied to the mirror dir", async () => {
    const ws = await makeWorkspace("no-traj");
    try {
      const name = "traj-skill";
      await seedActiveSkill(ws, name, { withTrajectory: true });

      // Sanity: the Voyager side does have a non-empty trajectory.jsonl.
      const trajPath = join(voyagerDirOf(ws.dir, name), "trajectory.jsonl");
      expect(existsSync(trajPath)).toBe(true);
      expect(readFileSync(trajPath, "utf8").length).toBeGreaterThan(0);

      const result = await ws.bridge.syncActiveSkills(await ws.shared.getSharedDb(), ws.dir);
      expect(result.mirrored).toEqual([name]);

      const mirrorDir = mirrorDirOf(ws.dir, name);
      expect(existsSync(mirrorDir)).toBe(true);
      // Primary assertion: no trajectory.jsonl under the mirror.
      expect(existsSync(join(mirrorDir, "trajectory.jsonl"))).toBe(false);
      // And more broadly: no file under the mirror named trajectory.jsonl.
      const mirroredFiles = snapshotDir(mirrorDir).map((f) => f.rel);
      expect(mirroredFiles.some((p) => p.endsWith("trajectory.jsonl"))).toBe(false);
    } finally {
      await teardown(ws);
    }
  });
});

describe("syncActiveSkills — stale cleanup", () => {
  test("stale hermes_* dir with no matching active row is cleaned up", async () => {
    const ws = await makeWorkspace("stale-orphan");
    try {
      // Pre-create a `hermes_orphan/` mirror as if a previous run wrote it.
      const orphanDir = mirrorDirOf(ws.dir, "orphan");
      mkdirSync(orphanDir, { recursive: true });
      writeFileSync(join(orphanDir, "SKILL.md"), "# Orphan body\n", "utf8");
      writeFileSync(join(orphanDir, "description.txt"), "Use orphan.", "utf8");

      // DB is empty — no active skills at all.
      const result = await ws.bridge.syncActiveSkills(await ws.shared.getSharedDb(), ws.dir);

      expect(result.mirrored).toEqual([]);
      expect(result.removed).toEqual(["orphan"]);
      expect(result.errors).toEqual([]);
      expect(existsSync(orphanDir)).toBe(false);
    } finally {
      await teardown(ws);
    }
  });

  test("sync does NOT touch .claude/skills/<non-hermes-prefix>/ dirs", async () => {
    const ws = await makeWorkspace("leave-user-alone");
    try {
      // User-owned skill: lives under .claude/skills/user-owned/ (no hermes_
      // prefix). The bridge must leave it alone forever.
      const userDir = join(ws.mirrorRoot, "user-owned");
      mkdirSync(userDir, { recursive: true });
      const userSkillMd = "# User owned\n\nhand-written by the human.\n";
      writeFileSync(join(userDir, "SKILL.md"), userSkillMd, "utf8");
      writeFileSync(join(userDir, "description.txt"), "Use user-owned things.", "utf8");

      // Now seed an active Voyager skill whose name collides: "user-owned".
      // The bridge mirrors it to `hermes_user-owned`, NOT to `user-owned`.
      await seedActiveSkill(ws, "user-owned", {
        skillMd: "# Hermes-authored user-owned\n",
        description: "Use the hermes copy.",
      });

      const result = await ws.bridge.syncActiveSkills(await ws.shared.getSharedDb(), ws.dir);
      expect(result.mirrored).toEqual(["user-owned"]);
      expect(result.removed).toEqual([]);
      expect(result.errors).toEqual([]);

      // User's dir is intact, byte-for-byte.
      expect(existsSync(userDir)).toBe(true);
      expect(readFileSync(join(userDir, "SKILL.md"), "utf8")).toBe(userSkillMd);
      expect(readFileSync(join(userDir, "description.txt"), "utf8")).toBe("Use user-owned things.");

      // The hermes mirror exists alongside it at a different path.
      const hermesMirror = mirrorDirOf(ws.dir, "user-owned");
      expect(existsSync(hermesMirror)).toBe(true);
      expect(hermesMirror).not.toBe(userDir);
      expect(readFileSync(join(hermesMirror, "SKILL.md"), "utf8")).toBe("# Hermes-authored user-owned\n");
    } finally {
      await teardown(ws);
    }
  });
});

describe("syncActiveSkills — error flattening", () => {
  test("missing Voyager source files → error recorded, other skills still mirrored", async () => {
    const ws = await makeWorkspace("missing-source");
    try {
      // One fully-seeded active skill.
      await seedActiveSkill(ws, "good-skill");

      // A second active skill that has a DB row but NO files on disk.
      await seedDbRowOnly(ws, "ghost-skill");

      // Must never throw.
      const result = await ws.bridge.syncActiveSkills(await ws.shared.getSharedDb(), ws.dir);

      expect(result.mirrored).toEqual(["good-skill"]);
      expect(result.removed).toEqual([]);
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].name).toBe("ghost-skill");
      expect(typeof result.errors[0].reason).toBe("string");
      expect(result.errors[0].reason.length).toBeGreaterThan(0);

      // good-skill still landed on disk; ghost-skill did not.
      expect(existsSync(mirrorDirOf(ws.dir, "good-skill"))).toBe(true);
      expect(existsSync(mirrorDirOf(ws.dir, "ghost-skill"))).toBe(false);
    } finally {
      await teardown(ws);
    }
  });
});

describe("syncActiveSkills — idempotency", () => {
  test("running sync twice produces identical filesystem state", async () => {
    const ws = await makeWorkspace("idempotent");
    try {
      await seedActiveSkill(ws, "alpha-skill", {
        skillMd: "# Alpha\nalpha body\n",
        description: "Use alpha-skill for alpha.",
      });
      await seedActiveSkill(ws, "beta-skill", {
        skillMd: "# Beta\nbeta body\n",
        description: "Use beta-skill for beta.",
      });

      const db = await ws.shared.getSharedDb();

      const first = await ws.bridge.syncActiveSkills(db, ws.dir);
      expect(first.mirrored).toEqual(["alpha-skill", "beta-skill"]);
      expect(first.removed).toEqual([]);
      expect(first.errors).toEqual([]);

      const snap1 = snapshotDir(ws.mirrorRoot);
      const dirs1 = listHermesMirrorDirs(ws);

      const second = await ws.bridge.syncActiveSkills(db, ws.dir);
      // mirrored/removed semantics on a no-op second run: nothing changed,
      // but the contract guarantees the filesystem state is identical. We
      // don't pin the shape of `mirrored` on the second run (some impls
      // report what they ensured, others report only changes) — we DO pin
      // that `removed` is empty and `errors` is empty.
      expect(second.removed).toEqual([]);
      expect(second.errors).toEqual([]);

      const snap2 = snapshotDir(ws.mirrorRoot);
      const dirs2 = listHermesMirrorDirs(ws);

      expect(dirs2).toEqual(dirs1);
      expect(snap2).toEqual(snap1);
    } finally {
      await teardown(ws);
    }
  });
});

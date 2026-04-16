import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, closeDb, type Database, openDb, skillsRepo } from "../state";
import * as reg from "./registry";

// listActiveSkills/listCandidateSkills both accept a `roots` arg so the test
// drives discovery with explicit cwd + home, which is OS-agnostic. The earlier
// env-based stubs failed on Linux because Bun's homedir() doesn't always honour
// $HOME.
let tempRoot: string;
let fakeHome: string;
let fakeProject: string;
let globalSkillsDir: string;
let projectSkillsDir: string;
let db: Database;
let roots: { cwd: string; home: string };

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-learn-reg-"));
  fakeHome = join(tempRoot, "home");
  fakeProject = join(tempRoot, "project");
  globalSkillsDir = join(fakeHome, ".claude", "skills");
  projectSkillsDir = join(fakeProject, ".claude", "skills");
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  roots = { cwd: fakeProject, home: fakeHome };

  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(async () => {
  closeDb(db);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await fs.rm(projectSkillsDir, { recursive: true, force: true });
  await fs.rm(globalSkillsDir, { recursive: true, force: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(globalSkillsDir, { recursive: true });
  db.exec("DELETE FROM skills");
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "SKILL.md"), body);
}

beforeEach(async () => {
  await reset();
});

describe("listActiveSkills", () => {
  test("returns empty array when no skills are active in DB", async () => {
    await writeSkill(globalSkillsDir, "fs-only", "---\ndescription: x\n---\n");
    const active = await reg.listActiveSkills(db, roots);
    expect(active).toEqual([]);
  });

  test("only returns filesystem skills whose DB row has status=active", async () => {
    await writeSkill(globalSkillsDir, "alpha", "---\ndescription: a\n---\n");
    await writeSkill(globalSkillsDir, "beta", "---\ndescription: b\n---\n");
    await writeSkill(globalSkillsDir, "gamma", "---\ndescription: g\n---\n");

    skillsRepo.upsertSkill(db, { name: "alpha", path: "/tmp/a", status: "active" });
    skillsRepo.upsertSkill(db, { name: "beta", path: "/tmp/b", status: "shadow" });
    // gamma has no DB row

    const active = await reg.listActiveSkills(db, roots);
    const names = active.map((s) => s.name).sort();
    expect(names).toEqual(["alpha"]);
  });

  test("skills with status candidate/shadow/disabled are excluded from active list", async () => {
    await writeSkill(globalSkillsDir, "c", "---\ndescription: c\n---\n");
    await writeSkill(globalSkillsDir, "s", "---\ndescription: s\n---\n");
    await writeSkill(globalSkillsDir, "d", "---\ndescription: d\n---\n");
    skillsRepo.upsertSkill(db, { name: "c", path: "/x", status: "candidate" });
    skillsRepo.upsertSkill(db, { name: "s", path: "/x", status: "shadow" });
    skillsRepo.upsertSkill(db, { name: "d", path: "/x", status: "disabled" });

    const active = await reg.listActiveSkills(db, roots);
    expect(active).toEqual([]);
  });
});

describe("listCandidateSkills", () => {
  test("returns filesystem skills whose DB row is candidate or shadow", async () => {
    await writeSkill(globalSkillsDir, "cand", "---\ndescription: c\n---\n");
    await writeSkill(globalSkillsDir, "shad", "---\ndescription: s\n---\n");
    await writeSkill(globalSkillsDir, "act", "---\ndescription: a\n---\n");

    skillsRepo.upsertSkill(db, { name: "cand", path: "/x", status: "candidate" });
    skillsRepo.upsertSkill(db, { name: "shad", path: "/x", status: "shadow" });
    skillsRepo.upsertSkill(db, { name: "act", path: "/x", status: "active" });

    const candidates = await reg.listCandidateSkills(db, roots);
    const names = candidates.map((s) => s.name).sort();
    expect(names).toEqual(["cand", "shad"]);
  });

  test("returns [] when no skills are in candidate/shadow status", async () => {
    await writeSkill(globalSkillsDir, "a", "---\ndescription: a\n---\n");
    expect(await reg.listCandidateSkills(db, roots)).toEqual([]);
  });

  test("skill present in DB but missing on disk is excluded", async () => {
    skillsRepo.upsertSkill(db, { name: "ghost", path: "/tmp/gone", status: "candidate" });
    expect(await reg.listCandidateSkills(db, roots)).toEqual([]);
  });
});

describe("re-exports", () => {
  test("exposes listSkills from the pure skills module", async () => {
    await writeSkill(globalSkillsDir, "re-export", "---\ndescription: x\n---\n");
    const all = await reg.listSkills(roots);
    expect(all.map((s) => s.name)).toContain("re-export");
  });

  test("exposes resolveSkillPrompt from the pure skills module", async () => {
    await writeSkill(globalSkillsDir, "resolve-me", "BODY");
    expect(await reg.resolveSkillPrompt("resolve-me", roots)).toBe("BODY");
  });

  test("exposes discoverSkills and extractDescription from discovery", () => {
    expect(typeof reg.discoverSkills).toBe("function");
    expect(typeof reg.extractDescription).toBe("function");
  });
});

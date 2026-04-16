import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, resolveSkillPrompt } from "./registry";

// Both functions accept an optional `roots` arg to override cwd/home; we drive
// them through explicit paths so the tests don't depend on $HOME being honoured
// by Bun's homedir() (which has surprising behaviour on Linux).
let tempRoot: string;
let fakeHome: string;
let fakeProject: string;
let globalSkillsDir: string;
let projectSkillsDir: string;
let pluginsDir: string;
let roots: { cwd: string; home: string };

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-reg-"));
  fakeHome = join(tempRoot, "home");
  fakeProject = join(tempRoot, "project");
  globalSkillsDir = join(fakeHome, ".claude", "skills");
  projectSkillsDir = join(fakeProject, ".claude", "skills");
  pluginsDir = join(fakeHome, ".claude", "plugins");
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(pluginsDir, { recursive: true });
  roots = { cwd: fakeProject, home: fakeHome };
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await fs.rm(projectSkillsDir, { recursive: true, force: true });
  await fs.rm(globalSkillsDir, { recursive: true, force: true });
  await fs.rm(pluginsDir, { recursive: true, force: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(pluginsDir, { recursive: true });
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "SKILL.md"), body);
}

beforeEach(async () => {
  await reset();
});

describe("listSkills", () => {
  test("returns empty array when nothing is installed", async () => {
    const skills = await listSkills(roots);
    expect(skills).toEqual([]);
  });

  test("returns discovered skills from project + global", async () => {
    await writeSkill(projectSkillsDir, "proj-only", "---\ndescription: p\n---\n");
    await writeSkill(globalSkillsDir, "glob-only", "---\ndescription: g\n---\n");
    const skills = await listSkills(roots);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["glob-only", "proj-only"]);
  });
});

describe("resolveSkillPrompt", () => {
  test("returns null for empty command (just '/')", async () => {
    expect(await resolveSkillPrompt("/", roots)).toBeNull();
  });

  test("returns null when the named skill does not exist anywhere", async () => {
    await writeSkill(globalSkillsDir, "other", "body");
    expect(await resolveSkillPrompt("ghost", roots)).toBeNull();
  });

  test("strips a leading slash from the command", async () => {
    await writeSkill(globalSkillsDir, "hi", "hello world");
    expect(await resolveSkillPrompt("/hi", roots)).toBe("hello world");
  });

  test("project skill takes precedence over global skill with same name", async () => {
    await writeSkill(projectSkillsDir, "shared", "PROJECT CONTENT");
    await writeSkill(globalSkillsDir, "shared", "GLOBAL CONTENT");
    expect(await resolveSkillPrompt("shared", roots)).toBe("PROJECT CONTENT");
  });

  test("falls back to global when the project lacks the skill", async () => {
    await writeSkill(globalSkillsDir, "only-global", "ONLY GLOBAL");
    expect(await resolveSkillPrompt("only-global", roots)).toBe("ONLY GLOBAL");
  });

  test("returns null when the SKILL.md is present but empty/whitespace", async () => {
    await writeSkill(globalSkillsDir, "blank", "");
    await writeSkill(globalSkillsDir, "ws", "   \n  ");
    expect(await resolveSkillPrompt("blank", roots)).toBeNull();
    expect(await resolveSkillPrompt("ws", roots)).toBeNull();
  });

  test("finds a plugin skill under plugins/<marketplace>/skills/<name>/SKILL.md", async () => {
    const pluginSkillDir = join(pluginsDir, "mymkt", "skills", "plug-skill");
    await fs.mkdir(pluginSkillDir, { recursive: true });
    await fs.writeFile(join(pluginSkillDir, "SKILL.md"), "PLUGIN BODY");

    expect(await resolveSkillPrompt("plug-skill", roots)).toBe("PLUGIN BODY");
  });

  test("respects plugin hint (marketplace:skill) to restrict search", async () => {
    // One marketplace has the skill, another does not; the hint should steer
    // the search to the right marketplace.
    const mktSkill = join(pluginsDir, "want-this", "skills", "target");
    await fs.mkdir(mktSkill, { recursive: true });
    await fs.writeFile(join(mktSkill, "SKILL.md"), "FROM WANT-THIS");

    const otherMkt = join(pluginsDir, "other", "skills", "target");
    await fs.mkdir(otherMkt, { recursive: true });
    await fs.writeFile(join(otherMkt, "SKILL.md"), "FROM OTHER");

    expect(await resolveSkillPrompt("want-this:target", roots)).toBe("FROM WANT-THIS");
  });

  test("finds a skill in the plugins cache directory (versioned path)", async () => {
    const cachedSkill = join(pluginsDir, "cache", "mkt", "plug", "v1", "skills", "cached");
    await fs.mkdir(cachedSkill, { recursive: true });
    await fs.writeFile(join(cachedSkill, "SKILL.md"), "CACHED BODY");

    expect(await resolveSkillPrompt("cached", roots)).toBe("CACHED BODY");
  });
});

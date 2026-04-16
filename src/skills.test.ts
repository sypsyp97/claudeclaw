import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, resolveSkillPrompt } from "./skills";

// The barrel re-exports `listSkills` / `resolveSkillPrompt` from
// `src/skills/registry.ts`. Both accept an optional `roots` arg so tests can
// drive them with explicit cwd + home, which is OS-agnostic — earlier env-based
// stubs failed on Linux because Bun's homedir() doesn't always honour $HOME.

let tempRoot: string;
let fakeHome: string;
let fakeProject: string;
let globalSkillsDir: string;
let projectSkillsDir: string;
let roots: { cwd: string; home: string };

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-skills-"));
  fakeHome = join(tempRoot, "home");
  fakeProject = join(tempRoot, "project");
  globalSkillsDir = join(fakeHome, ".claude", "skills");
  projectSkillsDir = join(fakeProject, ".claude", "skills");
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  roots = { cwd: fakeProject, home: fakeHome };
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function clearSkills(): Promise<void> {
  await fs.rm(projectSkillsDir, { recursive: true, force: true });
  await fs.rm(globalSkillsDir, { recursive: true, force: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(globalSkillsDir, { recursive: true });
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "SKILL.md"), body);
}

beforeEach(async () => {
  await clearSkills();
});

describe("listSkills", () => {
  test("returns empty array when no skills exist", async () => {
    const skills = await listSkills(roots);
    expect(skills).toEqual([]);
  });

  test("dedupes by name when a skill exists in both project and global (project wins)", async () => {
    await writeSkill(projectSkillsDir, "shared", "project body\n");
    await writeSkill(globalSkillsDir, "shared", "global body\n");

    const skills = await listSkills(roots);
    const shared = skills.filter((s) => s.name === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].description).toBe("project body");
  });

  test("extracts single-line frontmatter description", async () => {
    await writeSkill(globalSkillsDir, "single", "---\ndescription: Short desc\n---\nbody\n");
    const skills = await listSkills(roots);
    const found = skills.find((s) => s.name === "single");
    expect(found?.description).toBe("Short desc");
  });

  test("extracts multi-line frontmatter description (block scalar)", async () => {
    await writeSkill(
      globalSkillsDir,
      "multi",
      "---\ndescription: >\n  This is\n  multi line\nname: multi\n---\nbody\n"
    );
    const skills = await listSkills(roots);
    const found = skills.find((s) => s.name === "multi");
    expect(found?.description).toBe("This is multi line");
    expect(found!.description.length).toBeLessThanOrEqual(256);
  });

  test("falls back to first non-header, non-empty line when no frontmatter", async () => {
    await writeSkill(globalSkillsDir, "nofm", "# Heading\n\nFirst real line here\nSecond line\n");
    const skills = await listSkills(roots);
    const found = skills.find((s) => s.name === "nofm");
    expect(found?.description).toBe("First real line here");
  });

  test("truncates description to 256 chars", async () => {
    const long = "x".repeat(400);
    await writeSkill(globalSkillsDir, "long", `---\ndescription: ${long}\n---\nbody\n`);
    const skills = await listSkills(roots);
    const found = skills.find((s) => s.name === "long");
    expect(found?.description.length).toBe(256);
    expect(found?.description).toBe("x".repeat(256));
  });
});

describe("resolveSkillPrompt", () => {
  test("returns null when nothing is installed", async () => {
    expect(await resolveSkillPrompt("anything", roots)).toBeNull();
  });

  test("returns null for a missing skill even when others exist", async () => {
    await writeSkill(globalSkillsDir, "other", "something\n");
    expect(await resolveSkillPrompt("ghost", roots)).toBeNull();
  });

  test("project skill takes priority over global skill of same name", async () => {
    await writeSkill(projectSkillsDir, "hello", "PROJECT HELLO");
    await writeSkill(globalSkillsDir, "hello", "GLOBAL HELLO");

    const content = await resolveSkillPrompt("hello", roots);
    expect(content).toBe("PROJECT HELLO");
  });

  test("falls back to global when project does not have the skill", async () => {
    await writeSkill(globalSkillsDir, "foo", "GLOBAL FOO BODY");
    const content = await resolveSkillPrompt("foo", roots);
    expect(content).toBe("GLOBAL FOO BODY");
  });

  test("strips a leading '/' from the command name", async () => {
    await writeSkill(globalSkillsDir, "leading-slash", "slashed body");
    const content = await resolveSkillPrompt("/leading-slash", roots);
    expect(content).toBe("slashed body");
  });
});

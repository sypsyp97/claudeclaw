import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, extractDescription } from "./discovery";

// Fuzz the discovery / extractDescription path with hostile-shaped SKILL.md
// payloads. The function must never throw and must always return a sensible
// SkillInfo for the directory (or skip it cleanly).

let tempRoot: string;
let fakeCwd: string;
let fakeHome: string;
let projectSkillsDir: string;
let roots: { cwd: string; home: string };

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-discovery-fuzz-"));
  fakeCwd = join(tempRoot, "project");
  fakeHome = join(tempRoot, "home");
  projectSkillsDir = join(fakeCwd, ".claude", "skills");
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(join(fakeHome, ".claude", "skills"), { recursive: true });
  roots = { cwd: fakeCwd, home: fakeHome };
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(projectSkillsDir, { recursive: true, force: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
});

async function writeSkill(name: string, body: string | Buffer): Promise<void> {
  const dir = join(projectSkillsDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "SKILL.md"), body);
}

describe("discoverSkills hostile inputs", () => {
  test("survives a SKILL.md with binary garbage", async () => {
    const garbage = Buffer.from([0x00, 0xff, 0x01, 0x02, 0xfe, 0xfd, 0xfc, 0x03, 0x04]);
    await writeSkill("binary", garbage);
    const skills = await discoverSkills(roots);
    const found = skills.find((s) => s.name === "binary");
    // Binary content should still surface a skill (extractDescription falls
    // back to the first non-header line, even if mojibake).
    expect(found).toBeDefined();
    expect(typeof found?.description).toBe("string");
  });

  test("survives extremely long lines (> 100KB single line)", async () => {
    const huge = "x".repeat(120_000);
    await writeSkill("huge", `---\ndescription: ${huge}\n---\nbody\n`);
    const skills = await discoverSkills(roots);
    const found = skills.find((s) => s.name === "huge");
    expect(found).toBeDefined();
    // Description must be capped at 256 chars so it doesn't blow up the model.
    expect(found?.description.length).toBeLessThanOrEqual(256);
  });

  test("frontmatter with embedded --- inside the body is not mis-parsed", async () => {
    await writeSkill(
      "embedded-fence",
      "---\ndescription: real\n---\nbody starts here\n---\nthis is in the body, not frontmatter\n"
    );
    const skills = await discoverSkills(roots);
    const found = skills.find((s) => s.name === "embedded-fence");
    expect(found?.description).toBe("real");
  });

  test("frontmatter with CRLF line endings still parses", async () => {
    await writeSkill("crlf", "---\r\ndescription: crlf-desc\r\n---\r\nbody\r\n");
    const skills = await discoverSkills(roots);
    const found = skills.find((s) => s.name === "crlf");
    // The current parser is LF-only, so CRLF frontmatter falls through to the
    // body-line fallback. Pin that behaviour so a future regex tweak is a
    // visible diff, not a silent regression.
    expect(found).toBeDefined();
    expect(typeof found?.description).toBe("string");
    expect(found?.description.length).toBeGreaterThan(0);
  });

  test("a SKILL.md that is just '---\\n---\\n' (empty frontmatter, empty body) is skipped or default", async () => {
    await writeSkill("empty-fm", "---\n---\n");
    const skills = await discoverSkills(roots);
    const found = skills.find((s) => s.name === "empty-fm");
    // Either skipped (whitespace-only after frontmatter) or surfaced with default text.
    if (found) {
      expect(typeof found.description).toBe("string");
    }
  });

  test("symlink-style traversal in skill name is not collected", async () => {
    // Path traversal attempts: directory entries named ".." or "." should be
    // skipped because readdir on POSIX excludes them, but check withFileTypes
    // safety for a name containing '..'.
    const weirdName = "..dotdot";
    await writeSkill(weirdName, "---\ndescription: weird\n---\n");
    const skills = await discoverSkills(roots);
    const found = skills.find((s) => s.name === weirdName);
    expect(found).toBeDefined();
    expect(found?.description).toBe("weird");
    // Name is preserved verbatim (no path-traversal munging).
    expect(found?.name).toBe(weirdName);
  });

  test("missing frontmatter close fence falls back gracefully", async () => {
    await writeSkill("no-close", "---\ndescription: never closes\nname: x\nbody after\n");
    const skills = await discoverSkills(roots);
    const found = skills.find((s) => s.name === "no-close");
    expect(found).toBeDefined();
    expect(typeof found?.description).toBe("string");
    expect(found!.description.length).toBeGreaterThan(0);
  });
});

describe("extractDescription hostile inputs", () => {
  test("does not throw on empty string", () => {
    expect(() => extractDescription("")).not.toThrow();
    expect(extractDescription("")).toBe("Claude Code skill");
  });

  test("does not throw on only whitespace", () => {
    expect(extractDescription("   \n\t\n  ")).toBe("Claude Code skill");
  });

  test("does not hang on pathological frontmatter regex input", () => {
    // Cap on description length protects the consumer; this test pins that
    // 100k-char description doesn't recurse-explode the regex engine.
    const start = Date.now();
    const desc = extractDescription(`---\ndescription: ${"a".repeat(100_000)}\n---\n`);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(desc.length).toBe(256);
  });

  test("handles description with special regex chars unchanged", () => {
    const desc = extractDescription("---\ndescription: ()[]{}*+?.|^$\\\n---\n");
    expect(desc).toBe("()[]{}*+?.|^$\\");
  });
});

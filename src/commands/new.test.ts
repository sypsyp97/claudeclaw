import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RED-phase tests for the `new` scaffolder subcommand. The implementation does
// not yet exist: every test below spawns `bun run src/index.ts new ...` inside
// a fresh temp project directory and expects the documented scaffolder shape.
// Until `new.ts` is wired up, these will fail at the exit-code assertion.

const REPO_ROOT = process.cwd();

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runNew(cwd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "new", ...args], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("new subprocess timed out after 15s"));
    }, 15_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

// Same signature as runNew but skips the leading "new" token so we can exercise
// the "no kind" usage branch via `bun run src/index.ts new`.
function runBareNew(cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "new"], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("new subprocess timed out after 15s"));
    }, 15_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

async function freshProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hermes-new-"));
  await mkdir(join(dir, ".claude", "hermes"), { recursive: true });
  return dir;
}

describe("new command", () => {
  const dirsToClean: string[] = [];

  afterAll(async () => {
    for (const d of dirsToClean) {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test("new job <name> creates a job file with default schedule and prompt", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runNew(dir, ["job", "my-job"]);
    expect(result.exitCode).toBe(0);

    const jobPath = join(dir, ".claude", "hermes", "jobs", "my-job.md");
    expect(result.stdout).toContain("Created ");
    expect(result.stdout).toContain(jobPath);

    const contents = await readFile(jobPath, "utf8");
    const expected = `---\nschedule: "0 * * * *"\n---\nTODO: describe what this job should do.\n`;
    expect(contents).toBe(expected);
  }, 20_000);

  test("new job honors --schedule and --prompt long-form flags", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runNew(dir, [
      "job",
      "custom-job",
      "--schedule",
      "*/5 * * * *",
      "--prompt",
      "do the thing",
    ]);
    expect(result.exitCode).toBe(0);

    const jobPath = join(dir, ".claude", "hermes", "jobs", "custom-job.md");
    const contents = await readFile(jobPath, "utf8");
    expect(contents).toContain('schedule: "*/5 * * * *"');
    expect(contents).toContain("do the thing");
    // Frontmatter must still be a proper YAML block.
    expect(contents.startsWith("---\n")).toBe(true);
    expect(contents).toContain("\n---\n");
  }, 20_000);

  test("new job on an existing file errors and leaves the file untouched; --force overwrites", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const first = await runNew(dir, ["job", "dup-job"]);
    expect(first.exitCode).toBe(0);

    const jobPath = join(dir, ".claude", "hermes", "jobs", "dup-job.md");
    const before = await readFile(jobPath, "utf8");

    const second = await runNew(dir, [
      "job",
      "dup-job",
      "--schedule",
      "*/10 * * * *",
      "--prompt",
      "should not land",
    ]);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr.toLowerCase()).toContain("already exists");

    const afterNoForce = await readFile(jobPath, "utf8");
    expect(afterNoForce).toBe(before);

    const forced = await runNew(dir, [
      "job",
      "dup-job",
      "--schedule",
      "*/10 * * * *",
      "--prompt",
      "forced overwrite",
      "--force",
    ]);
    expect(forced.exitCode).toBe(0);

    const afterForce = await readFile(jobPath, "utf8");
    expect(afterForce).not.toBe(before);
    expect(afterForce).toContain('schedule: "*/10 * * * *"');
    expect(afterForce).toContain("forced overwrite");
  }, 20_000);

  test("new skill <name> creates SKILL.md with name and description; collision + --force", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runNew(dir, ["skill", "my-skill"]);
    expect(result.exitCode).toBe(0);

    const skillPath = join(dir, ".claude", "hermes", "skills", "my-skill", "SKILL.md");
    const contents = await readFile(skillPath, "utf8");
    expect(contents.split(/\r?\n/)).toContain("name: my-skill");
    expect(/^description:\s*\S/m.test(contents)).toBe(true);

    // Collision on the skill directory
    const dup = await runNew(dir, ["skill", "my-skill"]);
    expect(dup.exitCode).not.toBe(0);
    expect(dup.stderr.toLowerCase()).toContain("already exists");

    // --force overwrites
    const forced = await runNew(dir, ["skill", "my-skill", "--force"]);
    expect(forced.exitCode).toBe(0);

    const afterForce = await readFile(skillPath, "utf8");
    expect(afterForce.split(/\r?\n/)).toContain("name: my-skill");
    expect(/^description:\s*\S/m.test(afterForce)).toBe(true);
  }, 20_000);

  test("new prompt <name> creates a non-empty prompt file; collision + --force", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runNew(dir, ["prompt", "my-prompt"]);
    expect(result.exitCode).toBe(0);

    const promptPath = join(dir, ".claude", "hermes", "prompts", "my-prompt.md");
    const contents = await readFile(promptPath, "utf8");
    expect(contents.length).toBeGreaterThan(0);

    const dup = await runNew(dir, ["prompt", "my-prompt"]);
    expect(dup.exitCode).not.toBe(0);
    expect(dup.stderr.toLowerCase()).toContain("already exists");

    const forced = await runNew(dir, ["prompt", "my-prompt", "--force"]);
    expect(forced.exitCode).toBe(0);
    const afterForce = await readFile(promptPath, "utf8");
    expect(afterForce.length).toBeGreaterThan(0);
  }, 20_000);

  test("bare `new` with no kind prints usage and exits non-zero", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runBareNew(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("usage");
  }, 20_000);

  test("`new job` with no name prints usage and exits non-zero", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runNew(dir, ["job"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("usage");
  }, 20_000);

  test("unknown kind is rejected with a helpful stderr message", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runNew(dir, ["widget", "foo"]);
    expect(result.exitCode).not.toBe(0);
    const err = result.stderr.toLowerCase();
    const mentionsKinds =
      err.includes("unknown kind") ||
      err.includes("valid kinds") ||
      err.includes("job") ||
      err.includes("skill") ||
      err.includes("prompt");
    expect(mentionsKinds).toBe(true);
  }, 20_000);

  test("invalid name containing `/` is rejected", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runNew(dir, ["job", "foo/bar"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("invalid name");
  }, 20_000);

  test("invalid name `..` is rejected", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runNew(dir, ["job", ".."]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("invalid name");
  }, 20_000);

  // Suppress unused-import warnings for helpers we might reach for; writeFile
  // is intentionally imported so future additions can seed fixtures without
  // another import churn. Reference it once to keep noUnusedLocals happy.
  void writeFile;
});

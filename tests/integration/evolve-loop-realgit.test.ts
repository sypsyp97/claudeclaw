/**
 * Real-git integration test for the evolve loop. Spins up an isolated git
 * worktree in a tmp dir, hands `evolveOnce` a task directly, runs with REAL
 * git (no `runGit` injection — `defaultGit` spawns the actual `git` binary),
 * and asserts:
 *
 *   - GREEN verify → a new commit lands on HEAD with the executor's edit.
 *   - RED verify → the executor's edit is wiped and HEAD is unchanged.
 *   - EXEC failure → changes wiped, verify not called, HEAD unchanged.
 *
 * Only the verify gate and the exec step are stubbed; everything to do with
 * git (status, add, commit, restore, clean -fd, rev-parse) goes through the
 * real binary. This is the only test in the suite that proves the
 * commit/revert cycle works against an actual repo.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evolveOnce, type EvolveTask } from "../../src/evolve";
import { applyMigrations, closeDb, type Database, openDb } from "../../src/state";
import { listEvents } from "../../src/state/repos/events";

let tmpRepo: string;
let db: Database;

function runGitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function gitMustSucceed(cwd: string, args: string[]): string {
  const r = runGitSync(cwd, args);
  if (!r.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function makeTask(overrides: Partial<EvolveTask>): EvolveTask {
  return { id: "t", title: "t", body: "", ...overrides };
}

beforeAll(async () => {
  tmpRepo = mkdtempSync(join(tmpdir(), "hermes-evolve-realgit-"));
  // Initialise repo with deterministic main branch + identity so commits
  // don't pick up the host's git config (some CI machines have no user set).
  gitMustSucceed(tmpRepo, ["init", "-q", "-b", "main"]);
  gitMustSucceed(tmpRepo, ["config", "user.email", "evolve-test@hermes.local"]);
  gitMustSucceed(tmpRepo, ["config", "user.name", "Evolve Test"]);
  gitMustSucceed(tmpRepo, ["config", "commit.gpgsign", "false"]);
  gitMustSucceed(tmpRepo, ["config", "core.autocrlf", "false"]);
  gitMustSucceed(tmpRepo, ["config", "core.eol", "lf"]);

  await writeFile(join(tmpRepo, "README.md"), "# evolve target\n", "utf8");
  await writeFile(join(tmpRepo, ".gitignore"), ".claude/\n", "utf8");
  gitMustSucceed(tmpRepo, ["add", "README.md", ".gitignore"]);
  gitMustSucceed(tmpRepo, ["commit", "-q", "-m", "initial"]);

  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe("evolve loop with real git", () => {
  test("GREEN verify: real git commit lands on HEAD with the executor's edit", async () => {
    const headBefore = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);

    const result = await evolveOnce(
      db,
      makeTask({ id: "tweak-readme", title: "Tweak README", body: "Make the README more verbose." }),
      tmpRepo,
      {
        async runExec({ cwd }) {
          await writeFile(
            join(cwd, "README.md"),
            "# evolve target\n\nNow with more lines.\nAnd another.\n",
            "utf8"
          );
          return { ok: true, exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
        },
        gate: {
          async runVerify() {
            return { ok: true, exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
          },
        },
      }
    );

    expect(result.outcome).toBe("committed");
    expect(result.task.id).toBe("tweak-readme");
    expect(result.sha).toBeDefined();
    expect(result.sha?.length).toBeGreaterThan(20);

    const headAfter = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    expect(headAfter).not.toBe(headBefore);
    expect(headAfter).toBe(result.sha as string);

    const readme = await readFile(join(tmpRepo, "README.md"), "utf8");
    expect(readme).toContain("Now with more lines.");

    const status = gitMustSucceed(tmpRepo, ["status", "--porcelain"]);
    expect(status).toBe("");

    const events = listEvents(db, { kindPrefix: "evolve.commit" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("RED verify: real git wipes the executor's changes and HEAD doesn't move", async () => {
    const headBefore = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    const readmeBefore = await readFile(join(tmpRepo, "README.md"), "utf8");

    const result = await evolveOnce(
      db,
      makeTask({
        id: "broken-edit",
        title: "Apply broken edit",
        body: "Whatever the agent writes, verify will reject it.",
      }),
      tmpRepo,
      {
        async runExec({ cwd }) {
          await writeFile(join(cwd, "README.md"), "BROKEN\n", "utf8");
          // Untracked file — `git restore` won't help; only `clean -fd` removes it.
          await writeFile(join(cwd, "garbage.txt"), "junk\n", "utf8");
          return { ok: true, exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
        },
        gate: {
          async runVerify() {
            return {
              ok: false,
              exitCode: 1,
              durationMs: 1,
              stdout: "",
              stderr: "verify said no",
            };
          },
        },
      }
    );

    expect(result.outcome).toBe("verify-failed");
    expect(result.verify?.ok).toBe(false);

    const headAfter = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    expect(headAfter).toBe(headBefore);

    const readmeAfter = await readFile(join(tmpRepo, "README.md"), "utf8");
    expect(readmeAfter).toBe(readmeBefore);

    const status = gitMustSucceed(tmpRepo, ["status", "--porcelain"]);
    expect(status).toBe("");

    const events = listEvents(db, { kindPrefix: "evolve.revert" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("exec failure: real git wipes changes, no commit, no verify run", async () => {
    const headBefore = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    let verifyWasCalled = false;

    const result = await evolveOnce(
      db,
      makeTask({ id: "exec-blows-up", title: "Exec will fail", body: "Subagent crashes." }),
      tmpRepo,
      {
        async runExec({ cwd }) {
          await writeFile(join(cwd, "README.md"), "PARTIAL EDIT\n", "utf8");
          await writeFile(join(cwd, "untracked-side-file.txt"), "x\n", "utf8");
          return {
            ok: false,
            exitCode: 7,
            durationMs: 1,
            stdout: "",
            stderr: "boom",
          };
        },
        gate: {
          async runVerify() {
            verifyWasCalled = true;
            return { ok: true, exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
          },
        },
      }
    );

    expect(result.outcome).toBe("exec-failed");
    expect(result.exec?.exitCode).toBe(7);
    expect(verifyWasCalled).toBe(false);

    const headAfter = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    expect(headAfter).toBe(headBefore);

    const status = gitMustSucceed(tmpRepo, ["status", "--porcelain"]);
    expect(status).toBe("");
  });
});

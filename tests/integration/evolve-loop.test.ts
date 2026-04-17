import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, closeDb, eventsRepo, openDb, type Database } from "../../src/state";
import { evolveOnce, type EvolveTask } from "../../src/evolve";

let tempRoot: string;
let db: Database;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-evolve-"));
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(async () => {
  closeDb(db);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function task(overrides: Partial<EvolveTask> = {}): EvolveTask {
  return {
    id: "t-1",
    title: "demo task",
    body: "do something small",
    ...overrides,
  };
}

describe("evolveOnce — fake executor", () => {
  test("commits when exec + verify are green", async () => {
    let committed = false;
    let statusCalls = 0;
    const result = await evolveOnce(db, task({ id: "green-task", title: "green task" }), tempRoot, {
      runExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            statusCalls++;
            return statusCalls === 1
              ? { ok: true, stdout: "", stderr: "" }
              : { ok: true, stdout: " M src/foo.ts\n", stderr: "" };
          }
          if (args[0] === "add") return { ok: true, stdout: "", stderr: "" };
          if (args[0] === "diff") return { ok: true, stdout: "src/foo.ts\n", stderr: "" };
          if (args[0] === "commit") {
            committed = true;
            return { ok: true, stdout: "", stderr: "" };
          }
          if (args[0] === "rev-parse") return { ok: true, stdout: "deadbeefcafe\n", stderr: "" };
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("committed");
    expect(result.task.id).toBe("green-task");
    expect(committed).toBe(true);
    expect(result.sha).toBe("deadbeefcafe");
  });

  test("reverts only the exec-touched paths when verify is red", async () => {
    const restoreCalls: string[][] = [];
    let statusCalls = 0;

    const result = await evolveOnce(db, task({ id: "red-task", title: "red task" }), tempRoot, {
      runExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "typecheck failed",
          durationMs: 2,
        }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            statusCalls++;
            // Baseline: user already has an unrelated WIP file dirty.
            if (statusCalls === 1) return { ok: true, stdout: "?? user-wip.txt\n", stderr: "" };
            // After exec: user-wip still dirty + new evolve touch.
            return {
              ok: true,
              stdout: "?? user-wip.txt\n M src/evolve-edit.ts\n",
              stderr: "",
            };
          }
          if (args[0] === "restore" || args[0] === "clean") restoreCalls.push(args);
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("verify-failed");
    // Every revert command must be pathspec-scoped, and must NOT touch the user's WIP file.
    expect(restoreCalls.length).toBeGreaterThan(0);
    for (const call of restoreCalls) {
      expect(call).toContain("--");
      expect(call).toContain("src/evolve-edit.ts");
      expect(call).not.toContain("user-wip.txt");
    }

    const revertEvents = eventsRepo.listEvents(db, { kindPrefix: "evolve.revert" });
    expect(revertEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("exec failure reverts only exec-touched paths and skips verify", async () => {
    let verifyCalled = false;
    const restoreCalls: string[][] = [];
    let statusCalls = 0;

    const result = await evolveOnce(db, task({ id: "exec-blows", title: "exec blows up" }), tempRoot, {
      runExec: async () => ({ ok: false, exitCode: 7, stdout: "", stderr: "boom", durationMs: 1 }),
      gate: {
        runVerify: async () => {
          verifyCalled = true;
          return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
        },
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            statusCalls++;
            if (statusCalls === 1) return { ok: true, stdout: "", stderr: "" };
            return { ok: true, stdout: "?? half-applied.ts\n", stderr: "" };
          }
          if (args[0] === "restore" || args[0] === "clean") restoreCalls.push(args);
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("exec-failed");
    expect(verifyCalled).toBe(false);
    expect(restoreCalls.length).toBeGreaterThan(0);
    for (const call of restoreCalls) {
      expect(call).toContain("--");
      expect(call).toContain("half-applied.ts");
    }
  });

  test("does not revert anything when nothing was touched (clean exec failure)", async () => {
    const restoreCalls: string[][] = [];

    await evolveOnce(db, task({ id: "clean-fail", title: "clean fail" }), tempRoot, {
      runExec: async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
          if (args[0] === "restore" || args[0] === "clean") restoreCalls.push(args);
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(restoreCalls).toEqual([]);
  });

  // The audit caught this: paths that were dirty BEFORE the subagent ran were
  // being excluded from `touchedPaths` entirely — so if the subagent modified
  // an already-dirty file, that change was neither reverted on RED nor staged
  // on GREEN. Fix is a content-hash snapshot: a baseline path whose bytes
  // change during exec must land in the touched set.
  test("subagent edits an already-dirty baseline file → it is reverted on RED", async () => {
    const restoreCalls: string[][] = [];
    let hashCalls = 0;
    const result = await evolveOnce(db, task({ id: "edit-baseline", title: "edit baseline" }), tempRoot, {
      runExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "nope",
          durationMs: 1,
        }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            // Baseline and after: the same set of paths is dirty. Only the
            // *content* of user-wip.txt changes between snapshots.
            return { ok: true, stdout: " M user-wip.txt\n", stderr: "" };
          }
          if (args[0] === "restore" || args[0] === "clean") restoreCalls.push(args);
          if (args[0] === "ls-files") return { ok: true, stdout: "user-wip.txt\n", stderr: "" };
          return { ok: true, stdout: "", stderr: "" };
        },
        hashPath: async (_cwd, path) => {
          hashCalls++;
          // First snapshot (baseline): one content. Second snapshot (after
          // exec): different content. Any hash stability will cause the
          // path to be excluded from touched and the test to fail.
          if (path !== "user-wip.txt") return null;
          return hashCalls === 1 ? "hash-before" : "hash-after";
        },
      },
    });

    expect(result.outcome).toBe("verify-failed");
    // The baseline-dirty file must be reverted because the subagent touched it.
    const touchedRestore = restoreCalls.filter((c) => c.includes("user-wip.txt"));
    expect(touchedRestore.length).toBeGreaterThan(0);
  });

  test("baseline-dirty file NOT touched by subagent is preserved (not reverted)", async () => {
    const restoreCalls: string[][] = [];
    const result = await evolveOnce(db, task({ id: "preserve-wip", title: "preserve wip" }), tempRoot, {
      runExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "nope",
          durationMs: 1,
        }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            return { ok: true, stdout: " M user-wip.txt\n M evolve.ts\n", stderr: "" };
          }
          if (args[0] === "restore" || args[0] === "clean") restoreCalls.push(args);
          if (args[0] === "ls-files") return { ok: true, stdout: "x\n", stderr: "" };
          return { ok: true, stdout: "", stderr: "" };
        },
        // Only evolve.ts changes; user-wip.txt hash is stable across both
        // snapshots, so it must never appear in a restore/clean call.
        hashPath: async (_cwd, path) => {
          if (path === "user-wip.txt") return "stable";
          if (path === "evolve.ts") return String(Math.random()); // always fresh
          return null;
        },
      },
    });
    expect(result.outcome).toBe("verify-failed");
    for (const call of restoreCalls) {
      expect(call).not.toContain("user-wip.txt");
    }
  });
});

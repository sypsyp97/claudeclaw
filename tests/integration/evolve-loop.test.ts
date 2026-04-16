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
    const result = await evolveOnce(db, task({ id: "green-task", title: "green task" }), tempRoot, {
      runExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") return { ok: true, stdout: " M file\n", stderr: "" };
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

  test("reverts when verify is red", async () => {
    let reverted = 0;

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
          if (args[0] === "restore" || args[0] === "clean") reverted++;
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("verify-failed");
    expect(reverted).toBeGreaterThan(0);

    const revertEvents = eventsRepo.listEvents(db, { kindPrefix: "evolve.revert" });
    expect(revertEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("exec failure reverts changes and skips verify", async () => {
    let verifyCalled = false;
    let reverted = 0;

    const result = await evolveOnce(db, task({ id: "exec-blows", title: "exec blows up" }), tempRoot, {
      runExec: async () => ({ ok: false, exitCode: 7, stdout: "", stderr: "boom", durationMs: 1 }),
      gate: {
        runVerify: async () => {
          verifyCalled = true;
          return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
        },
        runGit: async (_cwd, args) => {
          if (args[0] === "restore" || args[0] === "clean") reverted++;
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("exec-failed");
    expect(verifyCalled).toBe(false);
    expect(reverted).toBeGreaterThan(0);
  });
});

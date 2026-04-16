/**
 * End-to-end: evolve loop with a real (fake) Claude CLI feeding events into
 * a status sink.
 *
 * We spawn fake-claude via HERMES_CLAUDE_BIN with a scripted streamEvents
 * scenario that emits Read + Edit tool_uses and a final result. The loop
 * must route events through executeSelfEdit (streaming variant) into the
 * FakeSink we pass as the status sink.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evolveOnce, type EvolveTask } from "../../src/evolve";
import { applyMigrations, closeDb, type Database, openDb } from "../../src/state";
import { createFakeSink } from "../../src/status/sink";
import type { StatusEvent } from "../../src/status/stream";

let tmpRepo: string;
let db: Database;
const REPO_ROOT = process.cwd();
const FAKE_CLAUDE = `bun run ${resolve(REPO_ROOT, "tests/fixtures/fake-claude.ts")}`;

beforeAll(async () => {
  tmpRepo = mkdtempSync(join(tmpdir(), "hermes-evolve-status-"));
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
  rmSync(tmpRepo, { recursive: true, force: true });
});

function task(overrides: Partial<EvolveTask> = {}): EvolveTask {
  return { id: "t-status", title: "Status-sink task", body: "do thing", ...overrides };
}

describe("evolveOnce with streaming sink", () => {
  test("sink receives task_start → tool events → task_complete when exec is streaming", async () => {
    const scenarioPath = join(tmpRepo, "sc-events.json");
    await writeFile(
      scenarioPath,
      JSON.stringify({
        streamEvents: [
          { type: "system", subtype: "init", session_id: "s-1", model: "fake" },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
                { type: "tool_use", id: "tu-2", name: "Edit", input: { file_path: "/b.ts" } },
              ],
            },
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
                { type: "tool_result", tool_use_id: "tu-2", content: "ok" },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "done",
            session_id: "s-1",
            num_turns: 1,
          },
        ],
      }),
      "utf8"
    );

    const sink = createFakeSink();
    const prevBin = process.env.HERMES_CLAUDE_BIN;
    const prevScenario = process.env.HERMES_FAKE_SCENARIO_PATH;
    process.env.HERMES_CLAUDE_BIN = FAKE_CLAUDE;
    process.env.HERMES_FAKE_SCENARIO_PATH = scenarioPath;

    try {
      const result = await evolveOnce(db, task(), tmpRepo, {
        sink,
        gate: {
          runVerify: async () => ({
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 1,
          }),
          runGit: async (_cwd, args) => {
            if (args[0] === "status") return { ok: true, stdout: " M a\n", stderr: "" };
            if (args[0] === "rev-parse") return { ok: true, stdout: "abcd1234abcd\n", stderr: "" };
            return { ok: true, stdout: "", stderr: "" };
          },
        },
      });

      expect(result.outcome).toBe("committed");

      const eventKinds = sink.events().map((e) => e.kind);
      expect(eventKinds).toContain("task_start");
      expect(eventKinds).toContain("tool_use_start");
      expect(eventKinds).toContain("tool_use_end");
      expect(eventKinds).toContain("task_complete");

      // Both tool_uses must show up
      const toolStarts = sink
        .events()
        .filter((e): e is Extract<StatusEvent, { kind: "tool_use_start" }> => e.kind === "tool_use_start");
      expect(toolStarts.length).toBe(2);
      expect(toolStarts.map((e) => e.name)).toEqual(["Read", "Edit"]);

      // Sink was opened with the task title and closed with ok=true
      expect(sink.calls[0]).toEqual(
        expect.objectContaining({ kind: "open", taskId: "t-status", label: "Status-sink task" })
      );
      const closeCall = sink.calls.at(-1);
      expect(closeCall?.kind).toBe("close");
      if (closeCall?.kind === "close") {
        expect(closeCall.result.ok).toBe(true);
      }
    } finally {
      if (prevBin === undefined) delete process.env.HERMES_CLAUDE_BIN;
      else process.env.HERMES_CLAUDE_BIN = prevBin;
      if (prevScenario === undefined) delete process.env.HERMES_FAKE_SCENARIO_PATH;
      else process.env.HERMES_FAKE_SCENARIO_PATH = prevScenario;
    }
  }, 30_000);

  test("sink is closed with ok=false when the subagent exits non-zero", async () => {
    const sink = createFakeSink();
    const prevExit = process.env.HERMES_FAKE_EXIT;
    const prevBin = process.env.HERMES_CLAUDE_BIN;
    const prevStderr = process.env.HERMES_FAKE_STDERR;
    process.env.HERMES_CLAUDE_BIN = FAKE_CLAUDE;
    process.env.HERMES_FAKE_EXIT = "3";
    process.env.HERMES_FAKE_STDERR = "simulated failure";

    try {
      const result = await evolveOnce(db, task({ id: "t-fail", title: "Failing task" }), tmpRepo, {
        sink,
        gate: {
          runVerify: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
          runGit: async () => ({ ok: true, stdout: "", stderr: "" }),
        },
      });

      expect(result.outcome).toBe("exec-failed");
      const closeCall = sink.calls.at(-1);
      expect(closeCall?.kind).toBe("close");
      if (closeCall?.kind === "close") {
        expect(closeCall.result.ok).toBe(false);
      }
    } finally {
      if (prevBin === undefined) delete process.env.HERMES_CLAUDE_BIN;
      else process.env.HERMES_CLAUDE_BIN = prevBin;
      if (prevExit === undefined) delete process.env.HERMES_FAKE_EXIT;
      else process.env.HERMES_FAKE_EXIT = prevExit;
      if (prevStderr === undefined) delete process.env.HERMES_FAKE_STDERR;
      else process.env.HERMES_FAKE_STDERR = prevStderr;
    }
  }, 30_000);
});

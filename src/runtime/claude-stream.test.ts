/**
 * Integration-leaning test: spawns fake-claude with a scripted stream-json
 * scenario and verifies the streaming wrapper pipes events into the sink.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runClaudeStreaming } from "./claude-stream";
import { createFakeSink } from "../status/sink";
import type { StatusEvent } from "../status/stream";

const REPO_ROOT = process.cwd();
const FAKE_CLAUDE = `bun run ${resolve(REPO_ROOT, "tests/fixtures/fake-claude.ts")}`;

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-claude-stream-"));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function withScenario(scenario: Record<string, unknown>): Promise<string> {
  const path = join(tempRoot, `sc-${Math.random().toString(36).slice(2, 9)}.json`);
  await writeFile(path, JSON.stringify(scenario), "utf8");
  return path;
}

describe("runClaudeStreaming", () => {
  test("happy path with one tool_use emits open → task_start → tool events → task_complete → close", async () => {
    const scenarioPath = await withScenario({
      sessionId: "s-1",
      streamEvents: [
        { type: "system", subtype: "init", session_id: "s-1", model: "fake" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } }],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
          },
        },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "done!" }] },
        },
        { type: "result", subtype: "success", result: "done!", session_id: "s-1", num_turns: 1 },
      ],
    });

    const sink = createFakeSink();
    const result = await runClaudeStreaming({
      args: ["-p", "go"],
      cwd: tempRoot,
      env: { ...process.env, HERMES_FAKE_SCENARIO_PATH: scenarioPath },
      sink,
      taskId: "task-1",
      label: "Happy path task",
      claudeBin: FAKE_CLAUDE,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("s-1");
    expect(result.finalResult).toBe("done!");

    const kinds = sink.calls.map((c) => c.kind);
    expect(kinds[0]).toBe("open");
    expect(kinds[kinds.length - 1]).toBe("close");
    const eventKinds = sink.events().map((e) => e.kind);
    expect(eventKinds).toEqual([
      "task_start",
      "tool_use_start",
      "tool_use_end",
      "text_delta",
      "task_complete",
    ]);
  }, 20_000);

  test("close is called with ok=true and finalText on success", async () => {
    const scenarioPath = await withScenario({
      streamEvents: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
        },
        { type: "result", subtype: "success", result: "reply", session_id: "s", num_turns: 1 },
      ],
    });

    const sink = createFakeSink();
    await runClaudeStreaming({
      args: ["-p", "go"],
      cwd: tempRoot,
      env: { ...process.env, HERMES_FAKE_SCENARIO_PATH: scenarioPath },
      sink,
      taskId: "t",
      label: "l",
      claudeBin: FAKE_CLAUDE,
    });

    const closeCall = sink.calls.at(-1);
    expect(closeCall?.kind).toBe("close");
    if (closeCall?.kind === "close") {
      expect(closeCall.result.ok).toBe(true);
      expect(closeCall.result.finalText).toBe("reply");
    }
  }, 20_000);

  test("non-zero exit code surfaces ok=false, close called with errorShort", async () => {
    const sink = createFakeSink();
    const result = await runClaudeStreaming({
      args: ["-p", "go"],
      cwd: tempRoot,
      env: { ...process.env, HERMES_FAKE_EXIT: "3", HERMES_FAKE_STDERR: "boom" },
      sink,
      taskId: "t",
      label: "l",
      claudeBin: FAKE_CLAUDE,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");

    const closeCall = sink.calls.at(-1);
    expect(closeCall?.kind).toBe("close");
    if (closeCall?.kind === "close") {
      expect(closeCall.result.ok).toBe(false);
      expect(closeCall.result.errorShort).toBeDefined();
    }
  }, 20_000);

  test("multiple tool_uses in sequence preserve arrival order in the sink", async () => {
    const scenarioPath = await withScenario({
      streamEvents: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "1", name: "Read", input: { file_path: "/a" } },
              { type: "tool_use", id: "2", name: "Edit", input: { file_path: "/b" } },
              { type: "tool_use", id: "3", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        { type: "result", subtype: "success", result: "ok", session_id: "s", num_turns: 1 },
      ],
    });

    const sink = createFakeSink();
    await runClaudeStreaming({
      args: ["-p", "go"],
      cwd: tempRoot,
      env: { ...process.env, HERMES_FAKE_SCENARIO_PATH: scenarioPath },
      sink,
      taskId: "t",
      label: "l",
      claudeBin: FAKE_CLAUDE,
    });

    const toolStarts = sink
      .events()
      .filter((e): e is Extract<StatusEvent, { kind: "tool_use_start" }> => e.kind === "tool_use_start")
      .map((e) => e.toolUseId);
    expect(toolStarts).toEqual(["1", "2", "3"]);
  }, 20_000);

  test("spawn failure (nonexistent binary) closes sink with ok=false", async () => {
    const sink = createFakeSink();
    const result = await runClaudeStreaming({
      args: ["-p", "go"],
      cwd: tempRoot,
      sink,
      taskId: "t",
      label: "l",
      claudeBin: "this-binary-definitely-does-not-exist-xyz-999",
    });

    expect(result.ok).toBe(false);
    const closeCall = sink.calls.at(-1);
    expect(closeCall?.kind).toBe("close");
    if (closeCall?.kind === "close") {
      expect(closeCall.result.ok).toBe(false);
    }
  }, 20_000);

  test("timeout kills the subprocess and closes the sink", async () => {
    const sink = createFakeSink();
    const result = await runClaudeStreaming({
      args: ["-p", "go"],
      cwd: tempRoot,
      env: { ...process.env, HERMES_FAKE_DELAY_MS: "5000", HERMES_FAKE_REPLY: "late" },
      sink,
      taskId: "t",
      label: "l",
      timeoutMs: 200,
      claudeBin: FAKE_CLAUDE,
    });

    expect(result.ok).toBe(false);
    const closeCall = sink.calls.at(-1);
    expect(closeCall?.kind).toBe("close");
  }, 20_000);
});

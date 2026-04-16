/**
 * Stream parser tests — feed canned NDJSON lines, expect StatusEvent sequence.
 *
 * Claude CLI --output-format stream-json --verbose emits one JSON object per
 * line. Envelope types we translate:
 *
 *   - system.init                  → task_start
 *   - assistant.message.content[]  → text_delta + tool_use_start (in block order)
 *   - user.message.content[]       → tool_use_end (from tool_result)
 *   - result                       → task_complete or error
 */

import { describe, expect, test } from "bun:test";
import { createStreamParser, formatToolLabel, type StatusEvent } from "./stream";

function ndjson(...events: object[]): string {
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

describe("createStreamParser — envelope translation", () => {
  test("system.init emits task_start with session_id + model", () => {
    const p = createStreamParser();
    const events = p.push(ndjson({ type: "system", subtype: "init", session_id: "sess-1", model: "opus" }));
    expect(events).toEqual([{ kind: "task_start", sessionId: "sess-1", model: "opus" }]);
  });

  test("assistant.text block emits text_delta", () => {
    const p = createStreamParser();
    const events = p.push(
      ndjson({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
      })
    );
    expect(events).toEqual([{ kind: "text_delta", text: "hello world" }]);
  });

  test("assistant.tool_use block emits tool_use_start with derived label", () => {
    const p = createStreamParser();
    const events = p.push(
      ndjson({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "Read",
              input: { file_path: "/abs/foo/bar.ts" },
            },
          ],
        },
      })
    );
    expect(events).toEqual([
      {
        kind: "tool_use_start",
        toolUseId: "tu-1",
        name: "Read",
        input: { file_path: "/abs/foo/bar.ts" },
        label: "Read(bar.ts)",
      },
    ]);
  });

  test("assistant with multiple content blocks preserves order", () => {
    const p = createStreamParser();
    const events = p.push(
      ndjson({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "going to read" },
            { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/foo.ts" } },
            { type: "text", text: "and then edit" },
            { type: "tool_use", id: "tu-2", name: "Edit", input: { file_path: "/bar.ts" } },
          ],
        },
      })
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["text_delta", "tool_use_start", "text_delta", "tool_use_start"]);
    expect((events[1] as Extract<StatusEvent, { kind: "tool_use_start" }>).toolUseId).toBe("tu-1");
    expect((events[3] as Extract<StatusEvent, { kind: "tool_use_start" }>).toolUseId).toBe("tu-2");
  });

  test("user.tool_result emits tool_use_end matched by tool_use_id", () => {
    const p = createStreamParser();
    // First open a tool_use so the parser knows about it
    p.push(
      ndjson({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/x" } }],
        },
      })
    );
    const events = p.push(
      ndjson({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
        },
      })
    );
    expect(events).toEqual([{ kind: "tool_use_end", toolUseId: "tu-1", ok: true }]);
  });

  test("user.tool_result with is_error emits tool_use_end ok=false", () => {
    const p = createStreamParser();
    const events = p.push(
      ndjson({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-x", content: "boom", is_error: true }],
        },
      })
    );
    expect(events).toEqual([{ kind: "tool_use_end", toolUseId: "tu-x", ok: false, errorShort: "boom" }]);
  });

  test("result success emits task_complete with result + num_turns", () => {
    const p = createStreamParser();
    const events = p.push(
      ndjson({
        type: "result",
        subtype: "success",
        result: "final reply here",
        session_id: "sess-9",
        num_turns: 3,
      })
    );
    expect(events).toEqual([
      {
        kind: "task_complete",
        result: "final reply here",
        numTurns: 3,
        sessionId: "sess-9",
      },
    ]);
  });

  test("result error emits error event", () => {
    const p = createStreamParser();
    const events = p.push(
      ndjson({
        type: "result",
        subtype: "error",
        result: "something broke",
        session_id: "sess-1",
      })
    );
    expect(events).toEqual([{ kind: "error", message: "something broke" }]);
  });
});

describe("createStreamParser — NDJSON boundary handling", () => {
  test("multiple lines in one chunk emit events in order", () => {
    const p = createStreamParser();
    const events = p.push(
      ndjson(
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        },
        { type: "result", subtype: "success", result: "hi", session_id: "s", num_turns: 1 }
      )
    );
    expect(events.map((e) => e.kind)).toEqual(["task_start", "text_delta", "task_complete"]);
  });

  test("partial chunk without trailing newline is buffered until next chunk", () => {
    const p = createStreamParser();
    const first = JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" });
    const a = p.push(first.slice(0, 20));
    const b = p.push(first.slice(20));
    expect(a).toEqual([]);
    expect(b).toEqual([]); // still no newline
    const c = p.push("\n");
    expect(c).toEqual([{ kind: "task_start", sessionId: "s", model: "m" }]);
  });

  test("flush drains trailing partial line if it is valid JSON", () => {
    const p = createStreamParser();
    const line = JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 1 });
    p.push(line); // no trailing newline
    const flushed = p.flush();
    expect(flushed.map((e) => e.kind)).toEqual(["task_complete"]);
  });

  test("malformed JSON line is skipped (no crash, subsequent lines still parse)", () => {
    const p = createStreamParser();
    const events = p.push(
      `${"{not-json at all"}\n${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "after bad" }] },
      })}\n`
    );
    expect(events).toEqual([{ kind: "text_delta", text: "after bad" }]);
  });

  test("empty lines are ignored", () => {
    const p = createStreamParser();
    const events = p.push(
      `\n\n${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      })}\n\n`
    );
    expect(events).toEqual([{ kind: "text_delta", text: "x" }]);
  });

  test("unknown envelope types are silently ignored", () => {
    const p = createStreamParser();
    const events = p.push(ndjson({ type: "heartbeat", foo: "bar" }, { type: "debug", marker: 1 }));
    expect(events).toEqual([]);
  });
});

describe("formatToolLabel", () => {
  test("Read uses basename of file_path", () => {
    expect(formatToolLabel("Read", { file_path: "/long/abs/path/foo.ts" })).toBe("Read(foo.ts)");
  });

  test("Edit uses basename of file_path", () => {
    expect(formatToolLabel("Edit", { file_path: "C:\\Users\\x\\bar.md" })).toBe("Edit(bar.md)");
  });

  test("Write uses basename of file_path", () => {
    expect(formatToolLabel("Write", { file_path: "src/new.ts" })).toBe("Write(new.ts)");
  });

  test("Bash truncates command at 60 chars", () => {
    const cmd = "a".repeat(100);
    const label = formatToolLabel("Bash", { command: cmd });
    expect(label.length).toBeLessThanOrEqual(70);
    expect(label).toContain("Bash(");
    expect(label).toContain("aaa");
  });

  test("Bash with short command shows full command", () => {
    expect(formatToolLabel("Bash", { command: "ls -la" })).toBe("Bash(ls -la)");
  });

  test("Grep shows pattern", () => {
    expect(formatToolLabel("Grep", { pattern: "foo.*bar" })).toBe("Grep(foo.*bar)");
  });

  test("Glob shows pattern", () => {
    expect(formatToolLabel("Glob", { pattern: "**/*.ts" })).toBe("Glob(**/*.ts)");
  });

  test("WebFetch shows hostname from url", () => {
    expect(formatToolLabel("WebFetch", { url: "https://example.com/path/to/x" })).toBe(
      "WebFetch(example.com)"
    );
  });

  test("WebSearch shows query", () => {
    expect(formatToolLabel("WebSearch", { query: "bun sqlite fts5" })).toBe("WebSearch(bun sqlite fts5)");
  });

  test("Task shows description truncated", () => {
    expect(formatToolLabel("Task", { description: "a normal description" })).toBe(
      "Task(a normal description)"
    );
  });

  test("unknown tool falls back to name only", () => {
    expect(formatToolLabel("MysteryTool", { whatever: 42 })).toBe("MysteryTool");
  });

  test("missing expected input field falls back to name only", () => {
    expect(formatToolLabel("Read", {})).toBe("Read");
    expect(formatToolLabel("Bash", {})).toBe("Bash");
  });

  test("null input does not crash", () => {
    expect(formatToolLabel("Read", null)).toBe("Read");
  });

  test("non-object input does not crash", () => {
    expect(formatToolLabel("Read", "weird")).toBe("Read");
    expect(formatToolLabel("Read", 42)).toBe("Read");
  });
});

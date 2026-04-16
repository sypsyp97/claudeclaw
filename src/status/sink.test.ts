import { describe, expect, test } from "bun:test";
import { createFakeSink, nullSink, type StatusSink } from "./sink";

async function drive(sink: StatusSink): Promise<void> {
  await sink.open("task-1", "Tweak README");
  await sink.update({ kind: "task_start", sessionId: "s-1", model: "opus" });
  await sink.update({
    kind: "tool_use_start",
    toolUseId: "tu-1",
    name: "Read",
    input: { file_path: "/a.ts" },
    label: "Read(a.ts)",
  });
  await sink.update({ kind: "tool_use_end", toolUseId: "tu-1", ok: true });
  await sink.update({ kind: "task_complete", result: "done", numTurns: 1 });
  await sink.close({ ok: true, finalText: "done" });
}

describe("nullSink", () => {
  test("accepts the full lifecycle without error", async () => {
    await drive(nullSink);
    // Nothing to assert — nullSink is a black hole. Just verify no throw.
    expect(true).toBe(true);
  });
});

describe("createFakeSink", () => {
  test("records open + every update + close, in order", async () => {
    const sink = createFakeSink();
    await drive(sink);
    const kinds = sink.calls.map((c) => c.kind);
    expect(kinds).toEqual(["open", "update", "update", "update", "update", "close"]);
  });

  test("open captures taskId + label", async () => {
    const sink = createFakeSink();
    await sink.open("t-42", "hello");
    expect(sink.calls).toEqual([{ kind: "open", taskId: "t-42", label: "hello" }]);
  });

  test("update captures the full StatusEvent payload by value", async () => {
    const sink = createFakeSink();
    const event = {
      kind: "tool_use_start" as const,
      toolUseId: "tu-x",
      name: "Edit",
      input: { file_path: "/foo.ts" },
      label: "Edit(foo.ts)",
    };
    await sink.update(event);
    expect(sink.calls[0]).toEqual({ kind: "update", event });
  });

  test("close captures the result envelope", async () => {
    const sink = createFakeSink();
    await sink.close({ ok: false, errorShort: "verify failed" });
    expect(sink.calls).toEqual([{ kind: "close", result: { ok: false, errorShort: "verify failed" } }]);
  });

  test("events() returns just the StatusEvents seen via update()", async () => {
    const sink = createFakeSink();
    await sink.open("t", "label");
    await sink.update({ kind: "text_delta", text: "a" });
    await sink.update({ kind: "text_delta", text: "b" });
    await sink.close({ ok: true });
    expect(sink.events().map((e) => (e.kind === "text_delta" ? e.text : e.kind))).toEqual(["a", "b"]);
  });
});

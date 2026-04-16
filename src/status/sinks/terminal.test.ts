import { describe, expect, test } from "bun:test";
import { createTerminalStatusSink } from "./terminal";

describe("createTerminalStatusSink", () => {
  test("open() writes a header line", async () => {
    const lines: string[] = [];
    const sink = createTerminalStatusSink({ write: (s) => lines.push(s) });
    await sink.open("t", "Tweak README");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join("")).toContain("Tweak README");
  });

  test("tool_use_start writes a timestamped progress line", async () => {
    const lines: string[] = [];
    const sink = createTerminalStatusSink({ write: (s) => lines.push(s) });
    await sink.open("t", "l");
    await sink.update({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: {},
      label: "Read(a.ts)",
    });
    // Must mention the label somewhere in the output
    expect(lines.join("")).toContain("Read(a.ts)");
  });

  test("tool_use_end writes an outcome marker (ok or error)", async () => {
    const lines: string[] = [];
    const sink = createTerminalStatusSink({ write: (s) => lines.push(s) });
    await sink.open("t", "l");
    await sink.update({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Bash",
      input: {},
      label: "Bash(cmd)",
    });
    await sink.update({ kind: "tool_use_end", toolUseId: "tu-1", ok: false, errorShort: "exit 2" });
    const joined = lines.join("");
    // Either the error marker or the errorShort must appear
    expect(joined).toContain("Bash(cmd)");
    expect(joined.toLowerCase()).toMatch(/fail|error|✗|exit 2/);
  });

  test("close() writes a final summary line", async () => {
    const lines: string[] = [];
    const sink = createTerminalStatusSink({ write: (s) => lines.push(s) });
    await sink.open("t", "l");
    await sink.update({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: {},
      label: "Read(a)",
    });
    await sink.update({ kind: "tool_use_end", toolUseId: "tu-1", ok: true });
    await sink.close({ ok: true });
    expect(lines.at(-1)?.toLowerCase() ?? "").toContain("done");
  });

  test("append-only — no carriage-returns that would break CI log capture", async () => {
    const lines: string[] = [];
    const sink = createTerminalStatusSink({ write: (s) => lines.push(s) });
    await sink.open("t", "l");
    for (let i = 0; i < 5; i++) {
      await sink.update({
        kind: "tool_use_start",
        toolUseId: `tu-${i}`,
        name: "Read",
        input: {},
        label: `Read(f${i})`,
      });
      await sink.update({ kind: "tool_use_end", toolUseId: `tu-${i}`, ok: true });
    }
    await sink.close({ ok: true });
    const joined = lines.join("");
    // No \r — terminal sink must be CI-safe (piped stderr, GitHub Actions log).
    expect(joined).not.toContain("\r");
  });

  test("text_delta chunks are not printed per-chunk (too noisy for terminal)", async () => {
    const lines: string[] = [];
    const sink = createTerminalStatusSink({ write: (s) => lines.push(s) });
    await sink.open("t", "l");
    await sink.update({ kind: "text_delta", text: "partial " });
    await sink.update({ kind: "text_delta", text: "reply" });
    const joined = lines.join("");
    // Don't want the assistant's verbatim text to pollute stderr progress.
    expect(joined).not.toContain("partial reply");
    expect(joined).not.toContain("partial ");
  });

  test("task_start line references session / model when present", async () => {
    const lines: string[] = [];
    const sink = createTerminalStatusSink({ write: (s) => lines.push(s) });
    await sink.open("t", "l");
    await sink.update({ kind: "task_start", sessionId: "sess-7", model: "opus" });
    // Presence of either signal is enough; we don't want to over-specify format.
    const joined = lines.join("");
    expect(joined).toMatch(/sess-7|opus/);
  });

  test("close() on failure writes a failure line with errorShort", async () => {
    const lines: string[] = [];
    const sink = createTerminalStatusSink({ write: (s) => lines.push(s) });
    await sink.open("t", "l");
    await sink.close({ ok: false, errorShort: "verify failed" });
    const last = lines.at(-1) ?? "";
    expect(last.toLowerCase()).toContain("fail");
    expect(last).toContain("verify failed");
  });
});

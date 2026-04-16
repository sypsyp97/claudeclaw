import { describe, expect, test } from "bun:test";
import { createRenderer } from "./render";

describe("createRenderer — running state", () => {
  test("initial render shows working header + elapsed seconds with no tools yet", () => {
    const r = createRenderer("Tweak README", 1000);
    const text = r.render(5000);
    expect(text).toContain("Hermes working");
    expect(text).toContain("4s");
  });

  test("renders one tool line after a tool_use_start", () => {
    const r = createRenderer("x", 0);
    r.apply({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: { file_path: "/foo.ts" },
      label: "Read(foo.ts)",
    });
    const text = r.render(1000);
    expect(text).toContain("Read(foo.ts)");
  });

  test("marks the in-flight tool as active", () => {
    const r = createRenderer("x", 0);
    r.apply({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: {},
      label: "Read(a.ts)",
    });
    r.apply({ kind: "tool_use_end", toolUseId: "tu-1", ok: true });
    r.apply({
      kind: "tool_use_start",
      toolUseId: "tu-2",
      name: "Edit",
      input: {},
      label: "Edit(b.ts)",
    });
    const text = r.render(1000);
    expect(text).toContain("Edit(b.ts)");
    // The last one (Edit) is active; active marker appears on that line.
    const editLine = text.split("\n").find((l) => l.includes("Edit(b.ts)")) ?? "";
    expect(editLine.toLowerCase()).toContain("active");
  });

  test("completed tool gets a success marker (no 'active')", () => {
    const r = createRenderer("x", 0);
    r.apply({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: {},
      label: "Read(a.ts)",
    });
    r.apply({ kind: "tool_use_end", toolUseId: "tu-1", ok: true });
    const text = r.render(1000);
    const readLine = text.split("\n").find((l) => l.includes("Read(a.ts)")) ?? "";
    expect(readLine.toLowerCase()).not.toContain("active");
  });

  test("failed tool is visually distinguished", () => {
    const r = createRenderer("x", 0);
    r.apply({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Bash",
      input: {},
      label: "Bash(nope)",
    });
    r.apply({ kind: "tool_use_end", toolUseId: "tu-1", ok: false, errorShort: "exit 1" });
    const text = r.render(1000);
    const bashLine = text.split("\n").find((l) => l.includes("Bash(nope)")) ?? "";
    // Accept either an X or ✗ marker; the important thing is it's not blank.
    expect(bashLine).not.toBe("");
    expect(bashLine.toLowerCase()).not.toContain("active");
  });

  test("keeps at most N visible tool lines + a collapsed summary for older", () => {
    const r = createRenderer("x", 0);
    for (let i = 0; i < 10; i++) {
      r.apply({
        kind: "tool_use_start",
        toolUseId: `tu-${i}`,
        name: "Read",
        input: {},
        label: `Read(f${i}.ts)`,
      });
      r.apply({ kind: "tool_use_end", toolUseId: `tu-${i}`, ok: true });
    }
    const text = r.render(1000);
    const toolLines = text.split("\n").filter((l) => l.includes("Read(f"));
    // Default cap should be <= 6 visible tool lines.
    expect(toolLines.length).toBeLessThanOrEqual(6);
    // Most recent tool (f9) must be visible; some older ones collapsed.
    expect(text).toContain("Read(f9.ts)");
    expect(text).toMatch(/\+\s*\d+\s+earlier/);
  });
});

describe("createRenderer — final state", () => {
  test("renderFinal with ok=true produces a success block", () => {
    const r = createRenderer("x", 0);
    r.apply({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: {},
      label: "Read(a.ts)",
    });
    r.apply({ kind: "tool_use_end", toolUseId: "tu-1", ok: true });
    const text = r.renderFinal({ ok: true }, 15000);
    expect(text.toLowerCase()).toContain("done");
    expect(text).toContain("15s");
    // Should not still say "working" or have an active-tool marker.
    expect(text).not.toContain("working");
    expect(text.toLowerCase()).not.toContain("active");
  });

  test("renderFinal with ok=false and errorShort shows failure with reason", () => {
    const r = createRenderer("x", 0);
    const text = r.renderFinal({ ok: false, errorShort: "verify failed" }, 8000);
    expect(text.toLowerCase()).toContain("fail");
    expect(text).toContain("verify failed");
  });

  test("renderFinal counts all tools that ran", () => {
    const r = createRenderer("x", 0);
    for (let i = 0; i < 3; i++) {
      r.apply({
        kind: "tool_use_start",
        toolUseId: `tu-${i}`,
        name: "Read",
        input: {},
        label: `Read(${i}.ts)`,
      });
      r.apply({ kind: "tool_use_end", toolUseId: `tu-${i}`, ok: true });
    }
    const text = r.renderFinal({ ok: true }, 5000);
    expect(text).toContain("3");
  });
});

describe("createRenderer — message width", () => {
  test("total rendered length is kept well under Discord's 2000-char limit", () => {
    const r = createRenderer("t", 0);
    for (let i = 0; i < 50; i++) {
      r.apply({
        kind: "tool_use_start",
        toolUseId: `tu-${i}`,
        name: "Bash",
        input: {},
        label: `Bash(${"x".repeat(60)})`,
      });
      r.apply({ kind: "tool_use_end", toolUseId: `tu-${i}`, ok: true });
    }
    const text = r.render(1000);
    expect(text.length).toBeLessThan(2000);
  });
});

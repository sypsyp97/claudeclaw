import { describe, expect, test } from "bun:test";
import { createDiscordStatusSink, type DiscordTransport } from "./discord";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RecordedCall {
  kind: "post" | "patch" | "delete";
  channelId: string;
  messageId?: string;
  content?: string;
}

function recorder(): { calls: RecordedCall[]; transport: DiscordTransport } {
  const calls: RecordedCall[] = [];
  let nextId = 1;
  return {
    calls,
    transport: {
      async postMessage(channelId, content) {
        const id = `msg-${nextId++}`;
        calls.push({ kind: "post", channelId, content });
        return { id };
      },
      async patchMessage(channelId, messageId, content) {
        calls.push({ kind: "patch", channelId, messageId, content });
      },
      async deleteMessage(channelId, messageId) {
        calls.push({ kind: "delete", channelId, messageId });
      },
    },
  };
}

describe("createDiscordStatusSink — lifecycle", () => {
  test("open() POSTs the initial status message to the channel", async () => {
    const { calls, transport } = recorder();
    const sink = createDiscordStatusSink({ transport, channelId: "chan-1", windowMs: 10 });
    await sink.open("t", "Tweak README");
    expect(calls).toEqual([expect.objectContaining({ kind: "post", channelId: "chan-1" })]);
    expect(calls[0]?.content).toBeDefined();
    expect(calls[0]?.content ?? "").toContain("Tweak README");
  });

  test("close() forces a final PATCH with the final summary", async () => {
    const { calls, transport } = recorder();
    const sink = createDiscordStatusSink({ transport, channelId: "c", windowMs: 10 });
    await sink.open("t", "l");
    await sink.close({ ok: true });
    const last = calls.at(-1);
    expect(last?.kind).toBe("patch");
    expect(last?.content?.toLowerCase() ?? "").toContain("done");
  });

  test("close() on failure shows the error in the final patch", async () => {
    const { calls, transport } = recorder();
    const sink = createDiscordStatusSink({ transport, channelId: "c", windowMs: 10 });
    await sink.open("t", "l");
    await sink.close({ ok: false, errorShort: "verify failed" });
    const last = calls.at(-1);
    expect(last?.kind).toBe("patch");
    expect(last?.content?.toLowerCase() ?? "").toContain("fail");
    expect(last?.content ?? "").toContain("verify failed");
  });
});

describe("createDiscordStatusSink — updates", () => {
  test("each tool_use_start eventually produces a PATCH with the tool's label", async () => {
    const { calls, transport } = recorder();
    const sink = createDiscordStatusSink({ transport, channelId: "c", windowMs: 20 });
    await sink.open("t", "l");
    await sink.update({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: { file_path: "/a.ts" },
      label: "Read(a.ts)",
    });
    await sleep(60);
    const patches = calls.filter((c) => c.kind === "patch");
    expect(patches.length).toBeGreaterThanOrEqual(1);
    expect(patches.some((p) => (p.content ?? "").includes("Read(a.ts)"))).toBe(true);
  });

  test("rapid updates within the coalesce window produce one PATCH (not many)", async () => {
    const { calls, transport } = recorder();
    const sink = createDiscordStatusSink({ transport, channelId: "c", windowMs: 40 });
    await sink.open("t", "l");
    for (let i = 0; i < 5; i++) {
      await sink.update({
        kind: "tool_use_start",
        toolUseId: `tu-${i}`,
        name: "Read",
        input: {},
        label: `Read(f${i}.ts)`,
      });
    }
    await sleep(100);
    const patchesDuringBurst = calls.filter((c) => c.kind === "patch").length;
    // Expect at most 2 patches (one coalesced trailing + possibly a second cycle).
    // The important property: FAR fewer than the 5 updates we sent.
    expect(patchesDuringBurst).toBeLessThanOrEqual(2);
  });

  test("every update is reflected in the final patch (even when coalesced)", async () => {
    const { calls, transport } = recorder();
    const sink = createDiscordStatusSink({ transport, channelId: "c", windowMs: 40 });
    await sink.open("t", "l");
    for (let i = 0; i < 3; i++) {
      await sink.update({
        kind: "tool_use_start",
        toolUseId: `tu-${i}`,
        name: "Read",
        input: {},
        label: `Read(f${i}.ts)`,
      });
    }
    await sink.close({ ok: true });
    const last = calls.at(-1);
    // The close-time final patch is the compact summary; it should mention the
    // tool count (3).
    expect(last?.content ?? "").toContain("3");
  });

  test("transport failures during update do not throw to caller", async () => {
    const transport: DiscordTransport = {
      async postMessage() {
        return { id: "msg-1" };
      },
      async patchMessage() {
        throw new Error("simulated 500");
      },
      async deleteMessage() {},
    };
    const sink = createDiscordStatusSink({ transport, channelId: "c", windowMs: 5 });
    await sink.open("t", "l");
    await sink.update({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: {},
      label: "Read(a)",
    });
    await sleep(30);
    // Close must also not throw.
    await sink.close({ ok: true });
    expect(true).toBe(true);
  });

  test("open() failure leaves the sink in a safe state (updates become no-ops)", async () => {
    const transport: DiscordTransport = {
      async postMessage() {
        throw new Error("no permission");
      },
      async patchMessage() {
        throw new Error("should not be called");
      },
      async deleteMessage() {},
    };
    const sink = createDiscordStatusSink({ transport, channelId: "c", windowMs: 5 });
    await sink.open("t", "l"); // swallows
    await sink.update({ kind: "text_delta", text: "x" });
    await sink.close({ ok: true });
    expect(true).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { createTelegramStatusSink, type TelegramTransport } from "./telegram";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RecordedCall {
  kind: "send" | "edit" | "delete";
  chatId: number;
  threadId?: number;
  messageId?: number;
  text?: string;
}

function recorder(): { calls: RecordedCall[]; transport: TelegramTransport } {
  const calls: RecordedCall[] = [];
  let nextId = 1;
  return {
    calls,
    transport: {
      async sendMessage(chatId, text, threadId) {
        const id = nextId++;
        const call: RecordedCall = { kind: "send", chatId, text };
        if (threadId !== undefined) call.threadId = threadId;
        calls.push(call);
        return { messageId: id };
      },
      async editMessageText(chatId, messageId, text) {
        calls.push({ kind: "edit", chatId, messageId, text });
      },
      async deleteMessage(chatId, messageId) {
        calls.push({ kind: "delete", chatId, messageId });
      },
    },
  };
}

describe("createTelegramStatusSink — lifecycle", () => {
  test("open() calls sendMessage with the chat + label", async () => {
    const { calls, transport } = recorder();
    const sink = createTelegramStatusSink({ transport, chatId: 42, windowMs: 10 });
    await sink.open("t", "Tweak README");
    expect(calls).toEqual([expect.objectContaining({ kind: "send", chatId: 42 })]);
    expect(calls[0]?.text ?? "").toContain("Tweak README");
  });

  test("open() forwards threadId when provided", async () => {
    const { calls, transport } = recorder();
    const sink = createTelegramStatusSink({
      transport,
      chatId: 42,
      threadId: 7,
      windowMs: 10,
    });
    await sink.open("t", "x");
    expect(calls[0]?.threadId).toBe(7);
  });

  test("close() issues a final edit with the summary", async () => {
    const { calls, transport } = recorder();
    const sink = createTelegramStatusSink({ transport, chatId: 1, windowMs: 10 });
    await sink.open("t", "l");
    await sink.close({ ok: true });
    const last = calls.at(-1);
    expect(last?.kind).toBe("edit");
    expect(last?.text?.toLowerCase() ?? "").toContain("done");
  });

  test("close() on failure shows the error in the final edit", async () => {
    const { calls, transport } = recorder();
    const sink = createTelegramStatusSink({ transport, chatId: 1, windowMs: 10 });
    await sink.open("t", "l");
    await sink.close({ ok: false, errorShort: "subagent crashed" });
    const last = calls.at(-1);
    expect(last?.kind).toBe("edit");
    expect(last?.text?.toLowerCase() ?? "").toContain("fail");
    expect(last?.text ?? "").toContain("subagent crashed");
  });
});

describe("createTelegramStatusSink — updates", () => {
  test("tool_use_start eventually produces an edit with the label", async () => {
    const { calls, transport } = recorder();
    const sink = createTelegramStatusSink({ transport, chatId: 1, windowMs: 20 });
    await sink.open("t", "l");
    await sink.update({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Bash",
      input: { command: "ls" },
      label: "Bash(ls)",
    });
    await sleep(60);
    const edits = calls.filter((c) => c.kind === "edit");
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.some((e) => (e.text ?? "").includes("Bash(ls)"))).toBe(true);
  });

  test("rapid updates coalesce (rate-limit safety)", async () => {
    const { calls, transport } = recorder();
    const sink = createTelegramStatusSink({ transport, chatId: 1, windowMs: 40 });
    await sink.open("t", "l");
    for (let i = 0; i < 6; i++) {
      await sink.update({
        kind: "tool_use_start",
        toolUseId: `tu-${i}`,
        name: "Read",
        input: {},
        label: `Read(f${i})`,
      });
    }
    await sleep(80);
    const edits = calls.filter((c) => c.kind === "edit").length;
    expect(edits).toBeLessThanOrEqual(2);
  });

  test("transport failures are swallowed — callers never see the rejection", async () => {
    const transport: TelegramTransport = {
      async sendMessage() {
        return { messageId: 1 };
      },
      async editMessageText() {
        throw new Error("429 too many requests");
      },
      async deleteMessage() {},
    };
    const sink = createTelegramStatusSink({ transport, chatId: 1, windowMs: 5 });
    await sink.open("t", "l");
    await sink.update({
      kind: "tool_use_start",
      toolUseId: "tu-1",
      name: "Read",
      input: {},
      label: "Read(x)",
    });
    await sleep(30);
    await sink.close({ ok: true });
    expect(true).toBe(true);
  });

  test("open() failure makes subsequent updates/close no-ops (no crash)", async () => {
    const transport: TelegramTransport = {
      async sendMessage() {
        throw new Error("unauthorized");
      },
      async editMessageText() {
        throw new Error("should not be called");
      },
      async deleteMessage() {},
    };
    const sink = createTelegramStatusSink({ transport, chatId: 1, windowMs: 5 });
    await sink.open("t", "l");
    await sink.update({ kind: "text_delta", text: "x" });
    await sink.close({ ok: true });
    expect(true).toBe(true);
  });
});

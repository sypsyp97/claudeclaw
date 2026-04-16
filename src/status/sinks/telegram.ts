/**
 * Telegram status sink. Mirrors the Discord sink but uses
 * sendMessage/editMessageText against the Bot API. One status message per
 * task lifetime, edited in place through a coalescer to stay under
 * Telegram's ~1 edit/sec per chat rate limit.
 */

import { createCoalescer, type Coalescer } from "../coalesce";
import { createRenderer, type Renderer } from "../render";
import type { CloseResult, StatusSink } from "../sink";
import type { StatusEvent } from "../stream";

export interface TelegramTransport {
  sendMessage(chatId: number, text: string, threadId?: number): Promise<{ messageId: number }>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
}

export interface TelegramStatusSinkOptions {
  transport: TelegramTransport;
  chatId: number;
  threadId?: number;
  windowMs?: number;
}

export function createTelegramStatusSink(opts: TelegramStatusSinkOptions): StatusSink {
  const { transport, chatId, threadId } = opts;
  let renderer: Renderer | null = null;
  let messageId: number | null = null;
  let coalescer: Coalescer | null = null;

  async function sendEdit(): Promise<void> {
    if (messageId === null || !renderer) return;
    const content = renderer.render();
    try {
      await transport.editMessageText(chatId, messageId, content);
    } catch {
      // swallow
    }
  }

  return {
    async open(_taskId, label) {
      renderer = createRenderer(label);
      coalescer = createCoalescer(sendEdit, { windowMs: opts.windowMs });
      const initial = renderer.render();
      try {
        const result = await transport.sendMessage(chatId, initial, threadId);
        messageId = result.messageId;
      } catch {
        messageId = null;
      }
    },

    async update(event: StatusEvent) {
      if (!renderer || messageId === null || !coalescer) return;
      renderer.apply(event);
      coalescer.schedule();
    },

    async close(result: CloseResult) {
      if (coalescer) coalescer.dispose();
      if (!renderer || messageId === null) return;
      const finalContent = renderer.renderFinal(result);
      try {
        await transport.editMessageText(chatId, messageId, finalContent);
      } catch {
        // swallow
      }
    },
  };
}

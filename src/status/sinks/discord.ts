/**
 * Discord status sink. Posts a single "status message" into the target
 * channel on open(), edits it in place on each update(), and collapses it
 * to a compact final summary on close().
 *
 * The transport is passed in so production wiring can hand it the existing
 * `discordApi` helper while tests inject a recorder. Any transport error is
 * swallowed — status rendering is never critical-path.
 */

import { createCoalescer, type Coalescer } from "../coalesce";
import { createRenderer, type Renderer } from "../render";
import type { CloseResult, StatusSink } from "../sink";
import type { StatusEvent } from "../stream";

export interface DiscordTransport {
  postMessage(channelId: string, content: string): Promise<{ id: string }>;
  patchMessage(channelId: string, messageId: string, content: string): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
}

export interface DiscordStatusSinkOptions {
  transport: DiscordTransport;
  channelId: string;
  windowMs?: number;
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 2000;

export function createDiscordStatusSink(opts: DiscordStatusSinkOptions): StatusSink {
  const { transport, channelId } = opts;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let renderer: Renderer | null = null;
  let messageId: string | null = null;
  let coalescer: Coalescer | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  async function sendPatch(): Promise<void> {
    if (!messageId || !renderer) return;
    const content = renderer.render();
    try {
      await transport.patchMessage(channelId, messageId, content);
    } catch {
      // swallow — status display is best-effort
    }
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(): void {
    if (heartbeatMs <= 0) return;
    if (heartbeatTimer !== null) return;
    const timer = setInterval(() => {
      // Fire-and-forget; sendPatch swallows its own errors, but guard the
      // synchronous portion too so a throw can't escape the timer callback.
      void sendPatch().catch(() => {});
    }, heartbeatMs);
    const maybeUnref = (timer as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") {
      maybeUnref.call(timer);
    }
    heartbeatTimer = timer;
  }

  return {
    async open(_taskId, label) {
      renderer = createRenderer(label);
      coalescer = createCoalescer(sendPatch, { windowMs: opts.windowMs });
      const initial = renderer.render();
      try {
        const result = await transport.postMessage(channelId, initial);
        messageId = result.id;
      } catch {
        messageId = null;
      }
      if (messageId) {
        startHeartbeat();
      }
    },

    async update(event: StatusEvent) {
      if (!renderer || !messageId || !coalescer) return;
      renderer.apply(event);
      coalescer.schedule();
    },

    async close(result: CloseResult) {
      stopHeartbeat();
      if (coalescer) coalescer.dispose();
      if (!renderer || !messageId) return;
      const finalContent = renderer.renderFinal(result);
      try {
        await transport.patchMessage(channelId, messageId, finalContent);
      } catch {
        // swallow
      }
    },
  };
}

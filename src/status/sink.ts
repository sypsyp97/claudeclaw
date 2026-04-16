/**
 * StatusSink — the surface that renders live tool-call progress somewhere the
 * user can see (Discord message, Telegram message, terminal stderr).
 *
 * Lifecycle: open(taskId, label) → update(event)* → close(result).
 * All methods are async so implementations can await network calls.
 */

import type { StatusEvent } from "./stream";

export interface CloseResult {
  ok: boolean;
  finalText?: string;
  errorShort?: string;
}

export interface StatusSink {
  open(taskId: string, label: string): Promise<void>;
  update(event: StatusEvent): Promise<void>;
  close(result: CloseResult): Promise<void>;
}

export const nullSink: StatusSink = {
  async open() {},
  async update() {},
  async close() {},
};

export type FakeSinkCall =
  | { kind: "open"; taskId: string; label: string }
  | { kind: "update"; event: StatusEvent }
  | { kind: "close"; result: CloseResult };

export interface FakeSink extends StatusSink {
  calls: FakeSinkCall[];
  events(): StatusEvent[];
}

export function createFakeSink(): FakeSink {
  const calls: FakeSinkCall[] = [];
  return {
    calls,
    async open(taskId, label) {
      calls.push({ kind: "open", taskId, label });
    },
    async update(event) {
      calls.push({ kind: "update", event });
    },
    async close(result) {
      calls.push({ kind: "close", result });
    },
    events() {
      return calls.filter((c) => c.kind === "update").map((c) => (c as { event: StatusEvent }).event);
    },
  };
}

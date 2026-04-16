/**
 * Terminal status sink — append-only progress lines written via a caller-
 * supplied writer (default: process.stderr). Used by scripts/evolve.ts and
 * any other CLI-driven path so the terminal shows live tool activity
 * without editing stdout (which may be captured/parsed by callers).
 *
 * Design choice: append-only, not carriage-return overwrite. stderr gets
 * piped, logged to GitHub Actions summaries, and redirected to files; \r
 * tricks break all three. The cost is a little more vertical output; the
 * benefit is log-capture stability.
 */

import type { CloseResult, StatusSink } from "../sink";
import type { StatusEvent } from "../stream";

type WriteFn = (line: string) => void;

export interface TerminalStatusSinkOptions {
  write?: WriteFn;
}

export function createTerminalStatusSink(opts: TerminalStatusSinkOptions = {}): StatusSink {
  const write: WriteFn = opts.write ?? ((line: string) => process.stderr.write(line));
  const startedAt = Date.now();
  let taskLabel = "";
  let toolCount = 0;

  function ts(): string {
    return new Date().toISOString().slice(11, 19);
  }

  function icon(name: string): string {
    switch (name) {
      case "Read":
      case "NotebookRead":
        return "📖";
      case "Edit":
      case "NotebookEdit":
        return "✏️";
      case "Write":
        return "📝";
      case "Bash":
        return "🖥️";
      case "Grep":
        return "🔎";
      case "Glob":
        return "🗂️";
      case "WebFetch":
        return "🌐";
      case "WebSearch":
        return "🔍";
      case "Task":
      case "Agent":
        return "🧵";
      default:
        return "⚡";
    }
  }

  function handleEvent(event: StatusEvent): void {
    switch (event.kind) {
      case "task_start": {
        const bits: string[] = [];
        if (event.sessionId) bits.push(event.sessionId);
        if (event.model) bits.push(event.model);
        write(`[${ts()}] ⏳ start${bits.length ? ` (${bits.join(", ")})` : ""}\n`);
        return;
      }
      case "tool_use_start": {
        toolCount++;
        write(`[${ts()}] ${icon(event.name)} ${event.label}\n`);
        return;
      }
      case "tool_use_end": {
        if (!event.ok) {
          const err = event.errorShort ? ` — ${event.errorShort}` : "";
          write(`[${ts()}]   ✗ tool failed${err}\n`);
        }
        return;
      }
      case "task_complete":
      case "text_delta":
        // no-op: final text belongs to stdout in terminal callers, not the
        // status stream; and per-delta chunks would flood stderr.
        return;
      case "error":
        write(`[${ts()}] ❌ ${event.message}\n`);
        return;
    }
  }

  return {
    async open(_taskId: string, label: string) {
      taskLabel = label;
      write(`[${ts()}] ⏳ ${label}\n`);
    },
    async update(event: StatusEvent) {
      handleEvent(event);
    },
    async close(result: CloseResult) {
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      if (result.ok) {
        write(`[${ts()}] ✅ Done — ${toolCount} tool${toolCount === 1 ? "" : "s"}, ${elapsed}s (${taskLabel})\n`);
      } else {
        const reason = result.errorShort ? ` ${result.errorShort}` : "";
        write(`[${ts()}] ❌ Failed —${reason} (${elapsed}s, ${taskLabel})\n`);
      }
    },
  };
}

/**
 * Canonical text renderer for the status block.
 *
 * Given a stream of StatusEvents, maintains a ring buffer of recent tool
 * invocations and produces a plain-text block that sinks can post or edit
 * into a single chat message. All sinks share this renderer so the layout
 * is consistent across Discord, Telegram, and terminal.
 *
 * Output shape (while running):
 *
 *   ⏳ Hermes working… (12s)
 *   📖 Read(foo.ts) ✓
 *   ✏️ Edit(bar.ts) ✓
 *   🖥️ Bash(bun test) ← active
 *
 * With >6 tools, the oldest collapse to `… +N earlier tools`.
 *
 * Final shape:
 *
 *   ✅ Done — 3 tools, 18s
 *   ❌ Failed — verify failed (18s)
 */

import type { CloseResult } from "./sink";
import type { StatusEvent } from "./stream";

const MAX_VISIBLE_TOOLS = 6;

type ToolState = "running" | "ok" | "error";

interface ToolEntry {
  id: string;
  label: string;
  name: string;
  state: ToolState;
  errorShort?: string;
}

export interface Renderer {
  apply(event: StatusEvent): void;
  render(now?: number): string;
  renderFinal(result: CloseResult, now?: number): string;
  toolCount(): number;
}

export function createRenderer(taskLabel: string, startedAt?: number): Renderer {
  const start = startedAt ?? Date.now();
  const tools: ToolEntry[] = [];
  let totalTools = 0;

  function apply(event: StatusEvent): void {
    if (event.kind === "tool_use_start") {
      tools.push({ id: event.toolUseId, label: event.label, name: event.name, state: "running" });
      totalTools++;
    } else if (event.kind === "tool_use_end") {
      const entry = tools.find((t) => t.id === event.toolUseId);
      if (entry) {
        entry.state = event.ok ? "ok" : "error";
        if (!event.ok) entry.errorShort = event.errorShort;
      }
    }
  }

  function elapsedSeconds(now?: number): number {
    return Math.max(0, Math.floor(((now ?? Date.now()) - start) / 1000));
  }

  function render(now?: number): string {
    const secs = elapsedSeconds(now);
    const lines: string[] = [`⏳ Hermes working… (${secs}s) — ${taskLabel}`];
    const hiddenCount = Math.max(0, tools.length - MAX_VISIBLE_TOOLS);
    if (hiddenCount > 0) {
      lines.push(`… +${hiddenCount} earlier tool${hiddenCount === 1 ? "" : "s"}`);
    }
    const visible = tools.slice(-MAX_VISIBLE_TOOLS);
    for (const t of visible) {
      lines.push(formatLine(t));
    }
    return lines.join("\n");
  }

  function renderFinal(result: CloseResult, now?: number): string {
    const secs = elapsedSeconds(now);
    if (result.ok) {
      return `✅ Done — ${totalTools} tool${totalTools === 1 ? "" : "s"}, ${secs}s`;
    }
    const reason = result.errorShort ? ` ${result.errorShort}` : "";
    return `❌ Failed —${reason} (${secs}s)`;
  }

  return {
    apply,
    render,
    renderFinal,
    toolCount: () => totalTools,
  };
}

function formatLine(t: ToolEntry): string {
  const icon = toolIcon(t.name);
  if (t.state === "running") return `${icon} ${t.label} ← active`;
  if (t.state === "ok") return `${icon} ${t.label} ✓`;
  return `${icon} ${t.label} ✗${t.errorShort ? ` ${t.errorShort}` : ""}`;
}

function toolIcon(name: string): string {
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

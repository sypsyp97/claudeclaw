/**
 * Parse Claude CLI `--output-format stream-json --verbose` output into a
 * stream of high-level StatusEvents.
 *
 * The CLI emits one JSON envelope per line (NDJSON). We translate envelopes
 * into UI-friendly events a sink can render:
 *
 *   system.init                   → task_start
 *   assistant.message.content[]   → text_delta + tool_use_start (preserves block order)
 *   user.message.content[]        → tool_use_end (matched by tool_use_id)
 *   result success                → task_complete
 *   result error                  → error
 *
 * Chunks arriving without a trailing newline are buffered until the next
 * chunk delivers one (or `flush()` is called at the end of the stream).
 * Malformed or unknown lines are silently skipped so one bad line doesn't
 * poison the whole stream.
 */

import { basename } from "node:path";

export type StatusEvent =
  | { kind: "task_start"; sessionId?: string; model?: string }
  | { kind: "tool_use_start"; toolUseId: string; name: string; input: unknown; label: string }
  | { kind: "tool_use_end"; toolUseId: string; ok: boolean; errorShort?: string }
  | { kind: "text_delta"; text: string }
  | { kind: "task_complete"; result: string; numTurns?: number; sessionId?: string }
  | { kind: "error"; message: string };

export interface StreamParser {
  push(chunk: string): StatusEvent[];
  flush(): StatusEvent[];
}

export function createStreamParser(): StreamParser {
  let buffer = "";

  return {
    push(chunk: string): StatusEvent[] {
      buffer += chunk;
      const out: StatusEvent[] = [];
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        out.push(...translateLine(line));
        nl = buffer.indexOf("\n");
      }
      return out;
    },
    flush(): StatusEvent[] {
      if (!buffer) return [];
      const out = translateLine(buffer);
      buffer = "";
      return out;
    },
  };
}

function translateLine(raw: string): StatusEvent[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const type = parsed.type;

  if (type === "system" && parsed.subtype === "init") {
    return [
      {
        kind: "task_start",
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
      },
    ];
  }

  if (type === "assistant" && isObject(parsed.message)) {
    const content = (parsed.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const events: StatusEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        events.push({ kind: "text_delta", text: block.text });
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        events.push({
          kind: "tool_use_start",
          toolUseId: block.id,
          name: block.name,
          input: block.input ?? {},
          label: formatToolLabel(block.name, block.input),
        });
      }
    }
    return events;
  }

  if (type === "user" && isObject(parsed.message)) {
    const content = (parsed.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const events: StatusEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const ok = block.is_error !== true;
        const event: Extract<StatusEvent, { kind: "tool_use_end" }> = {
          kind: "tool_use_end",
          toolUseId: block.tool_use_id,
          ok,
        };
        if (!ok) {
          event.errorShort = shortenError(block.content);
        }
        events.push(event);
      }
    }
    return events;
  }

  if (type === "result") {
    const resultText = typeof parsed.result === "string" ? parsed.result : "";
    if (parsed.subtype === "error") {
      return [{ kind: "error", message: resultText || "unknown error" }];
    }
    const event: Extract<StatusEvent, { kind: "task_complete" }> = {
      kind: "task_complete",
      result: resultText,
    };
    if (typeof parsed.num_turns === "number") event.numTurns = parsed.num_turns;
    if (typeof parsed.session_id === "string") event.sessionId = parsed.session_id;
    return [event];
  }

  return [];
}

export function formatToolLabel(name: string, input: unknown): string {
  if (!isObject(input)) return name;
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const fp = input.file_path;
      if (typeof fp !== "string" || !fp) return name;
      return `${name}(${basenameAny(fp)})`;
    }
    case "Bash": {
      const cmd = input.command;
      if (typeof cmd !== "string" || !cmd) return name;
      const truncated = cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd;
      return `${name}(${truncated})`;
    }
    case "Grep":
    case "Glob": {
      const pat = input.pattern;
      if (typeof pat !== "string" || !pat) return name;
      return `${name}(${pat})`;
    }
    case "WebFetch": {
      const url = input.url;
      if (typeof url !== "string" || !url) return name;
      try {
        return `${name}(${new URL(url).hostname})`;
      } catch {
        return name;
      }
    }
    case "WebSearch": {
      const q = input.query;
      if (typeof q !== "string" || !q) return name;
      return `${name}(${q})`;
    }
    case "Task": {
      const d = input.description ?? input.subagent_type;
      if (typeof d !== "string" || !d) return name;
      const truncated = d.length > 50 ? `${d.slice(0, 50)}…` : d;
      return `${name}(${truncated})`;
    }
    default:
      return name;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function basenameAny(fp: string): string {
  // basename() only handles the platform-native separator; we normalise both.
  const lastSlash = Math.max(fp.lastIndexOf("/"), fp.lastIndexOf("\\"));
  return lastSlash >= 0 ? fp.slice(lastSlash + 1) : basename(fp);
}

function shortenError(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 200);
  try {
    return JSON.stringify(content).slice(0, 200);
  } catch {
    return "error";
  }
}

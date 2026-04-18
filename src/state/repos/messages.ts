/**
 * Messages repo — append-only per-session transcript plus FTS5 index.
 * Search is scope-aware: the session → scope/source join happens here so
 * callers pass plain filter objects instead of doing JOINs themselves.
 */

import { heuristicImportance } from "../../memory/scoring";
import type { Database } from "../db";

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface MessageRow {
  id: number;
  session_id: number;
  ts: string;
  role: MessageRole;
  content: string;
  tool_calls_json: string | null;
  attachments_json: string | null;
}

export interface NewMessage {
  sessionId: number;
  ts?: string;
  role: MessageRole;
  content: string;
  toolCalls?: unknown;
  attachments?: unknown;
  importance?: number;
}

export function appendMessage(db: Database, input: NewMessage): number {
  const ts = input.ts ?? new Date().toISOString();
  const importance = input.importance ?? heuristicImportance(input.role, input.content);
  const result = db
    .prepare(
      `INSERT INTO messages (session_id, ts, role, content, tool_calls_json, attachments_json, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sessionId,
      ts,
      input.role,
      input.content,
      input.toolCalls === undefined ? null : JSON.stringify(input.toolCalls),
      input.attachments === undefined ? null : JSON.stringify(input.attachments),
      importance
    );
  return Number(result.lastInsertRowid);
}

export function listForSession(db: Database, sessionId: number, limit = 200): MessageRow[] {
  return db
    .query<MessageRow, [number, number]>(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY ts ASC LIMIT ?"
    )
    .all(sessionId, limit);
}

export interface SearchFilter {
  scope?: string;
  source?: string;
  limit?: number;
}

export interface SearchHit {
  messageId: number;
  sessionId: number;
  sessionKey: string;
  ts: string;
  role: MessageRole;
  snippet: string;
}

export function search(db: Database, query: string, filter: SearchFilter = {}): SearchHit[] {
  const limit = filter.limit ?? 20;
  const clauses: string[] = ["messages_fts MATCH ?"];
  const params: (string | number)[] = [query];
  if (filter.scope) {
    clauses.push("sessions.scope = ?");
    params.push(filter.scope);
  }
  if (filter.source) {
    clauses.push("sessions.source = ?");
    params.push(filter.source);
  }
  params.push(limit);

  const sql = `
    SELECT messages.id AS messageId,
           messages.session_id AS sessionId,
           sessions.key AS sessionKey,
           messages.ts AS ts,
           messages.role AS role,
           snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet
    FROM messages_fts
    JOIN messages ON messages.id = messages_fts.rowid
    JOIN sessions ON sessions.id = messages.session_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY messages.ts DESC
    LIMIT ?`;
  return db.query<SearchHit, typeof params>(sql).all(...params);
}

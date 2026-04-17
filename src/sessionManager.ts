/**
 * Per-thread Claude session state. SQLite-backed, keyed by the router
 * contract `thread:<source>:<threadId>` so every entry matches the
 * `workspace-scoped` counterparts in `sessions.ts` and the live router.
 *
 * Every write-side function takes `source` explicitly: thread IDs alone
 * are not globally unique (a Discord channel ID and a Telegram chat ID
 * can collide in principle), and the router's key contract already
 * forces callers to choose a source. Hiding that behind a default would
 * re-open the pre-refactor split-brain bug.
 *
 * `listThreadSessions()` returns every per-thread row because its only
 * caller (the Discord `/status` path) wants the global view.
 */

import { readFile, unlink, writeFile } from "fs/promises";
import { threadSessionsFile } from "./paths";
import { threadKey } from "./router/session-key";
import { getSharedDb } from "./state/shared-db";
import {
  bumpTurn,
  deleteByKey,
  getByKey,
  listByScope,
  markCompactWarned as repoMarkCompactWarned,
  replaceSession,
  touchLastUsed,
} from "./state/repos/sessions";
import type { SessionRow } from "./state/repos/sessions";

export type ThreadSource = "discord" | "telegram" | "cli";

export interface ThreadSession {
  sessionId: string;
  threadId: string;
  source: ThreadSource;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
}

function rowToThreadSession(row: SessionRow): ThreadSession | null {
  if (!row.claude_session_id || !row.thread) return null;
  return {
    sessionId: row.claude_session_id,
    threadId: row.thread,
    source: (row.source as ThreadSource) ?? "cli",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    turnCount: row.turn_count,
    compactWarned: row.compact_warned !== 0,
  };
}

/** Get session for a thread. Returns null if no session exists yet. */
export async function getThreadSession(
  source: ThreadSource,
  threadId: string,
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const db = await getSharedDb();
  const row = getByKey(db, threadKey(source, threadId));
  if (!row || !row.claude_session_id) return null;
  touchLastUsed(db, row.id);
  return {
    sessionId: row.claude_session_id,
    turnCount: row.turn_count,
    compactWarned: row.compact_warned !== 0,
  };
}

/** Create a new thread session after Claude outputs a session_id. */
export async function createThreadSession(
  source: ThreadSource,
  threadId: string,
  sessionId: string,
): Promise<void> {
  const db = await getSharedDb();
  const cwd = process.cwd();
  replaceSession(db, {
    key: threadKey(source, threadId),
    scope: "per-thread",
    source,
    workspace: cwd,
    thread: threadId,
    claudeSessionId: sessionId,
  });
}

/** Remove a thread session (e.g., on thread delete/archive). */
export async function removeThreadSession(source: ThreadSource, threadId: string): Promise<void> {
  const db = await getSharedDb();
  deleteByKey(db, threadKey(source, threadId));
  // Also strip the entry from the legacy `sessions.json`. Otherwise the
  // importer that runs on every fresh shared-db open would re-insert the
  // just-deleted thread on the next daemon restart. The legacy file can't
  // encode `source`, so we drop by bare threadId — which matches how the
  // importer reads it anyway.
  await forgetLegacyThread(threadId);
}

async function forgetLegacyThread(threadId: string): Promise<void> {
  const path = threadSessionsFile();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return; // no legacy file, nothing to rewrite
  }
  let parsed: { threads?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // malformed — leave alone, next boot's importer will swallow it too
  }
  if (!parsed || typeof parsed !== "object" || !parsed.threads || typeof parsed.threads !== "object") {
    return;
  }
  if (!(threadId in parsed.threads)) return;
  delete parsed.threads[threadId];
  try {
    if (Object.keys(parsed.threads).length === 0) {
      await unlink(path);
    } else {
      await writeFile(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    }
  } catch {
    // best-effort; if we can't rewrite, the next import will still try to
    // resurrect, but the SQLite delete we already did stands for this session.
  }
}

/** Increment turn counter for a thread session. */
export async function incrementThreadTurn(source: ThreadSource, threadId: string): Promise<number> {
  const db = await getSharedDb();
  const row = getByKey(db, threadKey(source, threadId));
  if (!row) return 0;
  bumpTurn(db, row.id);
  return row.turn_count + 1;
}

/** Mark compact warning sent for a thread session. */
export async function markThreadCompactWarned(source: ThreadSource, threadId: string): Promise<void> {
  const db = await getSharedDb();
  const row = getByKey(db, threadKey(source, threadId));
  if (!row) return;
  repoMarkCompactWarned(db, row.id);
}

/** List all active thread sessions across every source. */
export async function listThreadSessions(): Promise<ThreadSession[]> {
  const db = await getSharedDb();
  const rows = listByScope(db, "per-thread");
  const out: ThreadSession[] = [];
  for (const row of rows) {
    const mapped = rowToThreadSession(row);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Peek at a thread session without updating lastUsedAt. */
export async function peekThreadSession(
  source: ThreadSource,
  threadId: string,
): Promise<ThreadSession | null> {
  const db = await getSharedDb();
  const row = getByKey(db, threadKey(source, threadId));
  if (!row) return null;
  return rowToThreadSession(row);
}

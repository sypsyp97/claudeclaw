/**
 * Workspace-scoped Claude session state. Single source of truth is the
 * SQLite `sessions` table keyed by `workspace:<hash>`; legacy JSON files
 * under `.claude/hermes/` are read-only migration input, produced once by
 * `importLegacyJson` and never written again.
 *
 * Public API is preserved so runner.ts / commands/clear.ts did not have
 * to change. `backupSession` still writes a `session_N.backup` JSON file
 * under `.claude/hermes/` because it is a user-facing artifact (people
 * restore from it by hand); the row is deleted from the DB afterwards.
 */

import { readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { workspaceKey } from "./router/session-key";
import { hermesDir, sessionFile } from "./paths";
import { getSharedDb } from "./state/shared-db";
import {
  bumpTurn,
  deleteByKey,
  getByKey,
  markCompactWarned as repoMarkCompactWarned,
  replaceSession,
  touchLastUsed,
} from "./state/repos/sessions";

export interface GlobalSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
}

function currentKey(): string {
  return workspaceKey(process.cwd());
}

async function findCurrent(): Promise<GlobalSession | null> {
  const db = await getSharedDb();
  const row = getByKey(db, currentKey());
  if (!row || !row.claude_session_id) return null;
  return {
    sessionId: row.claude_session_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    turnCount: row.turn_count,
    compactWarned: row.compact_warned !== 0,
  };
}

/** Returns the existing session or null. Bumps `lastUsedAt` as a side effect. */
export async function getSession(): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const db = await getSharedDb();
  const row = getByKey(db, currentKey());
  if (!row || !row.claude_session_id) return null;
  touchLastUsed(db, row.id);
  return {
    sessionId: row.claude_session_id,
    turnCount: row.turn_count,
    compactWarned: row.compact_warned !== 0,
  };
}

/** Save a session ID obtained from Claude Code's output. Resets turn/compact counters. */
export async function createSession(sessionId: string): Promise<void> {
  const db = await getSharedDb();
  const cwd = process.cwd();
  replaceSession(db, {
    key: workspaceKey(cwd),
    scope: "workspace",
    source: "cli",
    workspace: cwd,
    claudeSessionId: sessionId,
  });
}

/** Returns session metadata without mutating lastUsedAt. */
export async function peekSession(): Promise<GlobalSession | null> {
  return await findCurrent();
}

/** Increment the turn counter after a successful Claude invocation. */
export async function incrementTurn(): Promise<number> {
  const db = await getSharedDb();
  const row = getByKey(db, currentKey());
  if (!row) return 0;
  bumpTurn(db, row.id);
  return row.turn_count + 1;
}

/** Mark that the compact warning has been sent for the current session. */
export async function markCompactWarned(): Promise<void> {
  const db = await getSharedDb();
  const row = getByKey(db, currentKey());
  if (!row) return;
  repoMarkCompactWarned(db, row.id);
}

export async function resetSession(): Promise<void> {
  const db = await getSharedDb();
  deleteByKey(db, currentKey());
  // Legacy session.json is imported into SQLite on first shared-db open.
  // After a reset the user expects an empty slate, so drop the legacy
  // file too — otherwise the next boot re-imports it and "reset" looks
  // like it did nothing.
  await unlink(sessionFile()).catch(() => {});
}

export async function backupSession(): Promise<string | null> {
  const existing = await findCurrent();
  if (!existing) return null;

  let files: string[];
  try {
    files = await readdir(hermesDir());
  } catch {
    files = [];
  }
  const indices = files
    .filter((f) => /^session_\d+\.backup$/.test(f))
    .map((f) => Number(f.match(/^session_(\d+)\.backup$/)![1]));
  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

  const backupName = `session_${nextIndex}.backup`;
  const backupPath = join(hermesDir(), backupName);
  await writeFile(backupPath, JSON.stringify(existing, null, 2) + "\n", "utf8");

  const db = await getSharedDb();
  deleteByKey(db, currentKey());
  // Legacy session.json, if present, has already been imported into
  // SQLite on shared-db open. After backup the row is gone and we also
  // remove the legacy file — otherwise the next boot re-imports stale
  // state and the backup appears to have been ignored.
  await unlink(sessionFile()).catch(() => {});

  return backupName;
}

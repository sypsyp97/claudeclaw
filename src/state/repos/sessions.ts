/**
 * Sessions repo — one row per logical conversation.
 * `key` is the router-assigned sessionKey; unique per workspace.
 */

import type { Database } from "../db";

export interface SessionRow {
  id: number;
  key: string;
  scope: string;
  source: string;
  workspace: string;
  guild: string | null;
  channel: string | null;
  thread: string | null;
  user: string | null;
  claude_session_id: string | null;
  created_at: string;
  last_used_at: string;
  turn_count: number;
  compact_warned: number;
}

export interface NewSession {
  key: string;
  scope: string;
  source: string;
  workspace: string;
  guild?: string | null;
  channel?: string | null;
  thread?: string | null;
  user?: string | null;
  claudeSessionId?: string | null;
}

/**
 * Replace an entire session row. Unlike `upsertSession`, this resets
 * `turn_count` / `compact_warned` and refreshes `created_at` — used when
 * the caller is starting a fresh Claude session (not just bumping the
 * lastUsedAt heartbeat on an existing one).
 */
export function replaceSession(db: Database, input: NewSession): SessionRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (key, scope, source, workspace, guild, channel, thread, user, claude_session_id, created_at, last_used_at, turn_count, compact_warned)
     VALUES ($key, $scope, $source, $workspace, $guild, $channel, $thread, $user, $claude, $now, $now, 0, 0)
     ON CONFLICT(key) DO UPDATE SET
       scope = $scope,
       source = $source,
       workspace = $workspace,
       guild = $guild,
       channel = $channel,
       thread = $thread,
       user = $user,
       claude_session_id = $claude,
       created_at = $now,
       last_used_at = $now,
       turn_count = 0,
       compact_warned = 0`
  ).run({
    $key: input.key,
    $scope: input.scope,
    $source: input.source,
    $workspace: input.workspace,
    $guild: input.guild ?? null,
    $channel: input.channel ?? null,
    $thread: input.thread ?? null,
    $user: input.user ?? null,
    $claude: input.claudeSessionId ?? null,
    $now: now,
  });
  return getByKey(db, input.key)!;
}

export function touchLastUsed(db: Database, id: number): void {
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function listByScope(db: Database, scope: string): SessionRow[] {
  return db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE scope = ? ORDER BY last_used_at DESC")
    .all(scope);
}

export function upsertSession(db: Database, input: NewSession): SessionRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (key, scope, source, workspace, guild, channel, thread, user, claude_session_id, created_at, last_used_at)
     VALUES ($key, $scope, $source, $workspace, $guild, $channel, $thread, $user, $claude, $now, $now)
     ON CONFLICT(key) DO UPDATE SET last_used_at = $now`
  ).run({
    $key: input.key,
    $scope: input.scope,
    $source: input.source,
    $workspace: input.workspace,
    $guild: input.guild ?? null,
    $channel: input.channel ?? null,
    $thread: input.thread ?? null,
    $user: input.user ?? null,
    $claude: input.claudeSessionId ?? null,
    $now: now,
  });
  return getByKey(db, input.key)!;
}

export function getByKey(db: Database, key: string): SessionRow | null {
  return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE key = ?").get(key) ?? null;
}

export function getById(db: Database, id: number): SessionRow | null {
  return db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE id = ?").get(id) ?? null;
}

export function listRecent(db: Database, limit = 50): SessionRow[] {
  return db
    .query<SessionRow, [number]>("SELECT * FROM sessions ORDER BY last_used_at DESC LIMIT ?")
    .all(limit);
}

export function bumpTurn(db: Database, id: number): void {
  db.prepare("UPDATE sessions SET turn_count = turn_count + 1, last_used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
}

export function setClaudeSessionId(db: Database, id: number, claudeSessionId: string): void {
  db.prepare("UPDATE sessions SET claude_session_id = ?, last_used_at = ? WHERE id = ?").run(
    claudeSessionId,
    new Date().toISOString(),
    id
  );
}

export function markCompactWarned(db: Database, id: number): void {
  db.prepare("UPDATE sessions SET compact_warned = 1 WHERE id = ?").run(id);
}

export function deleteByKey(db: Database, key: string): boolean {
  const result = db.prepare("DELETE FROM sessions WHERE key = ?").run(key);
  return result.changes > 0;
}

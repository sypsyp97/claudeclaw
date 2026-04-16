/**
 * Skill-run telemetry. Phase 6's evaluator appends one row per shadow/active
 * invocation; the promoter reads aggregates to decide promote/demote.
 */

import type { Database } from "../db";

export interface SkillRunRow {
  id: number;
  skill_name: string;
  version: number;
  session_id: number | null;
  started_at: string;
  ended_at: string | null;
  success: number | null;
  turns_saved: number | null;
  tools_used_json: string | null;
  user_feedback: string | null;
}

export interface NewSkillRun {
  skillName: string;
  version: number;
  sessionId?: number | null;
  toolsUsed?: unknown;
}

export function startRun(db: Database, input: NewSkillRun): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO skill_runs (skill_name, version, session_id, started_at, tools_used_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.skillName,
      input.version,
      input.sessionId ?? null,
      now,
      input.toolsUsed === undefined ? null : JSON.stringify(input.toolsUsed)
    );
  return Number(result.lastInsertRowid);
}

export interface FinishRun {
  id: number;
  success: boolean;
  turnsSaved?: number;
  userFeedback?: string;
}

export function finishRun(db: Database, input: FinishRun): void {
  db.prepare(
    `UPDATE skill_runs SET ended_at = ?, success = ?, turns_saved = ?, user_feedback = ?
     WHERE id = ?`
  ).run(
    new Date().toISOString(),
    input.success ? 1 : 0,
    input.turnsSaved ?? null,
    input.userFeedback ?? null,
    input.id
  );
}

export interface RunStats {
  runs: number;
  hits: number;
  successes: number;
  avgTurnsSaved: number;
}

export function statsFor(db: Database, skillName: string, windowDays: number): RunStats {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const row = db
    .query<
      { runs: number; hits: number; successes: number; avg_turns_saved: number | null },
      [string, string]
    >(
      `SELECT COUNT(*) AS runs,
              COUNT(ended_at) AS hits,
              COALESCE(SUM(success), 0) AS successes,
              AVG(turns_saved) AS avg_turns_saved
         FROM skill_runs
        WHERE skill_name = ? AND started_at >= ?`
    )
    .get(skillName, cutoff);
  return {
    runs: row?.runs ?? 0,
    hits: row?.hits ?? 0,
    successes: row?.successes ?? 0,
    avgTurnsSaved: row?.avg_turns_saved ?? 0,
  };
}

export function statsSinceRunId(db: Database, skillName: string, sinceRunId: number): RunStats {
  const row = db
    .query<
      { runs: number; hits: number; successes: number; avg_turns_saved: number | null },
      [string, number]
    >(
      `SELECT COUNT(*) AS runs,
              COUNT(ended_at) AS hits,
              COALESCE(SUM(success), 0) AS successes,
              AVG(turns_saved) AS avg_turns_saved
         FROM skill_runs
        WHERE skill_name = ? AND id > ?`
    )
    .get(skillName, sinceRunId);
  return {
    runs: row?.runs ?? 0,
    hits: row?.hits ?? 0,
    successes: row?.successes ?? 0,
    avgTurnsSaved: row?.avg_turns_saved ?? 0,
  };
}

export function getRun(db: Database, id: number): SkillRunRow | null {
  return db.query<SkillRunRow, [number]>("SELECT * FROM skill_runs WHERE id = ?").get(id) ?? null;
}

export function listRuns(db: Database, skillName: string, limit = 50): SkillRunRow[] {
  return db
    .query<SkillRunRow, [string, number]>(
      "SELECT * FROM skill_runs WHERE skill_name = ? ORDER BY started_at DESC LIMIT ?"
    )
    .all(skillName, limit);
}

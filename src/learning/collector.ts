/**
 * Collector — single entry point every envelope handler calls to record
 * a skill invocation. Writes one `skill_runs` row + one `learn_events`
 * entry; higher layers compute metrics off these two tables.
 */

import type { Database } from "../state/db";
import { appendEvent } from "../state/repos/events";
import { finishRun, getRun, startRun } from "../state/repos/skillRuns";

export interface StartCollect {
  skillName: string;
  version: number;
  sessionId?: number | null;
  toolsUsed?: unknown;
  shadow: boolean;
}

export function startCollect(db: Database, input: StartCollect): number {
  const runId = startRun(db, {
    skillName: input.skillName,
    version: input.version,
    sessionId: input.sessionId,
    toolsUsed: input.toolsUsed,
  });
  appendEvent(db, input.shadow ? "skill.shadow.start" : "skill.active.start", {
    runId,
    skillName: input.skillName,
    version: input.version,
  });
  return runId;
}

export interface FinishCollect {
  runId: number;
  skillName: string;
  success: boolean;
  turnsSaved?: number;
  userFeedback?: string;
  shadow: boolean;
}

export function finishCollect(db: Database, input: FinishCollect): void {
  // Guard against (a) bogus runIds (caller lost track) and (b) double-finish
  // (caller's defer ran twice). Both used to silently produce phantom finish
  // events with no underlying row update, polluting detector aggregates.
  const existing = getRun(db, input.runId);
  if (!existing) {
    appendEvent(db, "skill.collect.error", {
      reason: "finish-on-missing-run",
      runId: input.runId,
      skillName: input.skillName,
    });
    return;
  }
  if (existing.ended_at) {
    appendEvent(db, "skill.collect.error", {
      reason: "double-finish",
      runId: input.runId,
      skillName: input.skillName,
      previousEndedAt: existing.ended_at,
    });
    return;
  }

  finishRun(db, {
    id: input.runId,
    success: input.success,
    turnsSaved: input.turnsSaved,
    userFeedback: input.userFeedback,
  });
  appendEvent(db, input.shadow ? "skill.shadow.finish" : "skill.active.finish", {
    runId: input.runId,
    skillName: input.skillName,
    success: input.success,
    turnsSaved: input.turnsSaved ?? null,
  });
}

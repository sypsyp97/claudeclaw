/**
 * Park-style scoring for cross-session retrieval.
 *
 * Composite score = α·recency + β·(importance/10) + γ·relevance,
 * with α=0.3, β=0.2, γ=0.5 by default. Each component lives in [0, 1] so
 * the composite also lives in [0, 1] under DEFAULT_WEIGHTS.
 *
 * - recency = exp(-hoursSince(ts) / 24)  — half-life-ish decay over a day.
 * - importance is the stored 0..10 column, normalised by /10.
 * - relevance is a caller-supplied [0, 1] proxy for FTS rank quality.
 *
 * Heuristic importance baselines per role, with +2 bumps per unique trigger
 * word (`remember` / `todo` / `?`), clamped to 10.
 */

import type { Database } from "../state/db";
import { search, type SearchFilter, type SearchHit } from "../state/repos/messages";

export interface ScoringWeights {
  recency: number;
  importance: number;
  relevance: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  recency: 0.3,
  importance: 0.2,
  relevance: 0.5,
};

export type ScoringRole = "user" | "assistant" | "tool" | "system";

export interface MessageForScoring {
  role: ScoringRole;
  content: string;
  ts: string;
  importance: number;
  last_access?: string | null;
  relevance?: number;
}

const ROLE_BASELINE: Record<ScoringRole, number> = {
  user: 6,
  assistant: 5,
  tool: 3,
  system: 4,
};

const TRIGGERS: ReadonlyArray<string> = ["remember", "todo", "?"];

function needsPhraseQuoting(query: string): boolean {
  if (query.includes('"')) return false; // caller already quoted something
  // Bare operator chars that FTS5 would interpret structurally.
  return /[-:^*+(){}[\]]/.test(query);
}

export function heuristicImportance(role: ScoringRole, content: string): number {
  const baseline = ROLE_BASELINE[role] ?? 5;
  const lower = content.toLowerCase();
  let bumps = 0;
  for (const trigger of TRIGGERS) {
    if (lower.includes(trigger)) bumps++;
  }
  const score = baseline + 2 * bumps;
  return Math.min(10, Math.max(0, score));
}

export function scoreRow(
  row: MessageForScoring,
  now: Date,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
  const tsMs = Date.parse(row.ts);
  const nowMs = now.getTime();
  const hoursSince = Math.max(0, (nowMs - tsMs) / 3_600_000);
  const recency = Math.exp(-hoursSince / 24);
  const importanceNorm = Math.min(1, Math.max(0, row.importance / 10));
  const relevance = row.relevance ?? 0;
  return weights.recency * recency + weights.importance * importanceNorm + weights.relevance * relevance;
}

export function touchAccess(db: Database, messageId: number, now: Date = new Date()): void {
  db.prepare("UPDATE messages SET last_access = ? WHERE id = ?").run(now.toISOString(), messageId);
}

export interface ScoredHit {
  hit: SearchHit;
  score: number;
  row: MessageForScoring;
}

export interface SearchWithScoringOptions {
  weights?: ScoringWeights;
  filter?: SearchFilter;
  now?: Date;
}

interface StoredMessageRow {
  role: ScoringRole;
  content: string;
  ts: string;
  importance: number;
  last_access: string | null;
}

export function searchWithScoring(
  db: Database,
  query: string,
  opts: SearchWithScoringOptions = {}
): ScoredHit[] {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const now = opts.now ?? new Date();
  // FTS5 treats hyphens, colons, and other punctuation as operators (NEAR/NOT
  // etc.). When the caller passes a raw token without quoting, wrap it in a
  // phrase quote so those characters are treated as literals.
  const ftsQuery = needsPhraseQuoting(query) ? `"${query.replace(/"/g, '""')}"` : query;
  const hits = search(db, ftsQuery, opts.filter ?? {});

  const stmt = db.prepare("SELECT role, content, ts, importance, last_access FROM messages WHERE id = ?");

  const scored: ScoredHit[] = [];
  hits.forEach((hit, rankIndex) => {
    const stored = stmt.get(hit.messageId) as StoredMessageRow | null;
    if (!stored) return;
    const row: MessageForScoring = {
      role: stored.role,
      content: stored.content,
      ts: stored.ts,
      importance: stored.importance,
      last_access: stored.last_access,
      relevance: 1 / (rankIndex + 1),
    };
    scored.push({ hit, score: scoreRow(row, now, weights), row });
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

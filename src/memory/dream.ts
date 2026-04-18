/**
 * Honcho-style "Dream" consolidation pass.
 *
 * Three idempotent passes per nightly run:
 *   1. Compress old, undigested per-session message windows into a single
 *      `digests` row, marking each source row's `digested_at`.
 *   2. Dedupe MEMORY.md entries whose normalized body is identical, keeping
 *      only the newest per group.
 *   3. Mark contradicted entries (same key, different value) as
 *      `<!-- invalidated -->` rather than deleting them, so the audit trail
 *      survives.
 *
 * Pure heuristics only — no LLM. Safe to re-run; on unchanged state every
 * counter returns to zero.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { crossSessionMemoryFile } from "../paths";
import type { Database } from "../state/db";

const DAY_MS = 86_400_000;

export interface DreamOptions {
  now?: Date;
  /** Messages with `ts < now - ageDays` are eligible for digestion. */
  ageDays?: number;
  /** Workspace root; defaults to `process.cwd()`. */
  cwd?: string;
}

export interface DreamResult {
  digestsCreated: number;
  messagesDigested: number;
  memoryDedupeCount: number;
  memoryInvalidatedCount: number;
}

interface MessageRow {
  id: number;
  session_id: number;
  ts: string;
  content: string;
}

export async function runDream(db: Database, opts: DreamOptions = {}): Promise<DreamResult> {
  const now = opts.now ?? new Date();
  const ageDays = opts.ageDays ?? 7;
  const cutoffMs = now.getTime() - ageDays * DAY_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const createdAt = now.toISOString();

  const { digestsCreated, messagesDigested } = digestOldMessages(db, cutoffIso, createdAt);

  const { memoryDedupeCount, memoryInvalidatedCount } = consolidateMemory(opts.cwd);

  return {
    digestsCreated,
    messagesDigested,
    memoryDedupeCount,
    memoryInvalidatedCount,
  };
}

function digestOldMessages(
  db: Database,
  cutoffIso: string,
  createdAt: string
): { digestsCreated: number; messagesDigested: number } {
  const candidates = db
    .query<MessageRow, [string]>(
      `SELECT id, session_id, ts, content
         FROM messages
        WHERE digested_at IS NULL AND ts < ?
        ORDER BY session_id, ts, id`
    )
    .all(cutoffIso);

  if (candidates.length === 0) {
    return { digestsCreated: 0, messagesDigested: 0 };
  }

  const bySession = new Map<number, MessageRow[]>();
  for (const row of candidates) {
    let bucket = bySession.get(row.session_id);
    if (!bucket) {
      bucket = [];
      bySession.set(row.session_id, bucket);
    }
    bucket.push(row);
  }

  const insertDigest = db.prepare(
    `INSERT INTO digests
       (session_id, window_start, window_end, summary, source_msg_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const stampMessage = db.prepare("UPDATE messages SET digested_at = ? WHERE id = ?");

  let digestsCreated = 0;
  let messagesDigested = 0;

  const tx = db.transaction(() => {
    for (const [sessionId, rows] of bySession) {
      let windowStart = rows[0].ts;
      let windowEnd = rows[0].ts;
      for (const r of rows) {
        if (r.ts < windowStart) windowStart = r.ts;
        if (r.ts > windowEnd) windowEnd = r.ts;
      }
      const summary = cheapSummary(rows, windowStart, windowEnd);
      const ids = rows.map((r) => r.id);
      insertDigest.run(sessionId, windowStart, windowEnd, summary, JSON.stringify(ids), createdAt);
      for (const id of ids) {
        stampMessage.run(createdAt, id);
      }
      digestsCreated += 1;
      messagesDigested += rows.length;
    }
  });
  tx();

  return { digestsCreated, messagesDigested };
}

function cheapSummary(rows: MessageRow[], windowStart: string, windowEnd: string): string {
  const first = rows[0]?.content ?? "";
  const head = first.replace(/\s+/g, " ").trim().slice(0, 80);
  return `digest: ${rows.length} messages between ${windowStart} and ${windowEnd}${head ? ` — ${head}` : ""}`;
}

// ---------------------------------------------------------------------------
// MEMORY.md consolidation
// ---------------------------------------------------------------------------

interface MemoryEntry {
  /** ISO timestamp from the leading `<!-- ... -->` comment, or null. */
  ts: string | null;
  /** Raw lines making up the entry's body (excludes the timestamp comment). */
  bodyLines: string[];
  /** Joined+normalized body, used for dedupe + key extraction. */
  normalized: string;
  /** Key derived from the normalized body, or null. */
  key: string | null;
  /** Original source order; tiebreaker so output stays stable. */
  order: number;
  /** Set by the dedupe pass to drop the entry from the rewritten file. */
  drop: boolean;
  /** Set by the invalidate pass to prepend an `<!-- invalidated -->` marker. */
  invalidated: boolean;
}

function consolidateMemory(cwd?: string): {
  memoryDedupeCount: number;
  memoryInvalidatedCount: number;
} {
  const path = crossSessionMemoryFile(cwd);
  if (!existsSync(path)) {
    return { memoryDedupeCount: 0, memoryInvalidatedCount: 0 };
  }
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) {
    return { memoryDedupeCount: 0, memoryInvalidatedCount: 0 };
  }

  const entries = parseMemory(raw);
  if (entries.length === 0) {
    return { memoryDedupeCount: 0, memoryInvalidatedCount: 0 };
  }

  // ---- Dedupe pass: identical normalized body -> keep newest, drop rest.
  const dedupeBuckets = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    if (e.normalized.length === 0) continue;
    const bucket = dedupeBuckets.get(e.normalized);
    if (bucket) bucket.push(e);
    else dedupeBuckets.set(e.normalized, [e]);
  }
  let memoryDedupeCount = 0;
  for (const bucket of dedupeBuckets.values()) {
    if (bucket.length < 2) continue;
    const winner = newest(bucket);
    for (const e of bucket) {
      if (e !== winner) {
        e.drop = true;
        memoryDedupeCount += 1;
      }
    }
  }

  // ---- Invalidate pass: same key but different normalized body -> mark
  // the older entries, keep the newest verbatim.
  const keyBuckets = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    if (e.drop || e.key === null) continue;
    const bucket = keyBuckets.get(e.key);
    if (bucket) bucket.push(e);
    else keyBuckets.set(e.key, [e]);
  }
  let memoryInvalidatedCount = 0;
  for (const bucket of keyBuckets.values()) {
    if (bucket.length < 2) continue;
    const distinctBodies = new Set(bucket.map((e) => e.normalized));
    if (distinctBodies.size < 2) continue;
    const winner = newest(bucket);
    for (const e of bucket) {
      if (e === winner) continue;
      // Only mark already-marked entries once. Re-running consolidate on a
      // file that already carries the marker is a no-op.
      if (!e.invalidated && !alreadyInvalidated(e)) {
        e.invalidated = true;
        memoryInvalidatedCount += 1;
      }
    }
  }

  if (memoryDedupeCount === 0 && memoryInvalidatedCount === 0) {
    return { memoryDedupeCount: 0, memoryInvalidatedCount: 0 };
  }

  const out = renderMemory(entries);
  writeFileSync(path, out, "utf8");
  return { memoryDedupeCount, memoryInvalidatedCount };
}

const TS_COMMENT_RE = /^<!--\s*(.+?)\s*-->\s*$/;

function parseMemory(raw: string): MemoryEntry[] {
  // Normalise line endings so Windows-authored files behave like Unix ones.
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const entries: MemoryEntry[] = [];
  let current: { ts: string | null; bodyLines: string[] } | null = null;
  let order = 0;

  const flush = () => {
    if (!current) return;
    // Strip pure-empty trailing lines so the rendered output stays tidy.
    while (current.bodyLines.length > 0 && current.bodyLines[current.bodyLines.length - 1].trim() === "") {
      current.bodyLines.pop();
    }
    if (current.bodyLines.length === 0 && current.ts === null) {
      current = null;
      return;
    }
    const joined = current.bodyLines.join(" ");
    const normalized = normalizeMemoryLine(joined);
    const key = extractKey(joined);
    entries.push({
      ts: current.ts,
      bodyLines: [...current.bodyLines],
      normalized,
      key,
      order: order++,
      drop: false,
      invalidated: false,
    });
    current = null;
  };

  for (const line of lines) {
    const tsMatch = line.match(TS_COMMENT_RE);
    if (tsMatch && isLikelyTimestamp(tsMatch[1])) {
      flush();
      current = { ts: tsMatch[1], bodyLines: [] };
      continue;
    }
    if (current === null) {
      // Body before any timestamp comment — treat as an anonymous entry.
      if (line.trim() === "") continue;
      current = { ts: null, bodyLines: [] };
    }
    current.bodyLines.push(line);
  }
  flush();
  return entries;
}

function isLikelyTimestamp(s: string): boolean {
  // Accept anything that parses as a Date; falls back to string compare for
  // ordering, which still works for ISO-8601.
  return !Number.isNaN(Date.parse(s));
}

function newest(bucket: MemoryEntry[]): MemoryEntry {
  let winner = bucket[0];
  for (const e of bucket) {
    if (compareTs(e.ts, winner.ts) > 0) winner = e;
    else if (compareTs(e.ts, winner.ts) === 0 && e.order > winner.order) winner = e;
  }
  return winner;
}

function compareTs(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  // ISO-8601 sorts lexicographically; cheap and correct.
  return a < b ? -1 : a > b ? 1 : 0;
}

function alreadyInvalidated(e: MemoryEntry): boolean {
  return e.bodyLines.some((l) => /<!--\s*invalidated\s*-->/i.test(l));
}

function renderMemory(entries: MemoryEntry[]): string {
  const chunks: string[] = [];
  for (const e of entries) {
    if (e.drop) continue;
    if (e.ts !== null) chunks.push(`<!-- ${e.ts} -->`);
    if (e.invalidated) chunks.push("<!-- invalidated -->");
    for (const line of e.bodyLines) chunks.push(line);
    chunks.push("");
  }
  return chunks.join("\n");
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for direct unit tests.
// ---------------------------------------------------------------------------

export function normalizeMemoryLine(line: string): string {
  let out = line.toLowerCase();
  // Collapse all whitespace runs to a single space first, then strip the
  // padding around `=` so "x = 1" and "x=1" produce the same key.
  out = out.replace(/\s+/g, " ");
  out = out.replace(/\s*=\s*/g, "=");
  return out.trim();
}

export function extractKey(line: string): string | null {
  const normalized = normalizeMemoryLine(line);
  const idx = normalized.indexOf("=");
  if (idx < 0) return null;
  const key = normalized.slice(0, idx).trim();
  return key.length === 0 ? null : key;
}

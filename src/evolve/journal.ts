/**
 * Journal — the human-readable side of the evolve loop. Writes a daily
 * markdown journal under `<project-root>/memory/journal/<date>.md` and
 * appends structured `evolve.*` events into `learn_events` for machine
 * consumption.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { memoryDir } from "../paths";
import type { Database } from "../state/db";
import { appendEvent } from "../state/repos/events";

export type EvolveEventKind =
  | "evolve.plan"
  | "evolve.exec.start"
  | "evolve.exec.done"
  | "evolve.commit"
  | "evolve.revert"
  | "evolve.skip";

export interface EvolveEvent {
  kind: EvolveEventKind;
  slot: string;
  summary: string;
  details?: unknown;
}

export async function recordEvent(db: Database, event: EvolveEvent, cwd?: string): Promise<void> {
  appendEvent(db, event.kind, { slot: event.slot, summary: event.summary, details: event.details });
  await appendDailyJournal(event, cwd);
}

export function journalFile(date: Date, cwd?: string): string {
  const iso = date.toISOString().slice(0, 10);
  return join(memoryDir(cwd), "journal", `${iso}.md`);
}

// In-process mutex keyed by absolute file path. The daemon is single-process,
// so this is enough to serialise the daily-journal append path. Without it,
// concurrent recordEvent() calls used to either lose entries (read-modify-write
// race) or write two daily headers (existsSync race).
const journalLocks = new Map<string, Promise<void>>();

async function appendDailyJournal(event: EvolveEvent, cwd?: string): Promise<void> {
  const path = journalFile(new Date(), cwd);
  const prev = journalLocks.get(path) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => writeJournalEntry(path, event));
  journalLocks.set(path, next);
  try {
    await next;
  } finally {
    if (journalLocks.get(path) === next) journalLocks.delete(path);
  }
}

async function writeJournalEntry(path: string, event: EvolveEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  // Header lands once thanks to O_CREAT|O_EXCL; subsequent calls fall through.
  await writeFile(path, `# Evolve journal — ${date}\n\n`, { flag: "ax" }).catch(() => {});
  const entry = [
    `## ${new Date().toISOString()} — ${event.kind} — ${event.slot}`,
    "",
    event.summary,
    "",
    "",
  ].join("\n");
  await writeFile(path, entry, { flag: "a" });
}

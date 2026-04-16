import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, closeDb, type Database, openDb } from "../state";
import { journalFile, recordEvent } from "./journal";

// Stress the daily-journal write path with concurrent appends. The file is a
// read-modify-write loop with no lock, so without the fix the second writer
// would clobber the first writer's entry and (separately) two writers can both
// see no file and both prepend the daily header.

const ORIG_CWD = process.cwd();
let tempRoot: string;
let db: Database;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-journal-race-"));
  process.chdir(tempRoot);
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(async () => {
  closeDb(db);
  process.chdir(ORIG_CWD);
  await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  db.exec("DELETE FROM learn_events");
  // Wipe today's journal so each test starts from no-file.
  const path = journalFile(new Date(), tempRoot);
  await rm(path, { force: true });
});

describe("recordEvent under concurrency", () => {
  test("N parallel appends preserve every entry (no read-modify-write loss)", async () => {
    const N = 20;
    const events = Array.from({ length: N }, (_, i) => ({
      kind: "evolve.plan" as const,
      slot: `task-${i}`,
      summary: `summary-${i}`,
    }));

    await Promise.all(events.map((e) => recordEvent(db, e, tempRoot)));

    const path = journalFile(new Date(), tempRoot);
    const body = await readFile(path, "utf8");

    const missing: string[] = [];
    for (const e of events) {
      if (!body.includes(e.summary)) missing.push(e.summary);
    }
    expect(missing).toEqual([]);
  });

  test("parallel appends emit exactly one daily header (no duplicate header race)", async () => {
    await Promise.all([
      recordEvent(db, { kind: "evolve.plan", slot: "a", summary: "alpha" }, tempRoot),
      recordEvent(db, { kind: "evolve.plan", slot: "b", summary: "beta" }, tempRoot),
      recordEvent(db, { kind: "evolve.plan", slot: "c", summary: "gamma" }, tempRoot),
      recordEvent(db, { kind: "evolve.plan", slot: "d", summary: "delta" }, tempRoot),
    ]);

    const path = journalFile(new Date(), tempRoot);
    const body = await readFile(path, "utf8");

    const headerCount = (body.match(/# Evolve journal/g) ?? []).length;
    expect(headerCount).toBe(1);
  });
});

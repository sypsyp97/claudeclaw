/**
 * Path-keyed shared DB cache. Every `getSharedDb()` call for the same
 * resolved `stateDbFile()` returns the same handle, with migrations and
 * the one-shot legacy JSON importer applied exactly once per workspace.
 *
 * Bundling the importer in here means *any* entry point that touches
 * sessions — the daemon, the `send` CLI, the `clear` CLI, tests — picks
 * up legacy `session.json` / `sessions.json` state without each call
 * site having to remember to call `bootstrapState` first. That was the
 * footgun behind a real test regression: `send` worked against a fresh
 * SQLite DB but not against a workspace that still only had the old
 * JSON files, because nothing migrated them.
 *
 * Test hook: `resetSharedDbCache()` closes and drops every cached handle.
 * Integration tests that chdir between tempdirs call this in `beforeEach`
 * so a stale handle from a just-deleted tempdir does not resurface.
 */

import { unlinkSync } from "node:fs";
import { applyMigrations } from "./bootstrap";
import { type Database, openDb } from "./db";
import { importLegacyJson } from "./import-json";
import { stateDbFile } from "../paths";

const cache = new Map<string, Promise<Database>>();
const pathByHandle = new WeakMap<Database, string>();

export function getSharedDb(cwd: string = process.cwd()): Promise<Database> {
  const path = stateDbFile(cwd);
  const existing = cache.get(path);
  if (existing) return existing;
  const promise = (async () => {
    const db = openDb({ path });
    pathByHandle.set(db, path);
    await applyMigrations(db);
    // Import-on-first-open. `importLegacyJson` is idempotent (upserts by
    // unique key), so re-running it at most costs one extra lookup per
    // legacy row on every fresh-handle boot — negligible.
    try {
      await importLegacyJson(db, cwd);
    } catch {
      // If the legacy JSON is malformed, swallow and continue. Better to
      // serve an empty SQLite than to refuse to open the DB at all.
    }
    return db;
  })();
  cache.set(path, promise);
  return promise;
}

export async function resetSharedDbCache(): Promise<void> {
  const entries = Array.from(cache.values());
  cache.clear();
  for (const p of entries) {
    try {
      const db = await p;
      const dbPath = pathByHandle.get(db);
      // On Windows, WAL creates `.db-wal` / `.db-shm` sidecars that can
      // outlive `db.close()` and block a subsequent rmSync of the tmp
      // workspace. Checkpoint + switch to rollback journal before close
      // so SQLite drops the sidecars explicitly.
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        db.exec("PRAGMA journal_mode = DELETE;");
      } catch {
        // best-effort cleanup; carry on to close regardless
      }
      // `close(true)` throws rather than silently waiting on still-open
      // prepared statements — which on Windows is what keeps the tmp
      // dir locked after a test. We want to know immediately (and
      // bun:sqlite finalises statements on throw anyway, so the handle
      // still releases).
      try {
        db.close(true);
      } catch {
        db.close();
      }
      // Belt-and-suspenders: SQLite occasionally leaves `-shm` / `-wal`
      // behind on Windows even after the DELETE pragma. Explicit unlink
      // before the caller tries to rm the tmp dir.
      if (dbPath && dbPath !== ":memory:") {
        for (const suffix of ["-wal", "-shm"]) {
          try {
            unlinkSync(dbPath + suffix);
          } catch {
            // already gone, or never created
          }
        }
      }
    } catch {
      // already closed or failed to open — caller moved on
    }
  }
  // Force GC so any lingering JS-side handles to the DB are finalised
  // before the caller tries to rm the workspace. On Windows the native
  // handle sometimes outlives `close()` by a tick if the JS wrapper is
  // still reachable; GC makes that gap deterministic.
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
    Bun.gc(true);
  }
  // One more event-loop tick so the post-GC native close can land.
  // Windows needs a longer pause — 10ms occasionally still races.
  await new Promise((r) => setTimeout(r, 100));
}

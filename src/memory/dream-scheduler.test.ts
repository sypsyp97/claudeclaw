/**
 * Specifies the rate-limited Dream cron trigger.
 *
 * Drives:
 *   - migration `005_kv.sql` (creates the `kv` table for cross-call
 *     persistence of the dream cron's `last_run` timestamp).
 *   - `src/memory/dream-scheduler.ts` exposing `maybeRunDream(db, settings,
 *     opts?)`.
 *
 * Contract:
 *   - When `settings.dreamCron === false` → no-op, returns
 *     `{ ran: false, reason: "disabled" }`. runDream side effects MUST NOT
 *     occur.
 *   - When `now - last_run < intervalHours` → throttled, returns
 *     `{ ran: false, reason: "throttled" }`.
 *   - Otherwise → calls `runDream(db, { ageDays, now, cwd })`, persists
 *     `last_run = now.toISOString()` into the `kv` table under key
 *     `"dream.lastRunAt"`, and returns `{ ran: true, result }`.
 *
 * Tests reference the impl module via dynamic import inside `beforeEach` so
 * they fail at import-time with a useful "Cannot find module" message before
 * the impl agent has created `src/memory/dream-scheduler.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../../tests/helpers/rm-with-retry";

const ORIG_CWD = process.cwd();

const MIN_SETTINGS = {
  model: "",
  api: "",
  fallback: { model: "", api: "" },
  agentic: { enabled: false, defaultMode: "implementation", modes: [] },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: { enabled: false, interval: 15, prompt: "", excludeWindows: [], forwardToTelegram: false },
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], listenChannels: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  stt: { baseUrl: "", model: "" },
};

interface Workspace {
  dir: string;
  db: import("../state/db").Database;
  scheduler: any;
  shared: typeof import("../state/shared-db");
  sessionsRepo: typeof import("../state/repos/sessions");
}

async function makeWorkspace(prefix: string): Promise<Workspace> {
  const rawDir = mkdtempSync(join(tmpdir(), `hermes-dream-sched-${prefix}-`));
  mkdirSync(join(rawDir, ".claude", "hermes", "logs"), { recursive: true });
  mkdirSync(join(rawDir, "memory"), { recursive: true });
  writeFileSync(join(rawDir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.chdir(rawDir);
  const dir = process.cwd();

  const shared = await import("../state/shared-db");
  const sessionsRepo = await import("../state/repos/sessions");
  // Dynamic specifier so biome / static-analysis treats the impl path as
  // optional. Test fails at runtime with "Cannot find module" until the
  // impl agent creates `src/memory/dream-scheduler.ts`.
  const scheduler = await import(`./dream-scheduler`);
  const db = await shared.getSharedDb();
  return { dir, db, scheduler, shared, sessionsRepo };
}

async function teardown(ws: Workspace): Promise<void> {
  await ws.shared.resetSharedDbCache();
  process.chdir(ORIG_CWD);
  await rmWithRetry(ws.dir);
}

/** Insert a message with an explicit `ts` so we bypass the live clock. */
function seedOldMessage(
  db: import("../state/db").Database,
  sessionId: number,
  ts: string,
  role: string,
  content: string
): number {
  const result = db
    .prepare(`INSERT INTO messages (session_id, ts, role, content, importance) VALUES (?, ?, ?, ?, ?)`)
    .run(sessionId, ts, role, content, 5);
  return Number(result.lastInsertRowid);
}

afterAll(() => {
  process.chdir(ORIG_CWD);
});

describe("maybeRunDream — disabled", () => {
  test("returns { ran:false, reason:'disabled' } when settings.dreamCron is false and does NOT call runDream", async () => {
    const ws = await makeWorkspace("disabled");
    try {
      // Seed an old undigested message so we'd be able to detect a stray
      // runDream call by checking for a digests row.
      const session = ws.sessionsRepo.upsertSession(ws.db, {
        key: "dream-sched-disabled",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", "old undigested body");

      const result = await ws.scheduler.maybeRunDream(
        ws.db,
        { dreamCron: false },
        { now: new Date("2026-05-01T00:00:00Z"), cwd: ws.dir }
      );
      expect(result).toEqual({ ran: false, reason: "disabled" });

      // No digests row should have appeared.
      const digestCount = ws.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM digests").get();
      expect(digestCount!.count).toBe(0);

      // And the kv row must NOT have been written either.
      const kvRow = ws.db
        .query<{ value: string } | null, [string]>("SELECT value FROM kv WHERE key = ?")
        .get("dream.lastRunAt");
      expect(kvRow).toBeNull();
    } finally {
      await teardown(ws);
    }
  });
});

describe("maybeRunDream — first run persists last_run", () => {
  test("runs and persists last_run when cron is enabled and last_run is null", async () => {
    const ws = await makeWorkspace("first");
    try {
      const session = ws.sessionsRepo.upsertSession(ws.db, {
        key: "dream-sched-first",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", "first run body");

      const now = new Date("2026-05-01T00:00:00Z");
      const result = await ws.scheduler.maybeRunDream(ws.db, { dreamCron: true }, { now, cwd: ws.dir });
      expect(result.ran).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.result.digestsCreated).toBe(1);
      expect(result.result.messagesDigested).toBe(1);

      // The kv row must exist with key "dream.lastRunAt" and value = now.toISOString().
      const kvRow = ws.db
        .query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?")
        .get("dream.lastRunAt");
      expect(kvRow).not.toBeNull();
      expect(kvRow!.value).toBe(now.toISOString());
    } finally {
      await teardown(ws);
    }
  });
});

describe("maybeRunDream — throttling", () => {
  test("throttles when called twice in quick succession (default 24h interval)", async () => {
    const ws = await makeWorkspace("throttle");
    try {
      const session = ws.sessionsRepo.upsertSession(ws.db, {
        key: "dream-sched-throttle",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", "throttle body");

      const t0 = new Date("2026-05-01T00:00:00Z");
      const first = await ws.scheduler.maybeRunDream(ws.db, { dreamCron: true }, { now: t0, cwd: ws.dir });
      expect(first.ran).toBe(true);

      // Only 1 hour later — the default interval is 24h, so we expect throttled.
      const t1 = new Date(t0.getTime() + 1 * 60 * 60 * 1000);
      const second = await ws.scheduler.maybeRunDream(ws.db, { dreamCron: true }, { now: t1, cwd: ws.dir });
      expect(second).toEqual({ ran: false, reason: "throttled" });
    } finally {
      await teardown(ws);
    }
  });

  test("runs again when interval has elapsed (T0 + 25h)", async () => {
    const ws = await makeWorkspace("elapsed");
    try {
      const session = ws.sessionsRepo.upsertSession(ws.db, {
        key: "dream-sched-elapsed",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      // Two batches of old messages so the second runDream call still has
      // something to digest after the first batch is consumed.
      seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", "elapsed body 1");

      const t0 = new Date("2026-05-01T00:00:00Z");
      const first = await ws.scheduler.maybeRunDream(ws.db, { dreamCron: true }, { now: t0, cwd: ws.dir });
      expect(first.ran).toBe(true);

      // Seed a fresh old message so the second call has work to do (this
      // test is about the *gate*, not about runDream's idempotency).
      seedOldMessage(ws.db, session.id, "2026-04-02T00:00:00Z", "user", "elapsed body 2");

      const t1 = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
      const second = await ws.scheduler.maybeRunDream(ws.db, { dreamCron: true }, { now: t1, cwd: ws.dir });
      expect(second.ran).toBe(true);

      // Final last_run must be the more recent timestamp.
      const kvRow = ws.db
        .query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?")
        .get("dream.lastRunAt");
      expect(kvRow!.value).toBe(t1.toISOString());
    } finally {
      await teardown(ws);
    }
  });
});

describe("maybeRunDream — custom dreamIntervalHours", () => {
  test("respects custom dreamIntervalHours from settings", async () => {
    const ws = await makeWorkspace("custom-interval");
    try {
      const session = ws.sessionsRepo.upsertSession(ws.db, {
        key: "dream-sched-custom-interval",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", "interval body 1");

      const t0 = new Date("2026-05-01T00:00:00Z");
      const settings = { dreamCron: true, dreamIntervalHours: 1 };

      const first = await ws.scheduler.maybeRunDream(ws.db, settings, { now: t0, cwd: ws.dir });
      expect(first.ran).toBe(true);

      // 30 minutes later → throttled.
      const t30min = new Date(t0.getTime() + 30 * 60 * 1000);
      const throttled = await ws.scheduler.maybeRunDream(ws.db, settings, {
        now: t30min,
        cwd: ws.dir,
      });
      expect(throttled).toEqual({ ran: false, reason: "throttled" });

      // Seed more work, then call at T0 + 90 minutes → ran:true.
      seedOldMessage(ws.db, session.id, "2026-04-02T00:00:00Z", "user", "interval body 2");
      const t90min = new Date(t0.getTime() + 90 * 60 * 1000);
      const eligible = await ws.scheduler.maybeRunDream(ws.db, settings, {
        now: t90min,
        cwd: ws.dir,
      });
      expect(eligible.ran).toBe(true);
    } finally {
      await teardown(ws);
    }
  });
});

describe("maybeRunDream — custom dreamAgeDays", () => {
  test("passes dreamAgeDays through to runDream", async () => {
    const ws = await makeWorkspace("age");
    try {
      const session = ws.sessionsRepo.upsertSession(ws.db, {
        key: "dream-sched-age",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      const now = new Date("2026-05-01T00:00:00Z");
      // Message dated 2 days before "now" — stale enough for a 1-day cutoff
      // but NOT for the default 7-day cutoff.
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      seedOldMessage(ws.db, session.id, twoDaysAgo, "user", "two-day-old body");

      const result = await ws.scheduler.maybeRunDream(
        ws.db,
        { dreamCron: true, dreamAgeDays: 1 },
        { now, cwd: ws.dir }
      );
      expect(result.ran).toBe(true);
      expect(result.result.digestsCreated).toBe(1);
      expect(result.result.messagesDigested).toBe(1);

      // Sanity check: a digest row landed.
      const digestCount = ws.db
        .query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM digests WHERE session_id = ?")
        .get(session.id);
      expect(digestCount!.count).toBe(1);
    } finally {
      await teardown(ws);
    }
  });
});

describe("maybeRunDream — parallel calls", () => {
  test("two parallel calls leave a kv row behind (race-tolerant)", async () => {
    const ws = await makeWorkspace("parallel");
    try {
      const session = ws.sessionsRepo.upsertSession(ws.db, {
        key: "dream-sched-parallel",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", "parallel body");

      const now = new Date("2026-05-01T00:00:00Z");
      const settings = { dreamCron: true };
      const opts = { now, cwd: ws.dir };

      const results = await Promise.all([
        ws.scheduler.maybeRunDream(ws.db, settings, opts),
        ws.scheduler.maybeRunDream(ws.db, settings, opts),
      ]);

      // Spec preference: exactly one ran:true. We tolerate both ran:true on
      // SQLite WAL races, but the kv row MUST exist after parallel calls.
      const ranCount = results.filter((r) => r.ran === true).length;
      expect(ranCount).toBeGreaterThanOrEqual(1);

      const kvRow = ws.db
        .query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?")
        .get("dream.lastRunAt");
      expect(kvRow).not.toBeNull();
      expect(kvRow!.value).toBe(now.toISOString());
    } finally {
      await teardown(ws);
    }
  });
});

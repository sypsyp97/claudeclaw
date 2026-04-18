/**
 * Specifies the Honcho-style "Dream" consolidation pass.
 *
 * Drives:
 *   - migration `004_dream.sql` (adds `digested_at TEXT` on `messages`,
 *     creates the `digests` table)
 *   - `src/memory/dream.ts` exposing `runDream(db, opts)` plus the pure
 *     helpers `normalizeMemoryLine` and `extractKey`.
 *
 * Three passes per nightly run:
 *   1. Compress old, undigested per-session message windows into a single
 *      digests row, marking the source rows' `digested_at`.
 *   2. Dedupe MEMORY.md by normalized key, keeping the newest entry.
 *   3. Mark contradicted entries (same key, different value) as
 *      `<!-- invalidated -->` rather than deleting them.
 *
 * Pure heuristics only — no LLM calls. Idempotent across runs.
 *
 * The impl file does not exist yet; the test imports it dynamically inside
 * `beforeAll` so the suite produces useful red output (module-not-found
 * before impl, mass failures during impl) instead of failing to collect at
 * import time.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

let tempRoot: string;
let dream: any;
let shared: typeof import("../state/shared-db");
let sessionsRepo: typeof import("../state/repos/sessions");
let paths: typeof import("../paths");

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "hermes-dream-"));
  mkdirSync(join(tempRoot, ".claude", "hermes", "logs"), { recursive: true });
  writeFileSync(join(tempRoot, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.chdir(tempRoot);

  shared = await import("../state/shared-db");
  sessionsRepo = await import("../state/repos/sessions");
  paths = await import("../paths");
  dream = await import("./dream");
});

afterAll(async () => {
  await shared.resetSharedDbCache();
  process.chdir(ORIG_CWD);
  await rmWithRetry(tempRoot);
});

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IsolatedWorkspace {
  dir: string;
  db: import("../state/db").Database;
}

/**
 * Build a fresh isolated workspace + DB so each test owns its own state. The
 * caller is responsible for invoking `teardownWorkspace` in a `finally`.
 */
async function makeWorkspace(prefix: string): Promise<IsolatedWorkspace> {
  const dir = mkdtempSync(join(tmpdir(), `hermes-dream-${prefix}-`));
  mkdirSync(join(dir, ".claude", "hermes", "logs"), { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.chdir(dir);
  const db = await shared.getSharedDb();
  return { dir, db };
}

async function teardownWorkspace(ws: IsolatedWorkspace): Promise<void> {
  await shared.resetSharedDbCache();
  process.chdir(tempRoot);
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

describe("migration 004_dream", () => {
  test("adds digested_at TEXT column on messages and creates digests table", async () => {
    const ws = await makeWorkspace("mig");
    try {
      const cols = ws.db.query<ColumnInfo, []>("PRAGMA table_info(messages)").all();
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect(byName.has("digested_at")).toBe(true);
      expect(byName.get("digested_at")!.type.toUpperCase()).toBe("TEXT");

      const tableRow = ws.db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='digests'")
        .get();
      expect(tableRow).not.toBeNull();
      expect(tableRow!.name).toBe("digests");

      // Sanity-check the digests schema while we're here so impl can't
      // silently rename the columns the rest of the suite leans on.
      const digestCols = ws.db.query<ColumnInfo, []>("PRAGMA table_info(digests)").all();
      const digestNames = new Set(digestCols.map((c) => c.name));
      expect(digestNames.has("id")).toBe(true);
      expect(digestNames.has("session_id")).toBe(true);
      expect(digestNames.has("window_start")).toBe(true);
      expect(digestNames.has("window_end")).toBe(true);
      expect(digestNames.has("summary")).toBe(true);
      expect(digestNames.has("source_msg_ids")).toBe(true);
      expect(digestNames.has("created_at")).toBe(true);
    } finally {
      await teardownWorkspace(ws);
    }
  });
});

describe("runDream — message digestion", () => {
  test("old messages get digested into a single per-session digest row", async () => {
    const ws = await makeWorkspace("old");
    try {
      const session = sessionsRepo.upsertSession(ws.db, {
        key: "dream-old-key",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      const oldTs = "2026-04-01T12:00:00Z"; // 30 days before "now" below
      const seededIds: number[] = [];
      for (let i = 0; i < 10; i++) {
        const id = seedOldMessage(
          ws.db,
          session.id,
          oldTs,
          i % 2 === 0 ? "user" : "assistant",
          `old message body ${i}`
        );
        seededIds.push(id);
      }

      const result = await dream.runDream(ws.db, {
        now: new Date("2026-05-01T00:00:00Z"),
        ageDays: 7,
      });
      expect(result.digestsCreated).toBe(1);
      expect(result.messagesDigested).toBe(10);

      const undigested = ws.db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND digested_at IS NULL"
        )
        .get(session.id);
      expect(undigested!.count).toBe(0);

      const digestRows = ws.db
        .query<{ id: number; session_id: number; summary: string; source_msg_ids: string }, [number]>(
          "SELECT id, session_id, summary, source_msg_ids FROM digests WHERE session_id = ?"
        )
        .all(session.id);
      expect(digestRows.length).toBe(1);
      expect(digestRows[0].summary.length).toBeGreaterThan(0);

      const parsedIds = JSON.parse(digestRows[0].source_msg_ids);
      expect(Array.isArray(parsedIds)).toBe(true);
      expect(parsedIds.length).toBe(10);
      // Every seeded id must appear in the digest's source list.
      for (const id of seededIds) {
        expect(parsedIds).toContain(id);
      }
    } finally {
      await teardownWorkspace(ws);
    }
  });

  test("recent messages (younger than ageDays) are skipped", async () => {
    const ws = await makeWorkspace("recent");
    try {
      const session = sessionsRepo.upsertSession(ws.db, {
        key: "dream-recent-key",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      const recentTs = "2026-04-29T00:00:00Z"; // 2 days before "now"
      for (let i = 0; i < 5; i++) {
        seedOldMessage(ws.db, session.id, recentTs, "user", `recent body ${i}`);
      }

      const result = await dream.runDream(ws.db, {
        now: new Date("2026-05-01T00:00:00Z"),
        ageDays: 7,
      });
      expect(result.messagesDigested).toBe(0);
      expect(result.digestsCreated).toBe(0);

      const stillUndigested = ws.db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND digested_at IS NULL"
        )
        .get(session.id);
      expect(stillUndigested!.count).toBe(5);
    } finally {
      await teardownWorkspace(ws);
    }
  });

  test("mixed ages: only old messages get digested, recent ones stay untouched", async () => {
    const ws = await makeWorkspace("mixed");
    try {
      const session = sessionsRepo.upsertSession(ws.db, {
        key: "dream-mixed-key",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      const oldIds: number[] = [];
      const recentIds: number[] = [];
      for (let i = 0; i < 4; i++) {
        oldIds.push(seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", `old ${i}`));
      }
      for (let i = 0; i < 3; i++) {
        recentIds.push(seedOldMessage(ws.db, session.id, "2026-04-29T00:00:00Z", "user", `recent ${i}`));
      }

      const result = await dream.runDream(ws.db, {
        now: new Date("2026-05-01T00:00:00Z"),
        ageDays: 7,
      });
      expect(result.digestsCreated).toBe(1);
      expect(result.messagesDigested).toBe(4);

      // The 3 recent ids must still have a NULL digested_at.
      const placeholders = recentIds.map(() => "?").join(",");
      const recentNullCount = ws.db
        .query<{ count: number }, number[]>(
          `SELECT COUNT(*) AS count FROM messages WHERE digested_at IS NULL AND id IN (${placeholders})`
        )
        .get(...recentIds);
      expect(recentNullCount!.count).toBe(3);

      // And the 4 old ids must all be marked.
      const oldPlaceholders = oldIds.map(() => "?").join(",");
      const oldStampedCount = ws.db
        .query<{ count: number }, number[]>(
          `SELECT COUNT(*) AS count FROM messages WHERE digested_at IS NOT NULL AND id IN (${oldPlaceholders})`
        )
        .get(...oldIds);
      expect(oldStampedCount!.count).toBe(4);
    } finally {
      await teardownWorkspace(ws);
    }
  });

  test("already-digested rows are skipped — runDream is idempotent", async () => {
    const ws = await makeWorkspace("idemp");
    try {
      const session = sessionsRepo.upsertSession(ws.db, {
        key: "dream-idemp-key",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      for (let i = 0; i < 6; i++) {
        seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", `body ${i}`);
      }

      const opts = { now: new Date("2026-05-01T00:00:00Z"), ageDays: 7 };
      const first = await dream.runDream(ws.db, opts);
      expect(first.digestsCreated).toBe(1);
      expect(first.messagesDigested).toBe(6);

      const second = await dream.runDream(ws.db, opts);
      expect(second.digestsCreated).toBe(0);
      expect(second.messagesDigested).toBe(0);

      // And no extra digest row landed on the second pass.
      const digestCount = ws.db
        .query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM digests WHERE session_id = ?")
        .get(session.id);
      expect(digestCount!.count).toBe(1);
    } finally {
      await teardownWorkspace(ws);
    }
  });

  test("multiple sessions get independent digests", async () => {
    const ws = await makeWorkspace("multi-session");
    try {
      const sessionA = sessionsRepo.upsertSession(ws.db, {
        key: "dream-multi-A",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      const sessionB = sessionsRepo.upsertSession(ws.db, {
        key: "dream-multi-B",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      const aIds: number[] = [];
      const bIds: number[] = [];
      for (let i = 0; i < 5; i++) {
        aIds.push(seedOldMessage(ws.db, sessionA.id, "2026-04-01T00:00:00Z", "user", `A-${i}`));
        bIds.push(seedOldMessage(ws.db, sessionB.id, "2026-04-01T00:00:00Z", "user", `B-${i}`));
      }

      const result = await dream.runDream(ws.db, {
        now: new Date("2026-05-01T00:00:00Z"),
        ageDays: 7,
      });
      expect(result.digestsCreated).toBe(2);
      expect(result.messagesDigested).toBe(10);

      const aDigest = ws.db
        .query<{ source_msg_ids: string }, [number]>(
          "SELECT source_msg_ids FROM digests WHERE session_id = ?"
        )
        .get(sessionA.id);
      const bDigest = ws.db
        .query<{ source_msg_ids: string }, [number]>(
          "SELECT source_msg_ids FROM digests WHERE session_id = ?"
        )
        .get(sessionB.id);
      expect(aDigest).not.toBeNull();
      expect(bDigest).not.toBeNull();

      const aParsed: number[] = JSON.parse(aDigest!.source_msg_ids);
      const bParsed: number[] = JSON.parse(bDigest!.source_msg_ids);
      expect(aParsed.sort()).toEqual([...aIds].sort());
      expect(bParsed.sort()).toEqual([...bIds].sort());
      // No cross-contamination.
      for (const id of bIds) expect(aParsed).not.toContain(id);
      for (const id of aIds) expect(bParsed).not.toContain(id);
    } finally {
      await teardownWorkspace(ws);
    }
  });
});

describe("runDream — MEMORY.md dedupe", () => {
  test("identical normalized entries collapse to the newest one", async () => {
    const ws = await makeWorkspace("dedupe");
    try {
      const memoryPath = paths.crossSessionMemoryFile(ws.dir);
      const body = [
        "<!-- 2026-03-01T00:00:00Z -->",
        "postgres port = 5432",
        "",
        "<!-- 2026-03-05T00:00:00Z -->",
        "Postgres Port  =  5432",
        "",
        "<!-- 2026-03-10T00:00:00Z -->",
        "redis port = 6379",
        "",
      ].join("\n");
      writeFileSync(memoryPath, body, "utf8");

      const result = await dream.runDream(ws.db, {
        now: new Date("2026-05-01T00:00:00Z"),
        ageDays: 7,
        cwd: ws.dir,
      });
      expect(result.memoryDedupeCount).toBe(1);

      const after = readFileSync(memoryPath, "utf8");
      // Newest postgres entry survives verbatim.
      expect(after).toContain("Postgres Port  =  5432");
      // The older "postgres port = 5432" line is gone.
      expect(after).not.toContain("postgres port = 5432");
      // Unrelated key untouched.
      expect(after).toContain("redis port = 6379");
    } finally {
      await teardownWorkspace(ws);
    }
  });
});

describe("runDream — invalidation", () => {
  test("conflicting entries: older gets invalidated, newer survives, nothing deleted", async () => {
    const ws = await makeWorkspace("invalidate");
    try {
      const memoryPath = paths.crossSessionMemoryFile(ws.dir);
      const body = [
        "<!-- 2026-03-01T00:00:00Z -->",
        "api base = https://a.example.com",
        "",
        "<!-- 2026-03-05T00:00:00Z -->",
        "api base = https://b.example.com",
        "",
      ].join("\n");
      writeFileSync(memoryPath, body, "utf8");

      const result = await dream.runDream(ws.db, {
        now: new Date("2026-05-01T00:00:00Z"),
        ageDays: 7,
        cwd: ws.dir,
      });
      expect(result.memoryInvalidatedCount).toBe(1);

      const after = readFileSync(memoryPath, "utf8");
      // Newer line still present verbatim.
      expect(after).toContain("api base = https://b.example.com");
      // Older line is NOT deleted — still present in some form.
      expect(after).toContain("https://a.example.com");
      // …and now wears the invalidated marker.
      expect(after).toContain("invalidated");
    } finally {
      await teardownWorkspace(ws);
    }
  });

  test("two different keys: no conflict, no invalidation", async () => {
    const ws = await makeWorkspace("no-conflict");
    try {
      const memoryPath = paths.crossSessionMemoryFile(ws.dir);
      const body = [
        "<!-- 2026-03-01T00:00:00Z -->",
        "alpha = 1",
        "",
        "<!-- 2026-03-05T00:00:00Z -->",
        "beta = 2",
        "",
      ].join("\n");
      writeFileSync(memoryPath, body, "utf8");

      const result = await dream.runDream(ws.db, {
        now: new Date("2026-05-01T00:00:00Z"),
        ageDays: 7,
        cwd: ws.dir,
      });
      expect(result.memoryInvalidatedCount).toBe(0);

      const after = readFileSync(memoryPath, "utf8");
      expect(after).not.toContain("invalidated");
      expect(after).toContain("alpha = 1");
      expect(after).toContain("beta = 2");
    } finally {
      await teardownWorkspace(ws);
    }
  });
});

describe("runDream — combined single-shot pass", () => {
  test("digests messages, dedupes MEMORY.md, and invalidates conflicts in one call", async () => {
    const ws = await makeWorkspace("combined");
    try {
      // -- digests scenario --
      const session = sessionsRepo.upsertSession(ws.db, {
        key: "dream-combined-key",
        scope: "test",
        source: "test",
        workspace: ws.dir,
      });
      for (let i = 0; i < 3; i++) {
        seedOldMessage(ws.db, session.id, "2026-04-01T00:00:00Z", "user", `combined old ${i}`);
      }

      // -- MEMORY.md scenario: one dupe pair + one conflict pair + one neutral --
      const memoryPath = paths.crossSessionMemoryFile(ws.dir);
      const body = [
        "<!-- 2026-03-01T00:00:00Z -->",
        "log level = info",
        "",
        "<!-- 2026-03-05T00:00:00Z -->",
        "Log Level = info",
        "",
        "<!-- 2026-03-01T00:00:00Z -->",
        "auth mode = oauth",
        "",
        "<!-- 2026-03-08T00:00:00Z -->",
        "auth mode = saml",
        "",
        "<!-- 2026-03-10T00:00:00Z -->",
        "neutral key = value",
        "",
      ].join("\n");
      writeFileSync(memoryPath, body, "utf8");

      const result = await dream.runDream(ws.db, {
        now: new Date("2026-05-01T00:00:00Z"),
        ageDays: 7,
        cwd: ws.dir,
      });

      expect(result.digestsCreated).toBe(1);
      expect(result.messagesDigested).toBe(3);
      expect(result.memoryDedupeCount).toBe(1);
      expect(result.memoryInvalidatedCount).toBe(1);

      const after = readFileSync(memoryPath, "utf8");
      // Dedupe: newer "Log Level = info" survives, older variant gone.
      expect(after).toContain("Log Level = info");
      expect(after).not.toContain("log level = info");
      // Invalidate: older auth mode marked, newer survives.
      expect(after).toContain("auth mode = saml");
      expect(after).toContain("oauth");
      expect(after).toContain("invalidated");
      // Neutral entry untouched.
      expect(after).toContain("neutral key = value");
    } finally {
      await teardownWorkspace(ws);
    }
  });
});

describe("normalizeMemoryLine", () => {
  test("collapses runs of whitespace", () => {
    expect(dream.normalizeMemoryLine("foo    bar")).toBe(dream.normalizeMemoryLine("foo bar"));
  });

  test("case-folds and is whitespace-insensitive around '='", () => {
    expect(dream.normalizeMemoryLine("  Postgres   Port = 5432 ")).toBe(
      dream.normalizeMemoryLine("postgres port=5432")
    );
  });

  test("strips whitespace padding around '=' so 'x = 1' normalizes to 'x=1'", () => {
    expect(dream.normalizeMemoryLine("x = 1")).toBe(dream.normalizeMemoryLine("x=1"));
  });
});

describe("extractKey", () => {
  test("returns the trimmed lhs for a 'foo = 1' line", () => {
    expect(dream.extractKey("foo = 1")).toBe("foo");
  });

  test("returns null for a line that has no '='", () => {
    expect(dream.extractKey("random thought")).toBeNull();
  });

  test("for 'a=b=c' returns everything before the first '=' — i.e. 'a'", () => {
    expect(dream.extractKey("a=b=c")).toBe("a");
  });

  test("matches normalizeMemoryLine's casing/whitespace conventions", () => {
    // "postgres port = 5432" should yield the same key as "Postgres Port=5432"
    // once the impl normalizes — pin both spellings here.
    expect(dream.extractKey("postgres port = 5432")).toBe("postgres port");
  });
});

/**
 * Specifies the Park-style scoring layer for cross-session retrieval.
 *
 * Drives:
 *   - migration `002_message_scoring.sql` (adds `importance INTEGER NOT NULL
 *     DEFAULT 5` and `last_access TEXT` to `messages`)
 *   - `src/memory/scoring.ts` (pure scoring helpers + `touchAccess` writer)
 *   - integration: `searchWithScoring(db, query, opts)` exported from either
 *     `state/repos/messages` or `memory/search`, returning hits sorted by
 *     descending score.
 *   - back-compat: `appendMessage` automatically applies `heuristicImportance`
 *     when the caller does not pass an explicit `importance`.
 *
 * The impl file does not exist yet; the test imports it dynamically inside
 * `beforeAll` so the suite produces useful red output (module-not-found
 * before impl, mass failures during impl) instead of failing to collect at
 * import time.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

let tempRoot: string;
let scoring: any;
let shared: typeof import("../state/shared-db");
let messagesRepo: typeof import("../state/repos/messages");
let sessionsRepo: typeof import("../state/repos/sessions");
let searchMod: typeof import("./search");

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "hermes-scoring-"));
  mkdirSync(join(tempRoot, ".claude", "hermes", "logs"), { recursive: true });
  writeFileSync(join(tempRoot, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.chdir(tempRoot);

  shared = await import("../state/shared-db");
  messagesRepo = await import("../state/repos/messages");
  sessionsRepo = await import("../state/repos/sessions");
  searchMod = await import("./search");
  scoring = await import("./scoring");
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

describe("migration 002_message_scoring", () => {
  test("fresh DB has importance + last_access columns on messages with correct types", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-scoring-mig-"));
    mkdirSync(join(dir, ".claude", "hermes", "logs"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
    process.chdir(dir);
    try {
      const db = await shared.getSharedDb();
      const cols = db.query<ColumnInfo, []>("PRAGMA table_info(messages)").all();
      const byName = new Map(cols.map((c) => [c.name, c]));

      expect(byName.has("importance")).toBe(true);
      expect(byName.has("last_access")).toBe(true);

      expect(byName.get("importance")!.type.toUpperCase()).toBe("INTEGER");
      expect(byName.get("last_access")!.type.toUpperCase()).toBe("TEXT");
    } finally {
      await shared.resetSharedDbCache();
      process.chdir(tempRoot);
      await rmWithRetry(dir);
    }
  });

  test("rows inserted via raw SQL (no importance specified) inherit defaults: importance=5, last_access=NULL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-scoring-defaults-"));
    mkdirSync(join(dir, ".claude", "hermes", "logs"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
    process.chdir(dir);
    try {
      const db = await shared.getSharedDb();
      sessionsRepo.upsertSession(db, {
        key: "raw-defaults-key",
        scope: "test",
        source: "test",
        workspace: dir,
      });
      const session = sessionsRepo.getByKey(db, "raw-defaults-key")!;

      // Bypass appendMessage on purpose so the heuristic does NOT run; we
      // want to confirm the column-level DEFAULT really is 5.
      db.prepare(`INSERT INTO messages (session_id, ts, role, content) VALUES (?, ?, ?, ?)`).run(
        session.id,
        new Date().toISOString(),
        "user",
        "raw insert body"
      );

      const row = db
        .query<{ importance: number; last_access: string | null }, [number]>(
          "SELECT importance, last_access FROM messages WHERE session_id = ?"
        )
        .get(session.id);

      expect(row).not.toBeNull();
      expect(row!.importance).toBe(5);
      expect(row!.last_access).toBeNull();
    } finally {
      await shared.resetSharedDbCache();
      process.chdir(tempRoot);
      await rmWithRetry(dir);
    }
  });
});

describe("heuristicImportance", () => {
  test("user baseline is 6", () => {
    expect(scoring.heuristicImportance("user", "plain body")).toBe(6);
  });

  test("assistant baseline is 5", () => {
    expect(scoring.heuristicImportance("assistant", "plain body")).toBe(5);
  });

  test("tool baseline is 3", () => {
    expect(scoring.heuristicImportance("tool", "plain body")).toBe(3);
  });

  test("system baseline is 4", () => {
    expect(scoring.heuristicImportance("system", "plain body")).toBe(4);
  });

  test("'remember' (case-insensitive) bumps a user message to 8", () => {
    expect(scoring.heuristicImportance("user", "Remember this.")).toBe(8);
  });

  test("'todo' (case-insensitive) bumps a user message to 8", () => {
    expect(scoring.heuristicImportance("user", "TODO fix later")).toBe(8);
  });

  test("'?' bumps a user message to 8", () => {
    expect(scoring.heuristicImportance("user", "Where is the file?")).toBe(8);
  });

  test("multiple triggers cap at 10, not 12", () => {
    expect(scoring.heuristicImportance("user", "Remember the TODO — where is it?")).toBe(10);
  });

  test("plain content gets no bump — user 'hello' is exactly 6", () => {
    expect(scoring.heuristicImportance("user", "hello")).toBe(6);
  });
});

describe("scoreRow", () => {
  test("newer row outscores older when importance + relevance are equal", () => {
    const now = new Date("2026-04-18T12:00:00Z");
    const newer = {
      role: "user" as const,
      content: "x",
      ts: new Date(now.getTime() - 1 * 3600_000).toISOString(),
      importance: 5,
      relevance: 0.5,
    };
    const older = {
      role: "user" as const,
      content: "x",
      ts: new Date(now.getTime() - 48 * 3600_000).toISOString(),
      importance: 5,
      relevance: 0.5,
    };
    expect(scoring.scoreRow(newer, now)).toBeGreaterThan(scoring.scoreRow(older, now));
  });

  test("higher importance outscores lower when recency + relevance are equal", () => {
    const now = new Date("2026-04-18T12:00:00Z");
    const ts = new Date(now.getTime() - 6 * 3600_000).toISOString();
    const hi = { role: "user" as const, content: "x", ts, importance: 10, relevance: 0.5 };
    const lo = { role: "user" as const, content: "x", ts, importance: 1, relevance: 0.5 };
    expect(scoring.scoreRow(hi, now)).toBeGreaterThan(scoring.scoreRow(lo, now));
  });

  test("higher relevance outscores lower when recency + importance are equal", () => {
    const now = new Date("2026-04-18T12:00:00Z");
    const ts = new Date(now.getTime() - 6 * 3600_000).toISOString();
    const hi = { role: "user" as const, content: "x", ts, importance: 5, relevance: 0.9 };
    const lo = { role: "user" as const, content: "x", ts, importance: 5, relevance: 0.1 };
    expect(scoring.scoreRow(hi, now)).toBeGreaterThan(scoring.scoreRow(lo, now));
  });

  test("recency = 1 at now, exp(-1) at 24h with importance=0 + relevance=0", () => {
    const now = new Date("2026-04-18T12:00:00Z");
    const atNow = {
      role: "user" as const,
      content: "x",
      ts: now.toISOString(),
      importance: 0,
      relevance: 0,
    };
    const dayOld = {
      role: "user" as const,
      content: "x",
      ts: new Date(now.getTime() - 24 * 3600_000).toISOString(),
      importance: 0,
      relevance: 0,
    };
    // alpha = 0.3 in DEFAULT_WEIGHTS.
    expect(scoring.scoreRow(atNow, now)).toBeCloseTo(0.3, 5);
    expect(scoring.scoreRow(dayOld, now)).toBeCloseTo(0.3 / Math.E, 4);
  });

  test("custom weights are respected", () => {
    const now = new Date("2026-04-18T12:00:00Z");
    const row = {
      role: "user" as const,
      content: "x",
      ts: now.toISOString(),
      importance: 0,
      relevance: 0,
    };
    const score = scoring.scoreRow(row, now, {
      recency: 1,
      importance: 0,
      relevance: 0,
    });
    expect(score).toBeCloseTo(1.0, 5);
  });

  test("DEFAULT_WEIGHTS sum to 1 with the documented α=0.3, β=0.2, γ=0.5", () => {
    expect(scoring.DEFAULT_WEIGHTS.recency).toBeCloseTo(0.3, 6);
    expect(scoring.DEFAULT_WEIGHTS.importance).toBeCloseTo(0.2, 6);
    expect(scoring.DEFAULT_WEIGHTS.relevance).toBeCloseTo(0.5, 6);
  });
});

describe("touchAccess", () => {
  test("sets last_access to a non-empty ISO-8601 timestamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-scoring-touch-"));
    mkdirSync(join(dir, ".claude", "hermes", "logs"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
    process.chdir(dir);
    try {
      const db = await shared.getSharedDb();
      const session = sessionsRepo.upsertSession(db, {
        key: "touch-key",
        scope: "test",
        source: "test",
        workspace: dir,
      });
      const id = messagesRepo.appendMessage(db, {
        sessionId: session.id,
        role: "user",
        content: "touched body",
      });

      const before = db
        .query<{ last_access: string | null }, [number]>("SELECT last_access FROM messages WHERE id = ?")
        .get(id);
      expect(before).not.toBeNull();
      expect(before!.last_access).toBeNull();

      scoring.touchAccess(db, id);

      const after = db
        .query<{ last_access: string | null }, [number]>("SELECT last_access FROM messages WHERE id = ?")
        .get(id);
      expect(after).not.toBeNull();
      expect(typeof after!.last_access).toBe("string");
      expect((after!.last_access ?? "").length).toBeGreaterThan(0);
      // ISO-8601 round-trips back to a valid Date.
      const parsed = new Date(after!.last_access!);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    } finally {
      await shared.resetSharedDbCache();
      process.chdir(tempRoot);
      await rmWithRetry(dir);
    }
  });
});

describe("searchWithScoring", () => {
  test("returns FTS hits sorted by descending score, all in [0, 1]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-scoring-search-"));
    mkdirSync(join(dir, ".claude", "hermes", "logs"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
    process.chdir(dir);
    try {
      const db = await shared.getSharedDb();
      const sessionA = sessionsRepo.upsertSession(db, {
        key: "search-A",
        scope: "test",
        source: "test",
        workspace: dir,
      });
      const sessionB = sessionsRepo.upsertSession(db, {
        key: "search-B",
        scope: "test",
        source: "test",
        workspace: dir,
      });

      const now = Date.now();
      // Vary ts AND importance so resulting scores diverge clearly.
      const seeds: Array<{
        sessionId: number;
        offsetHours: number;
        importance: number;
      }> = [
        { sessionId: sessionA.id, offsetHours: 0, importance: 10 },
        { sessionId: sessionA.id, offsetHours: 12, importance: 5 },
        { sessionId: sessionA.id, offsetHours: 72, importance: 2 },
        { sessionId: sessionB.id, offsetHours: 6, importance: 8 },
        { sessionId: sessionB.id, offsetHours: 36, importance: 4 },
        { sessionId: sessionB.id, offsetHours: 96, importance: 1 },
      ];
      for (const s of seeds) {
        const ts = new Date(now - s.offsetHours * 3600_000).toISOString();
        db.prepare(
          `INSERT INTO messages (session_id, ts, role, content, importance) VALUES (?, ?, ?, ?, ?)`
        ).run(s.sessionId, ts, "user", "marker-LOOKUP token body", s.importance);
      }

      const results = scoring.searchWithScoring(db, "marker-LOOKUP", {});

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(2);

      // Sorted descending by score.
      for (let i = 0; i + 1 < results.length; i++) {
        expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
      }

      // Each entry exposes the documented shape.
      for (const r of results) {
        expect(r).toHaveProperty("hit");
        expect(r).toHaveProperty("score");
        expect(r).toHaveProperty("row");
        expect(typeof r.score).toBe("number");
        expect(Number.isFinite(r.score)).toBe(true);
        // With DEFAULT_WEIGHTS summing to 1 and every component in [0,1],
        // the composite score must also be in [0, 1].
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(r.hit).toHaveProperty("messageId");
        expect(r.hit).toHaveProperty("sessionId");
        expect(r.row).toHaveProperty("role");
        expect(r.row).toHaveProperty("ts");
        expect(r.row).toHaveProperty("importance");
      }
    } finally {
      await shared.resetSharedDbCache();
      process.chdir(tempRoot);
      await rmWithRetry(dir);
    }
  });
});

describe("appendMessage back-compat", () => {
  test("user message containing 'TODO' auto-sets importance=8 via the heuristic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-scoring-append-todo-"));
    mkdirSync(join(dir, ".claude", "hermes", "logs"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
    process.chdir(dir);
    try {
      const db = await shared.getSharedDb();
      const session = sessionsRepo.upsertSession(db, {
        key: "append-todo-key",
        scope: "test",
        source: "test",
        workspace: dir,
      });

      const todoId = messagesRepo.appendMessage(db, {
        sessionId: session.id,
        role: "user",
        content: "TODO write the docs",
      });
      const plainId = messagesRepo.appendMessage(db, {
        sessionId: session.id,
        role: "user",
        content: "hello",
      });

      const todoRow = db
        .query<{ importance: number }, [number]>("SELECT importance FROM messages WHERE id = ?")
        .get(todoId);
      const plainRow = db
        .query<{ importance: number }, [number]>("SELECT importance FROM messages WHERE id = ?")
        .get(plainId);

      expect(todoRow).not.toBeNull();
      expect(plainRow).not.toBeNull();
      expect(todoRow!.importance).toBe(8);
      expect(plainRow!.importance).toBe(6);
    } finally {
      await shared.resetSharedDbCache();
      process.chdir(tempRoot);
      await rmWithRetry(dir);
    }
  });
});

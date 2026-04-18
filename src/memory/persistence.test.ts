/**
 * Specifies the message-persistence + FTS-search wiring inside execClaude.
 *
 * After a Claude turn resolves, the runner must persist BOTH the user
 * prompt and the assistant reply into the SQLite `messages` table, keyed
 * to the corresponding `sessions` row. Searches via `searchSessions`
 * must then surface those messages by FTS.
 *
 * Each test owns its own tempdir + workspace so they can run in any
 * order without bleeding state across cases.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../../tests/helpers/rm-with-retry";

const ORIG_CWD = process.cwd();
const FAKE_CLAUDE_ABS = join(ORIG_CWD, "tests", "fixtures", "fake-claude.ts");

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
  runner: typeof import("../runner");
  sessions: typeof import("../sessions");
  config: typeof import("../config");
  shared: typeof import("../state/shared-db");
  messagesRepo: typeof import("../state/repos/messages");
  sessionsRepo: typeof import("../state/repos/sessions");
  searchMod: typeof import("./search");
}

/**
 * Build a fresh isolated workspace: tempdir + min settings + chdir, then
 * import the modules under test so they capture the new cwd. Returns
 * everything the test needs plus a teardown closure.
 */
async function makeWorkspace(prefix: string): Promise<Workspace> {
  const rawDir = mkdtempSync(join(tmpdir(), `hermes-persist-${prefix}-`));
  mkdirSync(join(rawDir, ".claude", "hermes", "logs"), { recursive: true });
  writeFileSync(join(rawDir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.chdir(rawDir);
  // Use `process.cwd()` as the canonical workspace path so assertions match
  // whatever `persistTurn` stored. On macOS `os.tmpdir()` returns
  // `/var/folders/...` but `process.cwd()` after chdir reports the realpath
  // `/private/var/folders/...` — the symlink resolution would break
  // `sessionRow.workspace === ws.dir` asserts otherwise.
  const dir = process.cwd();
  process.env.HERMES_CLAUDE_BIN = `bun run ${FAKE_CLAUDE_ABS}`;

  const config = await import("../config");
  await config.loadSettings();
  const sessions = await import("../sessions");
  const runner = await import("../runner");
  const shared = await import("../state/shared-db");
  const messagesRepo = await import("../state/repos/messages");
  const sessionsRepo = await import("../state/repos/sessions");
  const searchMod = await import("./search");
  return { dir, runner, sessions, config, shared, messagesRepo, sessionsRepo, searchMod };
}

async function teardown(ws: Workspace): Promise<void> {
  try {
    await ws.sessions.resetSession();
  } catch {
    // session may already be cleared
  }
  await ws.shared.resetSharedDbCache();
  process.chdir(ORIG_CWD);
  await rmWithRetry(ws.dir);
}

afterEach(() => {
  // Clear fake-claude env per test so leftover toggles never bleed.
  delete process.env.HERMES_FAKE_DELAY_MS;
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_ECHO_PROMPT;
  delete process.env.HERMES_FAKE_SESSION_ID;
  delete process.env.HERMES_FAKE_RATE_LIMIT;
  delete process.env.HERMES_FAKE_EXIT;
  delete process.env.HERMES_FAKE_STDERR;
  delete process.env.HERMES_FAKE_SCENARIO_PATH;
});

afterAll(() => {
  delete process.env.HERMES_CLAUDE_BIN;
  process.chdir(ORIG_CWD);
});

describe("execClaude message persistence", () => {
  test("single turn persists user + assistant rows that share a session", async () => {
    const ws = await makeWorkspace("single");
    try {
      process.env.HERMES_FAKE_REPLY = "assistant-reply-MARKER-XYZ";
      process.env.HERMES_FAKE_SESSION_ID = "single-turn-session";
      const r = await ws.runner.run("task", "user-prompt-MARKER-ABC");
      expect(r.exitCode).toBe(0);

      const db = await ws.shared.getSharedDb();
      const rows = db
        .query<{ id: number; session_id: number; role: string; content: string }, []>(
          "SELECT id, session_id, role, content FROM messages ORDER BY id ASC"
        )
        .all();
      expect(rows.length).toBe(2);

      const userRow = rows.find((r) => r.role === "user");
      const asstRow = rows.find((r) => r.role === "assistant");
      expect(userRow).toBeDefined();
      expect(asstRow).toBeDefined();
      expect(userRow!.content).toContain("user-prompt-MARKER-ABC");
      expect(asstRow!.content).toContain("assistant-reply-MARKER-XYZ");
      expect(userRow!.session_id).toBe(asstRow!.session_id);

      const sessionRow = ws.sessionsRepo.getById(db, userRow!.session_id);
      expect(sessionRow).not.toBeNull();
      expect(sessionRow!.source).toBe("cli");
      expect(sessionRow!.workspace).toBe(ws.dir);
      expect(sessionRow!.claude_session_id).not.toBeNull();
      expect(typeof sessionRow!.claude_session_id).toBe("string");
      expect((sessionRow!.claude_session_id ?? "").length).toBeGreaterThan(0);
    } finally {
      await teardown(ws);
    }
  });

  test("multi-turn resume persists both turns into the same sessions row", async () => {
    const ws = await makeWorkspace("multi");
    try {
      process.env.HERMES_FAKE_SESSION_ID = "multi-turn-session";
      process.env.HERMES_FAKE_REPLY = "assistant-turn-1";
      const r1 = await ws.runner.run("task", "user-prompt-1");
      expect(r1.exitCode).toBe(0);

      process.env.HERMES_FAKE_REPLY = "assistant-turn-2";
      const r2 = await ws.runner.run("task", "user-prompt-2");
      expect(r2.exitCode).toBe(0);

      const db = await ws.shared.getSharedDb();
      const rows = db
        .query<{ id: number; session_id: number; role: string; content: string }, []>(
          "SELECT id, session_id, role, content FROM messages ORDER BY id ASC"
        )
        .all();
      expect(rows.length).toBe(4);

      const sessionIds = new Set(rows.map((r) => r.session_id));
      expect(sessionIds.size).toBe(1);

      const userRows = rows.filter((r) => r.role === "user");
      const asstRows = rows.filter((r) => r.role === "assistant");
      expect(userRows.length).toBe(2);
      expect(asstRows.length).toBe(2);
      expect(userRows.some((r) => r.content.includes("user-prompt-1"))).toBe(true);
      expect(userRows.some((r) => r.content.includes("user-prompt-2"))).toBe(true);
      expect(asstRows.some((r) => r.content.includes("assistant-turn-1"))).toBe(true);
      expect(asstRows.some((r) => r.content.includes("assistant-turn-2"))).toBe(true);
    } finally {
      await teardown(ws);
    }
  });

  test("thread-scoped run routes messages to its own session row", async () => {
    const ws = await makeWorkspace("thread");
    try {
      process.env.HERMES_FAKE_REPLY = "discord-assistant-reply";
      process.env.HERMES_FAKE_SESSION_ID = "discord-claude-session";
      const r = await ws.runner.run("discord", "prompt-A", "channel-123", undefined, "discord");
      expect(r.exitCode).toBe(0);

      const db = await ws.shared.getSharedDb();
      const threadSession = ws.sessionsRepo.getByKey(db, "discord:channel-123");
      expect(threadSession).not.toBeNull();
      expect(threadSession!.source).toBe("discord");

      const rows = db
        .query<{ session_id: number; role: string; content: string }, [number]>(
          "SELECT session_id, role, content FROM messages WHERE session_id = ? ORDER BY id ASC"
        )
        .all(threadSession!.id);
      expect(rows.length).toBe(2);
      expect(rows.some((r) => r.role === "user" && r.content.includes("prompt-A"))).toBe(true);
      expect(rows.some((r) => r.role === "assistant" && r.content.includes("discord-assistant-reply"))).toBe(
        true
      );

      // No cli row should have been created for this thread-scoped run.
      const allRows = db.query<{ session_id: number }, []>("SELECT session_id FROM messages").all();
      const otherSessionIds = allRows.map((r) => r.session_id).filter((id) => id !== threadSession!.id);
      expect(otherSessionIds.length).toBe(0);
    } finally {
      await teardown(ws);
    }
  });

  test("FTS search finds tokens written across separate runs", async () => {
    const ws = await makeWorkspace("fts");
    try {
      process.env.HERMES_FAKE_SESSION_ID = "fts-session";
      process.env.HERMES_FAKE_REPLY = "ok-1";
      const r1 = await ws.runner.run("task", "alpha-token-QQQ first prompt");
      expect(r1.exitCode).toBe(0);

      process.env.HERMES_FAKE_REPLY = "ok-2";
      const r2 = await ws.runner.run("task", "beta-token-WWW second prompt");
      expect(r2.exitCode).toBe(0);

      const db = await ws.shared.getSharedDb();

      // Quote the queries so FTS5 treats hyphens as literals (otherwise
      // they parse as the NEAR/NOT operator and the lookup blows up before
      // it reaches our data).
      const alphaHits = ws.searchMod.searchSessions(db, { query: '"alpha-token-QQQ"' });
      expect(alphaHits.length).toBeGreaterThanOrEqual(1);

      const betaHits = ws.searchMod.searchSessions(db, { query: '"beta-token-WWW"' });
      expect(betaHits.length).toBeGreaterThanOrEqual(1);

      const missHits = ws.searchMod.searchSessions(db, { query: '"zeta-nonexistent"' });
      expect(missHits.length).toBe(0);
    } finally {
      await teardown(ws);
    }
  });

  test("a freshly migrated DB has zero messages before any run", async () => {
    const ws = await makeWorkspace("fresh");
    try {
      const db = await ws.shared.getSharedDb();
      const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM messages").get();
      expect(row).not.toBeNull();
      expect(row!.count).toBe(0);
    } finally {
      await teardown(ws);
    }
  });

  test("persistence failure is swallowed — runner.run still returns the Claude reply", async () => {
    const ws = await makeWorkspace("nonfatal");
    try {
      // Force the messages table to disappear AFTER migrations have run, so
      // any appendMessage call inside execClaude raises a SQLite error. The
      // runner must catch that error and still hand the user the model's
      // reply — persistence is a best-effort sidecar, never load-bearing.
      const db = await ws.shared.getSharedDb();
      db.exec("DROP TABLE IF EXISTS messages_fts;");
      db.exec("DROP TABLE IF EXISTS messages;");

      process.env.HERMES_FAKE_REPLY = "still-served-despite-db-failure";
      process.env.HERMES_FAKE_SESSION_ID = "nonfatal-session";
      const r = await ws.runner.run("task", "user prompt that cannot be persisted");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("still-served-despite-db-failure");
    } finally {
      await teardown(ws);
    }
  });
});

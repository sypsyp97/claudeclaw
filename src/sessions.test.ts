import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_CWD = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "hermes-session-"));
const HERMES_DIR = join(tempRoot, ".claude", "hermes");
await mkdir(HERMES_DIR, { recursive: true });
process.chdir(tempRoot);

// Imported AFTER chdir so the module's lazy path resolution points at our tmp.
const sessions = await import("./sessions");
const { sessionFile, hermesDir } = await import("./paths");

beforeAll(async () => {
  await sessions.resetSession();
});

beforeEach(async () => {
  // Clear filesystem + the module's cached `current` between tests.
  await sessions.resetSession();
  // Also nuke any leftover backup files so indices start fresh.
  let entries: string[] = [];
  try {
    entries = await readdir(hermesDir());
  } catch {
    entries = [];
  }
  for (const f of entries) {
    if (/^session_\d+\.backup$/.test(f)) {
      await unlink(join(hermesDir(), f)).catch(() => {});
    }
  }
});

afterAll(async () => {
  process.chdir(ORIGINAL_CWD);
  await rm(tempRoot, { recursive: true, force: true });
});

describe("getSession", () => {
  test("returns null when no session file exists", async () => {
    const s = await sessions.getSession();
    expect(s).toBeNull();
  });

  test("returns session data when file exists", async () => {
    await sessions.createSession("claude-abc-123");
    const s = await sessions.getSession();
    expect(s?.sessionId).toBe("claude-abc-123");
    expect(s?.turnCount).toBe(0);
    expect(s?.compactWarned).toBe(false);
  });

  test("backfills missing turnCount / compactWarned on older files", async () => {
    // Write a legacy-shaped file directly — no turnCount / compactWarned.
    const legacy = { sessionId: "old", createdAt: "2024-01-01T00:00:00.000Z" };
    await writeFile(sessionFile(), JSON.stringify(legacy), "utf8");
    // Drop the cache so the loader re-reads from disk.
    await sessions.resetSession();
    // resetSession also unlinks the file — write it back.
    await writeFile(sessionFile(), JSON.stringify(legacy), "utf8");

    const s = await sessions.getSession();
    expect(s?.sessionId).toBe("old");
    expect(s?.turnCount).toBe(0);
    expect(s?.compactWarned).toBe(false);

    const onDisk = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(onDisk.turnCount).toBe(0);
    expect(onDisk.compactWarned).toBe(false);
  });

  test("bumps lastUsedAt on every getSession call", async () => {
    await sessions.createSession("live");
    const peek1 = await sessions.peekSession();
    const first = peek1?.lastUsedAt;

    await new Promise((r) => setTimeout(r, 10));
    await sessions.getSession();

    const peek2 = await sessions.peekSession();
    expect(peek2?.lastUsedAt).not.toBe(first);
  });
});

describe("createSession", () => {
  test("writes a new session file with defaults", async () => {
    await sessions.createSession("new-session-id");
    const raw = await readFile(sessionFile(), "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.sessionId).toBe("new-session-id");
    expect(parsed.turnCount).toBe(0);
    expect(parsed.compactWarned).toBe(false);
    expect(parsed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("overwrites an existing session", async () => {
    await sessions.createSession("first");
    await sessions.createSession("second");
    const s = await sessions.getSession();
    expect(s?.sessionId).toBe("second");
  });

  test("file ends with a trailing newline (JSON-pretty-print)", async () => {
    await sessions.createSession("nl");
    const raw = await readFile(sessionFile(), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    // And is human-readable (has at least one indentation space).
    expect(raw).toContain("\n  ");
  });
});

describe("peekSession", () => {
  test("returns null when no file exists", async () => {
    const p = await sessions.peekSession();
    expect(p).toBeNull();
  });

  test("returns the raw stored session without mutating lastUsedAt", async () => {
    await sessions.createSession("peek-test");
    const p1 = await sessions.peekSession();
    const ts1 = p1?.lastUsedAt;
    await new Promise((r) => setTimeout(r, 10));
    const p2 = await sessions.peekSession();
    expect(p2?.lastUsedAt).toBe(ts1);
  });
});

describe("incrementTurn", () => {
  test("returns 0 and does not create a file when no session exists", async () => {
    const n = await sessions.incrementTurn();
    expect(n).toBe(0);
    const p = await sessions.peekSession();
    expect(p).toBeNull();
  });

  test("increments by 1 per call and persists", async () => {
    await sessions.createSession("inc");
    expect(await sessions.incrementTurn()).toBe(1);
    expect(await sessions.incrementTurn()).toBe(2);
    expect(await sessions.incrementTurn()).toBe(3);

    const raw = await readFile(sessionFile(), "utf8");
    expect(JSON.parse(raw).turnCount).toBe(3);
  });

  test("starts from 0 when turnCount is missing in a legacy file", async () => {
    // Seed a legacy session file directly.
    await writeFile(
      sessionFile(),
      JSON.stringify({
        sessionId: "legacy",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastUsedAt: "2024-01-01T00:00:00.000Z",
      })
    );
    await sessions.resetSession();
    await writeFile(
      sessionFile(),
      JSON.stringify({
        sessionId: "legacy",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastUsedAt: "2024-01-01T00:00:00.000Z",
      })
    );

    const n = await sessions.incrementTurn();
    expect(n).toBe(1);
  });
});

describe("markCompactWarned", () => {
  test("no-ops silently when no session file exists", async () => {
    await sessions.markCompactWarned();
    expect(await sessions.peekSession()).toBeNull();
  });

  test("sets compactWarned=true and persists", async () => {
    await sessions.createSession("warn");
    await sessions.markCompactWarned();
    const s = await sessions.getSession();
    expect(s?.compactWarned).toBe(true);

    const raw = await readFile(sessionFile(), "utf8");
    expect(JSON.parse(raw).compactWarned).toBe(true);
  });

  test("idempotent when called twice", async () => {
    await sessions.createSession("warn2");
    await sessions.markCompactWarned();
    await sessions.markCompactWarned();
    expect((await sessions.getSession())?.compactWarned).toBe(true);
  });
});

describe("resetSession", () => {
  test("removes the session file if present", async () => {
    await sessions.createSession("r");
    await sessions.resetSession();
    const s = await sessions.getSession();
    expect(s).toBeNull();
  });

  test("is a no-op when no file exists", async () => {
    await sessions.resetSession();
    // Should still be able to call again without throwing.
    await sessions.resetSession();
    expect(await sessions.getSession()).toBeNull();
  });
});

describe("backupSession", () => {
  test("returns null when no session exists", async () => {
    const name = await sessions.backupSession();
    expect(name).toBeNull();
  });

  test("renames session.json to session_1.backup on first call", async () => {
    await sessions.createSession("bk");
    const name = await sessions.backupSession();
    expect(name).toBe("session_1.backup");

    // session.json is gone.
    expect(await sessions.peekSession()).toBeNull();

    // backup file exists.
    const backup = JSON.parse(await readFile(join(hermesDir(), "session_1.backup"), "utf8"));
    expect(backup.sessionId).toBe("bk");
  });

  test("picks the next index when backups already exist", async () => {
    await sessions.createSession("a");
    await sessions.backupSession(); // session_1.backup

    await sessions.createSession("b");
    const second = await sessions.backupSession();
    expect(second).toBe("session_2.backup");

    await sessions.createSession("c");
    const third = await sessions.backupSession();
    expect(third).toBe("session_3.backup");
  });
});

describe("cache is keyed by resolved session file path (cwd-aware)", () => {
  // If the cache were not path-keyed, a process.chdir into a second workspace
  // would return the first workspace's session forever.
  test("chdir to a second workspace returns its own session, not the first", async () => {
    await sessions.createSession("ws-A");
    const a = await sessions.getSession();
    expect(a?.sessionId).toBe("ws-A");

    const secondRoot = await mkdtemp(join(tmpdir(), "hermes-session-B-"));
    await mkdir(join(secondRoot, ".claude", "hermes"), { recursive: true });
    const firstRoot = process.cwd();
    try {
      process.chdir(secondRoot);
      const fresh = await sessions.getSession();
      expect(fresh).toBeNull();

      await sessions.createSession("ws-B");
      const b = await sessions.getSession();
      expect(b?.sessionId).toBe("ws-B");
    } finally {
      process.chdir(firstRoot);
      await rm(secondRoot, { recursive: true, force: true });
    }

    // Back in workspace A the original session must still resolve.
    const backInA = await sessions.getSession();
    expect(backInA?.sessionId).toBe("ws-A");
  });
});

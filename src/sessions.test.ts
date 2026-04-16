import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../tests/helpers/rm-with-retry";
import { resetSharedDbCache } from "./state/shared-db";

const ORIGINAL_CWD = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "hermes-session-"));
const HERMES_DIR = join(tempRoot, ".claude", "hermes");
await mkdir(HERMES_DIR, { recursive: true });
process.chdir(tempRoot);

// Imported AFTER chdir so lazy path resolution inside the module points at tmp.
const sessions = await import("./sessions");
const { hermesDir } = await import("./paths");

beforeAll(async () => {
  await sessions.resetSession();
});

beforeEach(async () => {
  await sessions.resetSession();
  // Drop any leftover backup files so indices start fresh each test.
  const { readdir, unlink } = await import("node:fs/promises");
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
  await resetSharedDbCache();
  process.chdir(ORIGINAL_CWD);
  await rmWithRetry(tempRoot);
});

describe("getSession", () => {
  test("returns null when no session exists", async () => {
    expect(await sessions.getSession()).toBeNull();
  });

  test("returns session data when one has been created", async () => {
    await sessions.createSession("claude-abc-123");
    const s = await sessions.getSession();
    expect(s?.sessionId).toBe("claude-abc-123");
    expect(s?.turnCount).toBe(0);
    expect(s?.compactWarned).toBe(false);
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
  test("initialises turnCount=0 and compactWarned=false", async () => {
    await sessions.createSession("new-session-id");
    const s = await sessions.peekSession();
    expect(s?.sessionId).toBe("new-session-id");
    expect(s?.turnCount).toBe(0);
    expect(s?.compactWarned).toBe(false);
    expect(s?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s?.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("replaces an existing session and resets counters", async () => {
    await sessions.createSession("first");
    // Bump counters so we can see the replace clears them.
    await sessions.incrementTurn();
    await sessions.markCompactWarned();
    await sessions.createSession("second");
    const s = await sessions.peekSession();
    expect(s?.sessionId).toBe("second");
    expect(s?.turnCount).toBe(0);
    expect(s?.compactWarned).toBe(false);
  });
});

describe("peekSession", () => {
  test("returns null when no session exists", async () => {
    expect(await sessions.peekSession()).toBeNull();
  });

  test("does not mutate lastUsedAt", async () => {
    await sessions.createSession("peek-test");
    const p1 = await sessions.peekSession();
    const ts1 = p1?.lastUsedAt;
    await new Promise((r) => setTimeout(r, 10));
    const p2 = await sessions.peekSession();
    expect(p2?.lastUsedAt).toBe(ts1);
  });
});

describe("incrementTurn", () => {
  test("returns 0 and does not create a session when none exists", async () => {
    expect(await sessions.incrementTurn()).toBe(0);
    expect(await sessions.peekSession()).toBeNull();
  });

  test("increments by 1 per call and persists", async () => {
    await sessions.createSession("inc");
    expect(await sessions.incrementTurn()).toBe(1);
    expect(await sessions.incrementTurn()).toBe(2);
    expect(await sessions.incrementTurn()).toBe(3);
    const s = await sessions.peekSession();
    expect(s?.turnCount).toBe(3);
  });
});

describe("markCompactWarned", () => {
  test("no-ops silently when no session exists", async () => {
    await sessions.markCompactWarned();
    expect(await sessions.peekSession()).toBeNull();
  });

  test("sets compactWarned=true and persists", async () => {
    await sessions.createSession("warn");
    await sessions.markCompactWarned();
    const s = await sessions.getSession();
    expect(s?.compactWarned).toBe(true);
  });

  test("idempotent when called twice", async () => {
    await sessions.createSession("warn2");
    await sessions.markCompactWarned();
    await sessions.markCompactWarned();
    expect((await sessions.getSession())?.compactWarned).toBe(true);
  });
});

describe("resetSession", () => {
  test("removes the session if present", async () => {
    await sessions.createSession("r");
    await sessions.resetSession();
    expect(await sessions.getSession()).toBeNull();
  });

  test("is a no-op when no session exists", async () => {
    await sessions.resetSession();
    await sessions.resetSession();
    expect(await sessions.getSession()).toBeNull();
  });
});

describe("backupSession", () => {
  test("returns null when no session exists", async () => {
    expect(await sessions.backupSession()).toBeNull();
  });

  test("writes session_1.backup on first call and deletes the DB row", async () => {
    await sessions.createSession("bk");
    const name = await sessions.backupSession();
    expect(name).toBe("session_1.backup");

    expect(await sessions.peekSession()).toBeNull();

    const backup = JSON.parse(await readFile(join(hermesDir(), "session_1.backup"), "utf8"));
    expect(backup.sessionId).toBe("bk");
  });

  test("picks the next index when backups already exist", async () => {
    await sessions.createSession("a");
    await sessions.backupSession();

    await sessions.createSession("b");
    expect(await sessions.backupSession()).toBe("session_2.backup");

    await sessions.createSession("c");
    expect(await sessions.backupSession()).toBe("session_3.backup");
  });
});

describe("chdir awareness", () => {
  test("a second workspace returns its own session, not the first", async () => {
    await sessions.createSession("ws-A");
    expect((await sessions.getSession())?.sessionId).toBe("ws-A");

    const secondRoot = await mkdtemp(join(tmpdir(), "hermes-session-B-"));
    await mkdir(join(secondRoot, ".claude", "hermes"), { recursive: true });
    const firstRoot = process.cwd();
    try {
      process.chdir(secondRoot);
      expect(await sessions.getSession()).toBeNull();
      await sessions.createSession("ws-B");
      expect((await sessions.getSession())?.sessionId).toBe("ws-B");
    } finally {
      process.chdir(firstRoot);
      // Close any cached DB handle on the second workspace before rm
      // so Windows will release the tempdir.
      await resetSharedDbCache();
      await rmWithRetry(secondRoot);
    }

    expect((await sessions.getSession())?.sessionId).toBe("ws-A");
  });
});

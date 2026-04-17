import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../tests/helpers/rm-with-retry";
import { resetSharedDbCache } from "./state/shared-db";

const ORIG_CWD = process.cwd();
let tempRoot: string;
let mgr: typeof import("./sessionManager");

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-sessmgr-"));
  await mkdir(join(tempRoot, ".claude", "hermes"), { recursive: true });
  process.chdir(tempRoot);
  mgr = await import("./sessionManager");
});

afterAll(async () => {
  await resetSharedDbCache();
  process.chdir(ORIG_CWD);
  await rmWithRetry(tempRoot);
});

async function clearSessions(): Promise<void> {
  const existing = await mgr.listThreadSessions();
  for (const s of existing) {
    await mgr.removeThreadSession(s.source, s.threadId);
  }
}

beforeEach(async () => {
  await clearSessions();
});

describe("getThreadSession", () => {
  test("returns null when no session exists for the thread", async () => {
    expect(await mgr.getThreadSession("discord", "missing")).toBeNull();
  });

  test("returns shape {sessionId, turnCount, compactWarned} after create", async () => {
    await mgr.createThreadSession("discord", "t1", "session-abc");
    expect(await mgr.getThreadSession("discord", "t1")).toEqual({
      sessionId: "session-abc",
      turnCount: 0,
      compactWarned: false,
    });
  });

  test("isolates sessions by source — same threadId under two sources does not collide", async () => {
    await mgr.createThreadSession("discord", "same-id", "claude-discord");
    await mgr.createThreadSession("telegram", "same-id", "claude-telegram");
    expect((await mgr.getThreadSession("discord", "same-id"))?.sessionId).toBe("claude-discord");
    expect((await mgr.getThreadSession("telegram", "same-id"))?.sessionId).toBe("claude-telegram");
  });
});

describe("createThreadSession", () => {
  test("initialises turnCount=0 and compactWarned=false", async () => {
    await mgr.createThreadSession("discord", "t-init", "sess-1");
    const peek = await mgr.peekThreadSession("discord", "t-init");
    expect(peek).not.toBeNull();
    expect(peek?.turnCount).toBe(0);
    expect(peek?.compactWarned).toBe(false);
    expect(peek?.sessionId).toBe("sess-1");
    expect(peek?.threadId).toBe("t-init");
    expect(peek?.source).toBe("discord");
    expect(typeof peek?.createdAt).toBe("string");
    expect(typeof peek?.lastUsedAt).toBe("string");
  });

  test("replaces and resets counters on same (source, threadId)", async () => {
    await mgr.createThreadSession("discord", "t-same", "first");
    await mgr.incrementThreadTurn("discord", "t-same");
    await mgr.markThreadCompactWarned("discord", "t-same");
    await mgr.createThreadSession("discord", "t-same", "second");
    const peek = await mgr.peekThreadSession("discord", "t-same");
    expect(peek?.sessionId).toBe("second");
    expect(peek?.turnCount).toBe(0);
    expect(peek?.compactWarned).toBe(false);
  });
});

describe("removeThreadSession", () => {
  test("removes an existing session", async () => {
    await mgr.createThreadSession("discord", "t-del", "s");
    await mgr.removeThreadSession("discord", "t-del");
    expect(await mgr.peekThreadSession("discord", "t-del")).toBeNull();
  });

  test("idempotent — removing a missing threadId does not throw", async () => {
    await expect(mgr.removeThreadSession("discord", "never-existed")).resolves.toBeUndefined();
    await mgr.removeThreadSession("discord", "never-existed");
  });

  test("only removes the matching source's row", async () => {
    await mgr.createThreadSession("discord", "shared", "d");
    await mgr.createThreadSession("telegram", "shared", "t");
    await mgr.removeThreadSession("discord", "shared");
    expect(await mgr.peekThreadSession("discord", "shared")).toBeNull();
    expect(await mgr.peekThreadSession("telegram", "shared")).not.toBeNull();
  });

  // Regression: the shared-db cache re-runs importLegacyJson on every fresh
  // boot, so a legacy `sessions.json` left on disk would silently revive any
  // thread session a caller had just removed. `removeThreadSession` must also
  // strip the entry from the legacy JSON so a daemon restart doesn't undo it.
  test("survives a shared-db cache reset: deleted thread does not come back from legacy JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { threadSessionsFile } = await import("./paths");
    await writeFile(
      threadSessionsFile(),
      JSON.stringify({ threads: { "ghost-thread": { sessionId: "legacy-session-xyz" } } }),
      "utf8"
    );

    // Fresh open re-imports → the thread shows up in SQLite.
    await resetSharedDbCache();
    expect((await mgr.peekThreadSession("discord", "ghost-thread"))?.sessionId).toBe("legacy-session-xyz");

    // Remove → SQLite row gone.
    await mgr.removeThreadSession("discord", "ghost-thread");
    expect(await mgr.peekThreadSession("discord", "ghost-thread")).toBeNull();

    // Simulate a daemon restart: cache reset triggers another importer pass.
    // If the legacy JSON still had the entry, the thread would return here.
    await resetSharedDbCache();
    expect(await mgr.peekThreadSession("discord", "ghost-thread")).toBeNull();
  });
});

describe("incrementThreadTurn", () => {
  test("increments by 1 and returns the new value", async () => {
    await mgr.createThreadSession("discord", "t-inc", "sess");
    expect(await mgr.incrementThreadTurn("discord", "t-inc")).toBe(1);
    expect(await mgr.incrementThreadTurn("discord", "t-inc")).toBe(2);
    expect(await mgr.incrementThreadTurn("discord", "t-inc")).toBe(3);
  });

  test("returns 0 when the session is missing", async () => {
    expect(await mgr.incrementThreadTurn("discord", "ghost")).toBe(0);
  });

  test("persists the incremented count so peek sees it", async () => {
    await mgr.createThreadSession("discord", "t-persist", "sess");
    await mgr.incrementThreadTurn("discord", "t-persist");
    await mgr.incrementThreadTurn("discord", "t-persist");
    expect((await mgr.peekThreadSession("discord", "t-persist"))?.turnCount).toBe(2);
  });
});

describe("listThreadSessions", () => {
  test("returns empty array when nothing created", async () => {
    expect(await mgr.listThreadSessions()).toEqual([]);
  });

  test("returns every thread session created", async () => {
    await mgr.createThreadSession("discord", "a", "sa");
    await mgr.createThreadSession("discord", "b", "sb");
    await mgr.createThreadSession("telegram", "c", "sc");
    const list = await mgr.listThreadSessions();
    const ids = list.map((s) => s.threadId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    const sources = list.map((s) => `${s.source}:${s.threadId}`).sort();
    expect(sources).toEqual(["discord:a", "discord:b", "telegram:c"]);
  });
});

describe("peekThreadSession", () => {
  test("returns null for missing thread", async () => {
    expect(await mgr.peekThreadSession("discord", "nope")).toBeNull();
  });

  test("does NOT update lastUsedAt", async () => {
    await mgr.createThreadSession("discord", "t-peek", "sess");
    const before = (await mgr.peekThreadSession("discord", "t-peek"))?.lastUsedAt;
    await new Promise((r) => setTimeout(r, 10));
    await mgr.peekThreadSession("discord", "t-peek");
    const after = (await mgr.peekThreadSession("discord", "t-peek"))?.lastUsedAt;
    expect(after).toBe(before);
  });

  test("getThreadSession DOES update lastUsedAt", async () => {
    await mgr.createThreadSession("discord", "t-touch", "sess");
    const before = (await mgr.peekThreadSession("discord", "t-touch"))?.lastUsedAt;
    await new Promise((r) => setTimeout(r, 10));
    await mgr.getThreadSession("discord", "t-touch");
    const after = (await mgr.peekThreadSession("discord", "t-touch"))?.lastUsedAt;
    expect(after).not.toBe(before);
  });
});

describe("markThreadCompactWarned", () => {
  test("flips compactWarned from false to true", async () => {
    await mgr.createThreadSession("discord", "t-warn", "sess");
    await mgr.markThreadCompactWarned("discord", "t-warn");
    expect((await mgr.peekThreadSession("discord", "t-warn"))?.compactWarned).toBe(true);
  });

  test("is a no-op on missing thread", async () => {
    await expect(mgr.markThreadCompactWarned("discord", "ghost")).resolves.toBeUndefined();
  });
});

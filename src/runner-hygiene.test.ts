import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_CWD = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "hermes-runner-hygiene-"));
await mkdir(join(tempRoot, ".claude", "hermes"), { recursive: true });
process.chdir(tempRoot);

const { _enqueueForTest, _threadQueueSize } = await import("./runner");

afterAll(async () => {
  process.chdir(ORIGINAL_CWD);
  await rm(tempRoot, { recursive: true, force: true });
});

describe("threadQueues hygiene", () => {
  test("starts empty (no queues created until a threaded task runs)", () => {
    expect(_threadQueueSize()).toBe(0);
  });

  test("threaded task: slot is reclaimed after the task settles", async () => {
    const threadId = "thread-cleanup-1";
    const before = _threadQueueSize();
    await _enqueueForTest(async () => "ok", threadId);
    // Give microtasks a tick — the cleanup runs in a tracked.finally().
    await Promise.resolve();
    await Promise.resolve();
    expect(_threadQueueSize()).toBe(before);
  });

  test("threaded task that rejects still reclaims its slot", async () => {
    const threadId = "thread-cleanup-2";
    const before = _threadQueueSize();
    await expect(
      _enqueueForTest(async () => {
        throw new Error("boom");
      }, threadId)
    ).rejects.toThrow("boom");
    await Promise.resolve();
    await Promise.resolve();
    expect(_threadQueueSize()).toBe(before);
  });

  test("concurrent enqueues on the same thread collapse to one slot, and release it at the end", async () => {
    const threadId = "thread-cleanup-3";
    const before = _threadQueueSize();
    // Three tasks on the same thread run serially. At most one slot is held
    // at any given moment, and by the time all three settle it is gone.
    const a = _enqueueForTest(async () => 1, threadId);
    const b = _enqueueForTest(async () => 2, threadId);
    const c = _enqueueForTest(async () => 3, threadId);
    expect([await a, await b, await c]).toEqual([1, 2, 3]);
    await Promise.resolve();
    await Promise.resolve();
    expect(_threadQueueSize()).toBe(before);
  });

  test("distinct threadIds get distinct slots, each reclaimed independently", async () => {
    const before = _threadQueueSize();
    await Promise.all([
      _enqueueForTest(async () => "a", "thread-A"),
      _enqueueForTest(async () => "b", "thread-B"),
      _enqueueForTest(async () => "c", "thread-C"),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(_threadQueueSize()).toBe(before);
  });

  // Two bridges (e.g. Discord + Telegram) can mint the same bare thread-id
  // string. The session key contract already scopes them with `source` —
  // `thread:<source>:<id>` — and the queue must follow suit, otherwise
  // unrelated channels get forced onto the same serial lane for no reason.
  test("same thread-id from different sources runs in parallel, not serialized", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    async function task(): Promise<void> {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 80));
      inFlight--;
    }

    const sharedThreadId = "overlap-123";
    await Promise.all([
      _enqueueForTest(task, sharedThreadId, "discord"),
      _enqueueForTest(task, sharedThreadId, "telegram"),
    ]);

    expect(peakInFlight).toBe(2);
    await Promise.resolve();
    await Promise.resolve();
  });

  test("same thread-id AND same source still serializes (identity collision, not just id)", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    async function task(): Promise<void> {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
    }

    const threadId = "serialize-me";
    await Promise.all([
      _enqueueForTest(task, threadId, "discord"),
      _enqueueForTest(task, threadId, "discord"),
    ]);

    expect(peakInFlight).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
  });
});

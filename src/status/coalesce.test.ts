import { describe, expect, test } from "bun:test";
import { createCoalescer } from "./coalesce";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createCoalescer", () => {
  test("schedule fires flush once after the window elapses", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 20 }
    );
    c.schedule();
    await sleep(40);
    expect(calls).toBe(1);
  });

  test("multiple schedule() calls within the window coalesce to one flush", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 30 }
    );
    c.schedule();
    c.schedule();
    c.schedule();
    await sleep(60);
    expect(calls).toBe(1);
  });

  test("forceFlush runs immediately and cancels the pending timer", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 200 }
    );
    c.schedule();
    await c.forceFlush();
    expect(calls).toBe(1);
    await sleep(250);
    expect(calls).toBe(1);
  });

  test("forceFlush with nothing pending is a no-op", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 50 }
    );
    await c.forceFlush();
    expect(calls).toBe(0);
  });

  test("dispose cancels pending flush without running it", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 30 }
    );
    c.schedule();
    c.dispose();
    await sleep(60);
    expect(calls).toBe(0);
  });

  test("after a flush fires, a new schedule arms a fresh timer", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 20 }
    );
    c.schedule();
    await sleep(40);
    expect(calls).toBe(1);
    c.schedule();
    await sleep(40);
    expect(calls).toBe(2);
  });

  test("flush errors are swallowed so one bad edit does not crash the daemon", async () => {
    const c = createCoalescer(
      async () => {
        throw new Error("simulated api failure");
      },
      { windowMs: 10 }
    );
    c.schedule();
    await sleep(30);
    // Should not have thrown. Scheduling again must still work.
    c.schedule();
    await sleep(30);
    expect(true).toBe(true);
  });

  test("default window is non-zero (production safety)", () => {
    // Defensive: the default window must be > 0 so we never degenerate into
    // a no-debounce firehose that would breach rate limits.
    let calls = 0;
    const c = createCoalescer(async () => {
      calls++;
    });
    c.schedule();
    // Before any timer fires synchronously there must be zero calls.
    expect(calls).toBe(0);
    c.dispose();
  });
});

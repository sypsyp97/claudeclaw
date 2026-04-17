import { describe, expect, test } from "bun:test";
import type { Job } from "./jobs";
import { executeScheduledJob } from "./scheduler";

function job(overrides: Partial<Job> = {}): Job {
  return {
    name: "demo",
    schedule: "* * * * *",
    prompt: "hello",
    recurring: false,
    notify: true,
    ...overrides,
  };
}

function okResult(exitCode = 0) {
  return { stdout: "out", stderr: "", exitCode };
}

describe("executeScheduledJob — one-shot lifecycle", () => {
  test("success: clears schedule exactly once", async () => {
    const cleared: string[] = [];
    await executeScheduledJob(job({ name: "green", recurring: false }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(0),
      clearJobSchedule: async (name) => {
        cleared.push(name);
      },
    });
    expect(cleared).toEqual(["green"]);
  });

  test("non-zero exit: does NOT clear schedule (one-shot retry stays scheduled)", async () => {
    const cleared: string[] = [];
    await executeScheduledJob(job({ name: "red", recurring: false }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(2),
      clearJobSchedule: async (name) => {
        cleared.push(name);
      },
    });
    expect(cleared).toEqual([]);
  });

  test("run() throws: does NOT clear schedule; error flows to onError hook", async () => {
    const cleared: string[] = [];
    const errors: unknown[] = [];
    await executeScheduledJob(job({ name: "boom", recurring: false }), {
      resolvePrompt: async (p) => p,
      run: async () => {
        throw new Error("spawn crashed");
      },
      clearJobSchedule: async (name) => {
        cleared.push(name);
      },
      onError: (err) => errors.push(err),
    });
    expect(cleared).toEqual([]);
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("spawn crashed");
  });

  test("resolvePrompt throws: does NOT clear schedule, does NOT run", async () => {
    const cleared: string[] = [];
    let ran = false;
    const errors: unknown[] = [];
    await executeScheduledJob(job({ name: "prompt-fail" }), {
      resolvePrompt: async () => {
        throw new Error("prompt file gone");
      },
      run: async () => {
        ran = true;
        return okResult(0);
      },
      clearJobSchedule: async (name) => {
        cleared.push(name);
      },
      onError: (err) => errors.push(err),
    });
    expect(ran).toBe(false);
    expect(cleared).toEqual([]);
    expect(errors.length).toBe(1);
  });

  test("recurring job on success: does NOT clear schedule", async () => {
    const cleared: string[] = [];
    await executeScheduledJob(job({ name: "loop", recurring: true }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(0),
      clearJobSchedule: async (name) => {
        cleared.push(name);
      },
    });
    expect(cleared).toEqual([]);
  });

  test("recurring job on failure: does NOT clear schedule (unchanged from recurring semantics)", async () => {
    const cleared: string[] = [];
    await executeScheduledJob(job({ name: "loop-fail", recurring: true }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(1),
      clearJobSchedule: async (name) => {
        cleared.push(name);
      },
    });
    expect(cleared).toEqual([]);
  });
});

describe("executeScheduledJob — forwarding (notify)", () => {
  test("notify=true: forwards regardless of exit code", async () => {
    const forwarded: Array<{ label: string; exit: number }> = [];
    await executeScheduledJob(job({ notify: true }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(0),
      clearJobSchedule: async () => {},
      onForward: (label, r) => forwarded.push({ label, exit: r.exitCode }),
    });
    await executeScheduledJob(job({ notify: true, name: "fail" }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(3),
      clearJobSchedule: async () => {},
      onForward: (label, r) => forwarded.push({ label, exit: r.exitCode }),
    });
    expect(forwarded.length).toBe(2);
  });

  test("notify=false: never forwards", async () => {
    const forwarded: unknown[] = [];
    await executeScheduledJob(job({ notify: false }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(0),
      clearJobSchedule: async () => {},
      onForward: (label, r) => forwarded.push({ label, r }),
    });
    expect(forwarded).toEqual([]);
  });

  test("notify='error': forwards only on non-zero exit", async () => {
    const forwarded: number[] = [];
    await executeScheduledJob(job({ notify: "error" }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(0),
      clearJobSchedule: async () => {},
      onForward: (_label, r) => forwarded.push(r.exitCode),
    });
    await executeScheduledJob(job({ notify: "error", name: "fail" }), {
      resolvePrompt: async (p) => p,
      run: async () => okResult(4),
      clearJobSchedule: async () => {},
      onForward: (_label, r) => forwarded.push(r.exitCode),
    });
    expect(forwarded).toEqual([4]);
  });

  test("run() throws: skips forwarding entirely (no result to forward)", async () => {
    const forwarded: unknown[] = [];
    await executeScheduledJob(job({ notify: true, name: "thrown" }), {
      resolvePrompt: async (p) => p,
      run: async () => {
        throw new Error("boom");
      },
      clearJobSchedule: async () => {},
      onForward: (label, r) => forwarded.push({ label, r }),
      onError: () => {},
    });
    expect(forwarded).toEqual([]);
  });
});

/**
 * Contract tests for the JSON-in/JSON-out dispatcher around the
 * Anthropic `memory_20250818`-shaped 6-op agent memory protocol.
 *
 * Target module (not yet written — these tests drive the IMPL agent):
 *   ./agent-memory-dispatch
 *
 * Exported contract under test:
 *
 *   export type AgentMemoryOp =
 *     | { op: "view"; path: string }
 *     | { op: "create"; path: string; content: string }
 *     | { op: "str_replace"; path: string; old_str: string; new_str: string }
 *     | { op: "insert"; path: string; line: number; content: string }
 *     | { op: "delete"; path: string }
 *     | { op: "rename"; old_path: string; new_path: string };
 *
 *   export interface AgentMemoryResult {
 *     ok: boolean;
 *     result?: unknown;
 *     error?: string;
 *   }
 *
 *   export async function dispatchAgentMemory(
 *     call: AgentMemoryOp,
 *     cwd?: string,
 *   ): Promise<AgentMemoryResult>;
 *
 * Invariants pinned below:
 * - Unknown ops, path-escape attempts, absolute paths, and create-over-existing
 *   all return `{ ok: false, error: ... }`. The dispatcher MUST NEVER throw.
 * - Successful `view` returns `{ ok: true, result: ViewResult }`.
 * - Successful mutators return `{ ok: true }` (no `result` field, or
 *   `result: undefined` — tests accept either).
 *
 * Hermetic pattern: mkdtemp + chdir per test, capture `process.cwd()` as the
 * canonical workspace path (macOS symlinks `/var`→`/private/var`), restore
 * cwd + rm the tempdir in `afterEach`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CWD = process.cwd();

// Captured in beforeAll via dynamic import (same pattern as compose.test.ts).
// Typed as `any` so the test file doesn't choke when the module is missing —
// the import itself is what exercises the red state.
let dispatcher: any;

beforeAll(async () => {
  // Dynamic import so the test file loads even before the module exists.
  // Written as a template literal so biome cannot tree-shake / constant-fold
  // the specifier and complain about an unresolvable static import.
  const modPath = "./agent-memory-dispatch";
  dispatcher = await import(modPath);
});

let tempRoot: string;
let workspace: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-agent-dispatch-"));
  process.chdir(tempRoot);
  // Canonical workspace path — on macOS os.tmpdir() is `/var/folders/...` but
  // process.cwd() after chdir reports the realpath `/private/var/folders/...`.
  workspace = process.cwd();
  // Ensure the parent memory dir exists; the agent root itself is created on
  // demand by mutators, which matches the module's read-side empty-dir
  // semantics.
  await fs.mkdir(join(workspace, ".claude", "hermes", "memory"), { recursive: true });
});

afterEach(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

afterAll(() => {
  process.chdir(ORIG_CWD);
});

describe("dispatchAgentMemory: view", () => {
  test("view on empty agent root returns { ok:true, result:{kind:'dir',entries:[]} }", async () => {
    const res = await dispatcher.dispatchAgentMemory({ op: "view", path: "" }, workspace);
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ kind: "dir", entries: [] });
  });
});

describe("dispatchAgentMemory: create + view", () => {
  test("create then view of that file returns the file content", async () => {
    const createRes = await dispatcher.dispatchAgentMemory(
      { op: "create", path: "note.md", content: "hello-agent" },
      workspace
    );
    expect(createRes.ok).toBe(true);
    expect(createRes.error).toBeUndefined();

    const viewRes = await dispatcher.dispatchAgentMemory({ op: "view", path: "note.md" }, workspace);
    expect(viewRes.ok).toBe(true);
    expect(viewRes.error).toBeUndefined();
    expect(viewRes.result).toEqual({ kind: "file", content: "hello-agent" });
  });
});

describe("dispatchAgentMemory: str_replace", () => {
  test("str_replace successfully replaces a unique substring", async () => {
    const createRes = await dispatcher.dispatchAgentMemory(
      { op: "create", path: "edit.md", content: "alpha BETA gamma" },
      workspace
    );
    expect(createRes.ok).toBe(true);

    const editRes = await dispatcher.dispatchAgentMemory(
      { op: "str_replace", path: "edit.md", old_str: "BETA", new_str: "DELTA" },
      workspace
    );
    expect(editRes.ok).toBe(true);
    expect(editRes.error).toBeUndefined();

    const viewRes = await dispatcher.dispatchAgentMemory({ op: "view", path: "edit.md" }, workspace);
    expect(viewRes.ok).toBe(true);
    expect(viewRes.result).toEqual({ kind: "file", content: "alpha DELTA gamma" });
  });
});

describe("dispatchAgentMemory: insert", () => {
  test("insert at line 0 prepends to a created file", async () => {
    const createRes = await dispatcher.dispatchAgentMemory(
      { op: "create", path: "lines.md", content: "original-first-line\nsecond-line" },
      workspace
    );
    expect(createRes.ok).toBe(true);

    const insRes = await dispatcher.dispatchAgentMemory(
      { op: "insert", path: "lines.md", line: 0, content: "PREPENDED" },
      workspace
    );
    expect(insRes.ok).toBe(true);
    expect(insRes.error).toBeUndefined();

    const viewRes = await dispatcher.dispatchAgentMemory({ op: "view", path: "lines.md" }, workspace);
    expect(viewRes.ok).toBe(true);
    const content = (viewRes.result as { kind: "file"; content: string }).content;
    // The new line must sit before the original first line.
    const prependedIdx = content.indexOf("PREPENDED");
    const originalIdx = content.indexOf("original-first-line");
    expect(prependedIdx).toBeGreaterThanOrEqual(0);
    expect(originalIdx).toBeGreaterThan(prependedIdx);
  });
});

describe("dispatchAgentMemory: delete", () => {
  test("delete removes a created file so subsequent view errors", async () => {
    const createRes = await dispatcher.dispatchAgentMemory(
      { op: "create", path: "doomed.md", content: "bye" },
      workspace
    );
    expect(createRes.ok).toBe(true);

    const delRes = await dispatcher.dispatchAgentMemory({ op: "delete", path: "doomed.md" }, workspace);
    expect(delRes.ok).toBe(true);
    expect(delRes.error).toBeUndefined();

    const viewRes = await dispatcher.dispatchAgentMemory({ op: "view", path: "doomed.md" }, workspace);
    expect(viewRes.ok).toBe(false);
    expect(typeof viewRes.error).toBe("string");
    expect((viewRes.error ?? "").length).toBeGreaterThan(0);
  });
});

describe("dispatchAgentMemory: rename", () => {
  test("rename moves a created file to a new path", async () => {
    const createRes = await dispatcher.dispatchAgentMemory(
      { op: "create", path: "from.md", content: "movable" },
      workspace
    );
    expect(createRes.ok).toBe(true);

    const renRes = await dispatcher.dispatchAgentMemory(
      { op: "rename", old_path: "from.md", new_path: "to.md" },
      workspace
    );
    expect(renRes.ok).toBe(true);
    expect(renRes.error).toBeUndefined();

    // Old path gone.
    const oldView = await dispatcher.dispatchAgentMemory({ op: "view", path: "from.md" }, workspace);
    expect(oldView.ok).toBe(false);

    // New path present with the original content.
    const newView = await dispatcher.dispatchAgentMemory({ op: "view", path: "to.md" }, workspace);
    expect(newView.ok).toBe(true);
    expect(newView.result).toEqual({ kind: "file", content: "movable" });
  });
});

describe("dispatchAgentMemory: safety — path escape attempts", () => {
  test("path traversal ('../evil.md') returns ok:false with 'invalid' in error and never throws", async () => {
    let threw = false;
    let res: any;
    try {
      res = await dispatcher.dispatchAgentMemory(
        { op: "create", path: "../evil.md", content: "pwn" },
        workspace
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect((res.error as string).toLowerCase()).toContain("invalid");
  });

  test("absolute path ('/etc/passwd') returns ok:false and never throws", async () => {
    let threw = false;
    let res: any;
    try {
      res = await dispatcher.dispatchAgentMemory({ op: "view", path: "/etc/passwd" }, workspace);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect((res.error as string).length).toBeGreaterThan(0);
  });
});

describe("dispatchAgentMemory: unknown op", () => {
  test("unknown op name returns ok:false with 'op' in error and never throws", async () => {
    let threw = false;
    let res: any;
    try {
      // Intentionally force an unknown op through the dispatcher. The `as any`
      // cast is the only way to feed an off-contract op into a well-typed
      // API — the dispatcher's whole job here is to reject it at runtime.
      res = await dispatcher.dispatchAgentMemory({ op: "nonexistent_op", path: "x.md" } as any, workspace);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect((res.error as string).toLowerCase()).toContain("op");
  });
});

describe("dispatchAgentMemory: create over existing", () => {
  test("create of an existing file returns ok:false with 'exists' in error and never throws", async () => {
    const firstRes = await dispatcher.dispatchAgentMemory(
      { op: "create", path: "dup.md", content: "v1" },
      workspace
    );
    expect(firstRes.ok).toBe(true);

    let threw = false;
    let res: any;
    try {
      res = await dispatcher.dispatchAgentMemory({ op: "create", path: "dup.md", content: "v2" }, workspace);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect((res.error as string).toLowerCase()).toContain("exists");
  });
});

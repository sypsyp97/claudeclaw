/**
 * Tests for the Anthropic `memory_20250818`-shaped 6-op filesystem protocol
 * scoped to the agent-writable memory root.
 *
 * Target module: `./agent-memory` (does not yet exist — these tests drive its impl).
 *
 * Shape under test:
 *   view(path, cwd?)                                -> ViewResult | FileViewResult
 *   create(path, content, cwd?)                     -> void
 *   strReplace(path, oldString, newString, cwd?)    -> void
 *   insert(path, afterLine, content, cwd?)          -> void
 *   del(path, cwd?)                                 -> void
 *   rename(oldPath, newPath, cwd?)                  -> void
 *
 * All operations are scoped to:
 *   <cwd>/.claude/hermes/memory/agent/
 *
 * Anything that resolves outside that root must throw with a message
 * containing "path" or "invalid".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CWD = process.cwd();
let tempRoot: string;
let memoryDir: string;
let agentDir: string;
let mem: any;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-agent-mem-"));
  memoryDir = join(tempRoot, ".claude", "hermes", "memory");
  agentDir = join(memoryDir, "agent");
  await fs.mkdir(memoryDir, { recursive: true });
  process.chdir(tempRoot);
  mem = await import("./agent-memory");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test starts with a fresh agent root (the impl should be happy
  // creating it on demand).
  await fs.rm(agentDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

describe("view", () => {
  test("view('') on a fresh cwd returns an empty directory listing", async () => {
    // The agent root may not even exist yet. The impl should return an empty
    // dir listing rather than throwing.
    expect(existsSync(agentDir)).toBe(false);
    const got = await mem.view("");
    expect(got).toEqual({ kind: "dir", entries: [] });
  });

  test("after create('notes.md', 'hello'), view('') lists the new file and view('notes.md') returns its content", async () => {
    await mem.create("notes.md", "hello");

    const root = await mem.view("");
    expect(root).toEqual({
      kind: "dir",
      entries: [{ name: "notes.md", kind: "file" }],
    });

    const file = await mem.view("notes.md");
    expect(file).toEqual({ kind: "file", content: "hello" });
  });

  test("subdirectories are discovered", async () => {
    await mem.create("folder/a.md", "...");

    const root = await mem.view("");
    expect(root.kind).toBe("dir");
    const rootEntries = (root.entries as Array<{ name: string; kind: string }>).slice();
    expect(rootEntries).toContainEqual({ name: "folder", kind: "dir" });

    const sub = await mem.view("folder");
    expect(sub.kind).toBe("dir");
    expect(sub.entries).toEqual([{ name: "a.md", kind: "file" }]);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  test("create fails if the file already exists", async () => {
    await mem.create("dup.md", "first");

    let caught: unknown;
    try {
      await mem.create("dup.md", "second");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = ((caught as Error).message || "").toLowerCase();
    expect(msg).toContain("exist");

    // First write must still be intact.
    const file = await mem.view("dup.md");
    expect(file).toEqual({ kind: "file", content: "first" });
  });

  test("create makes intermediate dirs as needed", async () => {
    await mem.create("deep/nested/file.md", "x");
    const file = await mem.view("deep/nested/file.md");
    expect(file).toEqual({ kind: "file", content: "x" });
    expect(existsSync(join(agentDir, "deep", "nested", "file.md"))).toBe(true);
  });

  test("create with an absolute path or path traversal throws and writes nothing outside the agent root", async () => {
    const bads = [
      "/abs",
      "..escape.md",
      "../outside",
      "/",
      "",
      "..",
      "..\\bar",
      "/etc/passwd",
      "foo/../../../etc",
    ];

    for (const bad of bads) {
      const before = await listTree(tempRoot);

      let caught: unknown;
      try {
        await mem.create(bad, "x");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = ((caught as Error).message || "").toLowerCase();
      expect(msg.includes("path") || msg.includes("invalid")).toBe(true);

      // No new path appeared anywhere outside the agent root.
      const after = await listTree(tempRoot);
      const newPaths = after.filter((p) => !before.includes(p));
      for (const p of newPaths) {
        expect(p === agentDir || p.startsWith(agentDir + require("node:path").sep)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// str_replace
// ---------------------------------------------------------------------------

describe("strReplace", () => {
  test("unique match succeeds and the file content reflects the replacement", async () => {
    await mem.create("doc.md", "alpha BETA gamma");
    await mem.strReplace("doc.md", "BETA", "delta");

    const file = await mem.view("doc.md");
    expect(file).toEqual({ kind: "file", content: "alpha delta gamma" });
  });

  test("zero matches throws", async () => {
    await mem.create("doc.md", "alpha beta gamma");

    let caught: unknown;
    try {
      await mem.strReplace("doc.md", "no-such-string", "x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    // File must be untouched.
    const file = await mem.view("doc.md");
    expect(file.content).toBe("alpha beta gamma");
  });

  test("multiple matches throws with a message noting non-uniqueness", async () => {
    await mem.create("doc.md", "foo bar foo");

    let caught: unknown;
    try {
      await mem.strReplace("doc.md", "foo", "qux");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = ((caught as Error).message || "").toLowerCase();
    expect(msg.includes("multiple") || msg.includes("not unique") || msg.includes("unique")).toBe(true);

    // File must be untouched.
    const file = await mem.view("doc.md");
    expect(file.content).toBe("foo bar foo");
  });

  test("strReplace on a nonexistent file throws", async () => {
    let caught: unknown;
    try {
      await mem.strReplace("missing.md", "a", "b");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

describe("insert", () => {
  test("insert at afterLine=0 prepends", async () => {
    await mem.create("f.md", "line1\nline2");
    await mem.insert("f.md", 0, "new0");

    const file = await mem.view("f.md");
    expect(file.content).toBe("new0\nline1\nline2");
  });

  test("insert at afterLine=1 inserts after line 1", async () => {
    await mem.create("f.md", "line1\nline2");
    await mem.insert("f.md", 1, "new");

    const file = await mem.view("f.md");
    expect(file.content).toBe("line1\nnew\nline2");
  });

  test("insert at afterLine=9999 appends at EOF without throwing", async () => {
    await mem.create("f.md", "line1\nline2");
    await mem.insert("f.md", 9999, "tail");

    const file = await mem.view("f.md");
    // Last meaningful line is "tail", and the existing lines are preserved.
    expect(file.content.split("\n")).toContain("line1");
    expect(file.content.split("\n")).toContain("line2");
    expect(file.content.split("\n")).toContain("tail");
    // "tail" must come after "line2".
    const lines = file.content.split("\n");
    expect(lines.indexOf("tail")).toBeGreaterThan(lines.indexOf("line2"));
  });

  test("insert on a nonexistent file throws", async () => {
    let caught: unknown;
    try {
      await mem.insert("missing.md", 0, "x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("del", () => {
  test("delete on an existing file removes it; subsequent view throws", async () => {
    await mem.create("f.md", "bye");
    expect(existsSync(join(agentDir, "f.md"))).toBe(true);

    await mem.del("f.md");
    expect(existsSync(join(agentDir, "f.md"))).toBe(false);

    let caught: unknown;
    try {
      await mem.view("f.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  test("delete on a nonexistent file is a no-op (does not throw)", async () => {
    let caught: unknown;
    try {
      await mem.del("ghost.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
  });

  test("delete with path traversal throws and writes/removes nothing outside the agent root", async () => {
    // Plant a sibling file outside the agent root so we can confirm it's untouched.
    const outsideFile = join(memoryDir, "OUTSIDE.md");
    await fs.writeFile(outsideFile, "do not touch", "utf8");

    const bads = ["../OUTSIDE.md", "/abs", "..", "..\\bar", "foo/../../../etc"];
    for (const bad of bads) {
      let caught: unknown;
      try {
        await mem.del(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = ((caught as Error).message || "").toLowerCase();
      expect(msg.includes("path") || msg.includes("invalid")).toBe(true);
    }

    // Outside file must still exist with its original content.
    expect(existsSync(outsideFile)).toBe(true);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("do not touch");

    await fs.rm(outsideFile, { force: true });
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe("rename", () => {
  test("rename moves within the agent root", async () => {
    await mem.create("a.md", "x");
    await mem.rename("a.md", "b.md");

    const moved = await mem.view("b.md");
    expect(moved).toEqual({ kind: "file", content: "x" });

    let caught: unknown;
    try {
      await mem.view("a.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  test("rename with newPath outside the agent root throws and creates nothing outside", async () => {
    await mem.create("a.md", "x");
    const before = await listTree(tempRoot);

    let caught: unknown;
    try {
      await mem.rename("a.md", "../outside.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = ((caught as Error).message || "").toLowerCase();
    expect(msg.includes("path") || msg.includes("invalid")).toBe(true);

    // a.md must still exist (unmoved).
    const stillThere = await mem.view("a.md");
    expect(stillThere).toEqual({ kind: "file", content: "x" });

    // No path appeared outside the agent root.
    const after = await listTree(tempRoot);
    const newPaths = after.filter((p) => !before.includes(p));
    for (const p of newPaths) {
      expect(p === agentDir || p.startsWith(agentDir + require("node:path").sep)).toBe(true);
    }
  });

  test("rename fails if newPath already exists (no silent overwrite)", async () => {
    await mem.create("a.md", "from-a");
    await mem.create("b.md", "from-b");

    let caught: unknown;
    try {
      await mem.rename("a.md", "b.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    // Both files must be untouched.
    const a = await mem.view("a.md");
    const b = await mem.view("b.md");
    expect(a).toEqual({ kind: "file", content: "from-a" });
    expect(b).toEqual({ kind: "file", content: "from-b" });
  });

  test("rename on a nonexistent oldPath throws", async () => {
    let caught: unknown;
    try {
      await mem.rename("ghost.md", "b.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// invariant: nothing escapes the agent root
// ---------------------------------------------------------------------------

describe("invariant: nothing escapes the agent root", () => {
  test("after a full sequence of operations, every touched path lives under the agent root", async () => {
    // Plant a sibling outside the agent root to make sure none of the
    // operations touch it.
    const sibling = join(memoryDir, "SIBLING.md");
    await fs.writeFile(sibling, "untouched", "utf8");

    // Snapshot the entire tempRoot before our op sequence.
    const before = await listTree(tempRoot);

    // 1. Create a couple files (one nested).
    await mem.create("notes.md", "hello world");
    await mem.create("folder/a.md", "alpha\nbeta\ngamma");

    // 2. View them.
    await mem.view("");
    await mem.view("folder");
    await mem.view("notes.md");

    // 3. str_replace one of them.
    await mem.strReplace("notes.md", "world", "earth");

    // 4. Insert into the nested file.
    await mem.insert("folder/a.md", 1, "between");

    // 5. Rename within the agent root.
    await mem.rename("notes.md", "renamed.md");

    // 6. Delete the renamed file.
    await mem.del("renamed.md");

    // 7. Try a bunch of escape attempts that must throw and not write anywhere.
    const bads = ["/abs", "..", "../outside", "..\\sneaky", "foo/../../../etc"];
    for (const bad of bads) {
      let caughtCreate: unknown;
      try {
        await mem.create(bad, "nope");
      } catch (err) {
        caughtCreate = err;
      }
      expect(caughtCreate).toBeInstanceOf(Error);

      let caughtView: unknown;
      try {
        await mem.view(bad);
      } catch (err) {
        caughtView = err;
      }
      expect(caughtView).toBeInstanceOf(Error);
    }

    // Final snapshot: every newly-touched path must live under the agent root.
    const after = await listTree(tempRoot);
    const newPaths = after.filter((p) => !before.includes(p));
    for (const p of newPaths) {
      expect(p === agentDir || p.startsWith(agentDir + require("node:path").sep)).toBe(true);
    }

    // The sibling outside the agent root must still be intact and unchanged.
    expect(existsSync(sibling)).toBe(true);
    expect(await fs.readFile(sibling, "utf8")).toBe("untouched");
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function listTree(root: string): Promise<string[]> {
  type DirentLike = { name: string; isDirectory(): boolean };
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: DirentLike[];
    try {
      // Use `as` because Bun's fs/promises typings resolve the overload to
      // Dirent<NonSharedBuffer> while at runtime we actually get Dirent<string>.
      entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as DirentLike[];
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      out.push(full);
      if (e.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out;
}

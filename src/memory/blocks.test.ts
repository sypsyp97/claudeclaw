/**
 * Tests for the Letta-style labeled memory-block primitive.
 *
 * Target module: `./blocks` (does not yet exist — these tests drive its impl).
 *
 * Shape under test:
 *   readBlock(name, cwd?)          -> { name, content, budget }
 *   writeBlock(name, content, cwd?)
 *   removeBlock(name, cwd?)
 *   readAllBlocks(cwd?)            -> Block[]
 *   blockBudget(name)              -> number
 *
 * Storage: one markdown file per block in
 *   <cwd>/.claude/hermes/memory/blocks/<safe-name>.md
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CWD = process.cwd();
let tempRoot: string;
let blocksDir: string;
let memoryDir: string;
let blocks: any;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-blocks-"));
  memoryDir = join(tempRoot, ".claude", "hermes", "memory");
  blocksDir = join(memoryDir, "blocks");
  await fs.mkdir(memoryDir, { recursive: true });
  process.chdir(tempRoot);
  blocks = await import("./blocks");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test starts with an empty blocks dir so we don't leak state.
  await fs.rm(blocksDir, { recursive: true, force: true });
});

describe("blockBudget", () => {
  test("well-known names map to canonical budgets", () => {
    expect(blocks.blockBudget("persona")).toBe(4096);
    expect(blocks.blockBudget("human")).toBe(2048);
    expect(blocks.blockBudget("project")).toBe(4096);
  });

  test("unknown names fall back to 2048", () => {
    expect(blocks.blockBudget("random-slot")).toBe(2048);
    expect(blocks.blockBudget("totally-made-up")).toBe(2048);
  });

  test("any channel:<id> name gets 2048", () => {
    expect(blocks.blockBudget("channel:anything")).toBe(2048);
    expect(blocks.blockBudget("channel:C1234")).toBe(2048);
    expect(blocks.blockBudget("channel:")).toBe(2048);
  });
});

describe("round-trip", () => {
  test("well-known block writes and reads back with its canonical budget", async () => {
    await blocks.writeBlock("persona", "I am a careful assistant.");
    const got = await blocks.readBlock("persona");
    expect(got).toEqual({
      name: "persona",
      content: "I am a careful assistant.",
      budget: 4096,
    });

    // Exposed at the documented on-disk location.
    expect(existsSync(join(blocksDir, "persona.md"))).toBe(true);
    const onDisk = await fs.readFile(join(blocksDir, "persona.md"), "utf8");
    expect(onDisk).toContain("I am a careful assistant.");
  });

  test("unknown block round-trips with the default 2048 budget", async () => {
    await blocks.writeBlock("random-slot", "hi");
    const got = await blocks.readBlock("random-slot");
    expect(got.name).toBe("random-slot");
    expect(got.content).toBe("hi");
    expect(got.budget).toBe(2048);
  });

  test("channel-scoped block name round-trips verbatim", async () => {
    await blocks.writeBlock("channel:C1234", "greet with care");
    const got = await blocks.readBlock("channel:C1234");
    expect(got.name).toBe("channel:C1234");
    expect(got.content).toBe("greet with care");
    expect(got.budget).toBe(2048);
  });

  test("names are case-sensitive — 'Persona' and 'persona' are distinct blocks", async () => {
    await blocks.writeBlock("persona", "lowercase content");
    await blocks.writeBlock("Persona", "uppercase content");

    const lower = await blocks.readBlock("persona");
    const upper = await blocks.readBlock("Persona");

    expect(lower.content).toBe("lowercase content");
    expect(upper.content).toBe("uppercase content");
    expect(lower.name).toBe("persona");
    expect(upper.name).toBe("Persona");
  });
});

describe("missing blocks", () => {
  test("readBlock on a fresh cwd returns an empty-content block, not an error", async () => {
    const got = await blocks.readBlock("persona");
    expect(got).toEqual({ name: "persona", content: "", budget: 4096 });
  });

  test("readBlock on a nonexistent channel returns empty content with channel budget", async () => {
    const got = await blocks.readBlock("channel:NONEXISTENT");
    expect(got.name).toBe("channel:NONEXISTENT");
    expect(got.content).toBe("");
    expect(got.budget).toBe(2048);
  });
});

describe("budget enforcement", () => {
  test("writeBlock throws when content exceeds the budget", async () => {
    const tooBig = "x".repeat(3000); // human budget is 2048
    let caught: unknown;
    try {
      await blocks.writeBlock("human", tooBig);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("budget");
    expect(msg).toContain("human");

    // Partial writes are unacceptable — the file must not exist after the throw.
    expect(existsSync(join(blocksDir, "human.md"))).toBe(false);
  });

  test("whitespace counts — pure-whitespace over-budget strings also throw", async () => {
    const tooBig = " ".repeat(3000);
    let caught: unknown;
    try {
      await blocks.writeBlock("human", tooBig);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("budget");
  });

  test("exactly-at-budget succeeds; one over throws", async () => {
    const atBudget = "x".repeat(4096);
    await blocks.writeBlock("persona", atBudget);
    const got = await blocks.readBlock("persona");
    expect(got.content.length).toBe(4096);

    const overBudget = "x".repeat(4097);
    let caught: unknown;
    try {
      await blocks.writeBlock("persona", overBudget);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("budget");

    // The exactly-at-budget content is still the on-disk state (no clobber).
    const afterFail = await blocks.readBlock("persona");
    expect(afterFail.content.length).toBe(4096);
  });
});

describe("readAllBlocks", () => {
  test("fresh cwd with no writes returns an empty array", async () => {
    const all = await blocks.readAllBlocks();
    expect(Array.isArray(all)).toBe(true);
    expect(all).toEqual([]);
  });

  test("returns rows sorted alphabetically by name", async () => {
    // Write in intentionally non-sorted order.
    await blocks.writeBlock("project", "project body");
    await blocks.writeBlock("persona", "persona body");
    await blocks.writeBlock("channel:beta", "beta body");
    await blocks.writeBlock("human", "human body");

    const all = await blocks.readAllBlocks();
    const names = all.map((b: { name: string }) => b.name);
    expect(names).toEqual(["channel:beta", "human", "persona", "project"]);

    // Each row carries the right budget too.
    type BlockRow = { name: string; budget: number; content: string };
    const byName = new Map<string, BlockRow>(all.map((b: BlockRow): [string, BlockRow] => [b.name, b]));
    expect(byName.get("persona")?.budget).toBe(4096);
    expect(byName.get("project")?.budget).toBe(4096);
    expect(byName.get("human")?.budget).toBe(2048);
    expect(byName.get("channel:beta")?.budget).toBe(2048);
    expect(byName.get("channel:beta")?.content).toBe("beta body");
  });
});

describe("removeBlock", () => {
  test("removes the file and subsequent reads return empty content", async () => {
    await blocks.writeBlock("persona", "will be gone soon");
    expect(existsSync(join(blocksDir, "persona.md"))).toBe(true);

    await blocks.removeBlock("persona");
    expect(existsSync(join(blocksDir, "persona.md"))).toBe(false);

    const got = await blocks.readBlock("persona");
    expect(got.content).toBe("");
    expect(got.budget).toBe(4096);
  });

  test("removing a never-written block is a no-op (no throw)", async () => {
    let caught: unknown;
    try {
      await blocks.removeBlock("persona");
      await blocks.removeBlock("channel:ghost");
      await blocks.removeBlock("some-unknown-name");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
  });
});

describe("path-traversal guardrails", () => {
  const invalidNames = ["../escape", "/abs/path", "..", "../../hacker"];

  for (const bad of invalidNames) {
    test(`writeBlock(${JSON.stringify(bad)}) refuses to write outside the blocks dir`, async () => {
      // Snapshot the tempRoot tree so we can diff after the (expected) throw.
      const before = await listTree(tempRoot);

      let caught: unknown;
      try {
        await blocks.writeBlock(bad, "hacked");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = ((caught as Error).message || "").toLowerCase();
      expect(msg.includes("name") || msg.includes("invalid")).toBe(true);

      // No file should have appeared anywhere outside the (possibly absent) blocks dir.
      const after = await listTree(tempRoot);
      const newPaths = after.filter((p) => !before.includes(p));
      for (const p of newPaths) {
        expect(p.startsWith(blocksDir)).toBe(true);
      }
    });
  }
});

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

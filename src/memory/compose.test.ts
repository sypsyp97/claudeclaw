/**
 * Contract tests for the cache-stable system prompt composer.
 *
 * These tests pin down the refactor: runner.ts must eventually call a single
 * deterministic composer that produces a byte-identical `--append-system-prompt`
 * across turns so Claude's prompt cache is not invalidated.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CWD = process.cwd();
let tempRoot: string;
let memoryDir: string;
let mem: typeof import("./index");

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-compose-"));
  memoryDir = join(tempRoot, ".claude", "hermes", "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  process.chdir(tempRoot);
  mem = await import("./index");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset all memory layer files to a known clean state between tests so
  // each case has full control over what lands in which layer.
  await fs.rm(memoryDir, { recursive: true, force: true });
  await fs.mkdir(memoryDir, { recursive: true });
});

async function writeLayer(name: string, content: string): Promise<void> {
  await fs.writeFile(join(memoryDir, name), content, "utf8");
}

describe("composer determinism", () => {
  test("byte-identical across repeated calls with the same ctx", async () => {
    await writeLayer("SOUL.md", "SOUL-stable-layer");
    await writeLayer("IDENTITY.md", "IDENTITY-stable-layer");
    await mem.writeUserMemory("USER-stable-layer");
    // MEMORY.md is intentionally written as a hand-crafted static blob here
    // (no append -> no timestamp marker) so the determinism test does not
    // depend on the impl's timestamp-stripping behavior.
    await fs.writeFile(join(memoryDir, "MEMORY.md"), "MEMORY-stable-layer\n", "utf8");
    await mem.writeChannelMemory("chanA", "CHANNEL-stable-layer");

    const ctx = { channelId: "chanA", memoryScope: "channel" as const };
    const first = await mem.composeSystemPrompt(ctx);
    const second = await mem.composeSystemPrompt(ctx);
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("composer cache-stability: no volatile content", () => {
  test("output contains no ISO datetime and no 13-digit epoch ms", async () => {
    await writeLayer("SOUL.md", "SOUL-content");
    await writeLayer("IDENTITY.md", "IDENTITY-content");
    await mem.writeUserMemory("USER-content");
    // Use the real append path — this injects `<!-- <ISO> -->` markers into
    // MEMORY.md. The composer must strip or otherwise suppress them so the
    // outbound prompt is cache-stable.
    await mem.appendCrossSessionMemory("cache-stability-fact");
    await mem.writeChannelMemory("chanB", "CHANNEL-content");

    const out = await mem.composeSystemPrompt({
      channelId: "chanB",
      memoryScope: "channel",
    });

    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(out).not.toMatch(/(?<![\d.])\b\d{13}\b(?![\d.])/);
    // Sanity: the fact itself still made it through.
    expect(out).toContain("cache-stability-fact");
  });
});

describe("composer layer ordering", () => {
  test("SOUL -> IDENTITY -> USER -> MEMORY -> CHANNEL with distinct markers", async () => {
    await writeLayer("SOUL.md", "SOUL-MARKER-AAA");
    await writeLayer("IDENTITY.md", "IDENTITY-MARKER-BBB");
    await mem.writeUserMemory("USER-MARKER-CCC");
    await fs.writeFile(join(memoryDir, "MEMORY.md"), "MEMORY-MARKER-DDD\n", "utf8");
    await mem.writeChannelMemory("testchan", "CHANNEL-MARKER-EEE");

    const out = await mem.composeSystemPrompt({
      channelId: "testchan",
      memoryScope: "channel",
    });

    const soulIdx = out.indexOf("SOUL-MARKER-AAA");
    const idIdx = out.indexOf("IDENTITY-MARKER-BBB");
    const userIdx = out.indexOf("USER-MARKER-CCC");
    const memIdx = out.indexOf("MEMORY-MARKER-DDD");
    const chanIdx = out.indexOf("CHANNEL-MARKER-EEE");

    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThan(soulIdx);
    expect(userIdx).toBeGreaterThan(idIdx);
    expect(memIdx).toBeGreaterThan(userIdx);
    expect(chanIdx).toBeGreaterThan(memIdx);
  });
});

describe("composer MEMORY tail-truncation under maxBytes", () => {
  test("drops the oldest MEMORY entry first, keeps the newest", async () => {
    // Stable prefix layers — small so the budget is dominated by MEMORY.
    await writeLayer("SOUL.md", "S");
    await writeLayer("IDENTITY.md", "I");
    await mem.writeUserMemory("U");

    // Large oldest entry, small newest entry. If the impl naively slices
    // from the HEAD of the joined string (the current compose.ts behavior),
    // the tail — which includes the newest fact — is what gets dropped,
    // and this test fails. The contract is the opposite: the newest fact
    // survives, the oldest is dropped.
    const oldFiller = "X".repeat(400);
    await mem.appendCrossSessionMemory(`old-fact-AAA ${oldFiller}`);
    await mem.appendCrossSessionMemory("new-fact-ZZZ");

    // Pick a budget that comfortably fits the stable prefix (S + I + U +
    // joins ~= tens of bytes) plus the newest fact (~a few dozen bytes)
    // but cannot fit the 400-char-padded old fact as well.
    const out = await mem.composeSystemPrompt({
      memoryScope: "user",
      maxBytes: 200,
    });

    expect(out).toContain("new-fact-ZZZ");
    expect(out).not.toContain("old-fact-AAA");
    // Stable prefix must survive the truncation.
    expect(out).toContain("S");
    expect(out).toContain("I");
    expect(out).toContain("U");
  });
});

describe("composer Hermes prefix option", () => {
  test("includeHermesPrefix: true prepends the Hermes banner line", async () => {
    await writeLayer("SOUL.md", "SOUL-body");
    await writeLayer("IDENTITY.md", "IDENTITY-body");

    const out = await mem.composeSystemPrompt({
      memoryScope: "none",
      includeHermesPrefix: true,
    });

    expect(out.startsWith("You are running inside Claude Hermes.\n")).toBe(true);
    expect(out).toContain("SOUL-body");
  });

  test("omitting includeHermesPrefix does not add the banner", async () => {
    await writeLayer("SOUL.md", "SOUL-body");
    await writeLayer("IDENTITY.md", "IDENTITY-body");

    const out = await mem.composeSystemPrompt({ memoryScope: "none" });
    expect(out.startsWith("You are running inside Claude Hermes.")).toBe(false);
  });

  test("includeHermesPrefix: false does not add the banner", async () => {
    await writeLayer("SOUL.md", "SOUL-body");
    await writeLayer("IDENTITY.md", "IDENTITY-body");

    const out = await mem.composeSystemPrompt({
      memoryScope: "none",
      includeHermesPrefix: false,
    });
    expect(out.startsWith("You are running inside Claude Hermes.")).toBe(false);
  });
});

describe("composer project CLAUDE.md inclusion", () => {
  test("projectClaudeMd content lands between USER and MEMORY layers", async () => {
    await writeLayer("SOUL.md", "SOUL-MARKER-AAA");
    await writeLayer("IDENTITY.md", "IDENTITY-MARKER-BBB");
    await mem.writeUserMemory("USER-MARKER-CCC");
    await fs.writeFile(join(memoryDir, "MEMORY.md"), "MEMORY-MARKER-DDD\n", "utf8");

    const out = await mem.composeSystemPrompt({
      memoryScope: "user",
      projectClaudeMd: "PROJECT-CLAUDE-MARKER-FFF",
    });

    const userIdx = out.indexOf("USER-MARKER-CCC");
    const projIdx = out.indexOf("PROJECT-CLAUDE-MARKER-FFF");
    const memIdx = out.indexOf("MEMORY-MARKER-DDD");

    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(projIdx).toBeGreaterThan(userIdx);
    expect(memIdx).toBeGreaterThan(projIdx);
  });

  test("empty projectClaudeMd does not inject a marker or blank layer", async () => {
    await writeLayer("SOUL.md", "SOUL-MARKER-AAA");
    await writeLayer("IDENTITY.md", "IDENTITY-MARKER-BBB");
    await mem.writeUserMemory("USER-MARKER-CCC");
    await fs.writeFile(join(memoryDir, "MEMORY.md"), "MEMORY-MARKER-DDD\n", "utf8");

    const out = await mem.composeSystemPrompt({
      memoryScope: "user",
      projectClaudeMd: "",
    });

    expect(out).not.toContain("PROJECT-CLAUDE-MARKER-FFF");
    // USER still immediately adjacent to MEMORY (no phantom empty block
    // between them — a blank layer would produce a triple-newline gap).
    expect(out).not.toMatch(/\n\n\n/);
  });
});

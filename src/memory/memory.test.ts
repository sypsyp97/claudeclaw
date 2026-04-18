import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CWD = process.cwd();
let tempRoot: string;
let mem: typeof import("./index");

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-memory-"));
  await fs.mkdir(join(tempRoot, "memory"), { recursive: true });
  process.chdir(tempRoot);
  mem = await import("./index");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("memory files", () => {
  test("missing layer returns empty string", async () => {
    const soul = await mem.readSoul();
    expect(soul).toBe("");
  });

  test("write+read USER.md round-trips", async () => {
    await mem.writeUserMemory("owner: alice\nlikes: indigo");
    const content = await mem.readUserMemory();
    expect(content).toContain("alice");
    expect(content).toContain("indigo");
  });

  test("appendCrossSessionMemory stacks entries with timestamps", async () => {
    await mem.appendCrossSessionMemory("postgres port is 6543");
    await mem.appendCrossSessionMemory("ci uses bun test");
    const body = await mem.readCrossSessionMemory();
    expect(body).toContain("postgres port is 6543");
    expect(body).toContain("ci uses bun test");
    expect(body.split("<!-- ").length).toBeGreaterThanOrEqual(3);
  });

  test("channel memory is stored per channel id", async () => {
    await mem.writeChannelMemory("C1", "greet with claws");
    await mem.writeChannelMemory("C2", "announcements only");
    const one = await mem.readChannelMemory("C1");
    const two = await mem.readChannelMemory("C2");
    expect(one).toContain("claws");
    expect(two).toContain("announcements");
  });
});

describe("system prompt composition", () => {
  test("concatenates present layers in SOUL→IDENTITY→USER→MEMORY→CHANNEL order", async () => {
    await fs.writeFile(join(tempRoot, "memory", "SOUL.md"), "SOUL-text");
    await fs.writeFile(join(tempRoot, "memory", "IDENTITY.md"), "ID-text");
    await mem.writeUserMemory("USER-text");
    await mem.appendCrossSessionMemory("MEM-fact");
    await mem.writeChannelMemory("CX", "CHANNEL-play");

    const prompt = await mem.composeSystemPrompt({
      channelId: "CX",
      memoryScope: "channel",
    });

    const soulIdx = prompt.indexOf("SOUL-text");
    const idIdx = prompt.indexOf("ID-text");
    const memIdx = prompt.indexOf("MEM-fact");
    const chanIdx = prompt.indexOf("CHANNEL-play");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThan(soulIdx);
    expect(memIdx).toBeGreaterThan(idIdx);
    expect(chanIdx).toBeGreaterThan(memIdx);
  });

  test("memoryScope=none omits MEMORY + USER + CHANNEL layers", async () => {
    const prompt = await mem.composeSystemPrompt({ memoryScope: "none" });
    expect(prompt).not.toContain("USER-text");
    expect(prompt).not.toContain("MEM-fact");
    expect(prompt).not.toContain("CHANNEL-play");
  });

  test("maxBytes trims the tail", async () => {
    const prompt = await mem.composeSystemPrompt({
      memoryScope: "user",
      maxBytes: 20,
    });
    expect(prompt.length).toBeLessThanOrEqual(20);
  });
});

describe("nudge extractor", () => {
  test("heuristic extractor finds 'my X is Y' facts", async () => {
    const facts = await mem.extractFacts([
      { role: "user", content: "my postgres port is 6543" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "remember that deploys need the gateway restarted" },
    ]);
    expect(facts.length).toBe(2);
    expect(facts[0]).toEqual({ scope: "user", key: "postgres port", value: "6543" });
    expect(facts[1]?.scope).toBe("workspace");
  });

  test("setExtractor overrides the default", async () => {
    mem.setExtractor(async () => [{ scope: "user", key: "synthetic", value: "ok" }]);
    const facts = await mem.extractFacts([]);
    expect(facts).toEqual([{ scope: "user", key: "synthetic", value: "ok" }]);
    mem.resetExtractor();
  });
});

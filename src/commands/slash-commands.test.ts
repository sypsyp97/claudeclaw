/**
 * Tests for `buildSlashCommandList` — the function that combines hardcoded
 * Discord slash commands with discovered skills into a single registration
 * payload. See `src/commands/discord.ts` lines 366-392 for the current
 * hardcoded list.
 */

import { describe, expect, test } from "bun:test";

import { buildSlashCommandList, HARDCODED_COMMANDS } from "./slash-commands";
import type { SkillInfo } from "../skills/discovery";

const HARDCODED_NAMES = ["start", "reset", "compact", "status", "context"];
const DISCORD_NAME_RE = /^[a-z0-9_-]{1,32}$/;

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: "test-skill",
    description: "test skill description",
    path: "/tmp/skill/SKILL.md",
    source: "project",
    ...overrides,
  };
}

describe("HARDCODED_COMMANDS", () => {
  test("exposes the 5 hardcoded Discord commands in deterministic order", () => {
    expect(HARDCODED_COMMANDS.map((c) => c.name)).toEqual(HARDCODED_NAMES);
  });

  test("every hardcoded command is Discord-safe", () => {
    for (const cmd of HARDCODED_COMMANDS) {
      expect(cmd.type).toBe(1);
      expect(cmd.name).toMatch(DISCORD_NAME_RE);
      expect(cmd.description.length).toBeGreaterThanOrEqual(1);
      expect(cmd.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("buildSlashCommandList — hardcoded baseline", () => {
  test("with no skills returns exactly the 5 hardcoded commands", () => {
    const out = buildSlashCommandList([]);
    expect(out).toHaveLength(5);
    expect(out.map((c) => c.name)).toEqual(HARDCODED_NAMES);
    for (const cmd of out) {
      expect(cmd.type).toBe(1);
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  test("hardcoded names match Discord's regex and descriptions fit 1-100 chars", () => {
    const out = buildSlashCommandList([]);
    for (const cmd of out) {
      expect(cmd.name).toMatch(DISCORD_NAME_RE);
      expect(cmd.description.length).toBeGreaterThanOrEqual(1);
      expect(cmd.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("buildSlashCommandList — appending skills", () => {
  test("appends a plain valid skill after the 5 hardcoded commands", () => {
    const out = buildSlashCommandList([skill({ name: "mytool", description: "does stuff" })]);
    expect(out).toHaveLength(6);
    expect(out.slice(0, 5).map((c) => c.name)).toEqual(HARDCODED_NAMES);
    expect(out[5]).toEqual({
      name: "mytool",
      description: "does stuff",
      type: 1,
    });
  });
});

describe("buildSlashCommandList — slugification", () => {
  test("lowercases uppercase letters", () => {
    const out = buildSlashCommandList([skill({ name: "MyCoolSkill" })]);
    const added = out[out.length - 1];
    expect(added?.name).toBe("mycoolskill");
  });

  test("replaces colon with underscore while preserving other valid chars", () => {
    const out = buildSlashCommandList([skill({ name: "claude-hermes:clear" })]);
    const added = out[out.length - 1];
    expect(added?.name).toBe("claude-hermes_clear");
  });

  test("collapses unsafe chars (space, slash, dot) to underscore", () => {
    const out = buildSlashCommandList([
      skill({ name: "hello world", description: "a" }),
      skill({ name: "foo/bar", description: "b" }),
      skill({ name: "foo.bar", description: "c" }),
    ]);
    const names = out.slice(5).map((c) => c.name);
    expect(names).toContain("hello_world");
    expect(names).toContain("foo_bar");
    // "foo.bar" also slugs to "foo_bar" — collision with the previous skill,
    // so only the first appearance survives. Assert that at least one entry
    // resolves to "foo_bar" and that each produced name is Discord-safe.
    for (const n of names) {
      expect(n).toMatch(DISCORD_NAME_RE);
    }
  });

  test("skill whose slug becomes empty is skipped", () => {
    const out = buildSlashCommandList([skill({ name: "🔥" })]);
    expect(out).toHaveLength(5);
    expect(out.map((c) => c.name)).toEqual(HARDCODED_NAMES);
  });

  test("skill name longer than 32 chars is truncated to 32", () => {
    const longName = "a".repeat(40);
    const out = buildSlashCommandList([skill({ name: longName })]);
    const added = out[out.length - 1];
    expect(added).toBeDefined();
    expect(added!.name.length).toBe(32);
    expect(added!.name).toMatch(DISCORD_NAME_RE);
  });
});

describe("buildSlashCommandList — collisions", () => {
  test("skill whose slug equals a hardcoded name is dropped", () => {
    const out = buildSlashCommandList([skill({ name: "compact", description: "user override" })]);
    expect(out).toHaveLength(5);
    expect(out.map((c) => c.name)).toEqual(HARDCODED_NAMES);
    // The surviving "compact" must be the hardcoded one, not the skill's.
    const compact = out.find((c) => c.name === "compact");
    expect(compact?.description).not.toBe("user override");
  });

  test("two skills with identical slugs keep only the first", () => {
    const out = buildSlashCommandList([
      skill({ name: "foo", description: "first" }),
      skill({ name: "FOO", description: "second" }),
    ]);
    expect(out).toHaveLength(6);
    const fooEntries = out.filter((c) => c.name === "foo");
    expect(fooEntries).toHaveLength(1);
    expect(fooEntries[0]?.description).toBe("first");
  });
});

describe("buildSlashCommandList — descriptions", () => {
  test("truncates a 200-char description to exactly 100 chars", () => {
    const longDesc = "x".repeat(200);
    const out = buildSlashCommandList([skill({ name: "longdesc", description: longDesc })]);
    const added = out.find((c) => c.name === "longdesc");
    expect(added).toBeDefined();
    expect(added!.description.length).toBe(100);
  });

  test("empty description is replaced with a non-empty fallback <= 100 chars", () => {
    const out = buildSlashCommandList([skill({ name: "nodesc", description: "" })]);
    const added = out.find((c) => c.name === "nodesc");
    expect(added).toBeDefined();
    expect(added!.description.length).toBeGreaterThan(0);
    expect(added!.description.length).toBeLessThanOrEqual(100);
  });
});

describe("buildSlashCommandList — total cap", () => {
  test("caps output at 100 entries even with 200 skills", () => {
    const skills = Array.from({ length: 200 }, (_, i) => skill({ name: `skill${i}`, description: "d" }));
    const out = buildSlashCommandList(skills);
    expect(out).toHaveLength(100);
  });

  test("hardcoded commands stay present under the cap", () => {
    const skills = Array.from({ length: 200 }, (_, i) => skill({ name: `skill${i}`, description: "d" }));
    const out = buildSlashCommandList(skills);
    expect(out).toHaveLength(100);
    // First 5 entries must still be the hardcoded commands in order.
    expect(out.slice(0, 5).map((c) => c.name)).toEqual(HARDCODED_NAMES);
    // Remaining 95 are skill slots.
    expect(out.length - 5).toBe(95);
    // Every entry must still be Discord-safe.
    for (const cmd of out) {
      expect(cmd.type).toBe(1);
      expect(cmd.name).toMatch(DISCORD_NAME_RE);
      expect(cmd.description.length).toBeGreaterThanOrEqual(1);
      expect(cmd.description.length).toBeLessThanOrEqual(100);
    }
  });
});

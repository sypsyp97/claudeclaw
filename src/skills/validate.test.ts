import { describe, expect, test } from "bun:test";
import { validateSkillManifest } from "./validate";

const VALID_BODY = "# Title\n\nSome body content.\n";

function makeBody(lines: number): string {
  // Produces a body whose `body.split("\n").length` equals `lines` exactly.
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

function goodInput(overrides: Partial<{ name: string; description: string; body: string }> = {}) {
  return {
    name: "foo-bar-baz",
    description: "Use this skill when the user asks for foo bar baz.",
    body: VALID_BODY,
    ...overrides,
  };
}

describe("validateSkillManifest — rule 1: name length <= 64 chars", () => {
  test("65-char name fails with a length error", () => {
    const name = "a".repeat(65);
    const result = validateSkillManifest(goodInput({ name }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /too long|≤.?64|64 char/i.test(e))).toBe(true);
  });

  test("30-char name passes length check", () => {
    const name = "a".repeat(30); // also kebab-case safe (all lowercase letters)
    const result = validateSkillManifest(goodInput({ name }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateSkillManifest — rule 2: name is kebab-case", () => {
  test("underscore fails", () => {
    const result = validateSkillManifest(goodInput({ name: "Bad_Name" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("camelCase (uppercase letters) fails", () => {
    const result = validateSkillManifest(goodInput({ name: "fooBar" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("consecutive hyphens fail", () => {
    const result = validateSkillManifest(goodInput({ name: "foo--bar" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("leading hyphen fails", () => {
    const result = validateSkillManifest(goodInput({ name: "-leading" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("trailing hyphen fails", () => {
    const result = validateSkillManifest(goodInput({ name: "trailing-" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("clean kebab-case with digits passes", () => {
    const result = validateSkillManifest(goodInput({ name: "foo-bar-123" }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateSkillManifest — rule 3: name has no emoji / non-ASCII", () => {
  test("emoji in name fails", () => {
    const result = validateSkillManifest(goodInput({ name: "skill-🔥" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("validateSkillManifest — rule 4: description non-empty after trim", () => {
  test("empty description fails", () => {
    const result = validateSkillManifest(goodInput({ description: "" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("whitespace-only description fails", () => {
    const result = validateSkillManifest(goodInput({ description: "   " }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("non-empty description passes", () => {
    const result = validateSkillManifest(goodInput({ description: "Use this when…" }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateSkillManifest — rule 5: description <= 1024 chars", () => {
  test("1025-char description fails", () => {
    // Starts with 'Use ' so it passes rule 6, then padded to 1025 chars total.
    const description = "Use " + "x".repeat(1025 - 4);
    expect(description.length).toBe(1025);
    const result = validateSkillManifest(goodInput({ description }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("500-char description passes", () => {
    const description = "Use " + "x".repeat(500 - 4);
    expect(description.length).toBe(500);
    const result = validateSkillManifest(goodInput({ description }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateSkillManifest — rule 6: description starts with imperative verb", () => {
  test("non-imperative opening ('A skill that does X') fails", () => {
    const result = validateSkillManifest(goodInput({ description: "A skill that does X" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("lowercase 'use' fails (case-sensitive)", () => {
    const result = validateSkillManifest(goodInput({ description: "use when user wants X" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("'Use when user wants X' passes", () => {
    const result = validateSkillManifest(goodInput({ description: "Use when user wants X" }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("'Create a new foo bar widget' passes", () => {
    const result = validateSkillManifest(goodInput({ description: "Create a new foo bar widget" }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateSkillManifest — rule 7: body line count <= 500", () => {
  test("501-line body fails", () => {
    const body = makeBody(501);
    expect(body.split("\n").length).toBe(501);
    const result = validateSkillManifest(goodInput({ body }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("50-line body passes", () => {
    const body = makeBody(50);
    expect(body.split("\n").length).toBe(50);
    const result = validateSkillManifest(goodInput({ body }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateSkillManifest — rule 8: aggregate (does not short-circuit)", () => {
  test("input violating rules 1, 2, and 4 simultaneously returns 3+ distinct errors", () => {
    const result = validateSkillManifest({
      // Rule 1: 65 chars. Rule 2: uppercase + underscore => not kebab-case.
      name: "Bad_Name_" + "A".repeat(65 - "Bad_Name_".length),
      // Rule 4: whitespace-only description.
      description: "   ",
      body: VALID_BODY,
    });
    expect(result.ok).toBe(false);
    const distinct = new Set(result.errors);
    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });
});

describe("validateSkillManifest — rule 9: happy path", () => {
  test("perfectly valid input returns ok with empty errors", () => {
    const result = validateSkillManifest({
      name: "foo-bar-123",
      description: "Use this when the user wants foo bar baz functionality.",
      body: "# Foo Bar\n\nSome helpful instructions.\n",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

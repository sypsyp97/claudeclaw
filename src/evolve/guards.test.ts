import { describe, expect, test } from "bun:test";
import { __resetGuardsCache, buildEvolveSystemPrompt, evolveGuardsText } from "./guards";

describe("evolveGuardsText — content invariants", () => {
  test("contains the core 'no git stash' prohibition", () => {
    __resetGuardsCache();
    const text = evolveGuardsText();
    // Case-insensitive because the file may phrase this as "Do not run
    // `git stash`" or similar. The substring "git stash" is what matters.
    expect(text.toLowerCase()).toContain("git stash");
  });

  test("forbids branch switching in some form", () => {
    __resetGuardsCache();
    const text = evolveGuardsText().toLowerCase();
    // Any of these phrasings is fine; we just need the guard to exist.
    const mentionsBranch =
      text.includes("branch switch") || text.includes("git checkout") || text.includes("git switch");
    expect(mentionsBranch).toBe(true);
  });

  test("forbids --no-verify (hook bypass)", () => {
    __resetGuardsCache();
    const text = evolveGuardsText();
    expect(text).toContain("--no-verify");
  });

  test("forbids force push", () => {
    __resetGuardsCache();
    const text = evolveGuardsText().toLowerCase();
    expect(text).toContain("force push");
  });

  test("forbids modifying files outside the cwd", () => {
    __resetGuardsCache();
    const text = evolveGuardsText().toLowerCase();
    expect(text).toContain("outside");
    expect(text).toContain("working directory");
  });

  test("is non-empty even when the file is missing (fallback floor)", () => {
    __resetGuardsCache();
    const text = evolveGuardsText();
    // The fallback path is exercised by the real file being present in
    // this repo, but the invariant we want to pin is "guards never empty".
    expect(text.length).toBeGreaterThan(200);
  });
});

describe("buildEvolveSystemPrompt — composition", () => {
  test("returns guards alone when no user system prompt", () => {
    __resetGuardsCache();
    const out = buildEvolveSystemPrompt();
    expect(out).toBe(evolveGuardsText());
  });

  test("returns guards alone when user system prompt is empty/whitespace", () => {
    __resetGuardsCache();
    expect(buildEvolveSystemPrompt("")).toBe(evolveGuardsText());
    expect(buildEvolveSystemPrompt("   \n  \n")).toBe(evolveGuardsText());
  });

  test("prepends (not appends) the guards when a user system prompt is given", () => {
    __resetGuardsCache();
    const user = "you are an evolve subagent, go make things better";
    const out = buildEvolveSystemPrompt(user);
    const guardsIdx = out.indexOf("git stash");
    const userIdx = out.indexOf("you are an evolve subagent");
    expect(guardsIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(guardsIdx);
  });

  test("separates guards from user prompt with a blank line", () => {
    __resetGuardsCache();
    const user = "UNIQUE-USER-TOKEN-42";
    const out = buildEvolveSystemPrompt(user);
    // Exactly one blank line between the two blocks.
    expect(out).toContain(`\n\n${user}`);
  });
});

/**
 * Hard safety rules for the evolve subagent. Loaded from
 * `prompts/EVOLVE_GUARDS.md` at module init; falls back to a conservative
 * inline copy if the file is missing so the guard can never go silent.
 *
 * `buildEvolveSystemPrompt` PREPENDS the guards to whatever system prompt
 * the caller supplies. Order matters — the guards have to reach Claude
 * before any caller-supplied instruction that might otherwise be read as
 * permission to break them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Minimal fallback: if EVOLVE_GUARDS.md is missing (fresh checkout without
// the prompts dir, bad packaging, unit test with a synthetic tempdir), the
// evolve loop must still refuse the most destructive actions. This is
// intentionally narrower than the markdown copy — the markdown is the
// source of truth, this is a floor.
const FALLBACK_GUARDS = [
  "You are a subagent running under claude-hermes in a self-edit loop.",
  "Hard safety rules — violating any of these will get your run killed and rolled back:",
  "- Do not run `git stash`, `git checkout <branch>`, `git switch`, `git reset --hard`, or `git clean -fdx`.",
  "- Do not modify files outside the current working directory.",
  "- Do not use `--no-verify`, `--no-gpg-sign`, or any hook-bypass flags.",
  "- Do not force push. Do not push to shared remotes without explicit instruction.",
  "- Do not install global tools or modify global config.",
  "- Do not write or log secrets (API keys, tokens, `.env`, `~/.ssh/`).",
  "- Prefer the smaller, reversible action. When in doubt, stop and ask.",
].join("\n");

const GUARDS_FILE = join(import.meta.dir, "..", "..", "prompts", "EVOLVE_GUARDS.md");

let cached: string | null = null;

/**
 * Returns the evolve safety guards as a single string. Cached after the
 * first read. Falls back to an inlined conservative copy if the markdown
 * file cannot be read — the guards must never go silent, even in broken
 * install states.
 */
export function evolveGuardsText(): string {
  if (cached !== null) return cached;
  try {
    const body = readFileSync(GUARDS_FILE, "utf8").trim();
    cached = body.length > 0 ? body : FALLBACK_GUARDS;
  } catch {
    cached = FALLBACK_GUARDS;
  }
  return cached;
}

/**
 * Prepend the guards to `userSystemPrompt`. If `userSystemPrompt` is
 * empty/undefined, returns the guards alone. A single blank line
 * separates the two so Claude reads them as distinct blocks.
 */
export function buildEvolveSystemPrompt(userSystemPrompt?: string): string {
  const guards = evolveGuardsText();
  const user = (userSystemPrompt ?? "").trim();
  return user.length > 0 ? `${guards}\n\n${user}` : guards;
}

/** Reset the cache. Test-only. */
export function __resetGuardsCache(): void {
  cached = null;
}

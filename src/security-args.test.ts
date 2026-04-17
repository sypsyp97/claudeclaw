import { describe, expect, test } from "bun:test";
import type { SecurityConfig } from "./config";
import { buildSecurityArgs } from "./runner";

function cfg(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    level: "moderate",
    allowedTools: [],
    disallowedTools: [],
    bypassPermissions: false,
    ...overrides,
  };
}

describe("buildSecurityArgs — headless bypass follows the level", () => {
  // Hermes is always headless (heartbeat / Telegram / Discord / cron — no human
  // to click "allow"). If the CLI's permission gate fires, tool use hangs or
  // fails silently. So every level whose *intent* includes write-capable tools
  // must auto-emit --dangerously-skip-permissions. The only level that can run
  // without bypass is `locked`, because Read/Grep/Glob never prompt.

  test("locked default: no bypass (Read/Grep/Glob don't prompt)", () => {
    const args = buildSecurityArgs(cfg({ level: "locked" }));
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("strict auto-emits --dangerously-skip-permissions", () => {
    const args = buildSecurityArgs(cfg({ level: "strict" }));
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("moderate auto-emits --dangerously-skip-permissions", () => {
    const args = buildSecurityArgs(cfg({ level: "moderate" }));
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("unrestricted auto-emits --dangerously-skip-permissions", () => {
    const args = buildSecurityArgs(cfg({ level: "unrestricted" }));
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("bypassPermissions=true forces bypass even in locked mode", () => {
    // The flag is an OR-override: it adds bypass on top of whatever the level
    // would derive. Useful if someone pins `locked` for surface reasons but
    // still needs unattended Edit/Write on a narrow allowedTools list.
    const args = buildSecurityArgs(cfg({ level: "locked", bypassPermissions: true }));
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("--dangerously-skip-permissions is emitted at most once", () => {
    // moderate derives it; the flag also asks for it. We must not emit twice.
    const args = buildSecurityArgs(cfg({ level: "moderate", bypassPermissions: true }));
    const count = args.filter((a) => a === "--dangerously-skip-permissions").length;
    expect(count).toBe(1);
  });
});

describe("buildSecurityArgs — level presets use the CLI-standard flags", () => {
  test("locked → --allowedTools Read,Grep,Glob (not --tools)", () => {
    const args = buildSecurityArgs(cfg({ level: "locked" }));
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Read,Grep,Glob");
    // The non-standard `--tools` flag is gone.
    expect(args).not.toContain("--tools");
  });

  test("strict → --disallowedTools Bash,WebSearch,WebFetch", () => {
    const args = buildSecurityArgs(cfg({ level: "strict" }));
    const idx = args.indexOf("--disallowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Bash,WebSearch,WebFetch");
  });

  test("moderate emits no tool-surface flags by default", () => {
    const args = buildSecurityArgs(cfg({ level: "moderate" }));
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--tools");
  });

  test("unrestricted emits no tool-surface flags", () => {
    const args = buildSecurityArgs(cfg({ level: "unrestricted" }));
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
  });
});

describe("buildSecurityArgs — tool lists are comma-joined, not space-joined", () => {
  test("allowedTools list is passed as a single comma-joined value", () => {
    const args = buildSecurityArgs(cfg({ allowedTools: ["Read", "Bash"] }));
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Read,Bash");
    // Defense against regressions: a space-joined value would collapse to a
    // single tool name and silently fail closed.
    expect(args[idx + 1]).not.toBe("Read Bash");
  });

  test("disallowedTools list is passed as a single comma-joined value", () => {
    const args = buildSecurityArgs(cfg({ disallowedTools: ["WebFetch", "Bash", "WebSearch"] }));
    const idx = args.indexOf("--disallowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("WebFetch,Bash,WebSearch");
  });

  test("empty caller lists do not add stray flags", () => {
    const args = buildSecurityArgs(cfg({ level: "locked" }));
    // locked emits --allowedTools for its own preset; make sure the caller's
    // empty list does not add a second one or a stray --disallowedTools.
    expect(args.filter((a) => a === "--allowedTools").length).toBe(1);
    expect(args).not.toContain("--disallowedTools");
  });
});

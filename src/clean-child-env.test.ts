import { describe, expect, test } from "bun:test";
import { cleanChildEnv } from "./runner";

// Claude CLI child processes inherit the parent's env. When Hermes is
// launched from inside another Claude Code session (a common dev path), the
// child sees CLAUDECODE/CLAUDE_CODE_* vars and can:
//   1. Mis-detect itself as "nested under Claude Code" and IPC permission
//      prompts back to the parent window instead of running headless.
//   2. Use the parent's exec path / entrypoint in diagnostics that are wrong
//      for the daemon.
// cleanChildEnv strips the whole CLAUDE_CODE_* namespace plus the legacy
// CLAUDECODE flag so the child boots like a fresh terminal invocation.
describe("cleanChildEnv — strips parent Claude Code signalling vars", () => {
  test("strips CLAUDECODE", () => {
    const env = cleanChildEnv({ CLAUDECODE: "1", HOME: "/home/a" });
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env.HOME).toBe("/home/a");
  });

  test("strips CLAUDE_CODE_ENTRYPOINT", () => {
    const env = cleanChildEnv({ CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/usr/bin" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("strips CLAUDE_CODE_EXECPATH", () => {
    const env = cleanChildEnv({ CLAUDE_CODE_EXECPATH: "C:\\a\\claude.exe" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_EXECPATH");
  });

  test("strips any future CLAUDE_CODE_* var", () => {
    // Using a prefix match guards against new CLAUDE_CODE_* vars that a
    // future Claude Code release might add. If one of those leaks into the
    // child we're back to square one; prefix stripping is the cheap fix.
    const env = cleanChildEnv({
      CLAUDE_CODE_SOMETHING_NEW: "x",
      CLAUDE_CODE_PARENT_PID: "42",
      USER: "alice",
    });
    expect(env).not.toHaveProperty("CLAUDE_CODE_SOMETHING_NEW");
    expect(env).not.toHaveProperty("CLAUDE_CODE_PARENT_PID");
    expect(env.USER).toBe("alice");
  });

  test("does NOT strip unrelated CLAUDE_* vars (e.g. ANTHROPIC creds)", () => {
    // Stripping too aggressively would kill auth / provider routing. Only
    // the CLAUDE_CODE_* namespace and the legacy CLAUDECODE flag go.
    const env = cleanChildEnv({
      CLAUDE_MODEL: "opus",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "t",
    });
    expect(env.CLAUDE_MODEL).toBe("opus");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("t");
  });

  test("treats undefined values as absent (process.env quirk)", () => {
    // process.env values are technically `string | undefined`. The helper
    // must return a Record<string, string> — no undefineds leaking through.
    const env = cleanChildEnv({ HOME: "/home/a", MAYBE: undefined });
    expect(env.HOME).toBe("/home/a");
    expect(env).not.toHaveProperty("MAYBE");
    for (const v of Object.values(env)) {
      expect(typeof v).toBe("string");
    }
  });
});

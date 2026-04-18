/**
 * Pins the tool-trajectory wiring from runClaudeOnceStreaming →
 * captureCandidateSkill.
 *
 * Today `execClaude` passes `tools: []` into `captureCandidateSkill`, so the
 * SKILL.md body never learns about tool_use events the assistant emitted.
 * Once the runner pipes its StatusEvent stream through a `createToolCollector`
 * and hands the resulting `TrajectoryToolCall[]` to the capture hook, the
 * assistant's tool list should land in the generated SKILL.md body as
 * `- <name> (ok|fail)` lines. These tests fail today and pass after that
 * wiring lands.
 *
 * Test hermeticism copies persistence.test.ts: a fresh tempdir + workspace per
 * test, dynamic imports so each workspace captures its own cwd, and an
 * afterEach that drops the shared-db cache + restores cwd + retries rm.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../tests/helpers/rm-with-retry";
import type { StatusSink } from "./status/sink";

const ORIG_CWD = process.cwd();
const FAKE_CLAUDE_ABS = join(ORIG_CWD, "tests", "fixtures", "fake-claude.ts");

const MIN_SETTINGS = {
  model: "",
  api: "",
  fallback: { model: "", api: "" },
  agentic: { enabled: false, defaultMode: "implementation", modes: [] },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: {
    enabled: false,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: false,
  },
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], listenChannels: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  stt: { baseUrl: "", model: "" },
  // This is the flag the capture path gates on — without it the completion
  // hook short-circuits at `skipped:disabled` and no skill is ever written.
  learning: { captureCandidateSkills: true },
};

const noopSink: StatusSink = {
  async open() {},
  async update() {},
  async close() {},
};

interface Workspace {
  dir: string;
  runner: typeof import("./runner");
  sessions: typeof import("./sessions");
  config: typeof import("./config");
  shared: typeof import("./state/shared-db");
  skillsRepo: typeof import("./state/repos/skills");
}

async function makeWorkspace(prefix: string): Promise<Workspace> {
  const rawDir = mkdtempSync(join(tmpdir(), `hermes-tools-traj-${prefix}-`));
  mkdirSync(join(rawDir, ".claude", "hermes", "logs"), { recursive: true });
  writeFileSync(join(rawDir, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.chdir(rawDir);
  // macOS resolves tmp symlinks on chdir, so read cwd back for teardown.
  const dir = process.cwd();
  process.env.HERMES_CLAUDE_BIN = `bun run ${FAKE_CLAUDE_ABS}`;

  const config = await import("./config");
  await config.loadSettings();
  const sessions = await import("./sessions");
  const runner = await import("./runner");
  const shared = await import("./state/shared-db");
  const skillsRepo = await import("./state/repos/skills");
  return { dir, runner, sessions, config, shared, skillsRepo };
}

async function teardown(ws: Workspace): Promise<void> {
  try {
    await ws.sessions.resetSession();
  } catch {
    // session may already be cleared
  }
  await ws.shared.resetSharedDbCache();
  process.chdir(ORIG_CWD);
  await rmWithRetry(ws.dir);
}

async function writeScenario(
  ws: Workspace,
  streamEvents: unknown[],
  opts: { sessionId?: string } = {}
): Promise<string> {
  const sessionId = opts.sessionId ?? `tool-traj-${Math.random().toString(36).slice(2, 10)}`;
  const scenario = { sessionId, streamEvents };
  const path = join(ws.dir, `scenario-${Math.random().toString(36).slice(2, 9)}.json`);
  await writeFile(path, JSON.stringify(scenario), "utf8");
  process.env.HERMES_FAKE_SCENARIO_PATH = path;
  return path;
}

/**
 * Resolve the one-and-only captured skill directory. The capture hook writes
 * under `.claude/hermes/skills/<slugified-prompt>/`, so we just scan the
 * parent and expect exactly one entry.
 */
function findCapturedSkill(ws: Workspace): { name: string; dir: string } {
  const root = join(ws.dir, ".claude", "hermes", "skills");
  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  expect(entries.length).toBe(1);
  const name = entries[0]!.name;
  return { name, dir: join(root, name) };
}

afterEach(() => {
  delete process.env.HERMES_FAKE_DELAY_MS;
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_ECHO_PROMPT;
  delete process.env.HERMES_FAKE_SESSION_ID;
  delete process.env.HERMES_FAKE_RATE_LIMIT;
  delete process.env.HERMES_FAKE_EXIT;
  delete process.env.HERMES_FAKE_STDERR;
  delete process.env.HERMES_FAKE_SCENARIO_PATH;
});

afterAll(() => {
  delete process.env.HERMES_CLAUDE_BIN;
  process.chdir(ORIG_CWD);
});

describe("runner propagates tool-use trajectory into captureCandidateSkill", () => {
  test("single tool_use + ok tool_result lands in captured SKILL.md as - Read (ok)", async () => {
    const ws = await makeWorkspace("single-ok");
    try {
      const sessionId = "traj-single-ok";
      await writeScenario(
        ws,
        [
          { type: "system", subtype: "init", session_id: sessionId, model: "fake" },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "reply body that is at least six words long",
                },
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "Read",
                  input: { file_path: "/x" },
                },
              ],
            },
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: sessionId,
            result: "reply body that is at least six words long",
            num_turns: 1,
          },
        ],
        { sessionId }
      );

      const r = await ws.runner.run(
        "tool-traj-single",
        "read the readme file and summarise it",
        undefined,
        noopSink
      );
      expect(r.exitCode).toBe(0);

      // Give the fire-and-forget captureCandidateSkill microtask a chance to
      // finish (it runs inside `void (async () => …)()` in execClaude).
      await new Promise((resolve) => setTimeout(resolve, 100));

      const { name, dir } = findCapturedSkill(ws);
      const skillMd = await readFile(join(dir, "SKILL.md"), "utf8");
      expect(skillMd).toContain("- Read (ok)");

      const db = await ws.shared.getSharedDb();
      const row = ws.skillsRepo.getSkill(db, name);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("candidate");
    } finally {
      await teardown(ws);
    }
  });

  test("tool_result with is_error:true lands as - Bash (fail)", async () => {
    const ws = await makeWorkspace("single-fail");
    try {
      const sessionId = "traj-single-fail";
      await writeScenario(
        ws,
        [
          { type: "system", subtype: "init", session_id: sessionId, model: "fake" },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "reply body that is at least six words long",
                },
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "Bash",
                  input: { command: "ls" },
                },
              ],
            },
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-1",
                  is_error: true,
                  content: "boom",
                },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: sessionId,
            result: "reply body that is at least six words long",
            num_turns: 1,
          },
        ],
        { sessionId }
      );

      const r = await ws.runner.run(
        "tool-traj-fail",
        "run a command that lists the directory contents",
        undefined,
        noopSink
      );
      expect(r.exitCode).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const { dir } = findCapturedSkill(ws);
      const skillMd = await readFile(join(dir, "SKILL.md"), "utf8");
      expect(skillMd).toContain("- Bash (fail)");
    } finally {
      await teardown(ws);
    }
  });

  test("two tool_use blocks both land in SKILL.md in tool_use_start order", async () => {
    const ws = await makeWorkspace("two-tools");
    try {
      const sessionId = "traj-two-tools";
      // Assistant emits Read first, then Edit. User then returns tool_results
      // in reverse order (tu-2 / Edit before tu-1 / Read). The collector
      // snapshots in `tool_use_start` arrival order, so Read must still come
      // before Edit in the SKILL.md body.
      await writeScenario(
        ws,
        [
          { type: "system", subtype: "init", session_id: sessionId, model: "fake" },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "reply body that is at least six words long",
                },
                {
                  type: "tool_use",
                  id: "tu-1",
                  name: "Read",
                  input: { file_path: "/a" },
                },
                {
                  type: "tool_use",
                  id: "tu-2",
                  name: "Edit",
                  input: { file_path: "/b" },
                },
              ],
            },
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-2", content: "ok" },
                { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            session_id: sessionId,
            result: "reply body that is at least six words long",
            num_turns: 1,
          },
        ],
        { sessionId }
      );

      const r = await ws.runner.run(
        "tool-traj-two",
        "refactor the handler to use the new interface",
        undefined,
        noopSink
      );
      expect(r.exitCode).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const { dir } = findCapturedSkill(ws);
      const skillMd = await readFile(join(dir, "SKILL.md"), "utf8");
      expect(skillMd).toContain("- Read (ok)");
      expect(skillMd).toContain("- Edit (ok)");

      const readIdx = skillMd.indexOf("- Read (ok)");
      const editIdx = skillMd.indexOf("- Edit (ok)");
      // Both non-negative is already covered by the toContain asserts above,
      // but the order assert itself only makes sense with positive indices.
      expect(readIdx).toBeGreaterThanOrEqual(0);
      expect(editIdx).toBeGreaterThanOrEqual(0);
      expect(readIdx).toBeLessThan(editIdx);
    } finally {
      await teardown(ws);
    }
  });
});

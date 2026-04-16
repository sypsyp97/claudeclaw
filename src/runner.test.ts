import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CWD = process.cwd();
const FAKE_CLAUDE_ABS = join(ORIG_CWD, "tests", "fixtures", "fake-claude.ts");

let tmpProj: string;
let runner: typeof import("./runner");
let sessions: typeof import("./sessions");
let config: typeof import("./config");

const MIN_SETTINGS = {
  model: "",
  api: "",
  fallback: { model: "", api: "" },
  agentic: { enabled: false, defaultMode: "implementation", modes: [] },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: { enabled: false, interval: 15, prompt: "", excludeWindows: [], forwardToTelegram: false },
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], listenChannels: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  stt: { baseUrl: "", model: "" },
};

beforeAll(async () => {
  tmpProj = mkdtempSync(join(tmpdir(), "hermes-runner-"));
  process.chdir(tmpProj);
  mkdirSync(join(tmpProj, ".claude", "hermes", "logs"), { recursive: true });
  writeFileSync(join(tmpProj, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.env.HERMES_CLAUDE_BIN = `bun run ${FAKE_CLAUDE_ABS}`;

  config = await import("./config");
  await config.loadSettings();
  sessions = await import("./sessions");
  runner = await import("./runner");
});

afterAll(() => {
  process.chdir(ORIG_CWD);
  delete process.env.HERMES_CLAUDE_BIN;
  delete process.env.HERMES_FAKE_DELAY_MS;
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_ECHO_PROMPT;
  delete process.env.HERMES_FAKE_SESSION_ID;
  delete process.env.HERMES_FAKE_RATE_LIMIT;
  delete process.env.HERMES_FAKE_EXIT;
  rmSync(tmpProj, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env.HERMES_FAKE_DELAY_MS;
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_ECHO_PROMPT;
  delete process.env.HERMES_FAKE_SESSION_ID;
  delete process.env.HERMES_FAKE_RATE_LIMIT;
  delete process.env.HERMES_FAKE_EXIT;
  // Force a fresh global session for the next test's "new session" assertions.
  await sessions.resetSession();
});

describe("runner queue scheduling", () => {
  test("global queue serializes back-to-back calls on the same session", async () => {
    process.env.HERMES_FAKE_DELAY_MS = "300";
    const start = Date.now();
    const [r1, r2] = await Promise.all([runner.run("seq-a", "hi"), runner.run("seq-b", "hi")]);
    const elapsed = Date.now() - start;
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    // 2 spawns × 300ms delay each + spawn overhead. Serialized must clearly
    // exceed one call's worth.
    expect(elapsed).toBeGreaterThan(550);
  });

  test("per-thread queues run in parallel across distinct threads", async () => {
    process.env.HERMES_FAKE_DELAY_MS = "400";
    const start = Date.now();
    const [r1, r2] = await Promise.all([
      runner.run("par-a", "hi", "thread-X"),
      runner.run("par-b", "hi", "thread-Y"),
    ]);
    const elapsed = Date.now() - start;
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    // Two independent thread queues should both finish in roughly one delay
    // window plus spawn overhead — well under 2× delay.
    expect(elapsed).toBeLessThan(700);
  });

  test("messages within the same thread queue are serialized", async () => {
    process.env.HERMES_FAKE_DELAY_MS = "300";
    const start = Date.now();
    const [r1, r2] = await Promise.all([
      runner.run("samethread-a", "hi", "thread-Z"),
      runner.run("samethread-b", "hi", "thread-Z"),
    ]);
    const elapsed = Date.now() - start;
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(elapsed).toBeGreaterThan(550);
  });
});

describe("runner happy path", () => {
  test("creates session from fake-claude JSON on first call, resumes on second", async () => {
    process.env.HERMES_FAKE_SESSION_ID = "fake-fixed-session-001";
    process.env.HERMES_FAKE_REPLY = "first-call";
    const r1 = await runner.run("hp-new", "hello");
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout.trim()).toBe("first-call");

    const created = await sessions.peekSession();
    expect(created?.sessionId).toBe("fake-fixed-session-001");
    expect(created?.turnCount).toBe(0); // new session does not increment

    process.env.HERMES_FAKE_REPLY = "second-call";
    const r2 = await runner.run("hp-resume", "hello again");
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.trim()).toBe("second-call");

    const after = await sessions.peekSession();
    expect(after?.sessionId).toBe("fake-fixed-session-001"); // still the same session
    expect(after?.turnCount).toBe(1); // resume increments
  });

  test("writes a per-run log file under .claude/hermes/logs/", async () => {
    process.env.HERMES_FAKE_REPLY = "logged-output";
    const before = readdirSync(join(tmpProj, ".claude", "hermes", "logs")).length;
    const result = await runner.run("logwrite", "hi");
    expect(result.exitCode).toBe(0);

    const files = readdirSync(join(tmpProj, ".claude", "hermes", "logs"));
    expect(files.length).toBe(before + 1);
    const newFile = files.find((f) => f.startsWith("logwrite-"));
    expect(newFile).toBeDefined();
    const contents = await readFile(join(tmpProj, ".claude", "hermes", "logs", newFile!), "utf8");
    expect(contents).toContain("# logwrite");
    expect(contents).toContain("Exit code: 0");
    expect(contents).toContain("logged-output");
  });

  test("returns a structured RunResult with stdout, stderr, exitCode", async () => {
    process.env.HERMES_FAKE_REPLY = "ok";
    const r = await runner.run("shape-check", "hi");
    expect(typeof r.stdout).toBe("string");
    expect(typeof r.stderr).toBe("string");
    expect(typeof r.exitCode).toBe("number");
  });
});

describe("runner thread sessions", () => {
  test("creates an independent session per threadId", async () => {
    const sessionMgr = await import("./sessionManager");
    process.env.HERMES_FAKE_SESSION_ID = "thread-session-A";
    const ra = await runner.run("ta", "hi", "thread-iso-A");
    expect(ra.exitCode).toBe(0);
    process.env.HERMES_FAKE_SESSION_ID = "thread-session-B";
    const rb = await runner.run("tb", "hi", "thread-iso-B");
    expect(rb.exitCode).toBe(0);

    const a = await sessionMgr.peekThreadSession("thread-iso-A");
    const b = await sessionMgr.peekThreadSession("thread-iso-B");
    expect(a?.sessionId).toBe("thread-session-A");
    expect(b?.sessionId).toBe("thread-session-B");
    expect(a?.sessionId).not.toBe(b?.sessionId);
  });
});

describe("runUserMessage", () => {
  test("prefixes prompt with a clock line that the model sees", async () => {
    process.env.HERMES_FAKE_ECHO_PROMPT = "1";
    process.env.HERMES_FAKE_SESSION_ID = "echo-session";
    const r = await runner.runUserMessage("clock-prefix", "what time is it");
    expect(r.exitCode).toBe(0);
    // fake-claude echoes the prompt back; the runner injects a clock prefix
    // before user content, so the reply should contain both the user words
    // and a 4-digit year.
    expect(r.stdout).toContain("what time is it");
    expect(r.stdout).toMatch(/20\d{2}/);
  });
});

describe("bootstrap", () => {
  test("is a no-op when a session already exists", async () => {
    await sessions.createSession("preexisting-session-id");
    const before = await sessions.peekSession();
    process.env.HERMES_FAKE_REPLY = "should-not-be-called";
    await runner.bootstrap();
    const after = await sessions.peekSession();
    expect(after?.sessionId).toBe(before?.sessionId);
  });

  test("creates a session when none exists", async () => {
    process.env.HERMES_FAKE_SESSION_ID = "bootstrapped-session";
    process.env.HERMES_FAKE_REPLY = "wakeup-ok";
    await runner.bootstrap();
    const after = await sessions.peekSession();
    expect(after?.sessionId).toBe("bootstrapped-session");
  });
});

describe("compactCurrentSession", () => {
  test("returns failure when no active session exists", async () => {
    const result = await runner.compactCurrentSession();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No active session/i);
  });

  test("returns success when fake-claude exits 0 on /compact", async () => {
    await sessions.createSession("compactable-session-id");
    process.env.HERMES_FAKE_REPLY = "compacted";
    const result = await runner.compactCurrentSession();
    expect(result.success).toBe(true);
    expect(result.message).toContain("compactable-session-id".slice(0, 8));
  });
});

describe("ensureProjectClaudeMd", () => {
  const projectClaudeMd = () => join(tmpProj, "CLAUDE.md");
  const legacyClaudeMd = () => join(tmpProj, ".claude", "CLAUDE.md");

  afterEach(async () => {
    for (const path of [projectClaudeMd(), legacyClaudeMd()]) {
      if (existsSync(path)) rmSync(path);
    }
  });

  test("creates CLAUDE.md with the new managed block when no file exists", async () => {
    expect(existsSync(projectClaudeMd())).toBe(false);
    await runner.ensureProjectClaudeMd();
    expect(existsSync(projectClaudeMd())).toBe(true);
    const body = await readFile(projectClaudeMd(), "utf8");
    expect(body).toContain("<!-- hermes:managed:start -->");
    expect(body).toContain("<!-- hermes:managed:end -->");
  });

  test("is a no-op when CLAUDE.md already exists", async () => {
    const userContent = "# my hand-written notes\nDo not touch.\n";
    await writeFile(projectClaudeMd(), userContent, "utf8");
    await runner.ensureProjectClaudeMd();
    const body = await readFile(projectClaudeMd(), "utf8");
    expect(body).toBe(userContent);
  });

  test("rewrites legacy markers in the migrated content to the new marker name", async () => {
    const legacy = [
      "# My agent",
      "",
      "<!-- claudeclaw:managed:start -->",
      "old managed content",
      "<!-- claudeclaw:managed:end -->",
      "",
    ].join("\n");
    await writeFile(legacyClaudeMd(), legacy, "utf8");
    await runner.ensureProjectClaudeMd();
    expect(existsSync(projectClaudeMd())).toBe(true);
    const body = await readFile(projectClaudeMd(), "utf8");
    expect(body).toContain("<!-- hermes:managed:start -->");
    expect(body).toContain("<!-- hermes:managed:end -->");
    expect(body).not.toContain("<!-- claudeclaw:managed:start -->");
    expect(body).not.toContain("<!-- claudeclaw:managed:end -->");
    expect(body).toContain("# My agent"); // user header preserved
  });

  test("appends a managed block when legacy file has user content but no managed markers", async () => {
    const legacy = "# Notes only, no managed block\nLine two.\n";
    await writeFile(legacyClaudeMd(), legacy, "utf8");
    await runner.ensureProjectClaudeMd();
    const body = await readFile(projectClaudeMd(), "utf8");
    expect(body).toContain("# Notes only, no managed block");
    expect(body).toContain("Line two.");
    expect(body).toContain("<!-- hermes:managed:start -->");
  });
});

describe("compact event listener registration", () => {
  test("onCompactEvent accepts a listener without throwing", () => {
    const calls: unknown[] = [];
    expect(() => runner.onCompactEvent((e) => calls.push(e))).not.toThrow();
  });
});

describe("loadHeartbeatPromptTemplate", () => {
  test("returns a non-empty string when a prompt file is shipped", async () => {
    const template = await runner.loadHeartbeatPromptTemplate();
    expect(typeof template).toBe("string");
    // The bundled HEARTBEAT.md exists in prompts/heartbeat/. If a future
    // refactor removes it, this will break and tell the maintainer.
    expect(template.length).toBeGreaterThan(0);
  });
});

// --- StatusSink integration ---
// When a caller attaches a StatusSink, execClaude switches to
// runClaudeOnceStreaming (stream-json --verbose) and drives events into the
// sink. These tests share the outer beforeAll's tmpProj + fake-claude wiring.

describe("runner.run with a StatusSink", () => {
  test("streams events into the sink and returns the assistant's final text as stdout", async () => {
    const { createFakeSink } = await import("./status/sink");
    const { writeFile } = await import("node:fs/promises");
    const scenarioPath = join(tmpProj, `sink-ok-${Date.now()}.json`);
    await writeFile(
      scenarioPath,
      JSON.stringify({
        streamEvents: [
          { type: "system", subtype: "init", session_id: "sess-sink-ok", model: "fake" },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } }],
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
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "final user-visible reply" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "final user-visible reply",
            session_id: "sess-sink-ok",
            num_turns: 1,
          },
        ],
      }),
      "utf8"
    );
    const prevScenario = process.env.HERMES_FAKE_SCENARIO_PATH;
    process.env.HERMES_FAKE_SCENARIO_PATH = scenarioPath;
    try {
      const sink = createFakeSink();
      const result = await runner.run("sink-ok", "hi", "thread-sink-ok", sink);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("final user-visible reply");
      const kinds = sink.events().map((e) => e.kind);
      expect(kinds).toContain("task_start");
      expect(kinds).toContain("tool_use_start");
      expect(kinds).toContain("tool_use_end");
      expect(kinds).toContain("task_complete");
      expect(sink.calls[0]?.kind).toBe("open");
      expect(sink.calls.at(-1)?.kind).toBe("close");
    } finally {
      if (prevScenario === undefined) delete process.env.HERMES_FAKE_SCENARIO_PATH;
      else process.env.HERMES_FAKE_SCENARIO_PATH = prevScenario;
    }
  });

  test("sink close() is called with ok=false when Claude exits non-zero", async () => {
    const { createFakeSink } = await import("./status/sink");
    const prevExit = process.env.HERMES_FAKE_EXIT;
    const prevStderr = process.env.HERMES_FAKE_STDERR;
    process.env.HERMES_FAKE_EXIT = "3";
    process.env.HERMES_FAKE_STDERR = "fake crash";
    try {
      const sink = createFakeSink();
      const result = await runner.run("sink-fail", "hi", "thread-sink-fail", sink);
      expect(result.exitCode).toBe(3);
      const closeCall = sink.calls.at(-1);
      expect(closeCall?.kind).toBe("close");
      if (closeCall?.kind === "close") {
        expect(closeCall.result.ok).toBe(false);
      }
    } finally {
      if (prevExit === undefined) delete process.env.HERMES_FAKE_EXIT;
      else process.env.HERMES_FAKE_EXIT = prevExit;
      if (prevStderr === undefined) delete process.env.HERMES_FAKE_STDERR;
      else process.env.HERMES_FAKE_STDERR = prevStderr;
    }
  });

  test("without a sink, behavior is unchanged — buffered JSON path still used", async () => {
    process.env.HERMES_FAKE_REPLY = "buffered reply";
    process.env.HERMES_FAKE_SESSION_ID = "sess-buffered-check";
    try {
      const result = await runner.run("sink-absent", "hi", "thread-sink-absent");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("buffered reply");
    } finally {
      delete process.env.HERMES_FAKE_REPLY;
      delete process.env.HERMES_FAKE_SESSION_ID;
    }
  });
});

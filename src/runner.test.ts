import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../tests/helpers/rm-with-retry";

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

afterAll(async () => {
  // Drop the shared-db cache so Windows can release the tmp workspace.
  const { resetSharedDbCache } = await import("./state/shared-db");
  await resetSharedDbCache();
  process.chdir(ORIG_CWD);
  delete process.env.HERMES_CLAUDE_BIN;
  delete process.env.HERMES_FAKE_DELAY_MS;
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_ECHO_PROMPT;
  delete process.env.HERMES_FAKE_SESSION_ID;
  delete process.env.HERMES_FAKE_RATE_LIMIT;
  delete process.env.HERMES_FAKE_EXIT;
  await rmWithRetry(tmpProj);
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

  test("default: writes a metadata-only per-run log file (no body leak)", async () => {
    process.env.HERMES_FAKE_REPLY = "logged-output";
    const before = readdirSync(join(tmpProj, ".claude", "hermes", "logs")).length;
    const result = await runner.run("logwrite", "secret-prompt");
    expect(result.exitCode).toBe(0);

    const files = readdirSync(join(tmpProj, ".claude", "hermes", "logs"));
    expect(files.length).toBe(before + 1);
    const newFile = files.find((f) => f.startsWith("logwrite-"));
    expect(newFile).toBeDefined();
    const contents = await readFile(join(tmpProj, ".claude", "hermes", "logs", newFile!), "utf8");
    // Header metadata still present...
    expect(contents).toContain("# logwrite");
    expect(contents).toContain("Exit code: 0");
    // ...but the prompt and stdout bodies are redacted by default.
    expect(contents).not.toContain("secret-prompt");
    expect(contents).not.toContain("logged-output");
    expect(contents).toContain("bodies redacted");
  });

  test("logging.includeBodies=true: prompt + stdout land in the log file", async () => {
    process.env.HERMES_FAKE_REPLY = "optin-output";
    // Flip the setting on disk, then reload so parseSettings picks it up.
    const settingsPath = join(tmpProj, ".claude", "hermes", "settings.json");
    const raw = JSON.parse(await readFile(settingsPath, "utf8"));
    raw.logging = { includeBodies: true };
    await Bun.write(settingsPath, JSON.stringify(raw, null, 2) + "\n");
    const config = await import("./config");
    await config.reloadSettings();

    try {
      const result = await runner.run("logbodies", "optin-prompt");
      expect(result.exitCode).toBe(0);

      const files = readdirSync(join(tmpProj, ".claude", "hermes", "logs"));
      const newFile = files.find((f) => f.startsWith("logbodies-"));
      expect(newFile).toBeDefined();
      const contents = await readFile(join(tmpProj, ".claude", "hermes", "logs", newFile!), "utf8");
      expect(contents).toContain("optin-prompt");
      expect(contents).toContain("optin-output");
    } finally {
      // Revert settings on disk + in cache so subsequent tests see defaults.
      delete raw.logging;
      await Bun.write(settingsPath, JSON.stringify(raw, null, 2) + "\n");
      await config.reloadSettings();
    }
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

    const a = await sessionMgr.peekThreadSession("cli", "thread-iso-A");
    const b = await sessionMgr.peekThreadSession("cli", "thread-iso-B");
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

describe("extractSessionAndResult", () => {
  test("parses the array-of-envelopes shape the real CLI emits", () => {
    const payload = [
      { type: "system", subtype: "init", session_id: "abc", model: "x" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hey" }] } },
      { type: "result", subtype: "success", session_id: "abc", result: "hey", num_turns: 1 },
    ];
    expect(runner.extractSessionAndResult(payload)).toEqual({ sessionId: "abc", result: "hey" });
  });

  test("accepts the legacy single-object shape for backwards compatibility", () => {
    expect(runner.extractSessionAndResult({ session_id: "s1", result: "r1" })).toEqual({
      sessionId: "s1",
      result: "r1",
    });
  });

  test("prefers the result envelope's session_id over the init envelope's", () => {
    const payload = [
      { type: "system", subtype: "init", session_id: "init-sid" },
      { type: "result", subtype: "success", session_id: "final-sid", result: "ok" },
    ];
    expect(runner.extractSessionAndResult(payload)).toEqual({ sessionId: "final-sid", result: "ok" });
  });

  test("returns empty object for a non-object/array payload", () => {
    expect(runner.extractSessionAndResult("nope")).toEqual({});
    expect(runner.extractSessionAndResult(null)).toEqual({});
  });
});

// --- compactCurrentSession status-sink integration ---
// When a caller passes `{ sink }`, compactCurrentSession drives the sink's
// open/close lifecycle around the underlying runCompact. No update() calls
// are required — the contract only pins open-before and close-after.

interface RecorderSinkCall {
  kind: "open" | "update" | "close";
  payload: unknown;
}

function createRecorderSink() {
  const calls: RecorderSinkCall[] = [];
  const sink = {
    async open(taskId: string, label: string) {
      calls.push({ kind: "open", payload: { taskId, label } });
    },
    async update(event: unknown) {
      calls.push({ kind: "update", payload: event });
    },
    async close(result: unknown) {
      calls.push({ kind: "close", payload: result });
    },
  };
  return { calls, sink };
}

describe("compactCurrentSession — status sink", () => {
  test("happy path: sink sees open then close{ok:true} in order", async () => {
    // Seed an active session by running a normal turn first.
    process.env.HERMES_FAKE_SESSION_ID = "compact-sink-happy";
    process.env.HERMES_FAKE_REPLY = "seed";
    const seed = await runner.run("compact-sink-seed", "hi");
    expect(seed.exitCode).toBe(0);

    const { calls, sink } = createRecorderSink();
    process.env.HERMES_FAKE_REPLY = "compacted";
    const result = await (
      runner.compactCurrentSession as unknown as (opts: {
        sink: unknown;
      }) => Promise<{ success: boolean; message: string }>
    )({ sink });
    expect(result.success).toBe(true);

    const kinds = calls.map((c) => c.kind);
    const openIdx = kinds.indexOf("open");
    const closeIdx = kinds.indexOf("close");
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeLessThan(closeIdx);

    // Exactly one open, exactly one close.
    expect(kinds.filter((k) => k === "open").length).toBe(1);
    expect(kinds.filter((k) => k === "close").length).toBe(1);

    const closeCall = calls[closeIdx]!;
    const closePayload = closeCall.payload as { ok: boolean };
    expect(closePayload.ok).toBe(true);
  });

  test("label passed to open() contains 'compact' (case-insensitive)", async () => {
    process.env.HERMES_FAKE_SESSION_ID = "compact-sink-label";
    process.env.HERMES_FAKE_REPLY = "seed";
    const seed = await runner.run("compact-sink-label-seed", "hi");
    expect(seed.exitCode).toBe(0);

    const { calls, sink } = createRecorderSink();
    process.env.HERMES_FAKE_REPLY = "compacted";
    await (
      runner.compactCurrentSession as unknown as (opts: {
        sink: unknown;
      }) => Promise<{ success: boolean; message: string }>
    )({ sink });

    const openCall = calls.find((c) => c.kind === "open");
    expect(openCall).toBeDefined();
    const { label } = openCall!.payload as { taskId: string; label: string };
    expect(typeof label).toBe("string");
    expect(label.toLowerCase()).toContain("compact");
  });

  test("failure path: close() carries ok=false with a non-empty errorShort", async () => {
    process.env.HERMES_FAKE_SESSION_ID = "compact-sink-fail";
    process.env.HERMES_FAKE_REPLY = "seed";
    const seed = await runner.run("compact-sink-fail-seed", "hi");
    expect(seed.exitCode).toBe(0);

    // Force the compact invocation to exit non-zero.
    process.env.HERMES_FAKE_EXIT = "5";

    const { calls, sink } = createRecorderSink();
    const result = await (
      runner.compactCurrentSession as unknown as (opts: {
        sink: unknown;
      }) => Promise<{ success: boolean; message: string }>
    )({ sink });
    expect(result.success).toBe(false);

    const closeCall = calls.find((c) => c.kind === "close");
    expect(closeCall).toBeDefined();
    const payload = closeCall!.payload as { ok: boolean; errorShort?: string };
    expect(payload.ok).toBe(false);
    expect(typeof payload.errorShort).toBe("string");
    expect((payload.errorShort ?? "").length).toBeGreaterThan(0);
  });

  test("no active session: sink.open/close are not called", async () => {
    // Fresh state — afterEach's resetSession should have cleared anything, but
    // be explicit to keep the test self-contained.
    await sessions.resetSession();

    const { calls, sink } = createRecorderSink();
    const result = await (
      runner.compactCurrentSession as unknown as (opts: {
        sink: unknown;
      }) => Promise<{ success: boolean; message: string }>
    )({ sink });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No active session/i);

    const kinds = calls.map((c) => c.kind);
    expect(kinds).not.toContain("open");
    expect(kinds).not.toContain("close");
  });

  test("backward compat: compactCurrentSession() with no args still returns {success, message}", async () => {
    process.env.HERMES_FAKE_SESSION_ID = "compact-sink-compat";
    process.env.HERMES_FAKE_REPLY = "seed";
    const seed = await runner.run("compact-sink-compat-seed", "hi");
    expect(seed.exitCode).toBe(0);

    process.env.HERMES_FAKE_REPLY = "compacted";
    const result = await runner.compactCurrentSession();
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.message).toBe("string");
    expect(result.success).toBe(true);
  });
});

// --- status label must not leak the user's prompt ---
// Regression: the Discord status sink posts a "Hermes working… — <label>"
// header. Earlier revisions passed prompt.slice(0, 140) as the label, which
// echoed the user's own message back into the public status channel. The
// label must be an internal task identifier, never the prompt body.
describe("status label — user message must not leak", () => {
  test("run(name, prompt, ..., sink) passes name (not prompt) to sink.open", async () => {
    process.env.HERMES_FAKE_SESSION_ID = "label-leak-test";
    process.env.HERMES_FAKE_REPLY = "ok";

    const { calls, sink } = createRecorderSink();
    const secretPrompt = "private-user-secret-abc123";
    const result = await runner.run("discord", secretPrompt, undefined, sink as unknown as undefined);
    expect(result.exitCode).toBe(0);

    const openCall = calls.find((c) => c.kind === "open");
    expect(openCall).toBeDefined();
    const payload = openCall!.payload as { taskId: string; label: string };
    // The label must be the task identifier ("discord"), not the prompt text.
    expect(payload.label).toBe("discord");
    expect(payload.label).not.toContain("private-user-secret-abc123");
  });
});

import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getSession, createSession, incrementTurn, markCompactWarned } from "./sessions";
import {
  getThreadSession,
  createThreadSession,
  incrementThreadTurn,
  markThreadCompactWarned,
} from "./sessionManager";
import { getSettings, type ModelConfig, type SecurityConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";
import { selectModel } from "./model-router";
import { claudeArgv } from "./runtime/claude-cli";
import { createStreamParser, type StatusEvent } from "./status/stream";
import type { StatusSink } from "./status/sink";
import {
  LEGACY_MANAGED_BLOCK_END,
  LEGACY_MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  legacyProjectClaudeMdFile,
  logsDir,
  projectClaudeMdFile,
  promptsDir,
} from "./paths";

// These are anchored to the hermes installation (via import.meta.dir), not the
// project's cwd, so they are safe to freeze at module load.
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const HEARTBEAT_PROMPT_FILE = join(PROMPTS_DIR, "heartbeat", "HEARTBEAT.md");

/**
 * Compact configuration.
 * COMPACT_WARN_THRESHOLD: notify user that context is getting large.
 * COMPACT_TIMEOUT_ENABLED: whether to auto-compact on timeout (exit 124).
 */
const COMPACT_WARN_THRESHOLD = 25;
const COMPACT_TIMEOUT_ENABLED = true;

export type CompactEvent =
  | { type: "warn"; turnCount: number }
  | { type: "auto-compact-start" }
  | { type: "auto-compact-done"; success: boolean }
  | { type: "auto-compact-retry"; success: boolean; stdout: string; stderr: string; exitCode: number };

type CompactEventListener = (event: CompactEvent) => void;
const compactListeners: CompactEventListener[] = [];

/** Register a listener for compact-related events (warnings, auto-compact notifications). */
export function onCompactEvent(listener: CompactEventListener): void {
  compactListeners.push(listener);
}

function emitCompactEvent(event: CompactEvent): void {
  for (const listener of compactListeners) {
    try { listener(event); } catch {}
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const RATE_LIMIT_PATTERN = /you.ve hit your limit|out of extra usage/i;

// Serial queue — prevents concurrent --resume on the same session
// Global queue for non-thread messages (backward compatible)
let globalQueue: Promise<unknown> = Promise.resolve();
// Per-thread queues — each thread runs independently in parallel
const threadQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(fn: () => Promise<T>, threadId?: string): Promise<T> {
  if (threadId) {
    const current = threadQueues.get(threadId) ?? Promise.resolve();
    const task = current.then(fn, fn);
    threadQueues.set(threadId, task.catch(() => {}));
    return task;
  }
  const task = globalQueue.then(fn, fn);
  globalQueue = task.catch(() => {});
  return task;
}

function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

function sameModelConfig(a: ModelConfig, b: ModelConfig): boolean {
  return a.model.trim().toLowerCase() === b.model.trim().toLowerCase() && a.api.trim() === b.api.trim();
}

function hasModelConfig(value: ModelConfig): boolean {
  return value.model.trim().length > 0 || value.api.trim().length > 0;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return /enoent|no such file or directory/i.test(message);
}

function buildChildEnv(baseEnv: Record<string, string>, model: string, api: string): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv };
  const normalizedModel = model.trim().toLowerCase();

  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();

  if (normalizedModel === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  return childEnv;
}

/** Default timeout for a single Claude Code invocation (5 minutes). */
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;

async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  timeoutMs: number = CLAUDE_TIMEOUT_MS
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  // The timeout timer must be cleared on success — otherwise it keeps the
  // event loop alive (`claude-hermes send` would hang for the full
  // CLAUDE_TIMEOUT_MS after the child has already exited cleanly).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)),
      timeoutMs
    );
  });

  try {
    const [rawStdout, stderr] = (await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
      timeoutPromise,
    ])) as [string, string];
    await proc.exited;

    return {
      rawStdout,
      stderr,
      exitCode: proc.exitCode ?? 1,
    };
  } catch (err) {
    // Kill the hung process. Use unref() on the SIGKILL fallback so it
    // doesn't itself keep the event loop alive after the function returns.
    try { proc.kill("SIGTERM"); } catch {}
    const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    if (typeof killTimer.unref === "function") killTimer.unref();

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] ${message}`);

    return {
      rawStdout: "",
      stderr: message,
      exitCode: 124,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Streaming variant of runClaudeOnce — used when the caller attaches a
 * StatusSink (Discord/Telegram live-status path). Spawns claude with
 * --output-format stream-json --verbose, pipes events through the sink,
 * and returns the same shape runClaudeOnce does plus the sessionId +
 * finalResult already extracted from the stream.
 *
 * rawStdout here is the raw NDJSON (for log files); callers that need a
 * final reply should use finalResult, and callers that need the session
 * id should use sessionId. The JSON.parse() path in execClaude only runs
 * for the buffered (non-streaming) variant.
 */
async function runClaudeOnceStreaming(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  timeoutMs: number,
  sink: StatusSink,
  taskId: string,
  taskLabel: string,
): Promise<{
  rawStdout: string;
  stderr: string;
  exitCode: number;
  sessionId?: string;
  finalResult?: string;
}> {
  const args = [...baseArgs, "--output-format", "stream-json", "--verbose"];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  await sink.open(taskId, taskLabel);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });

  const parser = createStreamParser();
  let rawStdout = "";
  let sessionId: string | undefined;
  let finalResult: string | undefined;
  let errorShort: string | undefined;

  async function handleEvents(events: StatusEvent[]): Promise<void> {
    for (const event of events) {
      if (event.kind === "task_start") {
        sessionId = event.sessionId ?? sessionId;
      } else if (event.kind === "task_complete") {
        sessionId = event.sessionId ?? sessionId;
        finalResult = event.result;
      } else if (event.kind === "error") {
        errorShort = event.message;
      }
      try {
        await sink.update(event);
      } catch {
        // sink failures must never kill the Claude process
      }
    }
  }

  const readStdout = async (): Promise<void> => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawStdout += chunk;
        await handleEvents(parser.push(chunk));
      }
      const tail = decoder.decode();
      if (tail) {
        rawStdout += tail;
        await handleEvents(parser.push(tail));
      }
      await handleEvents(parser.flush());
    } finally {
      reader.releaseLock();
    }
  };

  try {
    const [, stderr] = (await Promise.race([
      Promise.all([readStdout(), new Response(proc.stderr).text()]),
      timeoutPromise,
    ])) as [void, string];
    await proc.exited;
    const exitCode = proc.exitCode ?? 1;
    const ok = exitCode === 0;
    try {
      const closeResult: { ok: boolean; finalText?: string; errorShort?: string } = { ok };
      if (finalResult !== undefined) closeResult.finalText = finalResult;
      if (!ok && (errorShort ?? stderr)) closeResult.errorShort = errorShort ?? stderr.trim().slice(-200);
      await sink.close(closeResult);
    } catch {
      // close failures must not mask the task result
    }
    const out: {
      rawStdout: string;
      stderr: string;
      exitCode: number;
      sessionId?: string;
      finalResult?: string;
    } = { rawStdout, stderr, exitCode };
    if (sessionId !== undefined) out.sessionId = sessionId;
    if (finalResult !== undefined) out.finalResult = finalResult;
    return out;
  } catch (err) {
    try { proc.kill("SIGTERM"); } catch {}
    const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    if (typeof killTimer.unref === "function") killTimer.unref();
    const message = err instanceof Error ? err.message : String(err);
    try {
      await sink.close({ ok: false, errorShort: message });
    } catch {
      // swallow
    }
    return { rawStdout: "", stderr: message, exitCode: 124 };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function dirScopePrompt(): string {
  return [
    `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${process.cwd()}`,
    "You MUST NOT read, write, edit, or delete any file outside this directory.",
    "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
    "If a request requires accessing files outside the project, refuse and explain why.",
  ].join("\n");
}

export async function ensureProjectClaudeMd(): Promise<void> {
  const projectClaudeMd = projectClaudeMdFile();
  const legacyClaudeMd = legacyProjectClaudeMdFile();
  // Preflight-only initialization: never rewrite an existing project CLAUDE.md.
  if (existsSync(projectClaudeMd)) return;

  const promptContent = (await loadPrompts()).trim();
  // We always WRITE the new hermes-named markers. The dual-read regex below
  // accepts the legacy block name so a stale one gets rewritten in place
  // instead of being appended as a second block. The Phase 1D migrator does
  // the same job at daemon startup for files not touched by preflight.
  const managedBlock = [MANAGED_BLOCK_START, promptContent, MANAGED_BLOCK_END].join("\n");

  let content = "";

  if (existsSync(legacyClaudeMd)) {
    try {
      const legacy = await readFile(legacyClaudeMd, "utf8");
      content = legacy.trim();
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read legacy .claude/CLAUDE.md:`, e);
      return;
    }
  }

  const normalized = content.trim();
  const hasManagedBlock =
    (normalized.includes(MANAGED_BLOCK_START) && normalized.includes(MANAGED_BLOCK_END)) ||
    (normalized.includes(LEGACY_MANAGED_BLOCK_START) && normalized.includes(LEGACY_MANAGED_BLOCK_END));
  const managedPattern = new RegExp(
    `(${MANAGED_BLOCK_START}|${LEGACY_MANAGED_BLOCK_START})[\\s\\S]*?(${MANAGED_BLOCK_END}|${LEGACY_MANAGED_BLOCK_END})`,
    "m"
  );

  const merged = hasManagedBlock
    ? `${normalized.replace(managedPattern, managedBlock)}\n`
    : normalized
      ? `${normalized}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;

  try {
    await writeFile(projectClaudeMd, merged, "utf8");
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to write project CLAUDE.md:`, e);
  }
}

/**
 * Translate a `SecurityConfig` into the Claude CLI flags that enforce it.
 *
 * Contract:
 *  - `--dangerously-skip-permissions` is only emitted when the caller set
 *    `bypassPermissions: true`. It is no longer unconditional — hermes has
 *    to opt into the nuclear option explicitly.
 *  - `allowedTools` / `disallowedTools` are emitted as comma-joined lists
 *    (`Read,Grep,Glob`), not space-joined. Space-joined lists are silently
 *    treated by the CLI as a single tool name and fail closed / open
 *    depending on the flag, which is exactly the kind of silent-failure we
 *    are trying to remove.
 *  - `level` provides the default tool surface for each posture:
 *     locked     → `--allowedTools Read,Grep,Glob`
 *     strict     → `--disallowedTools Bash,WebSearch,WebFetch`
 *     moderate   → no tool constraint (directory scope comes from the
 *                  system prompt the caller already appends)
 *     unrestricted → nothing
 *  - Caller-supplied `allowedTools` / `disallowedTools` arrays are appended
 *    in addition to the level defaults.
 */
export function buildSecurityArgs(security: SecurityConfig): string[] {
  const args: string[] = [];
  if (security.bypassPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  switch (security.level) {
    case "locked":
      args.push("--allowedTools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
      // Tool surface open; directory scoping comes from the appended system
      // prompt at the caller.
      break;
    case "unrestricted":
      break;
  }

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(","));
  }
  if (security.disallowedTools.length > 0) {
    args.push("--disallowedTools", security.disallowedTools.join(","));
  }

  return args;
}

/** Load and concatenate all prompt files from the prompts/ directory. */
async function loadPrompts(): Promise<string> {
  const selectedPromptFiles = [
    join(PROMPTS_DIR, "IDENTITY.md"),
    join(PROMPTS_DIR, "USER.md"),
    join(PROMPTS_DIR, "SOUL.md"),
  ];
  const parts: string[] = [];

  for (const file of selectedPromptFiles) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read prompt file ${file}:`, e);
    }
  }

  return parts.join("\n\n");
}

/**
 * Load the heartbeat prompt template.
 * Project-level override takes precedence: place a file at
 * .claude/hermes/prompts/HEARTBEAT.md to fully replace the built-in template.
 */
export async function loadHeartbeatPromptTemplate(): Promise<string> {
  const projectOverride = join(promptsDir(), "HEARTBEAT.md");
  for (const file of [projectOverride, HEARTBEAT_PROMPT_FILE]) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) return content.trim();
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn(`[${new Date().toLocaleTimeString()}] Failed to read heartbeat prompt file ${file}:`, e);
      }
    }
  }
  return "";
}

/** Run /compact on the current session to reduce context size. */
export async function runCompact(
  sessionId: string,
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  securityArgs: string[],
  timeoutMs: number
): Promise<boolean> {
  const compactArgs = [
    ...claudeArgv(),
    "-p", "/compact",
    "--output-format", "text",
    "--resume", sessionId,
    ...securityArgs,
  ];
  console.log(`[${new Date().toLocaleTimeString()}] Running /compact on session ${sessionId.slice(0, 8)}...`);
  const result = await runClaudeOnce(compactArgs, model, api, baseEnv, timeoutMs);
  const success = result.exitCode === 0;
  console.log(`[${new Date().toLocaleTimeString()}] Compact ${success ? "succeeded" : `failed (exit ${result.exitCode})`}`);
  return success;
}

/**
 * High-level compact: resolves session + settings internally.
 * Returns { success, message }.
 */
export async function compactCurrentSession(): Promise<{ success: boolean; message: string }> {
  const existing = await getSession();
  if (!existing) return { success: false, message: "No active session to compact." };

  const settings = getSettings();
  const securityArgs = buildSecurityArgs(settings.security);
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;
  const timeoutMs = (settings as any).sessionTimeoutMs || CLAUDE_TIMEOUT_MS;

  const ok = await runCompact(
    existing.sessionId,
    settings.model,
    settings.api,
    baseEnv,
    securityArgs,
    timeoutMs
  );

  return ok
    ? { success: true, message: `✅ Session compact complete (${existing.sessionId.slice(0, 8)})` }
    : { success: false, message: `❌ Compact failed (${existing.sessionId.slice(0, 8)})` };
}

async function execClaude(
  name: string,
  prompt: string,
  threadId?: string,
  sink?: StatusSink,
): Promise<RunResult> {
  const logs = logsDir();
  await mkdir(logs, { recursive: true });

  const existing = threadId
    ? await getThreadSession(threadId)
    : await getSession();
  const isNew = !existing;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(logs, `${name}-${timestamp}.log`);

  const settings = getSettings();
  const { security, model, api, fallback, agentic } = settings;

  // Determine which model to use based on agentic routing
  let primaryConfig: ModelConfig;
  let taskType = "unknown";
  let routingReasoning = "";

  if (agentic.enabled) {
    const routing = selectModel(prompt, agentic.modes, agentic.defaultMode);
    primaryConfig = { model: routing.model, api };
    taskType = routing.taskType;
    routingReasoning = routing.reasoning;
    console.log(
      `[${new Date().toLocaleTimeString()}] Agentic routing: ${routing.taskType} → ${routing.model} (${routing.reasoning})`
    );
  } else {
    primaryConfig = { model, api };
  }

  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);
  const timeoutMs = (settings as any).sessionTimeoutMs || CLAUDE_TIMEOUT_MS;

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (${isNew ? "new session" : `resume ${existing.sessionId.slice(0, 8)}`}, security: ${security.level})`
  );

  // New session: use json output to capture Claude's session_id
  // Resumed session: use text output with --resume
  // With sink: streaming path (stream-json --verbose) added inside runClaudeOnceStreaming.
  const outputFormat = isNew ? "json" : "text";
  const args = sink
    ? [...claudeArgv(), "-p", prompt, ...securityArgs]
    : [...claudeArgv(), "-p", prompt, "--output-format", outputFormat, ...securityArgs];

  if (!isNew) {
    args.push("--resume", existing.sessionId);
  }

  // Build the appended system prompt: prompt files + directory scoping
  // This is passed on EVERY invocation (not just new sessions) because
  // --append-system-prompt does not persist across --resume.
  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    "You are running inside Claude Hermes.",
  ];
  if (promptContent) appendParts.push(promptContent);

  // Load the project's CLAUDE.md if it exists
  const projectClaudeMd = projectClaudeMdFile();
  if (existsSync(projectClaudeMd)) {
    try {
      const claudeMd = await Bun.file(projectClaudeMd).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }

  if (security.level !== "unrestricted") appendParts.push(dirScopePrompt());
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  // Strip CLAUDECODE env var so child claude processes don't think they're nested
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  let exec: {
    rawStdout: string;
    stderr: string;
    exitCode: number;
    sessionId?: string;
    finalResult?: string;
  } = sink
    ? await runClaudeOnceStreaming(
        args,
        primaryConfig.model,
        primaryConfig.api,
        baseEnv,
        timeoutMs,
        sink,
        name,
        prompt.slice(0, 140),
      )
    : await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = sink
      ? await runClaudeOnceStreaming(
          args,
          fallbackConfig.model,
          fallbackConfig.api,
          baseEnv,
          timeoutMs,
          sink,
          name,
          prompt.slice(0, 140),
        )
      : await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv, timeoutMs);
    usedFallback = true;
  }

  const rawStdout = exec.rawStdout;
  const stderr = exec.stderr;
  const exitCode = exec.exitCode;
  let stdout = rawStdout;
  let sessionId = existing?.sessionId ?? "unknown";
  const rateLimitMessage = extractRateLimitMessage(rawStdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
  }

  // For new sessions, extract session_id + result text. Streaming has these
  // already on `exec`; buffered mode requires a JSON.parse of the JSON envelope.
  if (!rateLimitMessage && isNew && exitCode === 0) {
    if (sink && exec.sessionId) {
      sessionId = exec.sessionId;
      stdout = exec.finalResult ?? "";
      if (threadId) {
        await createThreadSession(threadId, sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Thread session created: ${sessionId} (thread ${threadId.slice(0, 8)})`);
      } else {
        await createSession(sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}`);
      }
    } else {
      try {
        const json = JSON.parse(rawStdout);
        sessionId = json.session_id;
        stdout = json.result ?? "";
        if (threadId) {
          await createThreadSession(threadId, sessionId);
          console.log(`[${new Date().toLocaleTimeString()}] Thread session created: ${sessionId} (thread ${threadId.slice(0, 8)})`);
        } else {
          await createSession(sessionId);
          console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}`);
        }
      } catch (e) {
        console.error(`[${new Date().toLocaleTimeString()}] Failed to parse session from Claude output:`, e);
      }
    }
  } else if (!rateLimitMessage && !isNew && exitCode === 0 && sink && exec.finalResult !== undefined) {
    // Resumed sessions in streaming mode: stdout is the assistant's final text,
    // not the NDJSON.
    stdout = exec.finalResult;
  }

  const result: RunResult = {
    stdout,
    stderr,
    exitCode,
  };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (${isNew ? "new" : "resumed"})`,
    `Model config: ${usedFallback ? "fallback" : "primary"}`,
    ...(agentic.enabled ? [`Task type: ${taskType}`, `Routing: ${routingReasoning}`] : []),
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  // --- Auto-compact on timeout (exit 124) ---
  if (COMPACT_TIMEOUT_ENABLED && exitCode === 124 && !isNew && existing) {
    emitCompactEvent({ type: "auto-compact-start" });
    const compactOk = await runCompact(
      existing.sessionId,
      primaryConfig.model,
      primaryConfig.api,
      baseEnv,
      securityArgs,
      timeoutMs
    );
    emitCompactEvent({ type: "auto-compact-done", success: compactOk });

    if (compactOk) {
      console.log(`[${new Date().toLocaleTimeString()}] Retrying ${name} after compact...`);
      const retryExec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs);
      const retryResult: RunResult = {
        stdout: retryExec.rawStdout,
        stderr: retryExec.stderr,
        exitCode: retryExec.exitCode,
      };
      emitCompactEvent({
        type: "auto-compact-retry",
        success: retryExec.exitCode === 0,
        stdout: retryResult.stdout,
        stderr: retryResult.stderr,
        exitCode: retryResult.exitCode,
      });

      if (retryExec.exitCode === 0) {
        const count = threadId ? await incrementThreadTurn(threadId) : await incrementTurn();
        console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${count} (after compact + retry)`);
      }
      return retryResult;
    }
  }

  // --- Turn tracking & compact warning ---
  if (exitCode === 0 && !isNew) {
    const turnCount = threadId ? await incrementThreadTurn(threadId) : await incrementTurn();
    console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${turnCount}${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`);

    if (turnCount >= COMPACT_WARN_THRESHOLD && existing && !existing.compactWarned) {
      if (threadId) {
        await markThreadCompactWarned(threadId);
      } else {
        await markCompactWarned();
      }
      emitCompactEvent({ type: "warn", turnCount });
    }
  }

  return result;
}

export async function run(
  name: string,
  prompt: string,
  threadId?: string,
  sink?: StatusSink,
): Promise<RunResult> {
  return enqueue(() => execClaude(name, prompt, threadId, sink), threadId);
}

function prefixUserMessageWithClock(prompt: string): string {
  try {
    const settings = getSettings();
    const prefix = buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
    return `${prefix}\n${prompt}`;
  } catch {
    const prefix = buildClockPromptPrefix(new Date(), 0);
    return `${prefix}\n${prompt}`;
  }
}

export async function runUserMessage(
  name: string,
  prompt: string,
  threadId?: string,
  sink?: StatusSink,
): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt), threadId, sink);
}

/**
 * Bootstrap the session: fires Claude with the system prompt so the
 * session is created immediately. No-op if a session already exists.
 */
export async function bootstrap(): Promise<void> {
  const existing = await getSession();
  if (existing) return;

  console.log(`[${new Date().toLocaleTimeString()}] Bootstrapping new session...`);
  await execClaude("bootstrap", "Wakeup, my friend!");
  console.log(`[${new Date().toLocaleTimeString()}] Bootstrap complete — session is live.`);
}

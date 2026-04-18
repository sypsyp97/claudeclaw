/**
 * Executor — spawns a Claude CLI subagent with a self-edit prompt, waits
 * for it to finish, returns stdout/stderr. The CLI path routes through
 * `src/runtime/claude-cli.ts::claudeArgv()` so tests can inject a fake via
 * `HERMES_CLAUDE_BIN`.
 *
 * If `opts.sink` is provided, the executor switches to the streaming path
 * (`runClaudeStreaming`) so live tool-call events reach the caller's sink
 * — scripts/evolve.ts uses this to print terminal progress.
 */

import { spawn } from "node:child_process";
import { claudeArgv } from "../runtime/claude-cli";
import { runClaudeStreaming } from "../runtime/claude-stream";
import type { StatusSink } from "../status/sink";
import { buildEvolveSystemPrompt } from "./guards";

export interface ExecuteOptions {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * Grace period between SIGTERM and SIGKILL when the timeout fires. If the
   * subagent installs a SIGTERM handler (or is wedged in a syscall), SIGTERM
   * alone leaves `proc.on("close")` pending forever and the executor hangs.
   * The SIGKILL fallback escalates after this delay so the evolve loop
   * always makes progress. Default 5000ms; matches runner.ts.
   */
  killEscalationMs?: number;
  claudeBin?: string;
  sink?: StatusSink;
  taskId?: string;
  taskLabel?: string;
}

const DEFAULT_KILL_ESCALATION_MS = 5000;

export interface ExecuteResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function executeSelfEdit(opts: ExecuteOptions): Promise<ExecuteResult> {
  if (opts.sink) return runStreamingExec(opts);

  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const [bin, ...prefix] = claudeArgv({ override: opts.claudeBin });
  const args = [...prefix, "-p", opts.prompt, "--output-format", "text"];
  // Always prepend the evolve safety guards. This is a hard invariant —
  // the guards reach Claude before any caller-supplied system prompt.
  args.push("--append-system-prompt", buildEvolveSystemPrompt(opts.systemPrompt));

  const killEscalationMs = opts.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;

  const started = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      // If the child ignores SIGTERM (handler installed, or wedged in a
      // syscall), follow up with SIGKILL so `proc.on("close")` always fires.
      // unref() so this timer alone doesn't keep the event loop alive after
      // the function has otherwise resolved.
      killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, killEscalationMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
    }, timeoutMs);

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr + String(err),
        durationMs: Date.now() - started,
      });
    });
  });
}

async function runStreamingExec(opts: ExecuteOptions): Promise<ExecuteResult> {
  const args: string[] = ["-p", opts.prompt];
  // Always prepend the evolve safety guards, same invariant as the
  // non-streaming path.
  args.push("--append-system-prompt", buildEvolveSystemPrompt(opts.systemPrompt));
  const streamOpts: Parameters<typeof runClaudeStreaming>[0] = {
    args,
    cwd: opts.cwd,
    sink: opts.sink!,
    taskId: opts.taskId ?? "evolve",
    label: opts.taskLabel ?? "evolve",
  };
  if (opts.timeoutMs !== undefined) streamOpts.timeoutMs = opts.timeoutMs;
  if (opts.claudeBin !== undefined) streamOpts.claudeBin = opts.claudeBin;
  const result = await runClaudeStreaming(streamOpts);
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}

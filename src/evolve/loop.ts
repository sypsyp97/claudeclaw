/**
 * Top-level evolve driver. One call = one iteration against a task the
 * caller already has in hand:
 *
 *   1. Executor spawns a Claude subagent to implement the task.
 *   2. Gate runs `bun run verify`.
 *   3. Green → commit. Red → revert. Either way, journal.
 *
 * Hermes talks to its user directly (Discord/Telegram/CLI), so the task
 * body is handed in by whoever triggers `evolveOnce` — no file-inbox or
 * GitHub-issue middleman. Tests inject fakes via `hooks`.
 */

import type { Database } from "../state/db";
import type { StatusSink } from "../status/sink";
import { executeSelfEdit, type ExecuteOptions, type ExecuteResult } from "./executor";
import { commitChanges, revertAll, runVerify, type GateRunners, type VerifyResult } from "./gate";
import { recordEvent } from "./journal";

export interface EvolveTask {
  id: string;
  title: string;
  body: string;
}

export type Outcome = "exec-failed" | "verify-failed" | "committed";

export interface EvolveIterationResult {
  outcome: Outcome;
  task: EvolveTask;
  sha?: string | null;
  verify?: VerifyResult;
  exec?: ExecuteResult;
}

export interface LoopHooks {
  gate?: GateRunners;
  runExec?(opts: ExecuteOptions): Promise<ExecuteResult>;
  buildPrompt?(task: EvolveTask): string;
  commitMessage?(task: EvolveTask): string;
  sink?: StatusSink;
}

export async function evolveOnce(
  db: Database,
  task: EvolveTask,
  cwd: string = process.cwd(),
  hooks: LoopHooks = {},
): Promise<EvolveIterationResult> {
  await recordEvent(
    db,
    { kind: "evolve.plan", slot: task.id, summary: task.title },
    cwd,
  );

  const prompt = (hooks.buildPrompt ?? defaultPrompt)(task);
  const execOpts: ExecuteOptions = { prompt, cwd, taskId: task.id, taskLabel: task.title };
  if (hooks.sink) execOpts.sink = hooks.sink;
  const exec = await (hooks.runExec ?? executeSelfEdit)(execOpts);

  await recordEvent(
    db,
    {
      kind: "evolve.exec.done",
      slot: task.id,
      summary: exec.ok ? "subagent finished green" : "subagent exited non-zero",
      details: { exitCode: exec.exitCode, durationMs: exec.durationMs },
    },
    cwd,
  );

  if (!exec.ok) {
    await revertAll(cwd, hooks.gate);
    return { outcome: "exec-failed", task, exec };
  }

  const verify = await runVerify(cwd, hooks.gate);
  if (!verify.ok) {
    await revertAll(cwd, hooks.gate);
    await recordEvent(
      db,
      {
        kind: "evolve.revert",
        slot: task.id,
        summary: `verify failed (exit ${verify.exitCode})`,
        details: { stderrTail: verify.stderr.slice(-1024) },
      },
      cwd,
    );
    return { outcome: "verify-failed", task, verify, exec };
  }

  const message = (hooks.commitMessage ?? defaultCommitMessage)(task);
  const sha = await commitChanges(cwd, message, hooks.gate);
  await recordEvent(
    db,
    {
      kind: "evolve.commit",
      slot: task.id,
      summary: sha ? `committed as ${sha.slice(0, 10)}` : "no changes to commit",
      details: { sha, durationMs: verify.durationMs },
    },
    cwd,
  );
  return { outcome: "committed", task, sha, verify, exec };
}

function defaultPrompt(task: EvolveTask): string {
  return [
    "You are Claude Hermes running inside its own repository.",
    "Your job this iteration: make the smallest set of code changes that make the task body below true, then exit.",
    "",
    "Rules:",
    "- Only edit files needed to satisfy the task body. Do not rename, reformat, or restructure files the task does not mention.",
    "- Do not delete or rewrite existing tests unless the task explicitly says so. If behavior changes, add new tests rather than editing unrelated ones.",
    "- Do not upgrade or add dependencies unless the task body names the package and version.",
    "- Do not modify files under `.github/`, `.claude/`, `scripts/verify.ts`, or any lockfile unless the task body names that exact path.",
    "- After your edits, `bun run verify` must exit 0. If you cannot make it exit 0, revert your edits and exit non-zero instead of leaving the tree in a broken state.",
    "- Do not run `git commit`, `git push`, `git tag`, or any network commands. The outer loop handles commit and revert.",
    "",
    `# Task ${task.id}`,
    `title: ${task.title}`,
    "",
    task.body,
  ].join("\n");
}

function defaultCommitMessage(task: EvolveTask): string {
  return `evolve: ${task.title}\n\nTask ${task.id}`;
}

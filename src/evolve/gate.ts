/**
 * Gate — commits on green verify, reverts on red. Every mutation is scoped to
 * a caller-provided path list so a failed evolve never sweeps in unrelated
 * user work sitting in the same worktree.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface VerifyResult {
  ok: boolean;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GateRunners {
  runVerify?(cwd: string): Promise<VerifyResult>;
  runGit?(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /**
   * Content fingerprint for one worktree-relative path. Returns null when the
   * path does not exist (deleted, never created). Used to detect when the
   * evolve subagent modifies a file that was ALREADY dirty before the run —
   * such a file would otherwise sit in `baselineDirty` and be invisible to
   * `touchedPaths`, meaning it wouldn't be reverted on RED or committed on
   * GREEN. Default hashes file bytes with SHA-1; tests inject.
   */
  hashPath?(cwd: string, path: string): Promise<string | null>;
}

export async function hashWorktreePath(cwd: string, path: string): Promise<string | null> {
  const abs = isAbsolute(path) ? path : join(cwd, path);
  try {
    const bytes = await readFile(abs);
    return createHash("sha1").update(bytes).digest("hex");
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    // Permission errors, Windows file-locking, etc. — treat as unknown, not
    // as "unchanged". Return a sentinel that differs from any real hash so
    // the path stays in the touched set and gets reverted conservatively.
    return `unreadable:${code ?? "unknown"}:${Date.now()}`;
  }
}

export async function runVerify(cwd: string, runners: GateRunners = {}): Promise<VerifyResult> {
  if (runners.runVerify) return runners.runVerify(cwd);
  return runProcess("bun", ["run", "verify"], cwd);
}

/**
 * Snapshot of paths that `git status --porcelain` currently reports dirty.
 * The caller should diff this against a pre-execution snapshot to derive the
 * set of paths the evolve subagent actually touched.
 */
export async function computeDirtyPaths(
  cwd: string,
  runners: GateRunners = {},
): Promise<string[]> {
  const run = runners.runGit ?? defaultGit;
  const status = await run(cwd, ["status", "--porcelain"]);
  if (!status.ok) return [];
  const set = new Set<string>();
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    const path = arrow >= 0 ? body.slice(arrow + 4) : body;
    const unquoted = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
    set.add(unquoted);
  }
  return Array.from(set).sort();
}

export async function commitChanges(
  cwd: string,
  message: string,
  paths: string[],
  runners: GateRunners = {},
): Promise<string | null> {
  if (paths.length === 0) return null;
  const run = runners.runGit ?? defaultGit;

  const add = await run(cwd, ["add", "--", ...paths]);
  if (!add.ok) return null;

  const staged = await run(cwd, ["diff", "--cached", "--name-only", "--", ...paths]);
  if (!staged.ok || !staged.stdout.trim()) return null;

  const commit = await run(cwd, ["commit", "-m", message]);
  if (!commit.ok) return null;

  const sha = await run(cwd, ["rev-parse", "HEAD"]);
  return sha.stdout.trim();
}

export async function revertPaths(
  cwd: string,
  paths: string[],
  runners: GateRunners = {},
): Promise<void> {
  if (paths.length === 0) return;
  const run = runners.runGit ?? defaultGit;

  // Partition the caller's path set into tracked vs untracked. `git restore`
  // refuses to process any pathspec that has no match in the index — passing
  // a mixed list would abort before touching the tracked files.
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const p of paths) {
    const r = await run(cwd, ["ls-files", "--error-unmatch", "--", p]);
    if (r.ok) tracked.push(p);
    else untracked.push(p);
  }

  if (tracked.length > 0) {
    await run(cwd, ["restore", "--staged", "--", ...tracked]);
    await run(cwd, ["restore", "--", ...tracked]);
  }
  if (untracked.length > 0) {
    await run(cwd, ["clean", "-fd", "--", ...untracked]);
  }
}

async function defaultGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await runProcess("git", args, cwd);
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

function runProcess(bin: string, args: string[], cwd: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        exitCode: -1,
        durationMs: Date.now() - started,
        stdout,
        stderr: stderr + String(err),
      });
    });
  });
}

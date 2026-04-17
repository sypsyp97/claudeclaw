/**
 * Cross-project daemon registry. Each running hermes daemon registers its
 * `{pid, cwd, startedAt}` here on boot so `hermes --stop-all` can find them
 * without trying to reverse Claude Code's lossy project-slug encoding (the
 * old approach broke completely on Windows and on any project path containing
 * a hyphen — e.g. `my-app` reconstructed as `my/app`).
 *
 * Storage: `~/.claude/hermes/daemons.json`. Shared by every hermes
 * installation on this user's machine, so writes are serialized within a
 * process (in-flight promise chain — same pattern as
 * `sessionManager.ts::forgetLegacyThread`). Cross-process races still exist;
 * acceptable because (a) registers/unregisters are rare and short, and
 * (b) `stop-all` filters dead pids anyway, so a stale entry is self-healing
 * on the next sweep.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DaemonEntry {
  pid: number;
  cwd: string;
  startedAt: string;
}

export interface RegistryOpts {
  /**
   * Override the on-disk path. Resolution precedence:
   *   1. `opts.path` (explicit caller arg — wins)
   *   2. `process.env.HERMES_DAEMON_REGISTRY` (used by the daemon-boot
   *      smoke tests so they don't pollute the user's real
   *      `~/.claude/hermes/daemons.json`)
   *   3. `defaultRegistryPath()` (production default)
   */
  path?: string;
}

export function defaultRegistryPath(): string {
  return join(homedir(), ".claude", "hermes", "daemons.json");
}

function resolveRegistryPath(opts: RegistryOpts): string {
  if (opts.path) return opts.path;
  const fromEnv = process.env.HERMES_DAEMON_REGISTRY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return defaultRegistryPath();
}

let writeChain: Promise<void> = Promise.resolve();

export async function listDaemons(opts: RegistryOpts = {}): Promise<DaemonEntry[]> {
  return readEntries(resolveRegistryPath(opts));
}

export function registerDaemon(entry: { pid: number; cwd: string }, opts: RegistryOpts = {}): Promise<void> {
  return enqueue(async () => {
    const path = resolveRegistryPath(opts);
    const existing = await readEntries(path);
    const filtered = existing.filter((e) => e.pid !== entry.pid);
    filtered.push({ pid: entry.pid, cwd: entry.cwd, startedAt: new Date().toISOString() });
    await writeEntries(path, filtered);
  });
}

export function unregisterDaemon(pid: number, opts: RegistryOpts = {}): Promise<void> {
  return enqueue(async () => {
    const path = resolveRegistryPath(opts);
    const existing = await readEntries(path);
    const filtered = existing.filter((e) => e.pid !== pid);
    if (filtered.length === existing.length) return;
    if (filtered.length === 0) {
      try {
        await unlink(path);
      } catch {
        // best-effort
      }
      return;
    }
    await writeEntries(path, filtered);
  });
}

function enqueue(fn: () => Promise<void>): Promise<void> {
  const next = writeChain.then(fn);
  writeChain = next.catch(() => undefined);
  return next;
}

async function readEntries(path: string): Promise<DaemonEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const daemons = (parsed as { daemons?: unknown }).daemons;
  if (!Array.isArray(daemons)) return [];
  const out: DaemonEntry[] = [];
  for (const candidate of daemons) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    if (typeof c.pid !== "number" || typeof c.cwd !== "string" || typeof c.startedAt !== "string") {
      continue;
    }
    out.push({ pid: c.pid, cwd: c.cwd, startedAt: c.startedAt });
  }
  return out;
}

async function writeEntries(path: string, entries: DaemonEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  const body = JSON.stringify({ daemons: entries }, null, 2) + "\n";
  // Write-then-rename for atomicity: a crash mid-write leaves the final path intact.
  const tmpPath = `${path}.tmp.${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, path);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

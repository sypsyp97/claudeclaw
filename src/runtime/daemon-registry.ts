/**
 * Project-scoped daemon registry. Each running hermes daemon registers its
 * `{pid, cwd, startedAt}` here on boot so `hermes --stop-all` can find them
 * without trying to reverse Claude Code's lossy project-slug encoding (the
 * old approach broke completely on Windows and on any project path containing
 * a hyphen — e.g. `my-app` reconstructed as `my/app`).
 *
 * Storage: `<cwd>/.claude/hermes/daemons.json`. Writes are serialized within
 * a process (in-flight promise chain — same pattern as
 * `sessionManager.ts::forgetLegacyThread`). Cross-process races still exist;
 * acceptable because (a) registers/unregisters are rare and short, and
 * (b) `stop-all` filters dead pids anyway, so a stale entry is self-healing
 * on the next sweep.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

export function defaultRegistryPath(cwd?: string): string {
  return join(cwd ?? process.cwd(), ".claude", "hermes", "daemons.json");
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

/**
 * One-shot migration from the legacy global registry at
 * `~/.claude/hermes/daemons.json` to the project-scoped registry at
 * `<cwd>/.claude/hermes/daemons.json`.
 *
 * - Entries matching `cwd` are merged into the project file (dedup on pid,
 *   newer `startedAt` wins).
 * - Entries for other cwds stay in the global file, or the global file is
 *   unlinked entirely if nothing remains.
 * - Idempotent: running it a second time on a clean state is a no-op.
 *
 * Caller must supply `home` explicitly — this module has zero reach into
 * the OS home directory, so the registry can never silently drift back
 * to a global path. `start.ts` injects the home path on boot; tests pass
 * a tmpdir.
 */
export async function migrateGlobalRegistry(opts: { home: string; cwd?: string }): Promise<{
  migrated: number;
  remainingGlobal: number;
}> {
  const home = opts.home;
  const cwd = opts.cwd ?? process.cwd();

  const globalPath = join(home, ".claude", "hermes", "daemons.json");
  const projectPath = join(cwd, ".claude", "hermes", "daemons.json");

  let globalRaw: string;
  try {
    globalRaw = await readFile(globalPath, "utf8");
  } catch {
    return { migrated: 0, remainingGlobal: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(globalRaw);
  } catch {
    // Corrupt global file — unlink it rather than leaving it to poison later
    // reads; a registry is a self-healing cache, not durable state.
    try {
      await unlink(globalPath);
    } catch {
      // best-effort
    }
    return { migrated: 0, remainingGlobal: 0 };
  }

  const rawList: unknown =
    parsed && typeof parsed === "object" && "daemons" in (parsed as object)
      ? (parsed as { daemons?: unknown }).daemons
      : null;
  const globalEntries: DaemonEntry[] = [];
  if (Array.isArray(rawList)) {
    for (const candidate of rawList) {
      if (!candidate || typeof candidate !== "object") continue;
      const c = candidate as Record<string, unknown>;
      if (typeof c.pid !== "number" || typeof c.cwd !== "string" || typeof c.startedAt !== "string") {
        continue;
      }
      globalEntries.push({ pid: c.pid, cwd: c.cwd, startedAt: c.startedAt });
    }
  }

  const matching = globalEntries.filter((e) => e.cwd === cwd);
  const remaining = globalEntries.filter((e) => e.cwd !== cwd);

  if (matching.length > 0) {
    const existing = await readEntries(projectPath);
    // Merge: dedup on pid, newer startedAt wins on collision.
    const byPid = new Map<number, DaemonEntry>();
    for (const e of existing) byPid.set(e.pid, e);
    for (const e of matching) {
      const prev = byPid.get(e.pid);
      if (!prev) {
        byPid.set(e.pid, e);
        continue;
      }
      const prevTs = Date.parse(prev.startedAt);
      const newTs = Date.parse(e.startedAt);
      if (Number.isFinite(newTs) && (!Number.isFinite(prevTs) || newTs >= prevTs)) {
        byPid.set(e.pid, e);
      }
    }
    await writeEntries(projectPath, Array.from(byPid.values()));
  }

  if (remaining.length === 0) {
    try {
      await unlink(globalPath);
    } catch {
      // best-effort
    }
  } else {
    await writeEntries(globalPath, remaining);
  }

  return { migrated: matching.length, remainingGlobal: remaining.length };
}

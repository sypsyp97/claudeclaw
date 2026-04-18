/**
 * Filesystem readers/writers for the layered markdown memory files.
 *
 * Layout:
 *   <project-root>/memory/
 *     SOUL.md            — long-lived agent identity (human-edited)
 *     IDENTITY.md        — workspace identity / tone
 *     USER.md            — facts about the human owner
 *     MEMORY.md          — cross-session facts (auto-appended by nudge)
 *     channels/<id>.md   — per-channel playbook
 *
 * All reads return `""` for missing files — callers treat absence as silent.
 * Writes create the containing directory as needed.
 */

import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  channelMemoryFile,
  crossSessionMemoryFile,
  identityMemoryFile,
  legacyMemoryDir,
  memoryDir,
  soulMemoryFile,
  userMemoryFile,
} from "../paths";

export async function readSoul(cwd?: string): Promise<string> {
  return readIfExists(soulMemoryFile(cwd));
}

export async function readIdentity(cwd?: string): Promise<string> {
  return readIfExists(identityMemoryFile(cwd));
}

export async function readUserMemory(cwd?: string): Promise<string> {
  return readIfExists(userMemoryFile(cwd));
}

export async function readCrossSessionMemory(cwd?: string): Promise<string> {
  return readIfExists(crossSessionMemoryFile(cwd));
}

export async function readChannelMemory(channelId: string, cwd?: string): Promise<string> {
  return readIfExists(channelMemoryFile(channelId, cwd));
}

export async function appendCrossSessionMemory(entry: string, cwd?: string): Promise<void> {
  const path = crossSessionMemoryFile(cwd);
  const now = new Date().toISOString();
  const payload = `\n<!-- ${now} -->\n${entry.trim()}\n`;
  await appendToFile(path, payload);
}

export async function writeUserMemory(content: string, cwd?: string): Promise<void> {
  const path = userMemoryFile(cwd);
  await writeWithMkdir(path, content.trimEnd() + "\n");
}

export async function writeChannelMemory(channelId: string, content: string, cwd?: string): Promise<void> {
  const path = channelMemoryFile(channelId, cwd);
  await writeWithMkdir(path, content.trimEnd() + "\n");
}

async function readIfExists(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function appendToFile(path: string, payload: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const prev = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, prev + payload, "utf8");
}

async function writeWithMkdir(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * One-shot migration of memory files from the legacy `.claude/hermes/memory/`
 * location to the project-root `memory/` location.
 *
 * Returns `{ moved, skipped }` where paths are relative to the legacy root.
 * Idempotent: a second invocation on a clean state is a no-op.
 *
 * - If the legacy dir doesn't exist, returns empty arrays.
 * - If the new dir doesn't exist, renames the whole tree atomically when
 *   possible, falling back to a per-file copy on cross-device rename errors.
 * - If both exist, walks the legacy tree; for each file, moves it to the new
 *   path iff the destination file does not already exist. Otherwise the legacy
 *   file stays put and its relative path is added to `skipped`.
 *
 * Uses only `fs/promises` (no Bun-only APIs) so it can be imported from tests
 * that stub `process.cwd()` via chdir into a tmpdir.
 */
export async function migrateLegacyMemory(cwd?: string): Promise<{ moved: string[]; skipped: string[] }> {
  const legacyRoot = legacyMemoryDir(cwd);
  const newRoot = memoryDir(cwd);

  if (!existsSync(legacyRoot)) {
    return { moved: [], skipped: [] };
  }

  const moved: string[] = [];
  const skipped: string[] = [];

  // Fast path: destination doesn't exist — rename the whole tree.
  if (!existsSync(newRoot)) {
    // Collect relative paths first so we can report `moved` accurately.
    const files = await collectFiles(legacyRoot);
    await mkdir(dirname(newRoot), { recursive: true });
    try {
      await rename(legacyRoot, newRoot);
      for (const file of files) moved.push(file);
      return { moved, skipped };
    } catch {
      // Fall through to per-file copy (cross-device or windows quirks).
    }
  }

  // Slow path: walk and move per-file.
  await walkAndMove(legacyRoot, legacyRoot, newRoot, moved, skipped);

  // Prune empty legacy subdirectories (best-effort).
  await pruneEmptyDirs(legacyRoot);

  return { moved, skipped };
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(toPosix(relative(root, full)));
      }
    }
  }
  await walk(root);
  return out;
}

async function walkAndMove(
  root: string,
  legacyRoot: string,
  newRoot: string,
  moved: string[],
  skipped: string[]
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const src = join(root, entry.name);
    const rel = relative(legacyRoot, src);
    const dst = join(newRoot, rel);
    if (entry.isDirectory()) {
      await walkAndMove(src, legacyRoot, newRoot, moved, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    if (existsSync(dst)) {
      skipped.push(toPosix(rel));
      continue;
    }
    await mkdir(dirname(dst), { recursive: true });
    try {
      await rename(src, dst);
    } catch {
      // Cross-device rename fallback: copy + unlink.
      const buf = await readFile(src);
      await writeFile(dst, buf);
      try {
        await unlink(src);
      } catch {
        // best-effort
      }
    }
    moved.push(toPosix(rel));
  }
}

async function pruneEmptyDirs(root: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await pruneEmptyDirs(join(root, entry.name));
    }
  }
  try {
    const remaining = await readdir(root);
    if (remaining.length === 0) {
      // Don't remove the legacy root itself — only empty subdirectories —
      // so callers can distinguish "nothing migrated" from "migrated and
      // cleaned up" without a stat check. Actually, we DO remove the root
      // too: if everything was moved, the whole tree should disappear.
      await rmdir(root).catch(() => {});
    }
  } catch {
    // best-effort
  }
}

function toPosix(p: string): string {
  return p.split(/[\\/]/g).join("/");
}

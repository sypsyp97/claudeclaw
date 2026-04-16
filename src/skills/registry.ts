/**
 * Router-facing skill surface: pretty `listSkills()` shape and
 * `resolveSkillPrompt(command)` for slash-command → SKILL.md lookups.
 *
 * Discovery is delegated to `./discovery.ts`; this module composes it with the
 * command-resolution path. Phase 6's learning pipeline replaces parts of this
 * file with shadow/active gating, but the public surface stays put.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverSkills, type DiscoveryRoots, type SkillInfo } from "./discovery";

export type { SkillInfo, SkillSource } from "./discovery";

export async function listSkills(roots?: DiscoveryRoots): Promise<SkillInfo[]> {
  return discoverSkills(roots);
}

export async function resolveSkillPrompt(
  command: string,
  roots?: DiscoveryRoots,
): Promise<string | null> {
  const name = command.startsWith("/") ? command.slice(1) : command;
  if (!name) return null;

  const colonIdx = name.indexOf(":");
  const pluginHint = colonIdx > 0 ? name.slice(0, colonIdx) : null;
  const skillName = colonIdx > 0 ? name.slice(colonIdx + 1) : name;

  const home = roots?.home ?? homedir();
  const cwd = roots?.cwd ?? process.cwd();
  const projectSkillsDir = join(cwd, ".claude", "skills");
  const globalSkillsDir = join(home, ".claude", "skills");
  const pluginsDir = join(home, ".claude", "plugins");

  if (!pluginHint) {
    const projectContent = await tryReadFile(join(projectSkillsDir, skillName, "SKILL.md"));
    if (projectContent) return projectContent;

    const globalContent = await tryReadFile(join(globalSkillsDir, skillName, "SKILL.md"));
    if (globalContent) return globalContent;
  }

  return searchPluginSkills(pluginsDir, skillName, pluginHint);
}

async function tryReadFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function searchPluginSkills(
  pluginsDir: string,
  skillName: string,
  pluginHint: string | null,
): Promise<string | null> {
  if (!existsSync(pluginsDir)) return null;

  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (pluginHint && entry.name !== pluginHint) continue;

      const direct = await tryReadFile(join(pluginsDir, entry.name, "skills", skillName, "SKILL.md"));
      if (direct) return direct;

      const cachePath = join(pluginsDir, "cache", entry.name);
      if (existsSync(cachePath)) {
        const cached = await searchCacheDir(cachePath, skillName);
        if (cached) return cached;
      }
    }

    const cacheRoot = join(pluginsDir, "cache");
    if (!pluginHint && existsSync(cacheRoot)) {
      const cacheEntries = await readdir(cacheRoot, { withFileTypes: true });
      for (const ce of cacheEntries) {
        if (!ce.isDirectory()) continue;
        const cached = await searchCacheDir(join(cacheRoot, ce.name), skillName);
        if (cached) return cached;
      }
    } else if (pluginHint) {
      const cachePath = join(pluginsDir, "cache", pluginHint);
      if (existsSync(cachePath)) {
        const cached = await searchCacheDir(cachePath, skillName);
        if (cached) return cached;
      }
    }
  } catch {
    // plugins dir not readable
  }

  return null;
}

async function searchCacheDir(cachePluginDir: string, skillName: string): Promise<string | null> {
  try {
    const subEntries = await readdir(cachePluginDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const innerDir = join(cachePluginDir, sub.name);
      const versionEntries = await readdir(innerDir, { withFileTypes: true });
      for (const ver of versionEntries) {
        if (!ver.isDirectory()) continue;
        const versioned = await tryReadFile(
          join(innerDir, ver.name, "skills", skillName, "SKILL.md"),
        );
        if (versioned) return versioned;
      }
      const direct = await tryReadFile(join(innerDir, "skills", skillName, "SKILL.md"));
      if (direct) return direct;
    }
  } catch {
    // not readable
  }
  return null;
}

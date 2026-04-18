/**
 * Voyager→Claude-Code skill bridge.
 *
 * Mirrors only `active` Voyager skills from `<cwd>/.claude/hermes/skills/<name>/`
 * into `<cwd>/.claude/skills/hermes_<name>/` so the spawned Claude CLI's built-in
 * skill discovery picks them up. Candidate / shadow / disabled skills stay
 * hidden — human review is the gate.
 *
 * Contract:
 *   - Only `status = 'active'` rows are mirrored.
 *   - Mirror filenames: `SKILL.md` and `description.txt` only. `trajectory.jsonl`
 *     is Voyager-internal and never mirrored.
 *   - Stale `hermes_*` dirs (no matching active row) are removed.
 *   - NEVER touches `.claude/skills/<x>/` where `x` does not start with
 *     `hermes_`. That path is user territory.
 *   - Idempotent and non-throwing: per-skill fs errors become entries in
 *     `errors`, never thrown.
 */

import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../state/db";
import { listSkills } from "../state/repos/skills";

export interface BridgeResult {
  mirrored: string[];
  removed: string[];
  errors: Array<{ name: string; reason: string }>;
}

const MIRROR_PREFIX = "hermes_";

function voyagerSkillDir(cwd: string, name: string): string {
  return join(cwd, ".claude", "hermes", "skills", name);
}

function mirrorRoot(cwd: string): string {
  return join(cwd, ".claude", "skills");
}

function mirrorSkillDir(cwd: string, name: string): string {
  return join(mirrorRoot(cwd), `${MIRROR_PREFIX}${name}`);
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function listMirrorSubdirs(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(mirrorRoot(cwd), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(MIRROR_PREFIX))
      .map((e) => e.name);
  } catch {
    // Mirror root doesn't exist yet → nothing to clean up.
    return [];
  }
}

export async function syncActiveSkills(
  db: Database,
  cwd: string = process.cwd(),
): Promise<BridgeResult> {
  const mirrored: string[] = [];
  const errors: Array<{ name: string; reason: string }> = [];
  const activeNames = new Set<string>();

  const rows = listSkills(db, "active");

  for (const row of rows) {
    const name = row.name;
    const srcDir = voyagerSkillDir(cwd, name);
    const srcSkillMdPath = join(srcDir, "SKILL.md");
    const srcDescPath = join(srcDir, "description.txt");

    const skillMd = await readIfExists(srcSkillMdPath);
    const description = await readIfExists(srcDescPath);

    if (skillMd === null || description === null) {
      errors.push({ name, reason: "voyager source missing" });
      continue;
    }

    const destDir = mirrorSkillDir(cwd, name);
    try {
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, "SKILL.md"), skillMd, "utf8");
      await writeFile(join(destDir, "description.txt"), description, "utf8");
      activeNames.add(name);
      mirrored.push(name);
    } catch (err) {
      errors.push({
        name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const removed: string[] = [];
  const existingMirrorDirs = await listMirrorSubdirs(cwd);
  for (const dirName of existingMirrorDirs) {
    const name = dirName.slice(MIRROR_PREFIX.length);
    if (activeNames.has(name)) continue;
    const fullPath = join(mirrorRoot(cwd), dirName);
    try {
      await rm(fullPath, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      errors.push({
        name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  mirrored.sort();
  removed.sort();

  return { mirrored, removed, errors };
}

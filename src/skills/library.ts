/**
 * Voyager-style skill library: read/write skill directories on disk plus a
 * JSONL trajectory log, and surface skills via the FTS5 index registered by
 * migration 003. Each skill lives at `.claude/hermes/skills/<name>/` and owns
 * three files:
 *
 *   - `SKILL.md`         — the skill body the model executes against.
 *   - `description.txt`  — the imperative one-liner the FTS index ranks.
 *   - `trajectory.jsonl` — append-only JSONL log of tool calls + outcomes.
 *
 * The FTS5 table is a plain (non-content-table) index: there is no SQL source
 * table to trigger off, so `writeSkill` keeps it in lockstep with disk by
 * doing an explicit DELETE + INSERT under the skill name.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getSharedDb } from "../state/shared-db";
import type { Database } from "../state/db";
import { validateSkillManifest } from "./validate";

export interface TrajectoryEntry {
  ts: string;
  tool: string;
  ok: boolean;
  note?: string;
}

export interface SkillFiles {
  skillMd: string;
  description: string;
  trajectory: TrajectoryEntry[];
}

function skillsRoot(cwd: string): string {
  return join(cwd, ".claude", "hermes", "skills");
}

function skillDir(cwd: string, name: string): string {
  return join(skillsRoot(cwd), name);
}

/**
 * Pull the `description:` value out of an optional YAML frontmatter block.
 * The frontmatter is the leading `---\n...\n---\n` segment. We do not pull
 * in a YAML dependency: the format we emit is single-line key/value pairs,
 * and that is all we need to parse on read-back.
 *
 * Returns `null` when no frontmatter or no `description` key is present.
 */
function extractFrontmatterDescription(skillMd: string): string | null {
  if (!skillMd.startsWith("---\n")) return null;
  const end = skillMd.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const block = skillMd.slice(4, end);
  const match = block.match(/^description:\s*(.+)$/m);
  if (!match) return null;
  return match[1]!.trim();
}

export async function readSkill(
  name: string,
  cwd: string = process.cwd(),
): Promise<SkillFiles | null> {
  const dir = skillDir(cwd, name);
  if (!existsSync(dir)) return null;

  const skillMdPath = join(dir, "SKILL.md");
  const descriptionPath = join(dir, "description.txt");
  const trajectoryPath = join(dir, "trajectory.jsonl");

  const skillMd = existsSync(skillMdPath)
    ? await readFile(skillMdPath, "utf8")
    : "";

  let description = "";
  if (existsSync(descriptionPath)) {
    description = await readFile(descriptionPath, "utf8");
  } else {
    const fromYaml = extractFrontmatterDescription(skillMd);
    if (fromYaml !== null) description = fromYaml;
  }

  const trajectory: TrajectoryEntry[] = [];
  if (existsSync(trajectoryPath)) {
    const raw = await readFile(trajectoryPath, "utf8");
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        trajectory.push(JSON.parse(line) as TrajectoryEntry);
      } catch {
        // Robustness: skip malformed lines so a single bad write does not
        // poison the entire log.
      }
    }
  }

  return { skillMd, description, trajectory };
}

export async function writeSkill(
  input: { name: string; description: string; skillMd: string },
  cwd: string = process.cwd(),
): Promise<void> {
  const validation = validateSkillManifest({
    name: input.name,
    description: input.description,
    body: input.skillMd,
  });
  if (!validation.ok) {
    throw new Error(
      `skill validation failed: ${validation.errors.join("; ")}`,
    );
  }

  const dir = skillDir(cwd, input.name);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "SKILL.md"), input.skillMd, "utf8");
  await writeFile(join(dir, "description.txt"), input.description, "utf8");
  // Touch trajectory.jsonl as an empty file so the reader never has to
  // special-case missing-file vs empty-file.
  if (!existsSync(join(dir, "trajectory.jsonl"))) {
    await writeFile(join(dir, "trajectory.jsonl"), "", "utf8");
  }

  const db = await getSharedDb(cwd);
  // Overwrite-safe FTS sync: drop any prior row for this name, then insert
  // the fresh description. Keeps the index in lockstep with disk on every
  // write — Test 16 pins the eviction half of this contract.
  db.transaction(() => {
    db.prepare("DELETE FROM skill_descriptions_fts WHERE name = ?").run(
      input.name,
    );
    db.prepare(
      "INSERT INTO skill_descriptions_fts (name, description) VALUES (?, ?)",
    ).run(input.name, input.description);
  })();
}

export async function appendTrajectory(
  name: string,
  entry: Omit<TrajectoryEntry, "ts"> & { ts?: string },
  cwd: string = process.cwd(),
): Promise<void> {
  const dir = skillDir(cwd, name);
  if (!existsSync(dir)) {
    throw new Error(
      `cannot append trajectory: skill "${name}" has not been written (missing ${dir})`,
    );
  }
  const full: TrajectoryEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    tool: entry.tool,
    ok: entry.ok,
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  };
  await appendFile(join(dir, "trajectory.jsonl"), JSON.stringify(full) + "\n", "utf8");
}

export function searchSkills(
  db: Database,
  query: string,
  opts: { limit?: number } = {},
): Array<{ name: string; description: string; rank: number }> {
  const limit = opts.limit ?? 20;
  return db
    .query<
      { name: string; description: string; rank: number },
      [string, number]
    >(
      "SELECT name, description, rank FROM skill_descriptions_fts WHERE skill_descriptions_fts MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(query, limit);
}

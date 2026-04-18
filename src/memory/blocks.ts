/**
 * Letta-style labeled memory-block primitive.
 *
 * Each block is a tiny, named, budget-capped slot of markdown stored at:
 *   <cwd>/.claude/hermes/memory/blocks/<encoded-name>.md
 *
 * The name → filename mapping is round-trippable so `readAllBlocks` can
 * recover the original block names from disk:
 *
 *   - Names matching `^[a-z0-9_-]+$` (and not starting with the encoded
 *     prefix `_x_`) are stored literally as `<name>.md`. This keeps the
 *     common case — `persona`, `human`, `project` — readable on disk.
 *   - Every other name (uppercase, contains `:`, `/`, `\`, `.`, etc.) is
 *     hex-encoded as `_x_<utf8-hex(name)>.md`. Hex (not base64 / not
 *     percent-encoding) is used so the encoded form is case-stable on
 *     case-insensitive filesystems like Windows NTFS — `Persona` and
 *     `persona` get distinct hex strings (`50657273...` vs `70657273...`)
 *     instead of colliding the way percent-encoding would for a single
 *     uppercase character that lives only in case.
 *   - Any name that itself starts with `_x_` is also encoded (the prefix
 *     is reserved). This avoids ambiguity at read time: a filename
 *     beginning with `_x_` is always a hex-encoded form.
 *
 * Path-traversal / absolute paths / separators in names are rejected up
 * front. Budget violations throw BEFORE any filesystem write so a failed
 * write never clobbers a previously-good file.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { memoryDir } from "../paths";

export interface Block {
  name: string;
  content: string;
  budget: number;
}

const DEFAULT_BUDGET = 2048;
const PERSONA_BUDGET = 4096;
const PROJECT_BUDGET = 4096;
const HUMAN_BUDGET = 2048;
const CHANNEL_BUDGET = 2048;

const ENCODED_PREFIX = "_x_";
const SAFE_NAME_RE = /^[a-z0-9_-]+$/;

export function blockBudget(name: string): number {
  if (name === "persona") return PERSONA_BUDGET;
  if (name === "project") return PROJECT_BUDGET;
  if (name === "human") return HUMAN_BUDGET;
  if (name.startsWith("channel:")) return CHANNEL_BUDGET;
  return DEFAULT_BUDGET;
}

function blocksDirFor(cwd?: string): string {
  return join(memoryDir(cwd), "blocks");
}

/**
 * Validate a block name for write operations. We reject anything that
 * could escape the blocks directory. `readBlock` / `removeBlock` use the
 * same validator so a malicious name can't probe arbitrary paths either.
 */
function assertValidName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`invalid block name: empty`);
  }
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.startsWith("/")
  ) {
    throw new Error(`invalid block name: ${JSON.stringify(name)}`);
  }
}

function encodeName(name: string): string {
  if (SAFE_NAME_RE.test(name) && !name.startsWith(ENCODED_PREFIX)) {
    return name;
  }
  const hex = Buffer.from(name, "utf8").toString("hex");
  return `${ENCODED_PREFIX}${hex}`;
}

function decodeFilename(file: string): string | null {
  if (!file.endsWith(".md")) return null;
  const stem = file.slice(0, -3);
  if (stem.length === 0) return null;
  if (stem.startsWith(ENCODED_PREFIX)) {
    const hex = stem.slice(ENCODED_PREFIX.length);
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      return null;
    }
    try {
      return Buffer.from(hex, "hex").toString("utf8");
    } catch {
      return null;
    }
  }
  // Literal: only accept files that match the safe regex; ignore stray
  // files dropped by hand that don't fit either scheme.
  if (!SAFE_NAME_RE.test(stem)) return null;
  return stem;
}

function blockPath(name: string, cwd?: string): string {
  return join(blocksDirFor(cwd), `${encodeName(name)}.md`);
}

export async function readBlock(name: string, cwd?: string): Promise<Block> {
  assertValidName(name);
  const budget = blockBudget(name);
  const path = blockPath(name, cwd);
  if (!existsSync(path)) {
    return { name, content: "", budget };
  }
  try {
    const content = await readFile(path, "utf8");
    return { name, content, budget };
  } catch {
    return { name, content: "", budget };
  }
}

export async function writeBlock(name: string, content: string, cwd?: string): Promise<void> {
  assertValidName(name);
  const budget = blockBudget(name);
  if (content.length > budget) {
    // Throw BEFORE touching disk so the previous on-disk state survives.
    throw new Error(`block ${JSON.stringify(name)} exceeds budget: ${content.length} > ${budget}`);
  }
  const dir = blocksDirFor(cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${encodeName(name)}.md`);
  await writeFile(path, content, "utf8");
}

export async function removeBlock(name: string, cwd?: string): Promise<void> {
  assertValidName(name);
  const path = blockPath(name, cwd);
  await rm(path, { force: true });
}

export async function readAllBlocks(cwd?: string): Promise<Block[]> {
  const dir = blocksDirFor(cwd);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Block[] = [];
  for (const file of entries) {
    const name = decodeFilename(file);
    if (name === null) continue;
    let content = "";
    try {
      content = await readFile(join(dir, file), "utf8");
    } catch {
      content = "";
    }
    out.push({ name, content, budget: blockBudget(name) });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Compose the 5-layer system prompt (SOUL → IDENTITY → USER → MEMORY → CHANNEL).
 *
 * Missing layers are silently skipped — the prompt is still well-formed,
 * just shorter. Each layer is joined by a blank line so Claude sees them as
 * distinct blocks.
 *
 * The composer is intentionally deterministic and cache-stable: identical
 * inputs produce byte-identical output. In particular, volatile content such
 * as the ISO timestamp markers that `appendCrossSessionMemory` writes into
 * `MEMORY.md` is stripped before emission so the appended system prompt does
 * not invalidate Claude's prompt cache between turns.
 */

import type { ChannelPolicy } from "../policy/channel";
import type { Block } from "./blocks";
import { readChannelMemory, readCrossSessionMemory, readIdentity, readSoul, readUserMemory } from "./files";

const HERMES_PREFIX = "You are running inside Claude Hermes.";
const AGENT_MEMORY_HINT =
  "You have a persistent scratchpad at `memory/agent/` in the project root. Use the agent-memory API to manage it: `view` to list/read, `create` to write a new file, `strReplace` for surgical edits, `insert` for line insertion, `del` for deletion, and `rename` to move files. View the directory before editing, and assume any write may be interrupted — keep entries small and idempotent.";

export interface ComposeContext {
  channelId?: string;
  memoryScope: ChannelPolicy["memoryScope"];
  cwd?: string;
  /** Optional hard cap on total characters; MEMORY is head-trimmed first, then a final slice is applied as a fallback. */
  maxBytes?: number;
  /** When true, prepend "You are running inside Claude Hermes.\n" to the composed output. */
  includeHermesPrefix?: boolean;
  /**
   * Optional project CLAUDE.md content, inserted between USER and MEMORY.
   * Empty / whitespace-only values are dropped so no phantom blank layer
   * appears in the output.
   */
  projectClaudeMd?: string;
  /**
   * Optional labeled blocks (Letta-style). Each block is emitted as a
   * `<block:NAME>…</block>` layer, sorted alphabetically by name. Blocks
   * whose content is empty / whitespace-only are dropped. Blocks sit
   * after USER and before MEMORY/CHANNEL, and survive MEMORY truncation.
   */
  blocks?: Block[];
  /**
   * When true, append a deterministic hint paragraph after CHANNEL that
   * points agents at the `<project-root>/memory/agent/` scratchpad and
   * enumerates the six agent-memory ops.
   */
  includeAgentMemoryHint?: boolean;
}

/** Shape of the 5 content layers before join, with MEMORY isolated so we can head-trim it. */
interface LayerBundle {
  /** Layers that sit before MEMORY and must survive truncation verbatim. */
  stablePrefix: string[];
  /** Pre-framed `<block:NAME>…</block>` layers, emitted between stablePrefix and MEMORY. Stable under truncation. */
  blocks: string[];
  /** Sanitized MEMORY body (timestamp markers already stripped). May be empty. */
  memory: string;
  /** Layers that sit after MEMORY (CHANNEL). */
  suffix: string[];
  /** Optional trailing hint layer (agent-memory hint), emitted after suffix. */
  trailer: string[];
}

export async function composeSystemPrompt(ctx: ComposeContext): Promise<string> {
  const bundle = await readLayerBundle(ctx);
  const joined = assemble(bundle, ctx.includeHermesPrefix ?? false);

  if (!ctx.maxBytes || joined.length <= ctx.maxBytes) {
    return joined;
  }

  // Budget exceeded: head-trim the MEMORY layer (drop oldest entries first),
  // preserving the stable prefix layers verbatim.
  const trimmed = truncateMemory(bundle, ctx.maxBytes, ctx.includeHermesPrefix ?? false);
  if (trimmed.length <= ctx.maxBytes) return trimmed;

  // Even with MEMORY fully dropped the prompt overruns the budget — fall back
  // to a hard slice on the whole string so the contract holds.
  return trimmed.slice(0, ctx.maxBytes);
}

async function readLayerBundle(ctx: ComposeContext): Promise<LayerBundle> {
  const [soul, identity] = await Promise.all([readSoul(ctx.cwd), readIdentity(ctx.cwd)]);
  const stablePrefix: string[] = [soul, identity];

  // USER is included for any scope that touches persisted state ("none" is
  // the only exclusion). Channel-scoped runs still want the owner facts.
  if (ctx.memoryScope === "user" || ctx.memoryScope === "workspace" || ctx.memoryScope === "channel") {
    stablePrefix.push(await readUserMemory(ctx.cwd));
  }

  if (ctx.projectClaudeMd && ctx.projectClaudeMd.trim().length > 0) {
    stablePrefix.push(ctx.projectClaudeMd);
  }

  let memory = "";
  if (ctx.memoryScope !== "none") {
    memory = sanitizeMemory(await readCrossSessionMemory(ctx.cwd));
  }

  const suffix: string[] = [];
  if (ctx.channelId && (ctx.memoryScope === "channel" || ctx.memoryScope === "workspace")) {
    suffix.push(await readChannelMemory(ctx.channelId, ctx.cwd));
  }

  const blocks = framedBlocks(ctx.blocks);

  const trailer: string[] = [];
  if (ctx.includeAgentMemoryHint === true) {
    trailer.push(AGENT_MEMORY_HINT);
  }

  return { stablePrefix, blocks, memory, suffix, trailer };
}

/**
 * Turn the caller's Block[] into pre-framed `<block:NAME>…</block>` strings,
 * sorted alphabetically by name. Empty / whitespace-only content is dropped
 * so no phantom block layer appears in the output.
 */
function framedBlocks(blocks: Block[] | undefined): string[] {
  if (!blocks || blocks.length === 0) return [];
  const kept = blocks.filter((b) => b.content.trim().length > 0);
  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return kept.map((b) => `<block:${b.name}>\n${b.content}\n</block>`);
}

function assemble(bundle: LayerBundle, includeHermesPrefix: boolean): string {
  const parts: string[] = [];
  if (includeHermesPrefix) parts.push(HERMES_PREFIX);
  for (const layer of bundle.stablePrefix) parts.push(layer);
  for (const layer of bundle.blocks) parts.push(layer);
  if (bundle.memory) parts.push(bundle.memory);
  for (const layer of bundle.suffix) parts.push(layer);
  for (const layer of bundle.trailer) parts.push(layer);

  const cleaned = parts.map((l) => l.trim()).filter((l) => l.length > 0);

  if (includeHermesPrefix && cleaned[0] === HERMES_PREFIX) {
    // Hermes prefix joins the first real layer with a single "\n" (per the
    // contract: output starts with `"You are running inside Claude Hermes.\n"`),
    // while all subsequent layers remain blank-line separated.
    const rest = cleaned.slice(1).join("\n\n");
    return rest.length > 0 ? `${HERMES_PREFIX}\n${rest}` : `${HERMES_PREFIX}\n`;
  }
  return cleaned.join("\n\n");
}

/**
 * Drop lines that are exclusively `<!-- <ISO-8601 timestamp> -->` comments.
 * The surrounding fact bodies are kept intact so callers still see the facts,
 * just without the volatile datetime markers.
 */
function sanitizeMemory(raw: string): string {
  if (!raw) return "";
  const tsLine = /^\s*<!--\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*-->\s*$/;
  const kept = raw.split(/\r?\n/).filter((line) => !tsLine.test(line));
  // Collapse any runs of blank lines left behind to a single blank, so tail
  // truncation can keep whole entries without accumulating dead space.
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of kept) {
    if (line.trim().length === 0) {
      blankRun++;
      if (blankRun <= 1) collapsed.push("");
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  return collapsed.join("\n").trim();
}

/**
 * Head-trim MEMORY so only the newest entries survive within `maxBytes`.
 *
 * Entries are identified as non-empty lines separated by blank lines in the
 * already-sanitized MEMORY body. We drop entries from the front until the
 * assembled prompt fits; entries themselves are kept whole (never chopped
 * mid-body).
 */
function truncateMemory(bundle: LayerBundle, maxBytes: number, includeHermesPrefix: boolean): string {
  const entries = splitMemoryEntries(bundle.memory);

  // Fast path: try dropping one leading entry at a time.
  for (let drop = 1; drop <= entries.length; drop++) {
    const kept = entries.slice(drop).join("\n\n");
    const candidate = assemble({ ...bundle, memory: kept }, includeHermesPrefix);
    if (candidate.length <= maxBytes) return candidate;
  }

  // Even an empty MEMORY doesn't fit — return the prefix-only version. The
  // caller will apply a final hard slice on this if it still overruns.
  return assemble({ ...bundle, memory: "" }, includeHermesPrefix);
}

/** Split sanitized MEMORY into entry blocks (blank-line separated). */
function splitMemoryEntries(memory: string): string[] {
  if (!memory) return [];
  return memory
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

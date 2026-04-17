/**
 * Builds the Discord slash-command registration payload by combining the
 * small set of hardcoded session-management commands with every discovered
 * skill. Splitting this out of `discord.ts` lets us unit-test slug/
 * description normalization without spinning up a gateway.
 *
 * Discord's own constraints drive the rules here:
 *   - command names match `^[a-z0-9_-]{1,32}$`
 *   - descriptions are 1..100 chars
 *   - a single app may register at most 100 global commands
 *
 * The hardcoded commands always win collisions, and when two skills slug to
 * the same value we keep the first one seen (stable order from discovery).
 */
import type { SkillInfo } from "../skills/discovery";

export interface SlashCommandSpec {
  name: string;
  description: string;
  /** Discord APPLICATION_COMMAND_TYPE.CHAT_INPUT */
  type: 1;
}

const DISCORD_COMMAND_LIMIT = 100;
const DISCORD_NAME_MAX = 32;
const DISCORD_DESCRIPTION_MAX = 100;

export const HARDCODED_COMMANDS: SlashCommandSpec[] = [
  {
    name: "start",
    description: "Show welcome message and usage instructions",
    type: 1,
  },
  {
    name: "reset",
    description: "Reset the global session for a fresh start",
    type: 1,
  },
  {
    name: "compact",
    description: "Compact session to reduce context size",
    type: 1,
  },
  {
    name: "status",
    description: "Show current session status",
    type: 1,
  },
  {
    name: "context",
    description: "Show context window usage",
    type: 1,
  },
];

function slugifyCommandName(raw: string): string {
  const lower = raw.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9_-]/g, "_");
  // Trim leading/trailing underscores that came from non-alphanumeric
  // characters at the edges (e.g. "🔥" -> "__" -> "").
  const trimmed = replaced.replace(/^_+|_+$/g, "");
  return trimmed.slice(0, DISCORD_NAME_MAX);
}

function normalizeDescription(raw: string, fallbackName: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length > 0) {
    return trimmed.slice(0, DISCORD_DESCRIPTION_MAX);
  }
  return `Custom skill: ${fallbackName}`.slice(0, DISCORD_DESCRIPTION_MAX);
}

export function buildSlashCommandList(skills: SkillInfo[]): SlashCommandSpec[] {
  const out: SlashCommandSpec[] = [...HARDCODED_COMMANDS];
  const used = new Set<string>(HARDCODED_COMMANDS.map((c) => c.name));

  for (const skill of skills) {
    if (out.length >= DISCORD_COMMAND_LIMIT) break;

    const slug = slugifyCommandName(skill.name);
    if (!slug) continue;
    if (used.has(slug)) continue;

    const description = normalizeDescription(skill.description, skill.name);
    out.push({ name: slug, description, type: 1 });
    used.add(slug);
  }

  return out;
}

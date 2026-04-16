/**
 * Single source of truth for every filesystem path the daemon reads or writes.
 *
 * Why:
 *   - Nine call sites used to hardcode `.claude/claudeclaw/...`; renaming was
 *     the blast radius from hell.
 *   - Tests that override `process.cwd()` need one knob, not nine.
 *   - The legacy directory is kept around so the one-shot migrator can find it
 *     and move contents across on first startup after the rename.
 *
 * Everything is computed lazily from `process.cwd()` at call time so tests can
 * chdir into a fixture and still get the right absolute paths. Do NOT capture
 * these values into `const`s at module load time in consumers.
 */

import { join } from "node:path";

export const HERMES_DIR_NAME = "hermes";
export const LEGACY_DIR_NAME = "claudeclaw";

/** Root of all hermes runtime state for the current workspace. */
export function hermesDir(cwd: string = process.cwd()): string {
  return join(cwd, ".claude", HERMES_DIR_NAME);
}

/** Legacy claudeclaw directory — only referenced by the migrator. */
export function legacyDir(cwd: string = process.cwd()): string {
  return join(cwd, ".claude", LEGACY_DIR_NAME);
}

export function settingsFile(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "settings.json");
}

export function sessionFile(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "session.json");
}

export function threadSessionsFile(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "sessions.json");
}

export function jobsDir(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "jobs");
}

export function logsDir(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "logs");
}

export function promptsDir(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "prompts");
}

export function inboxDir(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "inbox");
}

export function discordInboxDir(cwd: string = process.cwd()): string {
  return join(inboxDir(cwd), "discord");
}

export function telegramInboxDir(cwd: string = process.cwd()): string {
  return join(inboxDir(cwd), "telegram");
}

export function pidFile(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "daemon.pid");
}

export function stateDbFile(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "state.db");
}

export function whisperDir(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "whisper");
}

export function memoryDir(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "memory");
}

export function userMemoryFile(cwd: string = process.cwd()): string {
  return join(memoryDir(cwd), "USER.md");
}

export function crossSessionMemoryFile(cwd: string = process.cwd()): string {
  return join(memoryDir(cwd), "MEMORY.md");
}

export function soulMemoryFile(cwd: string = process.cwd()): string {
  return join(memoryDir(cwd), "SOUL.md");
}

export function identityMemoryFile(cwd: string = process.cwd()): string {
  return join(memoryDir(cwd), "IDENTITY.md");
}

export function channelMemoryFile(channelId: string, cwd: string = process.cwd()): string {
  return join(memoryDir(cwd), "channels", `${channelId}.md`);
}

export function migrationMarkerFile(cwd: string = process.cwd()): string {
  return join(hermesDir(cwd), "MIGRATED.json");
}

export function projectClaudeMdFile(cwd: string = process.cwd()): string {
  return join(cwd, "CLAUDE.md");
}

export function legacyProjectClaudeMdFile(cwd: string = process.cwd()): string {
  return join(cwd, ".claude", "CLAUDE.md");
}

export function claudeDir(cwd: string = process.cwd()): string {
  return join(cwd, ".claude");
}

export function projectClaudeSettingsFile(cwd: string = process.cwd()): string {
  return join(claudeDir(cwd), "settings.json");
}

export function statuslineFile(cwd: string = process.cwd()): string {
  return join(claudeDir(cwd), "statusline.cjs");
}

/** Managed-block markers injected into the project CLAUDE.md. */
export const MANAGED_BLOCK_START = "<!-- hermes:managed:start -->";
export const MANAGED_BLOCK_END = "<!-- hermes:managed:end -->";

/** Legacy markers the migrator rewrites on first boot. */
export const LEGACY_MANAGED_BLOCK_START = "<!-- claudeclaw:managed:start -->";
export const LEGACY_MANAGED_BLOCK_END = "<!-- claudeclaw:managed:end -->";

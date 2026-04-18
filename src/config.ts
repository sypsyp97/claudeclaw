import { isAbsolute, relative, resolve } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";
import { hermesDir, settingsFile, jobsDir, logsDir } from "./paths";

const DEFAULT_SETTINGS: Settings = {
  model: "",
  api: "",
  fallback: {
    model: "",
    api: "",
  },
  agentic: {
    enabled: false,
    defaultMode: "implementation",
    modes: [
      {
        name: "planning",
        model: "opus",
        keywords: [
          "plan", "design", "architect", "strategy", "approach",
          "research", "investigate", "analyze", "explore", "understand",
          "think", "consider", "evaluate", "assess", "review",
          "system design", "trade-off", "decision", "choose", "compare",
          "brainstorm", "ideate", "concept", "proposal",
        ],
        phrases: [
          "how to implement", "how should i", "what's the best way to",
          "should i", "which approach", "help me decide", "help me understand",
        ],
      },
      {
        name: "implementation",
        model: "sonnet",
        keywords: [
          "implement", "code", "write", "create", "build", "add",
          "fix", "debug", "refactor", "update", "modify", "change",
          "deploy", "run", "execute", "install", "configure",
          "test", "commit", "push", "merge", "release",
          "generate", "scaffold", "setup", "initialize",
        ],
      },
    ],
  },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: {
    enabled: false,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: false,
    forwardToDiscord: false,
  },
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], listenChannels: [], statusChannelId: "" },
  security: { level: "moderate", allowedTools: [], disallowedTools: [], bypassPermissions: false },
  stt: { baseUrl: "", model: "" },
  plugins: { preflightOnStart: false },
  logging: { includeBodies: false },
  memory: { dreamCron: false, dreamIntervalHours: 24, dreamAgeDays: 7 },
  learning: { captureCandidateSkills: false },
};

export interface HeartbeatExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: HeartbeatExcludeWindow[];
  forwardToTelegram: boolean;
  forwardToDiscord: boolean;
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[]; // Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER
  listenChannels: string[]; // Channel IDs where bot responds to all messages (no mention needed)
  statusChannelId?: string; // Channel ID where live job/heartbeat status messages are posted
}

export type SecurityLevel =
  | "locked"
  | "strict"
  | "moderate"
  | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
  /**
   * Force `--dangerously-skip-permissions` on top of whatever the level
   * would derive. Acts as an OR override: `strict` / `moderate` /
   * `unrestricted` already auto-emit bypass (the daemon is headless — a
   * prompt means a hang), so this flag only changes behavior for `locked`,
   * where it lets the caller run unattended Edit/Write via a narrow
   * `allowedTools` list. Off by default.
   */
  bypassPermissions: boolean;
}

export interface Settings {
  model: string;
  api: string;
  fallback: ModelConfig;
  agentic: AgenticConfig;
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  security: SecurityConfig;
  stt: SttConfig;
  plugins: PluginsConfig;
  logging: LoggingConfig;
  /**
   * Optional in the type so legacy fixtures stay typecheck-green; always
   * populated at runtime by `parseSettings` from `DEFAULT_SETTINGS.memory`.
   * Callers should use `settings.memory ?? DEFAULT_SETTINGS.memory` (or a
   * local fallback) when reading.
   */
  memory?: MemoryConfig;
  /**
   * Optional in the type so legacy fixtures stay typecheck-green; always
   * populated at runtime by `parseSettings` from `DEFAULT_SETTINGS.learning`.
   * Callers should null-check (`settings.learning?.captureCandidateSkills`)
   * before reading.
   */
  learning?: LearningConfig;
}

export interface LearningConfig {
  /**
   * When true, the runner fires the post-turn `captureCandidateSkill` hook
   * after every successful turn. Captured skills land at status=`candidate`
   * for human review — the hook never self-promotes to shadow/active. Off
   * by default; opt in once you trust the slug/description quality.
   */
  captureCandidateSkills: boolean;
}

export interface MemoryConfig {
  /**
   * When true, the daemon's 60s cron tick invokes `maybeRunDream` so the
   * Dream consolidation pass fires automatically (rate-limited by
   * `dreamIntervalHours`). Off by default — opt in once you trust the
   * digest output.
   */
  dreamCron: boolean;
  /** Minimum hours between auto-runs. Default 24. */
  dreamIntervalHours: number;
  /** Messages older than this many days are eligible for digestion. Default 7. */
  dreamAgeDays: number;
}

export interface LoggingConfig {
  /**
   * If true, runner logs include the full prompt, stdout, and stderr of every
   * Claude invocation. If false (default), only metadata is persisted: name,
   * timestamp, session id, model, exit code, and byte counts. This affects
   * only `.claude/hermes/logs/*.log`; on-disk state files are unaffected.
   *
   * Default false because those logs can contain third-party message content
   * (DMs, private channel text, STT transcripts) and long-lived credentials
   * passed through prompts.
   */
  includeBodies: boolean;
}

export interface PluginsConfig {
  /**
   * Whether to run preflight (clone third-party repos, `bun install`, enable
   * in project settings) during daemon startup. Off by default — preflight
   * fetches and executes code from the network, so it must be explicitly
   * opted into either here or via the `hermes preflight` CLI.
   */
  preflightOnStart: boolean;
}

export interface AgenticMode {
  name: string;
  model: string;
  keywords: string[];
  phrases?: string[];
}

export interface AgenticConfig {
  enabled: boolean;
  defaultMode: string;
  modes: AgenticMode[];
}

export interface ModelConfig {
  model: string;
  api: string;
}

export interface SttConfig {
  /** Base URL of an OpenAI-compatible STT API, e.g. "http://127.0.0.1:8000".
   *  When set, the daemon routes voice transcription through this API instead
   *  of the bundled whisper.cpp binary. */
  baseUrl: string;
  /** Model name passed to the API (default: "Systran/faster-whisper-large-v3") */
  model: string;
}

let cached: Settings | null = null;
let cachedPath: string | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(hermesDir(), { recursive: true });
  await mkdir(jobsDir(), { recursive: true });
  await mkdir(logsDir(), { recursive: true });

  if (!existsSync(settingsFile())) {
    await Bun.write(settingsFile(), JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
  }
}

const VALID_LEVELS = new Set<SecurityLevel>([
  "locked",
  "strict",
  "moderate",
  "unrestricted",
]);

function parseAgenticMode(raw: any): AgenticMode | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!name || !model) return null;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k: unknown) => typeof k === "string").map((k: string) => k.toLowerCase().trim())
    : [];
  const phrases = Array.isArray(raw.phrases)
    ? raw.phrases.filter((p: unknown) => typeof p === "string").map((p: string) => p.toLowerCase().trim())
    : undefined;
  return { name, model, keywords, ...(phrases && phrases.length > 0 ? { phrases } : {}) };
}

function parseAgenticConfig(raw: any): AgenticConfig {
  const defaults = DEFAULT_SETTINGS.agentic;
  if (!raw || typeof raw !== "object") return defaults;

  const enabled = raw.enabled ?? false;

  // Backward compat: old planningModel/implementationModel format
  if (!Array.isArray(raw.modes) && ("planningModel" in raw || "implementationModel" in raw)) {
    const planningModel = typeof raw.planningModel === "string" ? raw.planningModel.trim() : "opus";
    const implModel = typeof raw.implementationModel === "string" ? raw.implementationModel.trim() : "sonnet";
    return {
      enabled,
      defaultMode: "implementation",
      modes: [
        { ...defaults.modes[0], model: planningModel },
        { ...defaults.modes[1], model: implModel },
      ],
    };
  }

  // New modes format
  const modes: AgenticMode[] = [];
  if (Array.isArray(raw.modes)) {
    for (const m of raw.modes) {
      const parsed = parseAgenticMode(m);
      if (parsed) modes.push(parsed);
    }
  }

  return {
    enabled,
    defaultMode: typeof raw.defaultMode === "string" ? raw.defaultMode.trim() : "implementation",
    modes: modes.length > 0 ? modes : defaults.modes,
  };
}

function parseSettings(raw: Record<string, any>, discordUserIdsRaw: string[] = []): Settings {
  const rawLevel = raw.security?.level;
  const level: SecurityLevel =
    typeof rawLevel === "string" && VALID_LEVELS.has(rawLevel as SecurityLevel)
      ? (rawLevel as SecurityLevel)
      : "moderate";

  const parsedTimezone = parseTimezone(raw.timezone);

  return {
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    api: typeof raw.api === "string" ? raw.api.trim() : "",
    fallback: {
      model: typeof raw.fallback?.model === "string" ? raw.fallback.model.trim() : "",
      api: typeof raw.fallback?.api === "string" ? raw.fallback.api.trim() : "",
    },
    agentic: parseAgenticConfig(raw.agentic),
    timezone: parsedTimezone,
    timezoneOffsetMinutes: parseTimezoneOffsetMinutes(raw.timezoneOffsetMinutes, parsedTimezone),
    heartbeat: {
      enabled: raw.heartbeat?.enabled ?? false,
      interval: raw.heartbeat?.interval ?? 15,
      prompt: raw.heartbeat?.prompt ?? "",
      excludeWindows: parseExcludeWindows(raw.heartbeat?.excludeWindows),
      forwardToTelegram: raw.heartbeat?.forwardToTelegram === true,
      forwardToDiscord: raw.heartbeat?.forwardToDiscord === true,
    },
    telegram: {
      token: raw.telegram?.token ?? "",
      allowedUserIds: raw.telegram?.allowedUserIds ?? [],
    },
    discord: {
      token: typeof raw.discord?.token === "string" ? raw.discord.token.trim() : "",
      // Snowflake IDs > 2^53 lose precision under JSON.parse. Prefer the raw
      // string list regex'd out of the source text when available; fall back
      // to the numeric array so tests that inject settings in-memory still work.
      allowedUserIds: discordUserIdsRaw.length > 0
        ? discordUserIdsRaw
        : Array.isArray(raw.discord?.allowedUserIds)
          ? raw.discord.allowedUserIds.map(String)
          : [],
      listenChannels: Array.isArray(raw.discord?.listenChannels)
        ? raw.discord.listenChannels.map(String)
        : [],
      statusChannelId: typeof raw.discord?.statusChannelId === "string"
        ? raw.discord.statusChannelId.trim()
        : "",
    },
    security: {
      level,
      allowedTools: Array.isArray(raw.security?.allowedTools)
        ? raw.security.allowedTools
        : [],
      disallowedTools: Array.isArray(raw.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
      bypassPermissions: raw.security?.bypassPermissions === true,
    },
    stt: {
      baseUrl: typeof raw.stt?.baseUrl === "string" ? raw.stt.baseUrl.trim() : "",
      model: typeof raw.stt?.model === "string" ? raw.stt.model.trim() : "",
    },
    plugins: {
      preflightOnStart: raw.plugins?.preflightOnStart === true,
    },
    logging: {
      includeBodies: raw.logging?.includeBodies === true,
    },
    memory: parseMemoryConfig(raw.memory),
    learning: parseLearningConfig(raw.learning),
  };
}

function parseLearningConfig(raw: any): LearningConfig {
  const defaults: LearningConfig = { captureCandidateSkills: false };
  if (!raw || typeof raw !== "object") return { ...defaults };
  return {
    captureCandidateSkills: raw.captureCandidateSkills === true,
  };
}

function parseMemoryConfig(raw: any): MemoryConfig {
  const defaults: MemoryConfig = { dreamCron: false, dreamIntervalHours: 24, dreamAgeDays: 7 };
  if (!raw || typeof raw !== "object") return { ...defaults };
  const intervalHours = Number(raw.dreamIntervalHours);
  const ageDays = Number(raw.dreamAgeDays);
  return {
    dreamCron: raw.dreamCron === true,
    dreamIntervalHours:
      Number.isFinite(intervalHours) && intervalHours > 0
        ? intervalHours
        : defaults.dreamIntervalHours,
    dreamAgeDays:
      Number.isFinite(ageDays) && ageDays > 0 ? ageDays : defaults.dreamAgeDays,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseTimezone(value: unknown): string {
  return normalizeTimezoneName(value);
}

function parseExcludeWindows(value: unknown): HeartbeatExcludeWindow[] {
  if (!Array.isArray(value)) return [];
  const out: HeartbeatExcludeWindow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const start = typeof (entry as any).start === "string" ? (entry as any).start.trim() : "";
    const end = typeof (entry as any).end === "string" ? (entry as any).end.trim() : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;

    const rawDays = Array.isArray((entry as any).days) ? (entry as any).days : [];
    const parsedDays = rawDays
      .map((d: unknown) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
    const uniqueDays = Array.from(new Set<number>(parsedDays)).sort((a: number, b: number) => a - b);

    out.push({
      start,
      end,
      days: uniqueDays.length > 0 ? uniqueDays : [...ALL_DAYS],
    });
  }
  return out;
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

/**
 * Extract discord.allowedUserIds as raw strings from the JSON text.
 * JSON.parse destroys precision on large numeric snowflakes (>2^53),
 * so we regex them out of the raw text first.
 */
function extractDiscordUserIds(rawText: string): string[] {
  // Match the "discord" object's "allowedUserIds" array values
  const discordBlock = rawText.match(/"discord"\s*:\s*\{[\s\S]*?\}/);
  if (!discordBlock) return [];
  const arrayMatch = discordBlock[0].match(/"allowedUserIds"\s*:\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return [];
  const items: string[] = [];
  // Match both quoted strings and bare numbers
  for (const m of arrayMatch[1].matchAll(/("(\d+)"|(\d+))/g)) {
    items.push(m[2] ?? m[3]);
  }
  return items;
}

export async function loadSettings(): Promise<Settings> {
  const path = settingsFile();
  if (cached && cachedPath === path) return cached;
  const rawText = await Bun.file(path).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  cachedPath = path;
  return cached;
}

/** Re-read settings from disk, bypassing cache. */
export async function reloadSettings(): Promise<Settings> {
  const path = settingsFile();
  const rawText = await Bun.file(path).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  cachedPath = path;
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

const PROMPT_FILE_PREFIX = "@file:";

/**
 * If the prompt string starts with the explicit `@file:` prefix, read the
 * referenced file (relative to cwd) and return its trimmed contents. Any
 * other string — including prose that incidentally ends in `.md`, `.txt`, or
 * `.prompt` — is returned literally.
 *
 * Guardrails: absolute paths are rejected, and resolved paths must remain
 * strictly under cwd (no `..` escapes). When the prefix is present but the
 * path is rejected or missing, the literal trimmed string is returned and a
 * warning is logged.
 */
export async function resolvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;
  if (!trimmed.startsWith(PROMPT_FILE_PREFIX)) return trimmed;

  const spec = trimmed.slice(PROMPT_FILE_PREFIX.length).trim();
  if (!spec) {
    console.warn("[config] @file: prompt reference had no path, using as literal string");
    return trimmed;
  }
  if (isAbsolute(spec)) {
    console.warn(`[config] refusing absolute prompt path "${spec}", using as literal string`);
    return trimmed;
  }

  const cwd = process.cwd();
  const resolved = resolve(cwd, spec);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    console.warn(
      `[config] prompt path "${spec}" escapes project root, using as literal string`
    );
    return trimmed;
  }

  try {
    const content = await Bun.file(resolved).text();
    return content.trim();
  } catch {
    console.warn(`[config] Prompt path "${spec}" not found, using as literal string`);
    return trimmed;
  }
}

import { mkdir, unlink, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { matchesBetween, nextCronMatch } from "../cron";
import { claudeDir, projectClaudeSettingsFile, statuslineFile } from "../paths";
import {
  type HeartbeatConfig,
  initConfig,
  loadSettings,
  reloadSettings,
  resolvePrompt,
  type Settings,
} from "../config";
import { type Job, clearJobSchedule, loadJobs } from "../jobs";
import { migrateIfNeeded } from "../migrate/legacy";
import { checkExistingDaemon, cleanupPidFile, writePidFile } from "../pid";
import {
  bootstrap,
  ensureProjectClaudeMd,
  loadHeartbeatPromptTemplate,
  run,
  runUserMessage,
} from "../runner";
import { type StateData, writeState } from "../statusline";
import { getDayAndMinuteAtOffset } from "../timezone";

const PREFLIGHT_SCRIPT = fileURLToPath(new URL("../preflight.ts", import.meta.url));

async function runMigrationIfAny(): Promise<void> {
  try {
    const result = await migrateIfNeeded();
    if (result.status === "migrated") {
      console.log(
        `[${new Date().toLocaleTimeString()}] Migrated legacy .claude/claudeclaw → .claude/hermes (${result.filesCopied ?? 0} file(s)). Archived source: ${result.archivedAs}`,
      );
    } else if (result.status === "conflict") {
      console.warn(
        `[${new Date().toLocaleTimeString()}] Legacy .claude/claudeclaw still exists alongside .claude/hermes; manual cleanup required.`,
      );
    }
  } catch (err) {
    console.error(
      `[${new Date().toLocaleTimeString()}] Migration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- Statusline setup/teardown ---

const STATUSLINE_SCRIPT = `#!/usr/bin/env node
const { readFileSync } = require("fs");
const { join } = require("path");

const DIR = join(__dirname, "hermes");
const STATE_FILE = join(DIR, "state.json");
const PID_FILE = join(DIR, "daemon.pid");

const R = "\\x1b[0m";
const DIM = "\\x1b[2m";
const RED = "\\x1b[31m";
const GREEN = "\\x1b[32m";

function fmt(ms) {
  if (ms <= 0) return GREEN + "now!" + R;
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return (s % 60) + "s";
}

function alive() {
  try {
    var pid = readFileSync(PID_FILE, "utf-8").trim();
    process.kill(Number(pid), 0);
    return true;
  } catch { return false; }
}

var B = DIM + "\\u2502" + R;
var TL = DIM + "\\u256d" + R;
var TR = DIM + "\\u256e" + R;
var BL = DIM + "\\u2570" + R;
var BR = DIM + "\\u256f" + R;
var H = DIM + "\\u2500" + R;
var HEADER = TL + H.repeat(6) + " \\ud83e\\udd9e Claude Hermes \\ud83e\\udd9e " + H.repeat(6) + TR;
var FOOTER = BL + H.repeat(30) + BR;

if (!alive()) {
  process.stdout.write(
    HEADER + "\\n" +
    B + "        " + RED + "\\u25cb offline" + R + "              " + B + "\\n" +
    FOOTER
  );
  process.exit(0);
}

try {
  var state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  var now = Date.now();
  var info = [];

  if (state.heartbeat) {
    info.push("\\ud83d\\udc93 " + fmt(state.heartbeat.nextAt - now));
  }

  var jc = (state.jobs || []).length;
  info.push("\\ud83d\\udccb " + jc + " job" + (jc !== 1 ? "s" : ""));
  info.push(GREEN + "\\u25cf live" + R);

  if (state.telegram) {
    info.push(GREEN + "\\ud83d\\udce1" + R);
  }

  if (state.discord) {
    info.push(GREEN + "\\ud83c\\udfae" + R);
  }

  var mid = " " + info.join(" " + B + " ") + " ";

  process.stdout.write(HEADER + "\\n" + B + mid + B + "\\n" + FOOTER);
} catch {
  process.stdout.write(
    HEADER + "\\n" +
    B + DIM + "         waiting...         " + R + B + "\\n" +
    FOOTER
  );
}
`;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseClockMinutes(value: string): number | null {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isHeartbeatExcludedNow(config: HeartbeatConfig, timezoneOffsetMinutes: number): boolean {
  return isHeartbeatExcludedAt(config, timezoneOffsetMinutes, new Date());
}

function isHeartbeatExcludedAt(
  config: HeartbeatConfig,
  timezoneOffsetMinutes: number,
  at: Date,
): boolean {
  if (!Array.isArray(config.excludeWindows) || config.excludeWindows.length === 0) return false;
  const local = getDayAndMinuteAtOffset(at, timezoneOffsetMinutes);

  for (const window of config.excludeWindows) {
    const start = parseClockMinutes(window.start);
    const end = parseClockMinutes(window.end);
    if (start == null || end == null) continue;
    const days = Array.isArray(window.days) && window.days.length > 0 ? window.days : ALL_DAYS;
    const sameDay = start < end;

    if (sameDay) {
      if (days.includes(local.day) && local.minute >= start && local.minute < end) return true;
      continue;
    }

    if (start === end) {
      if (days.includes(local.day)) return true;
      continue;
    }

    if (local.minute >= start && days.includes(local.day)) return true;
    const previousDay = (local.day + 6) % 7;
    if (local.minute < end && days.includes(previousDay)) return true;
  }

  return false;
}

function nextAllowedHeartbeatAt(
  config: HeartbeatConfig,
  timezoneOffsetMinutes: number,
  intervalMs: number,
  fromMs: number,
): number {
  const interval = Math.max(60_000, Math.round(intervalMs));
  let candidate = fromMs + interval;
  let guard = 0;

  while (isHeartbeatExcludedAt(config, timezoneOffsetMinutes, new Date(candidate)) && guard < 20_000) {
    candidate += interval;
    guard++;
  }

  return candidate;
}

async function setupStatusline() {
  await mkdir(claudeDir(), { recursive: true });
  await writeFile(statuslineFile(), STATUSLINE_SCRIPT);

  let settings: Record<string, unknown> = {};
  try {
    settings = await Bun.file(projectClaudeSettingsFile()).json();
  } catch {
    // file doesn't exist or isn't valid JSON
  }
  settings.statusLine = {
    type: "command",
    command: "node .claude/statusline.cjs",
  };
  await writeFile(projectClaudeSettingsFile(), JSON.stringify(settings, null, 2) + "\n");
}

async function teardownStatusline() {
  try {
    const settings = await Bun.file(projectClaudeSettingsFile()).json();
    delete settings.statusLine;
    await writeFile(projectClaudeSettingsFile(), JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(statuslineFile());
  } catch {
    // already gone
  }
}

// --- Main ---

export async function start(args: string[] = []) {
  let hasPromptFlag = false;
  let hasTriggerFlag = false;
  let telegramFlag = false;
  let discordFlag = false;
  let debugFlag = false;
  let replaceExistingFlag = false;
  const payloadParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prompt") {
      hasPromptFlag = true;
    } else if (arg === "--trigger") {
      hasTriggerFlag = true;
    } else if (arg === "--telegram") {
      telegramFlag = true;
    } else if (arg === "--discord") {
      discordFlag = true;
    } else if (arg === "--debug") {
      debugFlag = true;
    } else if (arg === "--replace-existing") {
      replaceExistingFlag = true;
    } else {
      payloadParts.push(arg);
    }
  }
  const payload = payloadParts.join(" ").trim();
  if (hasPromptFlag && !payload) {
    console.error(
      "Usage: claude-hermes start --prompt <prompt> [--trigger] [--telegram] [--discord] [--debug] [--replace-existing]",
    );
    process.exit(1);
  }
  if (!hasPromptFlag && payload) {
    console.error("Prompt text requires `--prompt`.");
    process.exit(1);
  }
  if (telegramFlag && !hasTriggerFlag) {
    console.error("`--telegram` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (discordFlag && !hasTriggerFlag) {
    console.error("`--discord` with `start` requires `--trigger`.");
    process.exit(1);
  }

  // One-shot mode: explicit prompt without trigger.
  if (hasPromptFlag && !hasTriggerFlag) {
    await runMigrationIfAny();
    const existingPid = await checkExistingDaemon();
    if (existingPid) {
      console.error(
        `\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`,
      );
      console.error(
        "Use `claude-hermes send <message> [--telegram] [--discord]` while daemon is running.",
      );
      process.exit(1);
    }

    await initConfig();
    await loadSettings();
    await ensureProjectClaudeMd();
    const result = await runUserMessage("prompt", payload);
    console.log(result.stdout);
    if (result.exitCode !== 0) process.exit(result.exitCode);
    return;
  }

  await runMigrationIfAny();
  const existingPid = await checkExistingDaemon();
  if (existingPid) {
    if (!replaceExistingFlag) {
      console.error(
        `\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`,
      );
      console.error(`Use --stop first, or kill PID ${existingPid} manually.`);
      process.exit(1);
    }

    console.log(`Replacing existing daemon (PID ${existingPid})...`);
    try {
      process.kill(existingPid, "SIGTERM");
    } catch {
      // ignore if process is already dead
    }

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        process.kill(existingPid, 0);
        await Bun.sleep(100);
      } catch {
        break;
      }
    }

    await cleanupPidFile();
  }

  await initConfig();
  const settings = await loadSettings();
  await ensureProjectClaudeMd();
  const jobs = await loadJobs();

  await setupStatusline();
  await writePidFile();
  let discordStopGateway: (() => void) | null = null;

  async function shutdown() {
    if (discordStopGateway) discordStopGateway();
    await teardownStatusline();
    await cleanupPidFile();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("Claude Hermes daemon started");
  console.log(`  PID: ${process.pid}`);
  console.log(`  Security: ${settings.security.level}`);
  if (settings.security.allowedTools.length > 0) {
    console.log(`    + allowed: ${settings.security.allowedTools.join(", ")}`);
  }
  if (settings.security.disallowedTools.length > 0) {
    console.log(`    - blocked: ${settings.security.disallowedTools.join(", ")}`);
  }
  console.log(
    `  Heartbeat: ${settings.heartbeat.enabled ? `every ${settings.heartbeat.interval}m` : "disabled"}`,
  );
  if (debugFlag) console.log("  Debug: enabled");
  console.log(`  Jobs loaded: ${jobs.length}`);
  jobs.forEach((j) => console.log(`    - ${j.name} [${j.schedule}]`));

  // --- Mutable state ---
  let currentSettings: Settings = settings;
  let currentJobs: Job[] = jobs;
  let nextHeartbeatAt = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  const daemonStartedAt = Date.now();

  // --- Telegram ---
  let telegramSend: ((chatId: number, text: string) => Promise<void>) | null = null;
  let telegramToken = "";

  async function initTelegram(token: string) {
    if (token && token !== telegramToken) {
      const { startPolling, sendMessage } = await import("./telegram");
      startPolling(debugFlag);
      telegramSend = (chatId, text) => sendMessage(token, chatId, text);
      telegramToken = token;
      console.log(`[${ts()}] Telegram: enabled`);
    } else if (!token && telegramToken) {
      telegramSend = null;
      telegramToken = "";
      console.log(`[${ts()}] Telegram: disabled`);
    }
  }

  await initTelegram(currentSettings.telegram.token);
  if (!telegramToken) console.log("  Telegram: not configured");

  // --- Discord ---
  let discordSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  let discordToken = "";

  async function initDiscord(token: string) {
    if (token && token !== discordToken) {
      const { startGateway, sendMessageToUser, stopGateway } = await import("./discord");
      if (discordToken) stopGateway();
      startGateway(debugFlag);
      discordStopGateway = stopGateway;
      discordSendToUser = (userId, text) => sendMessageToUser(token, userId, text);
      discordToken = token;
      console.log(`[${ts()}] Discord: enabled`);
    } else if (!token && discordToken) {
      if (discordStopGateway) discordStopGateway();
      discordStopGateway = null;
      discordSendToUser = null;
      discordToken = "";
      console.log(`[${ts()}] Discord: disabled`);
    }
  }

  await initDiscord(currentSettings.discord.token);
  if (!discordToken) console.log("  Discord: not configured");

  // --- Helpers ---
  function ts() {
    return new Date().toLocaleTimeString();
  }

  function startPreflightInBackground(projectPath: string): void {
    try {
      const proc = Bun.spawn([process.execPath, "run", PREFLIGHT_SCRIPT, projectPath], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      proc.unref();
      console.log(`[${ts()}] Plugin preflight started in background`);
    } catch (err) {
      console.error(`[${ts()}] Failed to start plugin preflight:`, err);
    }
  }

  function forwardToTelegram(
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!telegramSend || currentSettings.telegram.allowedUserIds.length === 0) return;
    const text =
      result.exitCode === 0
        ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
        : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
    for (const userId of currentSettings.telegram.allowedUserIds) {
      telegramSend(userId, text).catch((err) =>
        console.error(`[Telegram] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  function forwardToDiscord(
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ) {
    if (!discordSendToUser || currentSettings.discord.allowedUserIds.length === 0) return;
    const text =
      result.exitCode === 0
        ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
        : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
    for (const userId of currentSettings.discord.allowedUserIds) {
      discordSendToUser(userId, text).catch((err) =>
        console.error(`[Discord] Failed to forward to ${userId}: ${err}`),
      );
    }
  }

  // --- Heartbeat scheduling ---
  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;

    if (!currentSettings.heartbeat.enabled) {
      nextHeartbeatAt = 0;
      return;
    }

    const ms = currentSettings.heartbeat.interval * 60_000;
    nextHeartbeatAt = nextAllowedHeartbeatAt(
      currentSettings.heartbeat,
      currentSettings.timezoneOffsetMinutes,
      ms,
      Date.now(),
    );

    function tick() {
      if (isHeartbeatExcludedNow(currentSettings.heartbeat, currentSettings.timezoneOffsetMinutes)) {
        console.log(`[${ts()}] Heartbeat skipped (excluded window)`);
        nextHeartbeatAt = nextAllowedHeartbeatAt(
          currentSettings.heartbeat,
          currentSettings.timezoneOffsetMinutes,
          ms,
          Date.now(),
        );
        return;
      }
      Promise.all([
        resolvePrompt(currentSettings.heartbeat.prompt),
        loadHeartbeatPromptTemplate(),
      ])
        .then(([prompt, template]) => {
          const userPromptSection = prompt.trim()
            ? `User custom heartbeat prompt:\n${prompt.trim()}`
            : "";
          const mergedPrompt = [template.trim(), userPromptSection]
            .filter((part) => part.length > 0)
            .join("\n\n");
          if (!mergedPrompt) return null;
          return run("heartbeat", mergedPrompt);
        })
        .then((r) => {
          if (!r) return;
          // "Routine" heartbeats (the OK marker) only forward when the user
          // explicitly opted the channel into heartbeat traffic. Non-routine
          // updates always forward — they exist precisely to be seen.
          const isRoutine = r.stdout.trim().startsWith("HEARTBEAT_OK");
          if (!isRoutine || currentSettings.heartbeat.forwardToTelegram) {
            forwardToTelegram("", r);
          }
          if (!isRoutine || currentSettings.heartbeat.forwardToDiscord) {
            forwardToDiscord("", r);
          }
        });
      nextHeartbeatAt = nextAllowedHeartbeatAt(
        currentSettings.heartbeat,
        currentSettings.timezoneOffsetMinutes,
        ms,
        Date.now(),
      );
    }

    heartbeatTimer = setTimeout(function runAndReschedule() {
      tick();
      heartbeatTimer = setTimeout(runAndReschedule, ms);
    }, ms);
  }

  // Startup init:
  // - trigger mode: run exactly one trigger prompt (no separate bootstrap)
  // - normal mode: bootstrap to initialize session context
  if (hasTriggerFlag) {
    const triggerPrompt = hasPromptFlag ? payload : "Wake up, my friend!";
    const triggerResult = await run("trigger", triggerPrompt);
    console.log(triggerResult.stdout);
    if (telegramFlag) forwardToTelegram("", triggerResult);
    if (discordFlag) forwardToDiscord("", triggerResult);
    if (triggerResult.exitCode !== 0) {
      console.error(
        `[${ts()}] Startup trigger failed (exit ${triggerResult.exitCode}). Daemon will continue running.`,
      );
    }
  } else {
    // Bootstrap the session first so system prompt is initial context
    // and session.json is created immediately.
    await bootstrap();
  }

  // Plugin preflight is opt-in: it clones third-party repos and runs
  // `bun install` on their dependencies, so it must be explicitly enabled
  // via `plugins.preflightOnStart` in settings.json (or the one-shot
  // `hermes preflight` command). Off by default.
  if (currentSettings.plugins.preflightOnStart) {
    startPreflightInBackground(process.cwd());
  } else {
    console.log(
      `[${ts()}] Plugin preflight skipped (plugins.preflightOnStart=false); run 'hermes preflight' to install manually.`,
    );
  }

  if (currentSettings.heartbeat.enabled) scheduleHeartbeat();

  // --- Hot-reload loop (every 30s) ---
  setInterval(async () => {
    try {
      const newSettings = await reloadSettings();
      const newJobs = await loadJobs();

      const hbChanged =
        newSettings.heartbeat.enabled !== currentSettings.heartbeat.enabled ||
        newSettings.heartbeat.interval !== currentSettings.heartbeat.interval ||
        newSettings.heartbeat.prompt !== currentSettings.heartbeat.prompt ||
        newSettings.timezoneOffsetMinutes !== currentSettings.timezoneOffsetMinutes ||
        newSettings.timezone !== currentSettings.timezone ||
        JSON.stringify(newSettings.heartbeat.excludeWindows) !==
          JSON.stringify(currentSettings.heartbeat.excludeWindows);

      const secChanged =
        newSettings.security.level !== currentSettings.security.level ||
        newSettings.security.allowedTools.join(",") !==
          currentSettings.security.allowedTools.join(",") ||
        newSettings.security.disallowedTools.join(",") !==
          currentSettings.security.disallowedTools.join(",");

      if (secChanged) {
        console.log(`[${ts()}] Security level changed → ${newSettings.security.level}`);
      }

      if (hbChanged) {
        console.log(
          `[${ts()}] Config change detected — heartbeat: ${newSettings.heartbeat.enabled ? `every ${newSettings.heartbeat.interval}m` : "disabled"}`,
        );
        currentSettings = newSettings;
        scheduleHeartbeat();
      } else {
        currentSettings = newSettings;
      }

      const jobNames = newJobs
        .map((j) => `${j.name}:${j.schedule}:${j.prompt}`)
        .sort()
        .join("|");
      const oldJobNames = currentJobs
        .map((j) => `${j.name}:${j.schedule}:${j.prompt}`)
        .sort()
        .join("|");
      if (jobNames !== oldJobNames) {
        console.log(`[${ts()}] Jobs reloaded: ${newJobs.length} job(s)`);
        newJobs.forEach((j) => console.log(`    - ${j.name} [${j.schedule}]`));
      }
      currentJobs = newJobs;

      await initTelegram(newSettings.telegram.token);
      await initDiscord(newSettings.discord.token);
    } catch (err) {
      console.error(`[${ts()}] Hot-reload error:`, err);
    }
  }, 30_000);

  // --- Cron tick (every 60s) ---
  // Track the last minute-slot each job was evaluated against so a daemon
  // sleep, clock skew, or blocked event loop doesn't drop a trigger.
  const lastTickFor = new Map<string, Date>();
  function updateState() {
    const now = new Date();
    const jobsState: { name: string; nextAt: number }[] = [];
    for (const job of currentJobs) {
      try {
        const next = nextCronMatch(job.schedule, now, currentSettings.timezoneOffsetMinutes);
        if (next) jobsState.push({ name: job.name, nextAt: next.getTime() });
      } catch (err) {
        console.error(`[${ts()}] Skipping ${job.name} in status: ${String(err)}`);
      }
    }
    const state: StateData = {
      heartbeat: currentSettings.heartbeat.enabled ? { nextAt: nextHeartbeatAt } : undefined,
      jobs: jobsState,
      security: currentSettings.security.level,
      telegram: !!currentSettings.telegram.token,
      discord: !!currentSettings.discord.token,
      startedAt: daemonStartedAt,
    };
    writeState(state);
  }

  updateState();

  setInterval(() => {
    const now = new Date();
    for (const job of currentJobs) {
      try {
        const since = lastTickFor.get(job.name) ?? new Date(now.getTime() - 60_000);
        lastTickFor.set(job.name, now);
        const hits = matchesBetween(
          job.schedule,
          since,
          now,
          currentSettings.timezoneOffsetMinutes,
        );
        if (hits.length === 0) continue;
        resolvePrompt(job.prompt)
          .then((prompt) => run(job.name, prompt))
          .then((r) => {
            if (job.notify === false) return;
            if (job.notify === "error" && r.exitCode === 0) return;
            forwardToTelegram(job.name, r);
            forwardToDiscord(job.name, r);
          })
          .catch((err) => {
            console.error(`[${ts()}] Job ${job.name} failed:`, err);
          })
          .finally(async () => {
            if (job.recurring) return;
            try {
              await clearJobSchedule(job.name);
              console.log(`[${ts()}] Cleared schedule for one-time job: ${job.name}`);
            } catch (err) {
              console.error(`[${ts()}] Failed to clear schedule for ${job.name}:`, err);
            }
          });
      } catch (err) {
        console.error(`[${ts()}] Cron tick error for ${job.name}:`, err);
      }
    }
    updateState();
  }, 60_000);
}

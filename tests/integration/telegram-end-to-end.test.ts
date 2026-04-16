/**
 * End-to-end exercise for the Telegram path. Telegram has no envelope adapter
 * yet (only Discord does), so the production entry point we drive is the
 * exact line `commands/telegram.ts:836` calls:
 *
 *     await runUserMessage("telegram", prefixedPrompt);
 *
 * What this test validates that nothing else does:
 *  1. A telegram-shaped prompt produces a reply via the real runner + the
 *     fake Claude CLI.
 *  2. Two turns within the same session reuse the same global session id
 *     (turn count increments).
 *  3. The voice path: fake-claude consumes a transcript pulled from a real
 *     local fake STT server (Bun.serve), exercising `transcribeAudioToText`
 *     with the OpenAI-compatible API code path.
 *  4. `[react:emoji]` directives survive the runner verbatim — the telegram
 *     adapter is responsible for stripping them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSharedDbCache } from "../../src/state/shared-db";
import { rmWithRetry } from "../helpers/rm-with-retry";

const ORIG_CWD = process.cwd();
const FAKE_CLAUDE_ABS = join(ORIG_CWD, "tests", "fixtures", "fake-claude.ts");

let tmpProj: string;
let runner: typeof import("../../src/runner");
let sessions: typeof import("../../src/sessions");
let whisper: typeof import("../../src/whisper");
let sttServer: ReturnType<typeof Bun.serve> | null = null;
let sttPort: number;

const MIN_SETTINGS = {
  model: "",
  api: "",
  fallback: { model: "", api: "" },
  agentic: { enabled: false, defaultMode: "implementation", modes: [] },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: { enabled: false, interval: 15, prompt: "", excludeWindows: [], forwardToTelegram: false },
  telegram: { token: "fake-telegram-token", allowedUserIds: [123456789] },
  discord: { token: "", allowedUserIds: [], listenChannels: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  // Filled in once the fake STT server is up.
  stt: { baseUrl: "", model: "test-model" },
};

beforeAll(async () => {
  // 1. Spin up a fake STT server first so we can put its URL into settings.
  sttServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/audio/transcriptions") {
        return new Response("not found", { status: 404 });
      }
      // Respond like an OpenAI-compatible STT API.
      return Response.json({ text: "hello from fake STT" });
    },
  });
  sttPort = sttServer.port as number;

  tmpProj = mkdtempSync(join(tmpdir(), "hermes-telegram-e2e-"));
  process.chdir(tmpProj);
  mkdirSync(join(tmpProj, ".claude", "hermes", "logs"), { recursive: true });
  MIN_SETTINGS.stt.baseUrl = `http://127.0.0.1:${sttPort}`;
  writeFileSync(join(tmpProj, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));

  process.env.HERMES_CLAUDE_BIN = `bun run ${FAKE_CLAUDE_ABS}`;

  const config = await import("../../src/config");
  // reload, not load — the settings module caches at module scope and the
  // discord e2e test (run earlier in this suite) may have populated it from
  // its own tmp project.
  await config.reloadSettings();
  sessions = await import("../../src/sessions");
  runner = await import("../../src/runner");
  whisper = await import("../../src/whisper");
});

afterAll(async () => {
  // Drop the shared-db cache before removing the tempdir — on Windows a
  // held-open SQLite handle turns the rmSync into an EBUSY.
  await resetSharedDbCache();
  process.chdir(ORIG_CWD);
  delete process.env.HERMES_CLAUDE_BIN;
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_SESSION_ID;
  delete process.env.HERMES_FAKE_ECHO_PROMPT;
  if (sttServer) sttServer.stop(true);
  if (tmpProj) await rmWithRetry(tmpProj);
});

afterEach(() => {
  // The fake-claude scenario env vars are sticky; clear them after every
  // test so a stray HERMES_FAKE_REPLY from a previous case doesn't leak in.
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_SESSION_ID;
  delete process.env.HERMES_FAKE_ECHO_PROMPT;
});

/**
 * Mirror what `commands/telegram.ts` builds before calling runUserMessage.
 */
function buildTelegramPrompt(opts: {
  username: string;
  text?: string;
  voiceTranscript?: string;
  imagePath?: string;
}): string {
  const parts = [`[Telegram from ${opts.username}]`];
  if (opts.text) parts.push(`Message: ${opts.text}`);
  if (opts.voiceTranscript) {
    parts.push(`Voice transcript: ${opts.voiceTranscript}`);
    parts.push("The user attached voice audio. Use the transcript as their spoken message.");
  }
  if (opts.imagePath) {
    parts.push(`Image path: ${opts.imagePath}`);
    parts.push("The user attached an image. Inspect this image file directly before answering.");
  }
  return parts.join("\n");
}

/**
 * Local copy of the helper from `commands/telegram.ts:361`. The function
 * isn't exported, but the contract is well-defined and stable. We use it
 * here only to assert the cleanup behavior the adapter would apply on top
 * of the runner's stdout.
 */
function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

describe("Telegram end-to-end (text path)", () => {
  test("text message produces a runner-driven reply via fake-claude", async () => {
    process.env.HERMES_FAKE_REPLY = "hi from claude";
    process.env.HERMES_FAKE_SESSION_ID = "telegram-session-1";

    const prompt = buildTelegramPrompt({ username: "alice", text: "ping" });
    const result = await runner.runUserMessage("telegram", prompt);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi from claude");

    const created = await sessions.peekSession();
    expect(created?.sessionId).toBe("telegram-session-1");
  });

  test("second turn resumes the same global session and increments turnCount", async () => {
    process.env.HERMES_FAKE_REPLY = "second turn ok";
    const prompt = buildTelegramPrompt({ username: "alice", text: "again" });
    const result = await runner.runUserMessage("telegram", prompt);

    expect(result.exitCode).toBe(0);
    const after = await sessions.peekSession();
    expect(after?.sessionId).toBe("telegram-session-1"); // unchanged
    expect((after?.turnCount ?? 0) >= 1).toBe(true); // resume increments
  });

  test("[react:emoji] directive survives the runner; adapter would strip it", async () => {
    process.env.HERMES_FAKE_REPLY = "[react:thumbsup] roger\nMore body text.";
    const prompt = buildTelegramPrompt({ username: "alice", text: "ack me" });
    const result = await runner.runUserMessage("telegram", prompt);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[react:thumbsup]");

    const { cleanedText, reactionEmoji } = extractReactionDirective(result.stdout);
    expect(reactionEmoji).toBe("thumbsup");
    expect(cleanedText).not.toContain("[react:");
    expect(cleanedText).toContain("roger");
    expect(cleanedText).toContain("More body text.");
  });

  test("clock prefix is injected into user prompts (runUserMessage path)", async () => {
    process.env.HERMES_FAKE_ECHO_PROMPT = "1";
    const prompt = buildTelegramPrompt({ username: "alice", text: "what time is it" });
    const result = await runner.runUserMessage("telegram", prompt);
    delete process.env.HERMES_FAKE_ECHO_PROMPT;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("what time is it");
    // runner.runUserMessage prefixes the prompt with a clock line that
    // contains the current year. The fake echoes the full prompt back.
    expect(result.stdout).toMatch(/20\d{2}/);
  });
});

describe("Telegram end-to-end (voice path with fake STT API)", () => {
  test("fake STT server transcribes audio; transcript flows into the prompt", async () => {
    // Write a tiny "voice" file. transcribeAudioToText doesn't care about
    // contents when going through the API path — the fake STT server
    // returns a fixed string regardless.
    const voicePath = join(tmpProj, "voice.ogg");
    await writeFile(voicePath, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // "OggS" magic

    const transcript = await whisper.transcribeAudioToText(voicePath);
    expect(transcript).toBe("hello from fake STT");

    process.env.HERMES_FAKE_ECHO_PROMPT = "1";
    const prompt = buildTelegramPrompt({
      username: "alice",
      voiceTranscript: transcript,
    });
    const result = await runner.runUserMessage("telegram", prompt);
    delete process.env.HERMES_FAKE_ECHO_PROMPT;

    expect(result.exitCode).toBe(0);
    // The prompt embedded the transcript; fake-claude echoes the prompt
    // back; therefore the reply contains the transcript text.
    expect(result.stdout).toContain("hello from fake STT");
    expect(result.stdout).toContain("Voice transcript:");
  });
});

describe("Telegram end-to-end (auth contract documented at the runner boundary)", () => {
  test("settings carry an allowedUserIds list — the adapter is responsible for filtering", async () => {
    // The production telegram handler at `commands/telegram.ts` rejects any
    // user id not in `settings.telegram.allowedUserIds` BEFORE invoking the
    // runner. There's no exported entry point for us to drive that flow
    // without re-implementing the entire polling loop, so we content
    // ourselves here with confirming the settings shape exposes the list.
    const config = await import("../../src/config");
    const settings = config.getSettings();
    expect(Array.isArray(settings.telegram.allowedUserIds)).toBe(true);
    expect(settings.telegram.allowedUserIds).toContain(123456789);
  });
});

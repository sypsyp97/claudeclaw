/**
 * End-to-end exercise: a Discord-shaped MESSAGE_CREATE payload travels through
 * every real production seam — adapter → channel-policy → router → runner →
 * fake-claude — and the runner output is captured. The only fakes are the
 * Claude CLI (HERMES_CLAUDE_BIN) and the project tmpdir; everything in
 * between (envelope, route decision, auth, session-key, SQLite policy
 * lookup, runner queue) is the real code.
 *
 * The legacy `commands/discord.ts` path (raw thread-id) is exercised in the
 * second describe block, mirroring what `handleMessageCreate` calls at
 * src/commands/discord.ts:649.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../helpers/rm-with-retry";
import { resolveDiscordPolicy } from "../../src/adapters/discord/channel-policy";
import {
  type DiscordContext,
  type DiscordMessageEvent,
  toEnvelope,
} from "../../src/adapters/discord/message-router";
import { type ChannelPolicy as RouterChannelPolicy, type RouteEnv, route } from "../../src/router/route";
import { upsertPolicy } from "../../src/state/repos/policies";
import { applyMigrations, closeDb, type Database, openDb } from "../../src/state";

const ORIG_CWD = process.cwd();
const FAKE_CLAUDE_ABS = join(ORIG_CWD, "tests", "fixtures", "fake-claude.ts");

let tmpProj: string;
let db: Database;
let runner: typeof import("../../src/runner");
let sessions: typeof import("../../src/sessions");
let sessionMgr: typeof import("../../src/sessionManager");

const MIN_SETTINGS = {
  model: "",
  api: "",
  fallback: { model: "", api: "" },
  agentic: { enabled: false, defaultMode: "implementation", modes: [] },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: { enabled: false, interval: 15, prompt: "", excludeWindows: [], forwardToTelegram: false },
  telegram: { token: "", allowedUserIds: [] },
  discord: {
    token: "fake-token",
    allowedUserIds: ["111111111111111111"],
    listenChannels: ["222222222222222222"],
  },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  stt: { baseUrl: "", model: "" },
};

beforeAll(async () => {
  tmpProj = mkdtempSync(join(tmpdir(), "hermes-discord-e2e-"));
  process.chdir(tmpProj);
  mkdirSync(join(tmpProj, ".claude", "hermes", "logs"), { recursive: true });
  writeFileSync(join(tmpProj, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.env.HERMES_CLAUDE_BIN = `bun run ${FAKE_CLAUDE_ABS}`;

  db = openDb({ path: ":memory:" });
  await applyMigrations(db);

  const config = await import("../../src/config");
  // reload (not load) — settings is module-scoped cached and another test
  // file may have already populated it from its own tmp project.
  await config.reloadSettings();
  sessions = await import("../../src/sessions");
  sessionMgr = await import("../../src/sessionManager");
  runner = await import("../../src/runner");
});

afterAll(async () => {
  closeDb(db);
  // Drop the shared-db cache before removing the tempdir — on Windows a
  // held-open SQLite handle turns the rmSync into an EBUSY.
  const { resetSharedDbCache } = await import("../../src/state/shared-db");
  await resetSharedDbCache();
  process.chdir(ORIG_CWD);
  delete process.env.HERMES_CLAUDE_BIN;
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_SESSION_ID;
  await rmWithRetry(tmpProj);
});

/**
 * Bridge the channel-policy `ChannelPolicy` shape (with `mode`, `autoThread`,
 * etc.) onto the router's flatter `ChannelPolicy` shape. Production hasn't
 * formalised this bridge yet — the test does it inline so the chain still
 * runs end-to-end.
 */
function buildRouteEnv(): RouteEnv {
  return {
    auth: {
      allowedUserIds: MIN_SETTINGS.discord.allowedUserIds,
      allowedAdmins: [],
    },
    defaultModel: MIN_SETTINGS.model || undefined,
    defaultFallbackModel: MIN_SETTINGS.fallback.model || undefined,
    defaultAllowedTools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
    claudeBin: process.env.HERMES_CLAUDE_BIN,
    policyFor(envelope) {
      const cp = resolveDiscordPolicy(db, {
        guild: envelope.guild,
        channel: envelope.channel,
        isDm: !envelope.guild,
      });
      const router: RouterChannelPolicy = {
        sessionScope: cp.sessionScope,
        allowedTools: cp.allowedSkills === "*" ? "*" : cp.allowedSkills,
        memoryScope: cp.memoryScope === "none" ? "none" : cp.memoryScope,
        model: cp.modelPolicy?.model,
        fallbackModel: cp.modelPolicy?.fallback,
      };
      return router;
    },
    promptLayers() {
      // Production composes SOUL → IDENTITY → USER → MEMORY → CHANNEL here.
      // For end-to-end behavior we only need a non-empty array so route()
      // produces a real systemPromptLayers slot.
      return ["SOUL: hermes", "IDENTITY: test"];
    },
  };
}

function discordCtx(opts: Partial<DiscordContext> = {}): DiscordContext {
  return {
    botUserId: "999999999999999999",
    adminIds: [],
    workspace: tmpProj,
    channelIsThread: false,
    isDm: false,
    ...opts,
  };
}

describe("Discord end-to-end (envelope → router → runner)", () => {
  test("DM message: real adapter → router → runner → fake-claude reply", async () => {
    const event: DiscordMessageEvent = {
      id: "msg-001",
      channel_id: "dm-channel-aaa",
      author: { id: "111111111111111111", username: "alice", global_name: "Alice" },
      content: "ping",
    };
    const env = toEnvelope(event, discordCtx({ isDm: true }));
    expect(env.source).toBe("discord");
    expect(env.trigger).toBe("dm");

    const routed = route(env, buildRouteEnv());
    expect(routed.auth.allow).toBe(true);
    expect(routed.decision.sessionScope).toBe("per-user");
    expect(routed.decision.sessionKey).toContain("user:discord:111111111111111111");

    process.env.HERMES_FAKE_REPLY = "pong";
    process.env.HERMES_FAKE_SESSION_ID = "dm-session";
    const result = await runner.runUserMessage(
      "discord-dm",
      env.message.text,
      routed.decision.sessionKey,
      undefined,
      "discord"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("pong");

    const persisted = await sessionMgr.peekThreadSession("discord", routed.decision.sessionKey);
    expect(persisted?.sessionId).toBe("dm-session");
  });

  test("guild mention: per-channel-user scope, real auth allowed", async () => {
    const event: DiscordMessageEvent = {
      id: "msg-002",
      channel_id: "channel-bbb",
      guild_id: "guild-xyz",
      author: { id: "111111111111111111", username: "alice" },
      content: "<@999999999999999999> hello",
      mentions: [{ id: "999999999999999999" }],
    };
    const env = toEnvelope(event, discordCtx({ isDm: false }));
    expect(env.trigger).toBe("mention");
    // mention chunk stripped from content
    expect(env.message.text).toBe("hello");

    const routed = route(env, buildRouteEnv());
    expect(routed.auth.allow).toBe(true);
    expect(routed.decision.sessionScope).toBe("per-channel-user");
    expect(routed.decision.sessionKey).toMatch(
      /channel-user:discord:guild-xyz:channel-bbb:111111111111111111/
    );

    process.env.HERMES_FAKE_REPLY = "hi back";
    process.env.HERMES_FAKE_SESSION_ID = "guild-mention-session";
    const result = await runner.runUserMessage(
      "discord-mention",
      env.message.text,
      routed.decision.sessionKey
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi back");
  });

  test("listen channel: free-response policy autoresponds without a mention", async () => {
    const event: DiscordMessageEvent = {
      id: "msg-003",
      channel_id: "listen-channel-ccc",
      guild_id: "guild-xyz",
      author: { id: "111111111111111111", username: "alice" },
      content: "no mention here",
    };
    const env = toEnvelope(
      event,
      discordCtx({ isDm: false, channelMode: "listen", channelName: "listen-channel" })
    );
    expect(env.trigger).toBe("listen");

    const routed = route(env, buildRouteEnv());
    expect(routed.auth.allow).toBe(true);
  });

  test("unauthorised user: route returns deny, runner is never invoked", async () => {
    const event: DiscordMessageEvent = {
      id: "msg-004",
      channel_id: "dm-channel-rando",
      author: { id: "777-not-in-allowlist", username: "rando" },
      content: "let me in",
    };
    const env = toEnvelope(event, discordCtx({ isDm: true }));
    const routed = route(env, buildRouteEnv());
    expect(routed.auth.allow).toBe(false);
    expect(routed.auth.reason).toBe("user-not-in-allowlist");
    // Production must check `auth.allow` before calling runner; we simulate
    // that by simply NOT calling runner here and asserting state didn't
    // change (no new session for that key).
    const persisted = await sessionMgr.peekThreadSession("discord", routed.decision.sessionKey);
    expect(persisted).toBeNull();
  });

  test("thread message: per-thread session scope, isolated from parent channel", async () => {
    const event: DiscordMessageEvent = {
      id: "msg-005",
      channel_id: "thread-aaa-001",
      guild_id: "guild-xyz",
      author: { id: "111111111111111111", username: "alice" },
      content: "in a thread",
      mentions: [{ id: "999999999999999999" }],
    };
    const env = toEnvelope(event, discordCtx({ isDm: false, channelIsThread: true }));
    expect(env.thread).toBe("thread-aaa-001");

    const routeEnv: RouteEnv = {
      ...buildRouteEnv(),
      // Override policy to per-thread for this scenario (production threads
      // are still routed through per-channel-user by default — the per-thread
      // scope is opt-in via the SQLite policy table).
      policyFor() {
        return {
          sessionScope: "per-thread",
          allowedTools: "*",
          memoryScope: "channel",
        };
      },
    };
    const routed = route(env, routeEnv);
    expect(routed.decision.sessionScope).toBe("per-thread");
    expect(routed.decision.sessionKey).toBe("thread:discord:thread-aaa-001");

    process.env.HERMES_FAKE_REPLY = "thread-reply";
    process.env.HERMES_FAKE_SESSION_ID = "thread-session-A";
    const result = await runner.runUserMessage(
      "discord-thread",
      env.message.text,
      routed.decision.sessionKey,
      undefined,
      "discord"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("thread-reply");

    // Same thread, second message: should resume, not create new
    process.env.HERMES_FAKE_REPLY = "thread-reply-2";
    const result2 = await runner.runUserMessage(
      "discord-thread",
      "second turn",
      routed.decision.sessionKey,
      undefined,
      "discord"
    );
    expect(result2.exitCode).toBe(0);
    const persisted = await sessionMgr.peekThreadSession("discord", routed.decision.sessionKey);
    expect(persisted?.sessionId).toBe("thread-session-A"); // unchanged
    expect(persisted?.turnCount).toBe(1); // 1 resume after the initial create
  });

  test("DB-stored channel policy override wins over default", async () => {
    upsertPolicy(
      db,
      { source: "discord", guild: "guild-override", channel: "channel-override" },
      { sessionScope: "shared", allowedSkills: ["Read", "Grep"] }
    );

    const event: DiscordMessageEvent = {
      id: "msg-006",
      channel_id: "channel-override",
      guild_id: "guild-override",
      author: { id: "111111111111111111", username: "alice" },
      content: "<@999999999999999999> override test",
      mentions: [{ id: "999999999999999999" }],
    };
    const env = toEnvelope(event, discordCtx({ isDm: false }));
    const routed = route(env, buildRouteEnv());
    expect(routed.decision.sessionScope).toBe("shared");
    expect(routed.decision.allowedTools).toEqual(["Read", "Grep"]);
  });
});

describe("Discord legacy production path (matches commands/discord.ts:649)", () => {
  test("runUserMessage with thread id mirrors what handleMessageCreate calls", async () => {
    // This is the real shape of what discord.ts does today: it takes a
    // Discord channel id (which doubles as a thread id when knownThreads
    // contains it) and passes it as the threadId to runUserMessage. We're
    // calling that exact entry point here to prove the production path
    // works.
    process.env.HERMES_FAKE_REPLY = "legacy-discord-reply";
    process.env.HERMES_FAKE_SESSION_ID = "legacy-discord-session";
    const result = await runner.runUserMessage(
      "discord",
      "[Discord from alice]\nMessage: hi",
      "discord-thread-legacy-1",
      undefined,
      "discord"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("legacy-discord-reply");

    const persisted = await sessionMgr.peekThreadSession("discord", "discord-thread-legacy-1");
    expect(persisted?.sessionId).toBe("legacy-discord-session");
  });

  test("[react:emoji] tag is preserved in stdout for the discord adapter to strip", async () => {
    process.env.HERMES_FAKE_REPLY = "[react:thumbsup] roger";
    process.env.HERMES_FAKE_SESSION_ID = "react-tag-session";
    const result = await runner.runUserMessage(
      "discord",
      "[Discord from alice]\nMessage: ack me",
      "discord-thread-react-1"
    );
    expect(result.exitCode).toBe(0);
    // Runner should pass [react:...] through verbatim — it's the discord
    // adapter's job to extract & strip it. extractReactionDirective lives in
    // commands/discord.ts and is not exposed; we just confirm the tag
    // survives the runner.
    expect(result.stdout).toContain("[react:thumbsup]");
  });
});

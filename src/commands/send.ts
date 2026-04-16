import { initConfig, loadSettings } from "../config";
import { runUserMessage } from "../runner";
import { getSession } from "../sessions";

/**
 * Parse a `--to user_id` flag out of argv. Returns the ID string (without the
 * flag) or null if absent. Multiple `--to` values are not allowed — one
 * invocation, one recipient.
 */
function parseToFlag(args: string[]): { to: string | null; rest: string[] } {
  const rest: string[] = [];
  let to: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--to") {
      if (to !== null) {
        console.error("send: --to may only be given once");
        process.exit(1);
      }
      to = args[++i] ?? "";
      if (!to) {
        console.error("send: --to requires a user id");
        process.exit(1);
      }
      continue;
    }
    rest.push(args[i]);
  }
  return { to, rest };
}

export async function send(args: string[]) {
  const { to, rest } = parseToFlag(args);
  const telegramFlag = rest.includes("--telegram");
  const discordFlag = rest.includes("--discord");
  const message = rest
    .filter((a) => a !== "--telegram" && a !== "--discord")
    .join(" ");

  if (!message) {
    console.error(
      "Usage: claude-hermes send <message> [--telegram|--discord --to <user_id>]",
    );
    process.exit(1);
  }

  if (telegramFlag && discordFlag) {
    console.error(
      "send: pick one of --telegram or --discord, not both (use two invocations if you need both channels)",
    );
    process.exit(1);
  }

  const wantsChannel = telegramFlag || discordFlag;
  if (wantsChannel && !to) {
    console.error(
      "send: --to <user_id> is required when forwarding to a channel. "
        + "Broadcast-to-all was removed — targeting every allowed user with "
        + "one command is too dangerous.",
    );
    process.exit(1);
  }

  await initConfig();
  await loadSettings();

  const session = await getSession();
  if (!session) {
    console.error("No active session. Start the daemon first.");
    process.exit(1);
  }

  const result = await runUserMessage("send", message);
  console.log(result.stdout);

  if (!wantsChannel) {
    if (result.exitCode !== 0) process.exit(result.exitCode);
    return;
  }

  const settings = await loadSettings();
  const text = result.exitCode === 0
    ? result.stdout || "(empty)"
    : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

  if (telegramFlag) {
    const token = settings.telegram.token;
    if (!token) {
      console.error("Telegram token is not configured in settings.");
      process.exit(1);
    }
    if (!settings.telegram.allowedUserIds.includes(Number(to))) {
      console.error(
        `send: --to ${to} is not in telegram.allowedUserIds; add them to settings first.`,
      );
      process.exit(1);
    }
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: to, text }),
      },
    );
    if (!res.ok) {
      console.error(`Failed to send to Telegram user ${to}: ${res.statusText}`);
      process.exit(1);
    }
    console.log(`Sent to Telegram user ${to}.`);
  }

  if (discordFlag) {
    const dToken = settings.discord.token;
    if (!dToken) {
      console.error("Discord token is not configured in settings.");
      process.exit(1);
    }
    if (!settings.discord.allowedUserIds.includes(to!)) {
      console.error(
        `send: --to ${to} is not in discord.allowedUserIds; add them to settings first.`,
      );
      process.exit(1);
    }
    const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${dToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: to }),
    });
    if (!dmRes.ok) {
      console.error(`Failed to create DM for Discord user ${to}: ${dmRes.statusText}`);
      process.exit(1);
    }
    const { id: channelId } = (await dmRes.json()) as { id: string };
    const msgRes = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${dToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text.slice(0, 2000) }),
      },
    );
    if (!msgRes.ok) {
      console.error(`Failed to send to Discord user ${to}: ${msgRes.statusText}`);
      process.exit(1);
    }
    console.log(`Sent to Discord user ${to}.`);
  }

  if (result.exitCode !== 0) process.exit(result.exitCode);
}

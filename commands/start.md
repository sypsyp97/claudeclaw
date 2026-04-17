---
description: Start daemon mode or run one-shot prompt/trigger
---

Start the heartbeat daemon for this project.

**What this will do (tell the user first)**: walk them through a short setup — pick a model, optionally enable a recurring "heartbeat", optionally connect Telegram/Discord, and pick a security level — then launch a background daemon scoped to the current folder. Everything configured here is written to `.claude/hermes/settings.json` and can be edited later without restarting. If it's their very first run, the daemon itself will also print a welcome banner, a preflight health check, and seed two example files (`.claude/hermes/prompts/heartbeat.md`, `.claude/hermes/jobs/example.md`) to show the file shapes.

Follow these steps exactly:

1. **Block home-directory starts (CRITICAL, BLOCKER)**:
   - Run `pwd` and `echo "$HOME"`.
   - If `pwd` equals `$HOME`, STOP immediately.
   - Tell the user exactly:
     - "CRITICAL BLOCKER: For security reasons, close this session and start a new one from the folder you want to initialize Claude Hermes in."
   - Do not continue with any other step until they restart from a non-home project directory.

2. **Runtime checker (Bun + Node)**:
   - Run:
     ```bash
     which bun
     which node
     ```
   - If `bun` is missing:
     - Tell the user Bun is required and will be auto-installed.
     - Run:
       ```bash
       curl -fsSL https://bun.sh/install | bash
       ```
     - Then source the shell profile to make `bun` available in the current session:
       ```bash
       source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null || true
       ```
     - Verify again with `which bun`. If still not found, tell the user installation failed and to install manually from https://bun.sh, then exit.
     - Tell the user Bun was auto-installed successfully.
   - If `node` is missing:
     - Tell the user Node.js is required for the OGG converter helper.
     - Ask them to install Node.js LTS and rerun start, then exit.

3. **Check existing config**: Read `.claude/hermes/settings.json` (if it exists). Determine which sections are already configured:
   - **Heartbeat configured** = `heartbeat.enabled` is `true` AND `heartbeat.prompt` is non-empty
   - **Telegram configured** = `telegram.token` is non-empty
   - **Discord configured** = `discord.token` is non-empty
   - **Security configured** = `security.level` exists and is not `"moderate"` (the default), OR `security.allowedTools`/`security.disallowedTools` are non-empty

4. **Interactive setup — smart mode** (BEFORE launching the daemon):

   Before asking any questions, give the user a short orientation in one paragraph (2–3 sentences max): "I'll ask you a few quick questions to set this up. Everything is optional except the model, and you can change any answer later by editing `.claude/hermes/settings.json`. All your answers stay on your machine." Do not re-explain this later.

   **If ALL three sections are already configured**, show a summary of the current config and ask ONE question:

   Use AskUserQuestion:
   - "Your settings are already configured. Want to change anything?" (header: "Settings", options: "Keep current settings", "Reconfigure")

   If they choose "Keep current settings", skip to step 6 (first contact question).
   If they choose "Reconfigure", proceed to step 5 below as if nothing was configured.

   **If SOME sections are configured and others are not**, show the already-configured sections as a summary, then only ask about the unconfigured sections in step 5.

   **If NOTHING is configured** (fresh install), ask about all three sections in step 5.

5. **Ask setup questions**:

   Use **AskUserQuestion** to ask all unconfigured sections at once (up to 3 questions in one call):

   - **Model** (always ask if `model` is empty/unset): "Which Claude model should Claude Hermes use? Opus is most capable but costs more; Sonnet is a good balance; Haiku is cheapest/fastest; GLM requires a separate Zhipu API token." (header: "Model", options: "opus (Recommended)", "sonnet", "haiku", "glm")
   - **If heartbeat is NOT configured**: "Enable heartbeat? The daemon will wake itself up on a fixed interval and run a prompt you write (e.g. 'review git status', 'check open PRs', 'remind me to drink water'). You can skip this and turn it on later." (header: "Heartbeat", options: "Yes", "No — skip for now")
   - **If Telegram is NOT configured**: "Configure Telegram? This lets you chat with the daemon from your phone via your own bot. You'll need a token from @BotFather (takes ~30 seconds)." (header: "Telegram", options: "Yes", "No — skip for now")
   - **If Discord is NOT configured**: "Configure Discord? Connects the daemon to DMs and channels you invite the bot to. You'll need a token from discord.com/developers (takes ~1 minute)." (header: "Discord", options: "Yes", "No — skip for now")
   - **If security is NOT configured**: "What security level for Claude? This controls which tools the daemon is allowed to use without asking. You can change it any time by editing settings.json." (header: "Security", options:
     - "Moderate (Recommended)" (description: "Full tool access, scoped to this project folder — good default for dev work")
     - "Locked" (description: "Read-only — Read/Grep/Glob only. No edits, no Bash, no web. Safest for exploration.")
     - "Strict" (description: "Can edit files but no Bash, no web. Middle ground.")
     - "Unrestricted" (description: "Full access with NO directory scoping — only pick this if you know why you need it."))

   Then, based on their answers:

   - **Model**: Set `model` in settings to their choice (e.g. `"opus"`, `"sonnet"`, `"haiku"`, `"glm"`). Default is `"opus"` if they don't pick.
   - **If model is `glm`**: Ask in normal free-form text for API token and set top-level `api` to that value (optional; user can skip). Only ask this token question when the selected model is `glm`.

   - **Agentic mode**: Use AskUserQuestion to ask:
     - "Enable agentic model routing? This automatically selects models based on task type using configurable modes." (header: "Agentic", options: "Yes — default modes (Recommended)", "No — use single model")
     - If "Yes": Set `agentic.enabled` to `true` with default modes (planning→opus, implementation→sonnet). The user can customize modes later via `/config`.
     - If "No": Set `agentic.enabled` to `false`.
   - Ask whether to set a fallback model. Recommend `glm` first so fallback uses a different provider path than the primary Claude model. If yes, set `fallback.model` and optionally `fallback.api`.
   - Ask whether to enable GLM fallback (kicks in automatically when your Claude token limit is hit). The fallback model is always `glm` — no other model is supported. Use AskUserQuestion: "Enable GLM fallback? Automatically switches to GLM when your Claude limit is hit." (header: "Fallback", options: "Yes — enable GLM fallback", "Skip"). If yes, ask in normal free-form text for the GLM API token (optional, user can skip). Set `fallback.model` to `"glm"` and `fallback.api` to the token if provided.

   - **If yes to heartbeat**: Use AskUserQuestion again with one question:
     - "How often should it run in minutes?" (header: "Interval", options: "5", "15", "30 (Recommended)", "60")
     - Set `heartbeat.enabled` to `true` and `heartbeat.interval` to their answer.
     - Ask for timezone as simple UTC offset text (example: `UTC+1`, `UTC-5`, `UTC+03:30`) and set top-level `timezone`.
   - **If heartbeat is no but `timezone` is missing**: set top-level `timezone` to `UTC+0`.

   - **If yes to Telegram**: Do NOT use AskUserQuestion for Telegram fields. Ask in normal free-form text for two values (both optional, user can skip either):
     - Telegram bot token (hint: create/get it from `@BotFather`)
     - Allowed Telegram user IDs (hint: use `@userinfobot` to get your numeric ID)
     - Set `telegram.token` and `telegram.allowedUserIds` (as array of numbers) accordingly.
     - Note: Telegram bot runs in-process with the daemon. All components (heartbeat, cron, telegram, discord) share one Claude session.

   - **If yes to Discord**: Do NOT use AskUserQuestion for Discord fields. Ask in normal free-form text for two values (both optional, user can skip either):
     - Discord bot token (hint: create a bot at https://discord.com/developers/applications → Bot → Token. Enable **Message Content Intent** under Privileged Gateway Intents.)
     - Allowed Discord user IDs (hint: enable Developer Mode in Discord settings → right-click your profile → Copy User ID). These are large numbers — they will be stored as strings.
     - Set `discord.token` and `discord.allowedUserIds` (as array of strings) accordingly.
     - Listen channel IDs (optional — hint: right-click a channel in Discord with Developer Mode enabled → Copy Channel ID). Channels where the bot responds to all messages without requiring an @mention.
     - Set `discord.listenChannels` (as array of strings) accordingly.
     - Note: Discord bot connects via WebSocket gateway in-process with the daemon. It supports DMs, guild mentions/replies, slash commands (/start, /reset), voice messages, and image attachments. `discord.allowedUserIds` is an allowlist that applies to messages, slash commands, and button interactions.

   - **Security level mapping** — set `security.level` in settings based on their choice:
     - "Locked" → `"locked"`
     - "Strict" → `"strict"`
     - "Moderate" → `"moderate"`
     - "Unrestricted" → `"unrestricted"`

   - **If security is "Strict" or "Locked"**: Use AskUserQuestion to ask:
     - "Allow any specific tools on top of the security level? (e.g. Bash(git:*) to allow only git commands)" (header: "Allow tools", options: "None — use level defaults (Recommended)", "Bash(git:*) — git only", "Bash(git:*) Bash(npm:*) — git + npm")
     - If they pick an option with tools or type custom ones, set `security.allowedTools` to the list.

   Update `.claude/hermes/settings.json` with their answers.

   After writing settings, tell the user — in one short paragraph — what will happen next: "Launching the daemon now. On first run it prints a welcome banner, a preflight health check (claude CLI, node, git repo, writable `.claude/hermes`), and seeds two example files (`prompts/heartbeat.md` and `jobs/example.md`) so you can see the file shapes. After that the daemon stays running in the background — check the log at `.claude/hermes/logs/daemon.log` if anything looks off."

6. **Launch/start action**:
   ```bash
   mkdir -p .claude/hermes/logs && nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts start > .claude/hermes/logs/daemon.log 2>&1 & echo $!
   ```
   Use the description "Starting Claude Hermes daemon" for this command.
   Wait 1 second, then check `cat .claude/hermes/logs/daemon.log`. If it contains "Aborted: daemon already running", tell the user and exit.

7. **Capture session ID**: Read `.claude/hermes/session.json` and extract the `sessionId` field. This is the shared Claude session used by the daemon for heartbeat, jobs, Telegram, and Discord.

8. **Report**: Print the ASCII art below then show the PID, session, and status info plus the Telegram/Discord next-step guidance.

CRITICAL: Output the banner block below EXACTLY as-is inside a markdown code block. Do NOT re-indent, re-align, or adjust ANY whitespace. Copy every character verbatim. Only replace `<PID>` and `<WORKING_DIR>` with actual values.

```
═══════ ⚡ Claude Hermes ⚡ ═══════
```

# HELLO, I AM YOUR CLAUDE HERMES!
**Daemon is running! PID: \<PID> | Dir: \<WORKING_DIR>**

```
/claude-hermes:status  - check status
/claude-hermes:stop    - stop daemon
/claude-hermes:clear   - back up session & restart fresh
/claude-hermes:config  - show config
```

**To start chatting on Telegram**
Go to your bot, send `/start`, and start talking.

**To start chatting on Discord**
DM your bot directly — no server invite needed: `https://discord.com/users/<DISCORD_BOT_ID>`
Or mention it in any server it's in. Use `/start` and `/reset` slash commands.
To get `<DISCORD_BOT_ID>`: read the daemon log for the bot's user ID (shown in the "Ready as <name> (<ID>)" line).

**To talk to your agent directly on Claude Code**
`cd <WORKING_DIR> && claude --resume <SESSION_ID>`

---

## Reference: File Formats

### Settings — `.claude/hermes/settings.json`
```json
{
  "model": "opus",
  "api": "",
  "fallback": {
    "model": "glm",
    "api": ""
  },
  "agentic": {
    "enabled": true,
    "defaultMode": "implementation",
    "modes": [
      {
        "name": "planning",
        "model": "opus",
        "keywords": ["plan", "design", "architect", "research", "analyze", "think", "evaluate", "review"],
        "phrases": ["how should i", "what's the best way to", "help me decide"]
      },
      {
        "name": "implementation",
        "model": "sonnet",
        "keywords": ["implement", "code", "write", "fix", "deploy", "test", "commit"]
      }
    ]
  },
  "timezone": "UTC+0",
  "heartbeat": {
    "enabled": true,
    "interval": 15,
    "prompt": "Check git status and summarize recent changes."
    // OR use a file path:
    // "prompt": "prompts/heartbeat.md"
  },
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowedUserIds": [123456789]
  },
  "discord": {
    "token": "MTIz...",
    "allowedUserIds": ["123456789012345678"],
    "listenChannels": ["987654321098765432"]
  },
  "security": {
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": []
  }
}
```
- `model` — Claude model to use (`opus`, `sonnet`, `haiku`, `glm`, or full model ID). Empty string uses default. Ignored when `agentic.enabled` is true.
- `api` — API token used when `model` is `glm` (passed as `ANTHROPIC_AUTH_TOKEN` for that provider path).
- `fallback.model` — backup model used automatically if the primary run returns a rate-limit message. Prefer `glm` for provider diversity.
- `fallback.api` — optional API token to use with `fallback.model`.
- `agentic.enabled` — when true, automatically routes tasks to appropriate models based on task type
- `agentic.defaultMode` — which mode to use when no keywords match (default: `"implementation"`)
- `agentic.modes` — array of routing modes, each with: `name` (string), `model` (string), `keywords` (string[]), optional `phrases` (string[], checked before keywords with higher priority). Old `planningModel`/`implementationModel` format is auto-converted.
- `timezone` — canonical app timezone as UTC offset text (example: `UTC+1`, `UTC-5`, `UTC+03:30`). Heartbeat windows, jobs, and UI all use this timezone.
- `heartbeat.enabled` — whether the recurring heartbeat runs
- `heartbeat.interval` — minutes between heartbeat runs
- `heartbeat.prompt` — the prompt sent to Claude on each heartbeat. Can be an inline string or a file path ending in `.md`, `.txt`, or `.prompt` (relative to project root). File contents are re-read on each tick, so edits take effect without restarting the daemon.
- Heartbeat template override (optional) — create `.claude/hermes/prompts/HEARTBEAT.md` to replace the built-in heartbeat template for this project.
- `telegram.token` — Telegram bot token from @BotFather
- `telegram.allowedUserIds` — array of numeric Telegram user IDs allowed to interact
- `discord.token` — Discord bot token from the Developer Portal
- `discord.allowedUserIds` — array of string Discord user IDs (snowflakes) allowed to interact
- `discord.listenChannels` — array of string channel IDs where the bot responds to all messages without requiring an @mention
- `security.level` — one of: `locked`, `strict`, `moderate`, `unrestricted`
- `security.allowedTools` — extra tools to allow on top of the level (e.g. `["Bash(git:*)"]`)
- `security.disallowedTools` — tools to block on top of the level

### Security Levels
All levels run without permission prompts (headless). Security is enforced via tool restrictions and project-directory scoping.

| Level | Tools available | Directory scoped |
|-------|----------------|-----------------|
| `locked` | Read, Grep, Glob only | Yes — project dir only |
| `strict` | Everything except Bash, WebSearch, WebFetch | Yes — project dir only |
| `moderate` | All tools | Yes — project dir only |
| `unrestricted` | All tools | No — full system access |

### Jobs — `.claude/hermes/jobs/<name>.md`
Jobs are markdown files with cron schedule frontmatter and a prompt body:
```markdown
---
schedule: "0 9 * * *"
---
Your prompt here. Claude will run this at the scheduled time.
```
- Schedule uses standard cron syntax: `minute hour day-of-month month day-of-week`
- **Timezone-aware**: cron times are evaluated in the configured `timezone`. E.g. `0 9 * * *` with `timezone: "UTC+2"` fires at 9:00 AM local time.
- The filename (without `.md`) becomes the job name
- Jobs are loaded at daemon startup from `.claude/hermes/jobs/`

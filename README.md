# Claude Hermes

> **Fork of [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw).** Rebuilt around a SQLite state engine, an envelope-based router, an auto-promoting skills pipeline, and a human-triggered, verify-gated self-evolution loop. The Telegram and Discord bridges are the only interfaces — no web dashboard.

> 🇨🇳 [中文 README](README.zh.md)

Claude Hermes turns your Claude Code into a personal assistant that never sleeps. It runs as a background daemon, executes tasks on a schedule, responds on Telegram and Discord, transcribes voice commands, and learns new skills from your usage.

## Why Hermes (vs. the Claw fork it grew out of)

| | Hermes | Claw |
| --- | --- | --- |
| Storage | `bun:sqlite` + FTS5, single `state.db` | flat JSON files |
| Sessions | scope-based router (`dm`, `per-channel-user`, `per-thread`, `shared`, `workspace`) | global + per-thread overrides |
| Skills | candidate → active with a rollback window (`shadow` on regression) | manual install only |
| Self-evolution | human-triggered, verify-gated: auto-commits on green, reverts on red | none |
| Model routing | agentic mode picks Opus for planning / Sonnet for implementation per message | single-model |
| Web dashboard | removed — talk to the daemon via Telegram/Discord/CLI | yes |
| Verify pipeline | typecheck + lint + unit + smoke + integration, all five must be green | manual |

## Install

Easiest path — install from the Claude Code plugin marketplace. Inside any Claude Code session, run:

```
/plugin marketplace add sypsyp97/claude-hermes
/plugin install claude-hermes@claude-hermes
/claude-hermes:start
```

The setup wizard walks you through model, heartbeat, Telegram, Discord, and security; the daemon then runs in the background. Bun is the only runtime dependency — `start` will offer to install it for you if it's missing.

If you previously ran the upstream Claw daemon in this workspace, the first `start` migrates `.claude/claudeclaw/` → `.claude/hermes/` once and then leaves the legacy directory untouched as a safety net.

### Develop from source

```bash
git clone https://github.com/sypsyp97/claude-hermes.git
cd claude-hermes
bun install
bun run verify
```

Then point Claude Code at the working tree:

```
/plugin marketplace add /absolute/path/to/claude-hermes
/plugin install claude-hermes@claude-hermes
```

## Features

### Automation
- **Heartbeat:** periodic check-ins with configurable intervals, quiet hours, and editable prompts. The heartbeat prompt can be an inline string or a file path; edits take effect without restarting the daemon.
- **Cron jobs:** timezone-aware schedules for repeating or one-time tasks. Job files hot-reload every 30s — no daemon restart needed.
- **Scaffolder (`/claude-hermes:new`):** `new job <name>`, `new skill <name>`, or `new prompt <name>` writes a template file with sensible frontmatter so you don't hand-craft YAML. Runs as a CLI too: `bun run src/index.ts new job my-job --schedule "0 9 * * *"`.
- **Self-evolution (`bun run scripts/evolve.ts`):** opt-in local tool that takes a task body (CLI arg or stdin or Discord/Telegram message), asks your local Claude to implement it, runs the full verify pipeline, and commits on green / `git restore`s on red. Small-step, verify-gated, journal-everything discipline. Human-triggered, not a cron — the verify gate is the safety net.

### Communication
- **Telegram:** text, image, and voice (whisper.cpp or any OpenAI-compatible STT endpoint).
- **Discord:** DMs, server mentions/replies, slash commands (`/start`, `/reset`), voice messages, image attachments, and reaction feedback.
- **Time-aware messages:** prefixes help the agent reason about delays and daily patterns.
- **Real-time status sinks:** task progress is streamed back to whoever triggered it — Discord reactions, Telegram typing indicators, or terminal lines — so long-running `evolve` runs or heartbeat turns aren't silent.

### Discord channel policies
The daemon auto-routes channels by name:
- **`listen-*` / `ask-*`** — free-response mode; the bot replies without needing an @mention.
- **`deliver-*`** — delivery-only, no interactive replies (use for broadcasts).
- **Server channels** — default: per-channel-user memory, reply on mention/reply only.
- **DMs** — default: per-user memory, reply to every message.
- **Manual override:** per-channel `channel_policies` rows in SQLite win over the name-based default.

### Multi-session threads (Discord)
- **Independent thread sessions:** each Discord thread gets its own Claude CLI session.
- **Parallel processing:** messages in different threads don't block each other.
- **Auto-create:** the first message in a new thread bootstraps a fresh session.
- **Cleanup:** thread sessions are dropped when the thread is deleted or archived.
- **Backwards-compatible:** DMs and main-channel messages keep using the global session.

See [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md) for the routing details.

### Reliability and control
- **Agentic model routing:** classify each turn as `planning` (→ Opus) or `implementation` (→ Sonnet) by keyword/phrase. Modes are fully configurable in `settings.json`; disable to pin a single model.
- **Model fallback:** if the primary model hits a rate limit, automatically retry on a backup model (prefer GLM for provider diversity).
- **Security levels:** four tool-access tiers, all headless (no permission prompts):
  - `locked` → `Read`, `Grep`, `Glob` only; scoped to project dir.
  - `strict` → everything except `Bash`, `WebSearch`, `WebFetch`; scoped to project dir.
  - `moderate` → all tools; scoped to project dir.
  - `unrestricted` → all tools, no directory scoping.
- **Skill auto-promotion:** after ≥20 runs in a 7-day window with ≥85% success rate, a candidate skill is promoted to `active`. If success drops below 70% in the rollback window after promotion, it demotes back to `shadow`. Thresholds live in `src/learning/config.ts` and are tunable.
- **Crash-safe daemon registry:** `~/.claude/hermes/daemons.json` uses atomic tmp-write + rename, so a SIGKILL mid-write can't wipe the registry.
- **Parent-daemon protection:** `/stop`, `/stop-all`, and `/clear` invoked from inside a daemon's own Claude child never kill the daemon that's running them.
- **Rate-limit retries:** Discord reaction PUTs go through a shared `discordApi` helper that honors `Retry-After` on 429s instead of silently dropping.

## Verify pipeline

`bun run verify` runs five stages and any failure is fatal:

```
typecheck → lint → unit → smoke → integration
```

The self-evolution loop only commits a change if all five are green; otherwise it `git restore`s and starts a fresh journal entry. Use `bun run verify --fast` for the inner loop (typecheck + unit).

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src tests scripts
bun run fmt         # biome format --write
bun test src        # unit tests
bun test tests/smoke
bun test tests/integration
```

## Acknowledgements

The Telegram bridge, Discord bridge, voice transcription, and the original cron/heartbeat scaffolding all come from [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw). The skills loop borrows its evolutionary cadence from [yologdev/yoyo-evolve](https://github.com/yologdev/yoyo-evolve).

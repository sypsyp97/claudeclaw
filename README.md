# Claude Hermes

> **Fork of [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw).** Rebuilt around a SQLite state engine, an envelope-based router, an auto-promoting skills pipeline, and a yoyo-style self-evolution loop. The Telegram and Discord bridges are the only interfaces — no web dashboard.

Claude Hermes turns your Claude Code into a personal assistant that never sleeps. It runs as a background daemon, executes tasks on a schedule, responds on Telegram and Discord, transcribes voice commands, and learns new skills from your usage.

## Why Hermes (vs. the Claw fork it grew out of)

| | Hermes | Claw |
| --- | --- | --- |
| Storage | `bun:sqlite` + FTS5, single `state.db` | flat JSON files |
| Sessions | scope-based router (`dm`, `per-channel-user`, `per-thread`, `shared`, `workspace`) | global + per-thread overrides |
| Skills | candidate → shadow → active with rollback window | manual install only |
| Self-evolution | 8h cron reads its own source, edits, runs `bun run verify`, commits on green | none |
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
- **Heartbeat:** periodic check-ins with configurable intervals, quiet hours, and editable prompts.
- **Cron jobs:** timezone-aware schedules for repeating or one-time tasks.
- **Self-evolution:** an 8h GitHub Actions cron reads its own source, asks Claude for one small improvement, runs the full verify pipeline, and commits on green / reverts on red.

### Communication
- **Telegram:** text, image, and voice (whisper.cpp or any OpenAI-compatible STT endpoint).
- **Discord:** DMs, server mentions/replies, slash commands, voice messages, attachments.
- **Time-aware messages:** prefixes help the agent reason about delays and daily patterns.

### Multi-session threads (Discord)
- **Independent thread sessions:** each Discord thread gets its own Claude CLI session.
- **Parallel processing:** messages in different threads don't block each other.
- **Auto-create:** the first message in a new thread bootstraps a fresh session.
- **Cleanup:** thread sessions are dropped when the thread is deleted or archived.
- **Backwards-compatible:** DMs and main-channel messages keep using the global session.

See [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md) for the routing details.

### Reliability and control
- **Model fallback:** automatically continue with a fallback model if the primary hits a limit.
- **Security levels:** four tool-access tiers from `locked` to `unrestricted`.
- **Skill auto-promotion:** repeated successful uses of a candidate skill promote it to active; a regression in the rollback window demotes it back to shadow.

## Verify pipeline

`bun run verify` runs five stages and any failure is fatal:

```
typecheck → lint → unit → smoke → integration
```

The self-evolution loop will only commit a change if all five are green; otherwise it `git restore`s and starts a fresh journal entry.

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

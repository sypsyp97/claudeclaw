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
- **Evolve safety guards:** the self-edit subagent's system prompt is always prefixed with hard rules — no `git stash`, no branch switching, no `--no-verify`, no force push, no writes outside the cwd. The guards live in `prompts/EVOLVE_GUARDS.md` with a conservative inline fallback so they can never go silent.
- **Crash-safe daemon registry:** `~/.claude/hermes/daemons.json` uses atomic tmp-write + rename, so a SIGKILL mid-write can't wipe the registry.
- **Parent-daemon protection:** `/stop`, `/stop-all`, and `/clear` invoked from inside a daemon's own Claude child never kill the daemon that's running them.
- **Rate-limit retries:** Discord reaction PUTs go through a shared `discordApi` helper that honors `Retry-After` on 429s instead of silently dropping.

## Memory system

The memory layer is split into three tiers, ordered from most to least stable:

**1. Identity (markdown, human-editable, cache-friendly prefix)**
- `prompts/{IDENTITY,USER,SOUL}.md` — repo-level templates, committed to git.
- `CLAUDE.md` at the project root — per-project instructions.
- `.claude/hermes/memory/{SOUL,IDENTITY,USER}.md` — per-workspace overrides.

These form the stable head of every `--append-system-prompt` and are meant to stay byte-identical across turns so the CLI's prompt cache hits. See [design notes in `src/memory/compose.ts`](src/memory/compose.ts) for the sanitization rules (ISO-timestamp markers in `MEMORY.md` are stripped; oldest entries get head-trimmed when over a byte cap; nothing volatile leaks into the prefix).

**2. Episodic state (SQLite, append-only, FTS-indexed)**
- `state.db` → `messages` table, populated on every successful turn by `persistTurn`. Each row carries `importance` (1–10, set by a heuristic: user=6, assistant=5, tool=3, system=4, +2 per occurrence of `remember`/`todo`/`?`, clamped at 10), `last_access`, and `digested_at`.
- FTS5 virtual tables: `messages_fts` for cross-session search, `skill_descriptions_fts` for retrieval over skill docs.
- Park-style scoring (`α·recency + β·importance + γ·relevance`, with `recency = exp(-h/24)`) lives in `src/memory/scoring.ts`; `searchWithScoring` returns ranked hits.

**3. Primitives (now wired into the runtime, but always opt-in or human-gated)**
- **Letta-style blocks** (`src/memory/blocks.ts`) — labeled slots (`persona`, `human`, `project`, `channel:<id>`) with hard char budgets; over-budget writes throw rather than silently truncate. Every block under `.claude/hermes/memory/blocks/` is loaded by the runner on each turn and emitted into the system prompt as `<block:NAME>…</block>` framing in stable alphabetical order — the spawned agent sees them every spawn.
- **Anthropic `memory_20250818` six-op API** (`src/memory/agent-memory.ts`) — `view / create / strReplace / insert / del / rename`, all scoped to `.claude/hermes/memory/agent/`. Path traversal is rejected by a single gatekeeper. The composer appends a hint paragraph to every prompt so the agent knows the scratchpad exists and which ops are available; `dispatchAgentMemory` (in `agent-memory-dispatch.ts`) flattens the six ops to a single JSON-shape entry point with `{ ok, result?, error? }` semantics.
- **Honcho-style Dream cron** (`src/memory/dream.ts`, `src/memory/dream-scheduler.ts`) — `runDream` digests messages older than `ageDays` into per-session summaries, dedupes `MEMORY.md` entries keeping the newest, marks contradicting entries with `<!-- invalidated -->` (never deletes). The daemon's 60s cron tick calls `maybeRunDream` on every pass; rate-limited by `dreamIntervalHours` (default 24h, persisted in the `kv` table so it survives restarts). Opt in via `settings.memory.dreamCron` (default false). Idempotent, heuristic-only, no LLM calls.
- **Voyager-style skill library** (`src/skills/library.ts`) — skills live as `<name>/{SKILL.md, description.txt, trajectory.jsonl}` under `.claude/hermes/skills/`; FTS5 over `description.txt` for retrieval; writes are gated by the validator in `src/skills/validate.ts`. Active rows are mirrored into `.claude/skills/hermes_<name>/` by `syncActiveSkills` (`src/skills/bridge.ts`) so Claude Code's built-in discovery picks them up; non-active rows stay invisible.
- **Closed-learning-loop primitives** (`src/learning/closed-loop.ts`) — `proposeSkillFromTrajectory` turns a `(prompt, reply, tools)` trace into a candidate manifest, then `promoteIfVerified` moves it `candidate → shadow` only when a caller-supplied `runVerify()` gate returns green. The runner now feeds every successful turn into `captureCandidateSkill` (`src/learning/completion-hook.ts`) which **stops at `candidate`**: the row is written to disk + DB but never auto-promoted to shadow or active. Promotion stays a human action. Opt in via `settings.learning.captureCandidateSkills` (default false); existing shadow / active rows are never clobbered by re-capture.

### What actually happens each turn today

1. `execClaude` composes the appended system prompt: `"You are running inside Claude Hermes."` + repo templates + project `CLAUDE.md` + runtime memory via `composeSystemPrompt({memoryScope: "workspace", blocks: readAllBlocks(), includeAgentMemoryHint: true})` (which sanitizes + tail-truncates MEMORY.md, emits all blocks alphabetically, and appends the agent-memory hint) + directory scope guard.
2. Claude runs, streams events to the sink (Discord/Telegram/terminal status).
3. On `exitCode === 0`, `persistTurn` upserts the session row and appends user + assistant messages to `messages` (with heuristic importance, FTS5 index auto-updated).
4. If `settings.learning.captureCandidateSkills` is on, the runner fires `captureCandidateSkill` in the background — non-trivial trajectories land as a `candidate` row + Voyager files, no auto-promotion.
5. The 60s daemon cron tick calls `maybeRunDream` (gated by `settings.memory.dreamCron`) and `syncActiveSkills` so digests stay current and human-promoted skills surface to the spawned agent without a daemon restart.
6. Any persistence / sidecar error is swallowed — the reply is returned regardless.

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

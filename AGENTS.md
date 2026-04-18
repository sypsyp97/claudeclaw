# AGENTS.md — orientation for autonomous AI agents

This file is for AI agents (Claude Code, autonomous evolve loops, third-party
SDK agents) working in this repo. Humans should read README.md instead.

## Quickstart

1. Read `CLAUDE.md` for project identity, persona, and behavioural rules.
2. Make your changes.
3. Run `bun run verify` — must exit 0 before you commit.
4. Commit with a meaningful message; push to a branch or main.
5. CI re-runs verify across (ubuntu, macos) × (bun 1.3.4, latest). All four
   legs must stay green.

## The verify pipeline

`bun run verify` is the single source of truth for "is this commit shippable".
It runs five steps in order, fails fast on the first red:

| step | command | what it catches |
|------|---------|-----------------|
| typecheck | `tsc --noEmit` | TS type errors |
| lint | `biome check src tests scripts` | style + safety lints |
| unit | `bun test src` | per-module behaviour |
| smoke | `bun test tests/smoke` | end-to-end CLI / daemon boot / install contract |
| integration | `bun test tests/integration` | router → runner with fake-claude |

**Machine-readable output:** `bun run verify --json` emits a JSON envelope
with per-step exitCode + stdoutTail/stderrTail. Parse this, don't scrape
the human log.

**Faster inner loop:** `bun run verify:fast` runs only typecheck + unit
(~8 s). Use this between edits; run full verify before every push.

## Cutting a release

`bun run release <version>` — bumps `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json` (plugins[0].version), and `package.json`
in one shot, then runs verify, commits, tags `v<version>`, pushes main + tag,
and creates a GitHub release. Flags: `--dry-run`, `--no-push`, `--no-release`,
`--notes-file=<path>`. The `plugin.json` version is what Claude Code's plugin
loader uses to invalidate its cache — old users only see updates when it
bumps.

## Test conventions

- Unit tests live next to their source: `foo.ts` → `foo.test.ts`.
- Smoke tests spawn real subprocesses — they go in `tests/smoke/`.
- Integration tests cross multiple modules (router + runner + state) — they
  go in `tests/integration/`.
- Tests are isolated via `mkdtemp` + cleanup, never against shared state.
- The Claude CLI is mocked via `tests/fixtures/fake-claude.ts`; set
  `HERMES_CLAUDE_BIN="bun run /abs/path/to/fake-claude.ts"` in your env.
- Skip the background plugin installer with `HERMES_SKIP_PREFLIGHT=1`.

## Hard rules — do not cross these

1. **Never commit a red verify.** Run `bun run verify:fast` before every
   commit; the evolve loop reverts commits that fail full verify on main.
2. **Never delete `LEGACY_*` constants in `src/paths.ts`.** Old users coming
   from `claudeclaw` rely on the migration path. Tests in
   `src/paths.test.ts` pin this; if you have to change them, talk to a human.
3. **Never write code that calls `os.homedir()` and expects `$HOME` to
   override it.** Bun on Linux ignores `$HOME` in some setups. Functions
   that need a configurable home must accept an explicit `roots.home` arg
   (see `discoverSkills`, `listSkills` for the pattern).
4. **Never serialise concurrent writes to a shared file via
   read-modify-write.** Use the in-process mutex pattern from
   `src/evolve/journal.ts:journalLocks`.

## Where things live

- `src/index.ts` — CLI dispatcher (start / status / send / --stop / --clear)
- `src/commands/` — one file per CLI subcommand
- `src/runner.ts` — the per-thread queue + Claude CLI wrapper
- `src/state/` — SQLite schema + migrations + repos
- `src/skills/` — discovery + registry + (in `learning/`) auto-promotion
- `src/evolve/` — the self-evolution loop
- `src/migrate/legacy.ts` — one-shot migrator from `.claude/claudeclaw/`
- `tests/fixtures/fake-claude.ts` — drop-in replacement for the real CLI
- `scripts/verify.ts` — the harness; emits structured JSON
- `commands/*.md` — Claude Code slash command definitions for end users

## Maintenance discipline (the "evolve" framework)

`bun run scripts/evolve.ts "<task body>"` (or pipe the body on stdin) runs
**one** maintenance iteration locally:

1. Takes the task body you handed it — no file inbox, no GitHub issue
   scraper. Hermes already talks to you directly (Discord/Telegram/terminal);
   whoever has the user's intent just hands it in.
2. Spawns Claude (your local logged-in CLI) with a self-edit prompt.
3. Runs full `bun run verify`.
4. **On green:** commits with a structured message + writes a journal entry.
   **On red:** reverts the working tree + writes the failure to the journal.

This is **opt-in and human-triggered**. There is intentionally no background
cron (no `.github/workflows/evolve.yml`, no daemon job). You — or another
agent at your direction — invoke it when you want a task moved forward.

If you ARE that agent, the contract is the same as the framework's:
- One task per iteration. Don't bundle.
- Don't suppress verify. Don't `--no-verify`. Don't disable a failing test.
- The journal at `.claude/hermes/memory/journal/<date>.md` is your audit
  trail — readers (humans or future you) reconstruct what happened from it.
- If three consecutive iterations on the same task revert, escalate to a
  human before retrying.

## When you get stuck

- `bun run verify --json | jq .results[]` shows you which step failed and
  the last 20 lines of stdout/stderr.
- `bun test path/to/specific.test.ts` runs one file in isolation.
- `cat .claude/hermes/memory/journal/*.md` shows what past evolve runs
  attempted and why they reverted.
- Read the SKILL.md files in `~/.claude/skills/` for reusable agent-side
  skills the project expects.

## Changing this file

This file is part of the agent contract. Treat changes here like API breaks:
update both the file and the smoke test that pins its existence
(`tests/smoke/plugin-contract.test.ts`).

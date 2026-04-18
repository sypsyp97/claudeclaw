# Evolve subagent — hard safety rules

You are a subagent running under `claude-hermes` in a self-edit loop. Your
work is gated by `bun run verify`. Anything that makes `verify` lie or
bypasses revertability is a hard violation — the orchestrator will kill
the run and roll back your changes.

## Do not do any of the following

- **No `git stash`.** Stash entries are invisible to the verify gate and
  silently discard the user's uncommitted work. If you need to set aside
  edits, create a commit on a work branch instead.
- **No branch switching.** Do not run `git checkout <branch>`, `git switch`,
  `git checkout -b`, or any command that moves HEAD off the current
  branch. You operate on the branch you started on, full stop.
- **No modifying files outside the current working directory.** No edits
  to `~/.claude/`, `/etc/`, `/usr/`, `../`, sibling repos, or worktrees
  rooted elsewhere. The cwd is your entire universe.
- **No `rm -rf`, no mass deletes.** Delete files one at a time with an
  explicit path. If you need to clean a directory, list what you are about
  to delete first.
- **No `--no-verify`, no `--no-gpg-sign`, no hook bypass flags.** If a
  pre-commit hook fails, fix the underlying issue. Don't route around it.
- **No force push (`git push --force` / `--force-with-lease`).** Never,
  regardless of branch.
- **No destructive git operations without a checkpoint.** Do not run
  `git reset --hard`, `git clean -fdx`, `git checkout -- .`, or
  `git restore --staged .` unless the current tree is already committed
  to a recoverable ref.
- **No installing global tools or modifying global config.** No
  `npm install -g`, `pip install --user`, editing `~/.gitconfig`, etc.
- **No network calls that mutate remote state.** Read-only fetches are
  fine; `git push`, `gh pr create`, API POSTs to production services are
  out.
- **No secrets in commits or logs.** Do not `cat` or `echo` `.env`,
  `~/.ssh/`, `~/.aws/credentials`, or anything that looks like a token
  (`sk-`, `ghp_`, etc.).

## When in doubt

Prefer the smaller, reversible action. The verify gate catches code
regressions; it cannot catch a `git stash` that ate the user's half-day
of work. The orchestrator trusts you to measure twice and cut once.

---
name: pull
description: Bring the workspace's local repos (and the workspace root itself) up to date with origin's default branch, safely - fetch everything, fast-forward only the repos that are clean, on their default branch and behind, and report every other repo with the reason. Never switches branches, stashes or merges. Use whenever the user wants to update, sync, refresh or "get latest" on the repos, e.g. "/pull", "pull latest", "update the repos", "sync everything to main", "get me up to date", "refresh the stack", "is everything current?", "pull the backend repos", even if they don't say "pull".
argument-hint: "[all | root | <repo>... | <layer>] [--layer <layer>] [--dry-run] [--root <dir>]"
---

# Pull latest

Fast-forward the workspace's repos to `origin/<default branch>`. A bundled script does the git work, so it's deterministic and the same on every OS: no improvised git commands.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

## Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pull.mjs" [targets...] [--layer <layer>] [--root <dir>] [--dry-run] [--json]
```

| User says | Run with | Pulls |
|---|---|---|
| `/pull`, `/pull all` | (nothing) | The workspace root (when it's a git repo) + every repo in `repos.json` |
| `/pull root` | `root` | Just the workspace root |
| `/pull api web` | `api web` | Those repos, by name or `relativePath` |
| `/pull backend` | `backend` or `--layer backend` | The repos whose `repos.json` `layer` is `backend` |
| "what would pull do?" | `--dry-run` | Nothing: reports from the refs as of the last fetch (it doesn't fetch) |

An unknown name exits 2 and lists the valid repos and layers: show the user and ask. `--root` defaults to the current directory's workspace.

## How it behaves

1. Refuses inside a worktree (a root with `.worktree.json`): worktrees are feature-branch checkouts, so pull the main workspace instead. Exit 2.
2. Fetches every target repo from `origin`, in parallel (not in `--dry-run`).
3. Fast-forwards (`git merge --ff-only origin/<default>`) **only** a repo that is on its default branch, has no uncommitted changes to tracked files, and is strictly behind. Untracked files don't block it unless they'd be overwritten, in which case git refuses and that's reported.
4. Never checks out, switches branches, stashes, rebases or creates a merge commit. Everything else is reported:

   | Result | Meaning |
   |---|---|
   | `fast-forwarded N commit(s)` | Moved to origin's tip |
   | `up to date` | Nothing to do |
   | `N ahead: nothing to pull` | Local commits not on origin; nothing upstream |
   | `on <branch>, not <default>: skipped` | On a feature branch: left there |
   | `uncommitted changes: skipped` | Dirty and behind: left alone |
   | `diverged: needs a decision` | Local commits *and* upstream commits |
   | `fetch failed` / `fast-forward refused` / `origin/<x> not found` | Errors (exit 1) |
   | `not cloned` / `no origin remote` | Skipped |

5. If the workspace root moved and the change touched the dashboard engine folder (`.claude/dashboard/engine.json` `dir`, default `natterjack`), it prints a reminder to restart the dashboard.

Exit 0 unless a repo errored; skipped and diverged repos aren't errors.

## After running

Relay the table in your own words. **Call out explicitly** every repo that isn't on latest, since those are what the user needs to act on:

- **Skipped (on a branch / dirty)**: name them; their work is untouched and they weren't updated.
- **Diverged**: don't force anything. Say what's ahead and behind and let the user choose (rebase, reset, or open a PR).
- **Errors**: the first line of git's message.
- **Dashboard restart** reminder, when printed.

If every repo came back fast-forwarded or up to date, one line is enough ("all N repos up to date with origin").

## Notes

- The repo list is read live from `repos.json` (or discovered without one): never hardcode it.
- `defaultBranch` in `repos.json` wins; otherwise origin's HEAD, then `main`/`master`/`develop`.
- To update a repo that's on a feature branch, the user switches or rebases it themselves; this skill never does.

---
name: commit
description: Create Conventional Commits across every repo of a multi-repo workspace (or a single repo), with the ticket from the branch name, context from the issue tracker, and a message proposed from the actual diff. Use whenever the user wants to commit, "commit this", "commit my changes", "make a commit", "write a commit message", "save this work to git", "commit across the repos", or wraps up a change and wants it committed, even if they don't say "commit". Surfaces staged, unstaged and untracked work in every repo and asks what to include; never skips hooks. `--auto` commits unattended for an autonomous implement run.
argument-hint: "[--root <dir>] [--auto] [--ticket <ID>] [message hint...]"
---

# Commit

Write well-formed [Conventional Commits](https://www.conventionalcommits.org/) in each repo a change touched: one commit per repo per logical change, in dependency order, with the ticket referenced.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

## Usage

| Invocation | What it does |
|---|---|
| `/commit` | Shows every repo's changes, asks what to stage, proposes messages, commits on confirmation. |
| `/commit --root worktrees/ENG-123` | Same, for that worktree's repos (from a session whose cwd is the main workspace). |
| `/commit --auto` | Unattended: stages and commits everything in the repos on the ticket branch, no questions. |
| `/commit --ticket ENG-123` | Use this ticket instead of the one inferred from the branch. |
| `/commit fix the retry backoff` | Free text is a hint for the message. |

Without `--root`, a `/commit` from the main workspace inspects the main workspace's repos, which are usually clean while the real work sits in a worktree. If the user is working in a worktree, pass its root.

## 1. See everything

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-status.mjs" --root <root> [--ticket <ID>] --json
```

It lists every repo with changes (`--all` adds clean ones): `name`, `path`, `branch`, `defaultBranch`, `onDefault`, `ticket` (from the branch, using `workspace.json` `issues.ticketPattern`), `ahead`/`behind` vs `origin/<default>`, `staged[]`, `unstaged[]`, `untracked[]` (each `{ status, path, oldPath? }`; renames carry `oldPath`), `diffStat` of the staged changes, `dependencies`, and `eligible` (on a branch for the ticket: what `--auto` may commit). Top-level `ticket` is the ticket being committed for. Drop `--json` for a readable summary. The workspace root is included when it's a git repo itself.

## 2. Decide what to stage (interactive)

**Never silently ignore unstaged or untracked work**: the user usually means to commit it too. If anything is unstaged or untracked, alongside staged changes or instead of them, list it per repo and ask which files to include. Stage the approved files with `git -C <repo> add -- <files>`, then re-run the script.

Warn before committing in a repo that's on its default branch (`onDefault`), and before staging anything that looks like a secret (`.env`, keys, credentials) or a build artifact.

## 3. Context

- **The diff.** `git -C <repo> diff --cached` for each repo with staged changes. Read it; the message describes what changed and why, not the file list.
- **The ticket**, when there is one: pick the tracker by `.claude/dashboard/workspace.json` `issues.kind` (`linear`: the Linear MCP's tool ending `get_issue`; `jira`: the Atlassian MCP's `getJiraIssue`; `github`: `gh issue view <n>`), else whatever is connected. Tool names vary by server; match on the suffix. Use the title and acceptance criteria for the message body. If nothing is reachable, carry on without it, silently.
- **This conversation.** If this session made the change, you already know the intent: that's the best source.

## 4. Write the message

```
<type>(<scope>)[!]: <description>

[body: what and why, wrapped at ~72]

[BREAKING CHANGE: <what breaks and how to migrate>]
Refs: <TICKET>
```

- **Description**: imperative, lower case, no trailing period, under ~50 characters.
- **Type** from what the change does; file types are a hint:

  | Change | Type |
  |---|---|
  | New capability (endpoint, page, command, job, migration adding schema) | `feat` |
  | Corrects behaviour | `fix` |
  | Restructures without changing behaviour | `refactor` |
  | Faster, same behaviour | `perf` |
  | Only tests (`*.test.*`, `*.spec.*`, `*_test.*`, `*Tests.*`, `test/`, `tests/`) | `test` |
  | Only docs (`*.md`, `docs/`) | `docs` |
  | Formatting only | `style` |
  | Build config, packaging, compiler/bundler settings | `build` |
  | CI pipelines (`.github/workflows/`, `.gitlab-ci.yml`, `azure-pipelines.yml`) | `ci` |
  | Dependency bumps, lockfiles, housekeeping | `chore` (scope `deps` for dependencies) |

- **Scope**: if the workspace `CLAUDE.md` / `AGENTS.md` lists commit scopes, use that list. Otherwise the area of the code inside the repo (`auth`, `billing`, `db`), or the repo's short name (`api`, `web`) in a multi-repo change. Omit it when the change is broad.
- **Breaking change**: a removed or renamed public API, changed response shape, required config, or a destructive migration gets `!` after the scope and a `BREAKING CHANGE:` footer saying what breaks and how to migrate.
- **Footer**: `Refs: <TICKET>` when there's a ticket (`Fixes: <TICKET>` if the team uses closing keywords and this completes it). Follow the repo's existing style when it differs: check `git log --oneline -10`.
- **Attribution**: add a `Co-Authored-By` (or other) trailer only when the session or harness instructions say to, using exactly the lines they give. Otherwise add none.

A multi-repo change gets one commit per repo, each message scoped to that repo's part (the same ticket footer in all). Two unrelated changes in one repo are two commits: stage and commit them separately.

## 5. Confirm and commit

Show each proposed message with its repo and files, and ask to confirm or edit. Then commit in **dependency order** (repos that others depend on first: `dependencies` in `repos.json`):

```bash
git -C <repo> commit -F <message-file>
```

Write the message to a temp file and use `-F`, so quoting can't mangle it. **Never pass `--no-verify`** or otherwise bypass hooks or signing. If a hook fails, show its output, fix the cause (lint, format, a failing test), re-stage and commit again; if the fix isn't obvious, stop and report it.

Finish with `git -C <repo> log --oneline -1` per repo committed.

## `--auto` (unattended)

For an autonomous run (e.g. an implement pipeline), where nobody can answer:

1. Run the script with `--root` and `--ticket` (or rely on `.worktree.json`'s ticket).
2. For every repo with `eligible: true`: stage **exactly the paths the script reported** for it (its `unstaged[]` and `untracked[]` entries, plus a rename's `oldPath`), as literal paths: `git -C <repo> --literal-pathspecs add -A -- <path> ...`. For a long list, write the paths NUL-separated to a file and use `--pathspec-from-file=<file> --pathspec-file-nul`. Without `--literal-pathspecs`, git reads paths as glob patterns: a reported `app/[id].tsx` would also stage `app/i.tsx` and `app/d.tsx`. Leave out any `untracked[]` entry ending in `/` (an untracked folder that is a nested repo would be staged as a gitlink) and list it as skipped. Never a bare `git add -A` / `git add .`: the script leaves nested repos and other repos' folders out of a root's lists, and an unrestricted add would stage them as embedded-repo gitlinks. Then commit as above without asking: one logical commit per repo, dependency order. Still read the diff and write a real message.
3. **Never** commit in a repo that's on its default branch, detached, or on another ticket's branch; list those as skipped with their changes. If `ticket` is null, commit nothing and say so.
4. A failing hook: fix the cause and retry once; if it still fails, stop and report it. Never bypass.
5. Print what was committed: repo, short sha, subject.

Don't push: that's the PR step's job.

## Notes

- Amending is only for a commit that hasn't been pushed, and only when the user asks.
- If there's nothing staged and nothing to stage, say "nothing to commit" and stop.
- The script only reads; staging and committing are separate git calls you make, so the user sees each one.

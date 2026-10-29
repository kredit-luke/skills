# multirepo

Workflow skills for workspaces made of several git repos side by side (or a single repo): the everyday steps around a ticket, written once so a team doesn't have to write its own.

They read a [Natterjack](../natterjack/) workspace's config when it's there (`repos.json`, `.claude/dashboard/workspace.json`, `.worktree.json`) and work without it: the repo layout, base branches and ticket ids are discovered.

## Install

```
/plugin marketplace add lhoezee/skills
/plugin install multirepo@lhoezee-skills
```

(Copilot CLI: `copilot plugin install multirepo@lhoezee-skills`; Codex CLI: `codex plugin add multirepo@lhoezee-skills`.)

## Skills

| Skill | What it does |
|---|---|
| `/multirepo:implement <TICKET> [--auto] [--here]` | A ticket end to end: finds or creates its worktree, checks the repos are fresh, settles open questions up front (or decides and records them under `--auto`), branches every affected repo, then runs Agent-tool subagents per repo in dependency order with a review of every changed repo, optional QA and Copilot review, and hands off to `commit` / `pr`. |
| `/multirepo:align <TICKET>` | Before planning: a one-question-at-a-time interview that checks engineering reads the ticket the way its author meant (terms, problem, solution), and writes a short PRD-style alignment doc to `~/.claude/align/`, optionally posted to the ticket. |
| `/multirepo:fetch-ticket <TICKET>` | Reads a Linear, Jira or GitHub Issues ticket, comments included, into one normalized shape (description as Markdown, acceptance criteria, links, subtasks, attached plan and alignment comments); handles oversized tool results saved to a file. |
| `tdd` (used by subagents) | Red/green/refactor for the agents writing code: one failing test first, proven to fail, minimum code, full suite, then refactor. |
| `/multirepo:worktree <TICKET \| name>` | A parallel copy of the repos a ticket needs under `worktrees/<name>/`, each on the ticket branch (independent clones, or native `git worktree`s with `--native`), with workspace config, dependencies and port slots. `--list` shows what's merged (squash merges and merged PRs included), `--remove` guards unsaved work, `--purge` removes only what git and the tracker agree has shipped. |
| `/multirepo:pull [all \| root \| <repo> \| <layer>]` | Fast-forwards repos to their default branch, but only the ones that are clean, on that branch and strictly behind; everything else is reported with the reason, never switched or stashed. |
| `/multirepo:commit` | Conventional Commits in every repo the change touched, ticket from the branch, context from the tracker; shows unstaged and untracked work and asks; never skips hooks. `--auto` for unattended runs. |
| `/multirepo:pr` | PRs for every repo on the ticket branch, in dependency order, cross-linked, ticket in the title; updates the ticket. Optionally requests Copilot and watches the PRs: fixes valid feedback, replies to and resolves threads, keeps branches current; merges only with `--auto-merge`. In a Natterjack dashboard run it hands the watch to the dashboard. |
| `/multirepo:copilot-review` | A local, pre-push second opinion from the GitHub Copilot CLI (a different model) over every repo's changes as one review, new files included; optionally fixes the real findings and re-reviews, up to 3 rounds. Never commits. Needs `copilot`. |
| `/multirepo:factory [--max n]` | Runs the software factory from a session: pulls the tickets the team's Factory policy takes in (by tracker state and label), up to its WIP limit, and runs each through `implement` under the policy in its own worktree. The Natterjack dashboard's Factory page does the same with Pull work in. |
| `/multirepo:retro <TICKET>` | The retro for a merged factory ticket: what review caught, which assumptions were wrong, how the Approver's call held up, and small CLAUDE.md, skill or policy tweaks proposed for a person to accept. Recorded on the Factory board. |
| `/multirepo:approve --ticket <ID> --gate <gate>` | The software factory's Approver: rates a change's risk (the team's risk rules, then a conservative judgement), records it on the Natterjack Factory board, and approves or merges only when the team's policy enforces it, as its own account, with every condition met. Advisory otherwise. `implement` runs it at gates set to the Approver. |
| `/multirepo:review-guide <PR> [...]` | Writes a guided review for a PR (intent, the core change, its consequences, the glue, risks and questions for the reviewer, with links to the lines) and posts it as one comment, updated in place on later runs. The Natterjack dashboard's Reviews page shows it. `implement` runs it once PRs are open. |
| `/multirepo:spec-check [TICKET]` | Scores a draft or an existing ticket for spec readiness the way the Factory's spec gate will (the same script, the team's thresholds and weights) and says what's missing. Records nothing, so a ticket-writing skill can show the author the score before the ticket is created. |
| `/multirepo:submit-plan [plan] [TICKET]` | Posts a plan from `~/.claude/plans/` to a Linear, Jira or GitHub Issues ticket as a tagged comment, and updates that comment on later submissions. |

## What it reads

| File | Used for |
|---|---|
| `repos.json` | The repos: `name`, `relativePath`, `defaultBranch`, `dependencies` (PR and commit order), `layer` (pull targets), `remote`. Without it, a single repo or the git repos one level down. |
| `.worktree.json` | Inside a worktree folder: its repos, branch and ticket (`ticketId`, `tracker`). |
| `.claude/dashboard/workspace.json` | `issues.kind` (which tracker), `issues.ticketPattern` (ticket ids in branch names; without one, `repo#12` when `issues.kind` is `github`, the id the dashboard uses, else `KEY-123`; GitHub ids keep their case, other trackers' keys are upper-cased), `issues.repos` (GitHub: maps folder-safe branch and worktree names like `feature/api-12` back to `api#12`, for the listed repos only; a worktree's `.worktree.json` `ticketId` wins over it), `worktrees.dir` / `portsFile` / `ports` (worktree folder and port slots, shared with the dashboard). |

Optional keys these skills add to `workspace.json`:

| Key | Default | Meaning |
|---|---|---|
| `worktrees.copy` | `[]` | Extra files or folders (relative to the workspace) copied into every new worktree, e.g. `[".claude/references", "docs"]`. |
| `issues.doneStates` | `["Done"]` | Tracker states `worktree --purge` treats as shipped (case-insensitive). |
| `issues.progressState` | `"In Progress"` | The state `implement` moves a ticket to when work starts (Jira: by transition name). |
| `issues.reviewState` | `"In Review"` | The state `pr` moves a ticket to (Jira: the transition whose name contains it). |

Project conventions (the stack, commit scopes, which agent owns which code, whether PRs may be auto-merged) come from the workspace's `CLAUDE.md` / `AGENTS.md`.

## Maintaining

Tests: `node --test "plugins/multirepo/scripts/test/*.test.mjs"` (they make throwaway git repos and bare remotes). To release, bump the version in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, run `claude plugin validate .` from the repo root, commit, and tag the version-bump commit `multirepo-v<version>`.

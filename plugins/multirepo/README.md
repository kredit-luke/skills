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
| `/multirepo:copilot-review` | A local, pre-push second opinion from the GitHub Copilot CLI (a different model) over every repo's changes as one review; optionally fixes the real findings and re-reviews, up to 3 rounds. Never commits. Needs `copilot`. |
| `/multirepo:submit-plan <TICKET>` | Posts a plan from `~/.claude/plans/` to a Linear, Jira or GitHub Issues ticket as a tagged comment, and updates that comment on later submissions. |

## What it reads

| File | Used for |
|---|---|
| `repos.json` | The repos (`relativePath`, `defaultBranch`). Without it, a single repo or the git repos one level down. |
| `.worktree.json` | Inside a worktree folder: just the repos cloned into it. |
| `.claude/dashboard/workspace.json` | `issues.ticketPattern` (ticket ids in branch names) and `issues.kind` (which tracker). |

Project conventions (the stack, which agent owns which code) come from the workspace's `CLAUDE.md` / `AGENTS.md`.

## Maintaining

Tests: `node --test "plugins/multirepo/scripts/test/*.test.mjs"` (they make throwaway git repos). To release, bump the version in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, run `claude plugin validate .` from the repo root, commit, and tag the version-bump commit `multirepo-v<version>`.

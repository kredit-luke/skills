# Workflow skills

The dashboard runs whatever skills the workspace has; these five are what teams usually want, and what the Issues page's **Implement** button and the Home skill cards call. Write them for the team (their tracker, ticket format, code host, branch convention, repos), in `.claude/skills/<name>/SKILL.md`, with any deterministic git work in a bundled Node script next to the SKILL.md (so it behaves the same on every OS). Keep each one's `description` specific about when to use it; that's what makes Claude pick it.

Settle these with the team first and record them in the root CLAUDE.md:
- **Ticket id** format and regex (same as `workspace.json` `issues.ticketPattern`).
- **Branch convention**, e.g. `feature/<TICKET>` / `fix/<TICKET>`. The one hard rule for multi-repo work: **the same branch name in every repo a ticket touches**, so the change is traceable across repos.
- **Commit style**, e.g. Conventional Commits with the ticket in the footer (`Refs: ENG-123`).
- **Dependency order** between repos (who consumes whose API), for implementing, and for opening PRs.
- **Tracker access for Claude**: the tracker's MCP connector (Linear, Atlassian, GitHub) or CLI. Skills read and update tickets through it; list its tools in `allowed-tools`.

## /implement <TICKET> [--auto]

The pipeline behind the Issues page's Implement button. The deck preset is `"/implement {ticket}"` with the ticket arg's `pattern` = the ticket regex, and an `--auto` option. Steps:
1. **Read the ticket** (tracker MCP): description, comments (look for an attached plan), labels, linked issues.
2. **Pick the workspace**: reuse the ticket's worktree if one exists, else create one (`/worktree`), unless `--here`.
3. **Settle open questions up front**, in one AskUserQuestion round: scope, approach choices, anything ambiguous in the ticket. Under `--auto`, decide them yourself with sensible defaults and record each decision as a ticket comment. (Running headless in the dashboard, AskUserQuestion becomes the dashboard's question block automatically.)
4. **Branches**: create the convention's branch in every affected repo.
5. **Implement per repo in dependency order** with Agent-tool subagents (one per repo, foreground; give each the ticket, the decisions, and the repo's CLAUDE.md conventions); regenerate any generated clients between steps rather than hand-writing them.
6. **Review** (a reviewer subagent over the combined diff) and **test** (the repos' test suites; a browser QA subagent for UI changes if the team has one).
7. **End with a decision**: commit and open PRs / commit only / stop. Under `--auto`, commit and open PRs, never merge. Post a summary comment on the ticket and move it to the team's "in review" state.

## /commit

Stage (ask when it isn't obvious what belongs), read the diff, and write a commit message in the team's style with the ticket from the branch name (`git rev-parse --abbrev-ref HEAD` + the ticket regex). One commit per logical change; in a multi-repo change, commit in each affected repo. Never skip hooks.

## /pr [--draft]

For every repo with commits on the ticket branch, in dependency order: push, open a PR with the code host CLI (`gh pr create` / `glab mr create`), title with the ticket, body with what/why/how-tested and links to the sibling PRs (edit earlier PRs to link later ones once they exist), and the tracker link. Then move the ticket to the team's review state and comment the PR links. Optional: a watch loop that addresses review comments (only in a terminal: headless runs can't outlive their turn).

## /worktree <TICKET | name> | --list | --remove <name>

Parallel work without touching the main checkout: **independent clones** (not `git worktree`, which ties the repos together) of the affected repos into `worktrees/<name>/<repo>/`, each on the ticket branch, plus `worktrees/<name>/.worktree.json`:
```json
{ "name": "ENG-123", "ticketId": "ENG-123", "tracker": "linear", "branch": "feature/ENG-123", "repos": ["api", "web"], "created": "…" }
```
The dashboard's Workspaces page lists every folder under `worktrees/` with a `.worktree.json` (its `repos` are the git repos it shows) and runs that worktree's apps. For apps to run side by side with main, allocate each worktree a port set (base port + slot × 10, skipping ports in use) and record it in the per-user ports file (`workspace.json` `worktrees.portsFile`):
```json
{ "worktrees": { "ENG-123": { "slot": 1, "workspace": "/abs/path/worktrees/ENG-123", "ports": { "api": 8090, "web": 5183 } } } }
```
`--remove` refuses when a repo has uncommitted or unpushed work unless forced, and frees the slot.

## /pull [all]

Fast-forward the workspace's repos to their default branch: for each repo, skip (and say why) when it has uncommitted changes or is on another branch, else `git fetch` + `git merge --ff-only`. A bundled script keeps it deterministic. Also pull the workspace root itself (it carries the dashboard and config), then remind people to restart the dashboard if `dashboard/` changed.

## Presets worth adding to deck.json

- **Morning brief** (read-only): open PRs and their checks, red CI on the default branch, my in-progress tickets; ends with the 3 things to do first.
- **Pull latest**: `/pull`.
- **Implement ticket**: `/implement {ticket}` with the `--auto` option.
- Anything the team runs weekly (dependency upgrades, audits), as report-only prompts.

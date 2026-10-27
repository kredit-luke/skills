# Workflow skills

The dashboard runs whatever skills the workspace has; these five are what teams usually want, and what the Issues page's **Implement** button and the Home skill cards call.

## The `multirepo` plugin (ready-made)

The same marketplace ships them as a plugin: `multirepo@lhoezee-skills` (`plugins/multirepo/` in lhoezee/skills). Skills: `implement`, `align`, `fetch-ticket`, `worktree`, `pull`, `commit`, `pr`, `copilot-review`, `submit-plan`, and `tdd` for subagents, invoked as `/multirepo:<skill>`. They work with Linear, Jira and GitHub Issues, and read this dashboard's config:

| Config | Used for |
|---|---|
| `repos.json` `relativePath`, `defaultBranch`, `dependencies`, `layer` | Which repos, their base branch, implementation and PR order, pull targets. |
| `workspace.json` `issues.kind`, `issues.ticketPattern`, `issues.repos` | The tracker, and ticket ids in branch names. GitHub ids keep their case, and branches use the folder-safe form (`api#12` → `feature/api-12`), which `issues.repos` maps back. |
| `workspace.json` `issues.progressState`, `reviewState`, `doneStates` | Ticket states for started / PRs open / safe-to-purge (defaults "In Progress", "In Review", ["Done"]). |
| `workspace.json` `worktrees.dir`, `portsFile`, `ports`, `copy` | Worktree folder, port slots (allocated exactly like the dashboard: same file, lock and offsets), extra files copied in. |
| `.worktree.json` | A worktree's ticket, branch and repos (the shape below). |
| `factory.json` | The Factory policy: `/multirepo:implement` reads it (`factory.mjs policy`) and reports each step to the Factory board (below). |

Team conventions (ticket format, branch prefixes, which subagent or reviewer owns which repo, quality gates, commit scopes, merge rules) go in the root CLAUDE.md, where the skills look for them. Enable it at project scope so the whole team and cloud sessions get it: `claude plugin install multirepo@lhoezee-skills --scope project`, plus `extraKnownMarketplaces` for `lhoezee-skills` in `.claude/settings.json`. The Implement preset's prompt is then `/multirepo:implement {ticket}`; the dashboard recognises a namespaced implement prompt for run-to-ticket matching and its terminal button, and lists plugin skills (as `/<plugin>:<skill>`) with the workspace's own.

The rest of this page is the contract they follow, and what to write if the team prefers its own skills.

## Writing your own

Write them for the team (their tracker, ticket format, code host, branch convention, repos), in `.claude/skills/<name>/SKILL.md`, with any deterministic git work in a bundled Node script next to the SKILL.md (so it behaves the same on every OS). Keep each one's `description` specific about when to use it; that's what makes Claude pick it.

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

### Reporting to the Factory board

A pipeline that reports its progress gets a card on the **Factory** page. Each work item has one manifest, `<workspace>/.claude/ledger/factory/<ticket>.json` (in the source workspace's ledger even when the work is in a worktree; the ticket id made file-safe, `acme/api#7` → `acme_api_7.json`). The board reads that folder; it never scrapes transcripts. `/multirepo:implement` writes it through `scripts/factory.mjs` (`start`, `stage`, `gate`, `pr`, `done`); a pipeline of your own can call the same script or write the same shape:

```json
{
  "version": 1, "ticket": "ENG-123", "title": "Retry failed calls", "url": "https://linear.app/acme/issue/ENG-123",
  "mode": "interactive", "policy": { "preset": "supervised", "updatedAt": "2026-10-27T10:00:00Z" },
  "workroot": "/work/acme/worktrees/eng-123", "branch": "feature/ENG-123", "repos": ["api", "web"],
  "plan": "~/.claude/plans/ENG-123-retries.md",
  "startedAt": "2026-10-27T10:00:00Z", "updatedAt": "2026-10-27T10:40:00Z",
  "stages": [{ "id": "build", "repo": "api", "agent": "dotnet-dev", "status": "done", "startedAt": "…", "endedAt": "…", "note": "Added RetryPolicy; 14 tests" }],
  "gates": [{ "id": "plan", "mode": "human", "decision": "approved", "by": "user", "risk": null, "rationale": null, "sha": null, "at": "…" }],
  "prs": [{ "repo": "api", "url": "https://github.com/acme/api/pull/42", "number": 42, "state": "open" }],
  "done": false, "error": null
}
```

- **`stages[]`**: one row per stage and repo, `status` `pending` | `running` | `done` | `failed` | `skipped`; the latest status counts (a failed build that's running again is running).
- **`spec`**: the ticket's spec readiness from `spec-check.mjs --ticket` (`score`, `level`, the team's levels, and each check's `score`, `finding` and any `override` the agent made with its reason), shown on the card and in its details.
- **`gates[]`**: appended per decision (`pending`, then `approved` or `rejected`); the last one counts, and the history is the audit trail.
- **Where the card sits**: the first stage or gate (in the policy's order) it hasn't finished. A stage it never reported counts as skipped once a later one has activity. `done: true`, or every PR merged, puts it in Done.
- The card adds what the dashboard knows: runs whose ticket matches (cost, agent, a question waiting), and the policy's budget.

## /commit

Stage (ask when it isn't obvious what belongs), read the diff, and write a commit message in the team's style with the ticket from the branch name (`git rev-parse --abbrev-ref HEAD` + the ticket regex). One commit per logical change; in a multi-repo change, commit in each affected repo. Never skip hooks.

## /pr [--draft]

For every repo with commits on the ticket branch, in dependency order: push, open a PR with the code host CLI (`gh pr create` / `glab mr create`), title with the ticket, body with what/why/how-tested and links to the sibling PRs (edit earlier PRs to link later ones once they exist), and the tracker link. Then move the ticket to the team's review state and comment the PR links. Optional: a watch loop that addresses review comments (only in a terminal: headless runs can't outlive their turn).

## /worktree <TICKET | name> | --list | --remove <name>

Parallel work without touching the main checkout, with the affected repos in `worktrees/<name>/<repo>/`, each on the ticket branch. Two ways to put them there; the dashboard handles both:
- **Independent clones**: fully separate (delete the folder freely), but each fetches from the remote and has its own `.git`.
- **Native `git worktree add`** (`git -C <repo> worktree add worktrees/<name>/<repo> -b feature/<TICKET>`): seconds, no network, shares the main clone's objects; the branch can't be checked out in main at the same time, and a folder deleted by hand needs `git worktree prune`. For a monorepo this is one command.

Write `worktrees/<name>/.worktree.json` either way (for git worktrees it's optional: the dashboard finds them with `git worktree list` and reads the ticket from the branch):
```json
{ "name": "ENG-123", "ticketId": "ENG-123", "tracker": "linear", "branch": "feature/ENG-123", "repos": ["api", "web"], "created": "…" }
```
The dashboard's Workspaces page shows the worktree's repos and runs its apps. For apps to run side by side with main, each worktree needs its own ports. Simplest: set `workspace.json` `worktrees.ports` (`{ "base": 24000, "slotSize": 100 }`) and the dashboard allocates a slot on first start. If the team's own scripts start apps too, have them allocate the same way and record it in the per-user ports file (`workspace.json` `worktrees.portsFile`), holding `<portsFile>.lock` while writing:
```json
{ "worktrees": { "ENG-123": { "slot": 1, "workspace": "/abs/path/worktrees/ENG-123", "ports": { "api": 24101, "web": 24102 } } } }
```
Give shared services a worktree rarely changes `"fallback": "main"` in apps.json: worktrees then use main's instance unless they run their own.

`--remove` refuses when a repo has uncommitted or unpushed work unless forced (`git worktree remove` for native ones), and frees the slot.

## /pull [all]

Fast-forward the workspace's repos to their default branch: for each repo, skip (and say why) when it has uncommitted changes or is on another branch, else `git fetch` + `git merge --ff-only`. A bundled script keeps it deterministic. Also pull the workspace root itself (it carries the dashboard and config), then remind people to restart the dashboard if `<engine>/` changed.

## Presets worth adding to deck.json

- **Morning brief** (read-only): open PRs and their checks, red CI on the default branch, my in-progress tickets; ends with the 3 things to do first.
- **Pull latest**: `/pull`.
- **Implement ticket**: `/implement {ticket}` with the `--auto` option.
- Anything the team runs weekly (dependency upgrades, audits), as report-only prompts.

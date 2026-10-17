---
name: worktree
description: Create, list, remove, purge and sync isolated per-ticket worktrees for parallel work across a multi-repo workspace (or a single repo). Use whenever the user wants a separate copy of the repos to work on a ticket without disturbing the main checkout, e.g. "new worktree for ENG-123", "spin up a workspace for this ticket", "parallel work on another ticket", "set up a sandbox to try something", "list my worktrees", "what's the state of my worktrees", "which worktrees are merged", "remove the ENG-123 worktree", "clean up merged worktrees", "purge old worktrees", "sync the worktree config", "my worktree has stale settings / CLAUDE.md".
argument-hint: "<TICKET | tracker-url | name> [--repos a,b] [--native] | --list | --remove <name> | --purge | --sync"
allowed-tools: Bash, Read
---

# Worktree

A worktree is `<workspace>/<worktrees.dir>/<name>/` (default `worktrees/`) holding the chosen repos at their `repos.json` `relativePath` (nested paths like `services/api` work), each on the ticket branch, plus a copy of the workspace's Claude config and a `.worktree.json`. A session started there works on that ticket alone; the main checkout is untouched.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

## The script

Everything deterministic is one script; use it rather than ad-hoc git commands.

```bash
W="${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs"
node "$W" create --name <name> --repos <a,b> [--branch <b>] [--ticket <id>] [--tracker <kind>] [--native] [--root <ws>] [--no-install] [--json]
node "$W" list   [--root <ws>] [--json] [--no-fetch] [--no-pr]
node "$W" remove --name <name> [--force] [--delete-remote-branches] [--root <ws>] [--json]
node "$W" sync   [--path <worktree>] [--json]
```

`--root` defaults to the workspace around the current folder. `create` must run from the **main** workspace and refuses inside a worktree; `list`/`remove` run from a worktree act on its source workspace.

**create** does:
- **Repos** (`--repos`: repos.json names or relativePaths; an unknown one is an error that lists the valid ones).
  - Default: independent clones from the main checkout's `origin`, so the clone's origin is the real remote. Delete freely.
  - `--native`: `git worktree add` of each main repo. Seconds, no network, shared objects. Needs `--branch`, and that branch can't also be checked out in main.
  - The branch is checked out from `origin/<branch>` when it already exists, else created from `origin/<default>` with no upstream (the first `git push -u` sets it).
- **Config**: copies `CLAUDE.md`, `AGENTS.md`, `repos.json`, `.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`, plus `worktrees.copy` (below).
  - `.claude/skills` and `.claude/agents` are **never** copied. Claude Code finds them by walking up the tree, so the worktree already inherits them, and a copy shows up as duplicates.
  - Settings **are** copied because Claude Code reads them from one project root and doesn't merge an ancestor's. Without the copy the worktree loses the permission allowlist.
- **Metadata**: writes `.worktree.json`: `{ name, ticketId, tracker, branch, repos, created, sourceWorkspace }`.
  - `ticketId` comes from `--ticket`, else from the name/branch (`issues.ticketPattern`). `tracker` comes from `--tracker`, else `issues.kind`.
  - Older files with `linearId`/`mode` are still read (as `ticketId` + tracker `linear`).
- **Dependencies**: `npm ci` (with a lockfile) or `npm install` in each repo with a `package.json`, unless `--no-install`. A failure is reported and the rest carries on.
- **Ports**: only with `worktrees.ports`. It allocates a port slot in the per-user ports file exactly as the dashboard does (same file, same lock, same formula `base + slot × slotSize + slotOffset`, lowest free slot) and prints the ports. Without `worktrees.ports` it allocates nothing and says so.

### Workspace config it reads (`.claude/dashboard/workspace.json`, all optional)

| Key | Default | Use |
|---|---|---|
| `worktrees.dir` | `worktrees` | Where worktrees live. |
| `worktrees.portsFile` / `worktrees.ports` | see the dashboard's config reference | Port slots (shared with the dashboard). |
| `worktrees.copy` | `[]` | **Extra** workspace-relative files or folders copied into every worktree and re-copied by sync, e.g. `[".claude/references", "docs", "docker-compose.yml"]`. Add anything CLAUDE.md, AGENTS.md or agents point at, or those links dangle in the worktree. Entries must be relative paths inside the workspace: `.`, `..`, absolute paths and anything resolving to the workspace itself are skipped with a warning. So is anything that would overwrite a checkout: a `.git` path, a repo folder (or a folder containing one), a path inside a cloned repo, or a folder holding git-tracked files. |
| (in a worktree) | | Worktrees don't get their own `workspace.json`: the skills read the source workspace's (via `.worktree.json` `sourceWorkspace`). |
| `issues.kind` / `issues.ticketPattern` | none / `KEY-123` | Tracker and ticket ids. |
| `issues.doneStates` | `["Done"]` | Tracker states that count as shipped for `--purge` (case-insensitive), e.g. `["Ready to deploy", "Done"]`. |

## Create: ticket mode (`/worktree ENG-123` or a tracker URL)

When the argument matches the ticket pattern, or is a tracker URL (take the id from the path):

1. **Read the ticket** with the tracker for `issues.kind`:
   - Linear: its MCP `get_issue`.
   - Jira: the Atlassian MCP.
   - GitHub Issues: `gh issue view <n> --repo <owner/name> --json title,body,labels,state`.

   If it isn't found or no tracker is connected, say so and offer ad-hoc mode with the id as the name.
2. **Branch**: follow the convention in CLAUDE.md if it has one. Otherwise:
   - `fix/<ID>` for bugs (type or label "bug"/"fix");
   - `chore/<ID>` for chores/maintenance;
   - `feature/<ID>` for everything else.
3. **Repos**. If `--repos` was given, use it as is and skip this step and the next: the caller already confirmed it, and asking again re-opens a decision the user just made. Otherwise, propose repos from the ticket (title, description, labels, components) matched against `repos.json` names, `layer` and `dependencies`. If the ticket changes something another repo consumes, include the consumers it names. With nothing to go on, propose all.
4. **Confirm**: `AskUserQuestion` (multiSelect), every repo as an option with the proposed ones first, marked "(suggested)".
5. **Create**: `node "$W" create --name <folder> --repos <list> --branch <prefix><ID> --ticket <ID>` (+ `--native` if the user asked for git worktrees).
   - `<folder>` is the id when it's a valid name (`[A-Za-z0-9_.-]+`, e.g. `ENG-123`). Otherwise derive one by replacing every other character with `-`: GitHub's `acme/api#7` → `acme-api-7`. `--ticket` keeps the original id for the metadata (and so the tracker lookups), and the branch uses the derived form too (`#` and `/` in a ticket make awkward branch names).

## Create: ad-hoc mode (`/worktree spike-auth`)

Any other name (`[A-Za-z0-9_.-]+`): ask which repos (multiSelect, unless `--repos`), then `create --name <name> --repos <list>`. Add `--branch` only if the user gives one. Without it each clone is switched to its default branch (`repos.json` `defaultBranch`, else origin's HEAD).

**After create**, relay the summary: the path, branch, any failures, and the ports. Tell the user to open a new session in the worktree folder.

## List (`/worktree --list`)

1. Run `node "$W" list --json`. It fetches each repo's base branch in parallel (8s timeout each) so merge detection isn't fooled by stale refs. `--no-fetch` / `--no-pr` skip the network.
2. For worktrees with `metadata.ticketId`, fetch the ticket's state (and title/assignee) from the tracker in one parallel batch. On failure show `<Tracker>: unavailable` and carry on.
3. **Render markdown** (not the script's box table, which renders as a scrolling code block in chat), one block per worktree:

   ```markdown
   ## Worktree: <name>
   - **Path:** `<path>` · **Created:** <YYYY-MM-DD> · **Branch:** `<branch>`
   - **<Tracker>:** *<state>*, <assignee> · "<title>" [<ticketId>](<url>)

   | Repo | Branch | Local | vs Remote | vs main |
   |------|--------|-------|-----------|---------|
   ```

   - **Local**: `clean`, or `N uncommitted`.
   - **vs Remote**: `no upstream` (`unpushed === null`), `in sync` (0), or `N unpushed`.
   - **Missing repo**: `| <repo> | _(missing)_ | — | — | — |`.
   - **No ticket**: leave out the tracker line.
   - **`native: true`**: add "(git worktree)" after the repo name.
   - **vs main**: use the first rule that matches (`<mainRef>` is e.g. `origin/main`; deltas are `+aheadOfMain`/`-behindMain`):
     1. `unknown`: `merged === null` (no base ref found).
     2. `no commits yet (= <mainRef>)`: `merged` and ahead = behind = 0.
     3. `merged → <mainRef>`: `merged`, meaning HEAD is in main (a normal or fast-forward merge).
     4. `squash-merged → <mainRef>`: `treesIdentical`.
     5. `squash-merged → <mainRef> (-N)`: `allPatchesOnMain`.
     6. `pr-merged → <mainRef> #<prNumber>`: `prMerged`.
     7. `pr-merged #<prNumber> (+<prAheadBy> since), newer commits not merged`: `prMergedStale`. The work in that PR shipped; the commits after it didn't.
     8. `squash-merged (+A/-B since)`: `squashMergedByGrep` only.
     9. `not merged (+A/-B)`.

   **Why so many signals.** A squash merge puts a new commit on main, so the ancestor check (`merged`) misses it.
   - `treesIdentical` catches "just squash-merged, nothing since".
   - `allPatchesOnMain` (`git cherry`: every branch commit's patch is on main) catches it after main moved on.
   - When the content drifted from what landed (regenerated files, conflict fixes), no patch matches. Then `prMerged` asks `gh pr list --head <branch> --state merged`, the real merge event, and only counts a PR merged **into the default branch** whose head commit **is** the local HEAD or contains it. A same-named branch with commits pushed after the merge is `prMergedStale`, not merged. It's only checked when git is inconclusive, and it degrades silently without `gh`. It passes `--repo` only for github.com and the hosts `gh auth status` lists; for anything else (e.g. an SSH host alias) gh runs in the repo folder and resolves the remote itself.
   - `squashMergedByGrep` (main's log mentions the ticket id) is the weakest: a hint worth a manual look, never proof.

## Remove (`/worktree --remove <name>`)

1. `node "$W" remove --name <name>`. It refuses (exit 1, details on stderr) when any repo has uncommitted changes, stashes or unpushed commits (including commits on a branch with no upstream that are on no remote), and when it finds a checkout git can't read (a broken gitdir link, a corrupt repo, dubious ownership): it can't prove those are safe. A folder without `.worktree.json` is scanned for checkouts (the source workspace's repo paths, then three levels down); if none can be inspected and the folder isn't empty, it refuses without `--force` rather than guess.
2. If it refused, show the details and ask with `AskUserQuestion` ("Yes, remove it" / "No, keep it"). Only on an explicit yes, re-run with `--force`.
3. It removes native repos with `git worktree remove` + `prune`, frees the port slot, and deletes the folder with retries. If the folder is locked (Windows: a shell, editor, dev server or build server inside it), it says so. Tell the user to `cd` out or close the process, then delete the folder.

`--delete-remote-branches` also runs `git push origin --delete <branch>` per repo (never the default branch) before deleting. It's off by default because an open PR may still need the branch. Failures are reported, not fatal.

## Purge (`/worktree --purge`)

Removes only worktrees that are safe by **both** gates. Git alone can lie (merged, but the ticket is still in QA and its context is needed). The tracker alone can lie too (Done, but a local commit never shipped).

1. **Git-safe**, every repo:
   - `uncommitted === 0`;
   - `unpushed === 0`, or `null` when the repo is merged;
   - `merged || treesIdentical || allPatchesOnMain || prMerged`.

   `squashMergedByGrep` alone is **not** safe, and neither is `prMergedStale` (commits after the merged PR never shipped).
2. **Tracker shipping-ready**: the ticket's state is in `issues.doneStates` (default `["Done"]`, case-insensitive). For GitHub Issues, "closed" also counts.

Procedure:

1. `list --json`.
2. Classify every worktree. Skip without the tracker call: no metadata, or no ticket id.
3. Fetch every remaining ticket's state in parallel.
4. Show a dry-run preview: `### Eligible for removal (N)` (Worktree | State | Notes) and `### Skipped (M)` (Worktree | Reason), each skipped worktree with its **first** failure. Nothing eligible → say `Nothing to purge.` and stop.
5. Confirm with `AskUserQuestion` (`Remove N worktree(s): <names>?`).
6. On yes, run `remove --name <n> --force --delete-remote-branches` for each, in parallel.
7. Report `Removed: <names>. Skipped: <count>.` plus any failures.

| Cause | Reason string |
|---|---|
| Uncommitted work | `<repo>: <N> uncommitted` |
| Unpushed, unmerged | `<repo>: <N> unpushed` |
| Grep-only signal | `<repo>: squash-merged (+<N> since)` |
| Unmerged commits | `<repo>: not merged (+<N>)` |
| No base ref | `<repo>: unknown vs main` |
| Ticket not done | `<Tracker>: <state>` |
| Tracker unreachable | `<Tracker>: unreachable` |
| No ticket id | `no ticket` |
| No `.worktree.json` | `no metadata` |

## Sync (`/worktree --sync`, inside a worktree)

`node "$W" sync [--path <worktree>]` re-copies the config list from the worktree's `sourceWorkspace`. Folders are replaced, so deletions carry over. It also deletes stale `.claude/skills` / `.claude/agents` copies an older tool left behind, but keeps any that hold git-tracked files (in a single-repo workspace they're the project's own). Then tell the user to restart the session: settings and CLAUDE.md load at start.

## Headless runs

In a dashboard or `claude -p` run, `AskUserQuestion` becomes the dashboard's question block automatically, so keep using it. Never treat silence or a missing answer as confirmation for `--force`, remove or purge: stop and report instead.

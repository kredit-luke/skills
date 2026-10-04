---
name: add-adapter
description: Add support to a Natterjack dashboard for an issue tracker it doesn't have yet (e.g. Azure Boards, Shortcut, GitLab Issues, YouTrack, ClickUp, Asana, Monday), or another code host for the Needs-you inbox, or another place to publish read-only code snapshots (SharePoint, Google Drive, Notion). Use when the team's tracker or code host isn't Linear, Jira, GitHub Issues or GitHub, or its snapshot host isn't Confluence or a plain web server, or when the Issues page says "<tracker> isn't supported yet".
argument-hint: "<tracker or code host>"
---

# Add an adapter

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`, `references/` and `engine/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`) wherever it appears.

Read `${CLAUDE_PLUGIN_ROOT}/references/adapters.md` first: it has the `IssueTracker` interface, the normalized issue shapes, and a walkthrough of an existing adapter. `<engine>` below is the workspace's engine folder: `natterjack/` by default, `dashboard/` in older workspaces; `.claude/dashboard/engine.json` `dir` says which. Then:

1. **Read the three existing adapters** in `<workspace>/<engine>/server/src/issues/` (`linear.ts` = GraphQL + pasted key, `jira.ts` = REST + email:token, `github.ts` = a CLI's own login). Pick the closest as your model.
2. **Find the tracker's API**: how a personal token authenticates, how to list issues filtered by project/team and state (with a single request if possible, ≤ ~250 results), how to fetch one issue with its description, and the viewer's name. Use its official API docs (WebFetch) rather than memory. Prefer a personal access token the user pastes (stored in `.claude/ledger/<tracker>-api-key`, mode 600, or an env var) or an already-authenticated CLI; never OAuth flows, never a shared/team key in config.
3. **Write `issues/<kind>.ts`** implementing `IssueTracker`: `status`, `connectHelp` (the steps the Issues page shows, with a link to where the token is created), `connect` (validate the token with a cheap "who am I" call before saving it), `disconnect`, `issues(filter)` (cache 60s, keep the last good list on errors), `issue(id)` (description as markdown), `issueUrl(id)`. Keep it dependency-free (`node:https` / `node:child_process`).
4. **Register it** in `issues/index.ts` `ADAPTERS`, and add its defaults to `TRACKER_DEFAULTS` in `server/src/config.ts` (display label, the state that means "ready to build", its ticket-id regex if it isn't `KEY-123`).
5. **Test**: unit-test the pure parts (query building, response mapping, description conversion) in `server/test/issues.test.ts`; `npm test`; then set `issues.kind` in workspace.json, restart the dashboard, connect on the Issues page and check the board, the detail panel, Explain and Implement.
6. **Offer to contribute it back** (`contribute` skill): other teams on the same tracker get it on their next upgrade.

A **snapshot source** (where read-only copies of the code are published for people who can't clone: SharePoint, Google Drive, Notion, …): implement `SnapshotSource` in `<engine>/server/src/snapshot-sources/<kind>.ts` following the "Snapshot sources" section of `references/adapters.md`, register it in `SOURCES`, add its settings to `scripts/validate.mjs` and `shared/repos.schema.json`, and test it in `server/test/snapshot.test.ts` against a local fake server. Then set `repos.json` `snapshot.source`, run `node <engine>/bin/snapshot.mjs publish --dry --out <dir>` to check sizes, publish, and download from the Repos page.

A code host other than GitHub (GitLab, Bitbucket, Azure DevOps) for the Home page's Needs-you inbox: extend `server/src/inbox.ts` the same way (its `github` path uses the `gh` CLI; add a branch for `codeHost.kind`), and a matching catalog check (e.g. `glab`) in machine.json.

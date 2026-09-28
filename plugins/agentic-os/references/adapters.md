# Issue tracker adapters

The Issues page, Explain / Implement, search, and the ticket strip on runs all go through one `IssueTracker`, chosen by `workspace.json` `issues.kind`. Adapters live in `dashboard/server/src/issues/`: `linear.ts` (GraphQL, pasted key), `jira.ts` (REST v3, pasted `email:token`), `github.ts` (the `gh` CLI's own login). The dashboard reads the tracker directly with each person's own credentials: refreshing the board costs no Claude usage, and everyone sees what their account can see. Claude *runs* that need the tracker (Implement, a morning brief) use its MCP connector instead.

## The interface (`issues/index.ts`)

```ts
interface IssueTracker {
  kind: string;
  cache: { issues: Issue[] } | null;            // last good list (search indexes it)
  status(): { connected: boolean; source: "env" | "file" | "cli" | null; viewer: string | null };
  connectHelp(): { title: string; steps: string[] /* markdown */; placeholder: string; needsKey: boolean } | null;
  connect(key: string): Promise<status>;         // validate with a cheap "who am I" call, then save (mode 600)
  disconnect(): status;
  issues(filter: { teams: string[]; states: string[] }, force?: boolean): Promise<{ connected: boolean; issues: Issue[]; fetchedAt?: number; error?: string | null }>;
  issue(id: string): Promise<IssueDetail>;
  issueUrl(id: string): string | null;
}
```

Normalized shapes (`shared/api.ts`):
- **Issue**: `id` (the ticket id people type: `ENG-12`, `api#42`), `title`, `url`, `team` (whatever the tracker groups by: Linear team, Jira project, GitHub repo), `teamKey`, `state` (board column), `stateColor?` (hex), `priority` (1 = urgent … 4 = low, 0 = none), `priorityLabel`, `assignee`, `project` (milestone / fix version / project), `labels: [{ name, color }]`, `updatedAt` (ISO).
- **IssueDetail**: `id`, `title`, `url`, `team`, `state`, `priorityLabel`, `assignee`, `project`, `cycle` (sprint/cycle/iteration), `labels`, `description` (**markdown**: convert rich text such as Jira's ADF), `branchName`, `updatedAt`.

`filter.teams` / `filter.states` are names from `deck.json` `issues`; empty means all (don't send an empty `IN ()`). The server adds `canImplement`, `hasWorktree` and `lastRun` itself.

## Conventions

- **Credentials**: a personal token the user pastes on the Issues page, saved to `<ledger>/<kind>-api-key` with mode 0600, or an env var (document both in `connectHelp`); or an already-authenticated CLI (`needsKey: false`). Never a shared key in committed config, never OAuth flows, never send the key to the browser.
- **Caching**: 60s; one request in flight at a time; on error keep the last good list and set `error` (the page shows it above the stale board).
- **No dependencies**: `node:https`, `node:child_process`. Timeouts on every request (20s).
- **Limits**: one request for the board where possible, ≤ ~250 issues, ordered by recently updated.
- **Defaults**: add the kind to `TRACKER_DEFAULTS` in `server/src/config.ts`: its `label`, `implementStates`, and `ticketPattern` if ids aren't `KEY-123`.
- **Register** it in `ADAPTERS` in `issues/index.ts`.

## Checklist for a new tracker

Azure Boards (WIQL + work items API, PAT with Basic auth), Shortcut (REST, `Shortcut-Token` header, ids `sc-123`), GitLab Issues (`glab` CLI or REST with a PAT; ids `<project>#<iid>`), YouTrack (REST, permanent token), ClickUp / Asana / Monday (REST, personal tokens).

1. Auth that works with a personal token, and a "who am I" endpoint for `connect`.
2. Query for the board: filter by team/project and state names; include state color if the API has one.
3. One-issue endpoint with the description (convert to markdown).
4. The id people use in branches and commits; its regex for `ticketPattern`.
5. Tests for the pure parts (query building, mapping, description conversion) in `server/test/issues.test.ts`; then connect for real on the Issues page, and try Explain.

## Code hosts (the Needs-you inbox)

`server/src/inbox.ts` reads the code host for "my open PRs (checks, reviews, conflicts)", "reviews requested from me" and "CI on the default branch" of `codeHost.ciRepos`. `github` uses the `gh` CLI. Another host is a branch in `get()` keyed on `workspaceConfig().codeHost.kind` returning the same `{ items, ciHealth, errors }` shape (e.g. `glab mr list --author=@me`, `glab ci status`).

## Docs providers (searchable external docs)

A docs.json source with `"kind": "external", "provider": "<kind>"` becomes searchable when `dashboard/server/src/docs-providers/` has an adapter for it (`confluence.ts` so far): the Docs page searches and reads it, global search lists its matches, and runs can be told to use it ("Use <name>"). The interface (`docs-providers/index.ts`):

```ts
interface DocsProvider {
  kind: string; label: string;
  status(): { connected: boolean; source: "env" | "file" | "tracker" | null; viewer: string | null };
  connectHelp(): { title; steps: string[] /* markdown */; placeholder; needsKey } | null;
  connect(key: string): Promise<status>;      // validate with a "who am I" call, then save to <ledger>/<kind>-api-token (mode 600)
  disconnect(): status;
  spaces(): Promise<{ key; name; url }[]>;   // whatever the service groups pages by (spaces, teamspaces, drives)
  search(query: string, spaces: string[], limit?: number): Promise<DocHit[]>;   // empty query = recently updated
  page(id: string): Promise<DocPage>;         // body as HTML with absolute links; the UI sanitizes it
  runNote(pageId?: string | null): string;    // appended to a run's system prompt: which MCP tools to use, what to cite
}
```

Same conventions as trackers: each person's own key (never a shared one in config, never OAuth), `node:https` only, 20s timeouts, errors with a `status` (400 = bad input, 401/403 = reconnect). If the service shares a login with the issue tracker (Confluence and Jira), reuse the tracker's key when the site matches, so there's nothing more to paste. Register it in `PROVIDERS` in `docs-providers/index.ts`; test the pure parts (query building, result mapping) in `server/test/docs-providers.test.ts`.

Candidates: Notion (`POST /v1/search`, integration token; pages → blocks to HTML), Google Drive (Drive v3 `files.list` with `fullText contains`, export Docs as HTML; needs OAuth, so probably a CLI such as `gcloud` instead), SharePoint/OneDrive (Microsoft Graph search), GitBook, Guru, Slab.

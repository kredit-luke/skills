# Dashboard config reference

Everything team-specific lives in `<workspace>/.claude/dashboard/` (committed) plus `brand/`. Every file is optional: a page without its config explains how to set it up. Files are re-read when they change; edits apply on the next page load (only `dashboard.port` needs a restart). `$comment` keys are ignored; keep one at the top of each file saying what it is.

Personal/local state is in `<workspace>/.claude/ledger/` (gitignored): run history, attachments, settings overrides, pasted tracker keys, personal links, the dashboard token and log.

---

## workspace.json: who this workspace is

```json
{
  "name": "Acme",
  "dashboard": {
    "title": "Workspace Dashboard",
    "port": 3333,
    "devPort": 4339,
    "legacyRedirects": [{ "port": 4202, "routes": { "/": "/links" }, "prefixes": { "/docs/": "/docs" }, "fallback": "/links" }]
  },
  "worktrees": { "dir": "worktrees", "portsFile": "~/.acme-ports.json", "screenshots": ".claude/qa-artifacts/screenshots" },
  "issues": { "kind": "jira", "site": "acme.atlassian.net", "projects": ["ENG"], "implementStates": ["To Do"] },
  "codeHost": { "kind": "github", "ciRepos": ["acme/api", "acme/web"], "ciBranch": "main" },
  "brand": { "logo": "logo.svg", "logoAlt": "Acme", "favicon": "favicon.png" },
  "copy": { "linksSub": "…", "searchExamples": ["deploy", "feature flags"], "askPlaceholder": "e.g. …" }
}
```

| Field | Default | Notes |
|---|---|---|
| `name` | folder name | Sidebar (when there's no logo) and page titles. |
| `dashboard.port` | 3333 | `DASHBOARD_PORT` env var overrides it per machine; `--port` per start. Must not clash with an app port. |
| `dashboard.devPort` | 4339 | The UI dev server (`npm run dev` in dashboard/) allowed to call the server. Keep in step with `angular.json`'s serve port. |
| `dashboard.legacyRedirects` | none | Old tools' ports that should redirect into the dashboard. |
| `worktrees.dir` | `worktrees` | Where per-ticket worktrees live (Workspaces page lists `<dir>/*` with a `.worktree.json`). Native `git worktree`s are found too, wherever they are: see "Worktrees" below. |
| `worktrees.portsFile` | `~/.agentic-workspace-ports.json` | Per-user file of worktree ports: `{ worktrees: { <name>: { slot, workspace, ports: { <appId>: port } } } }`. Written by the team's worktree tooling, or by the dashboard when `worktrees.ports` is set. |
| `worktrees.ports` | none | `{ "base": 24000, "slotSize": 100 }`: the dashboard gives each worktree a port slot on its first start, `base + slot × slotSize + slotOffset` per app, and records it in the ports file. Leave it out when the team's tooling allocates. |
| `worktrees.screenshots` | `.claude/qa-artifacts/screenshots` | QA screenshots shown per workspace. |
| `issues.kind` | `none` | `linear` \| `jira` \| `github` \| `none` (or any adapter you add). |
| `issues.label` | per kind | Shown in the UI. |
| `issues.implementStates` | Linear `Todo`, Jira `To Do`, GitHub `Open` | Issues in these states get the Implement button (with `deck.json` `issues.implementTeams`). |
| `issues.ticketPattern` | `^[A-Z][A-Z0-9]*-\d+$` (GitHub: `^[\w.-]+#\d+$`) | Anchored regex for a ticket id. |
| `issues.urlTemplate` | from the adapter | Issue URL with `{id}`, if the adapter can't build one. |
| Linear | `org` | The workspace slug in `linear.app/<org>/...`. Key: pasted on the Issues page (`lin_api_…`) or `LINEAR_API_KEY`. |
| Jira | `site`, `projects` | `acme.atlassian.net`; project keys or names. Key: `email:api-token` pasted on the Issues page, or `JIRA_EMAIL` + `JIRA_API_TOKEN`. |
| GitHub Issues | `repos` (or `repo`), `states` | `["owner/name", …]`; `states` maps board columns to labels, e.g. `{ "In progress": ["in progress"] }` (open issues with none = "Open"). Ids are `<repo>#<n>`. Uses `gh` login. |
| `codeHost.kind` | `github` | The Home page's Needs-you inbox (your PRs, reviews requested, red CI). `github` uses the `gh` CLI; `none` turns it off. |
| `codeHost.ciRepos` / `ciBranch` | `[]` / `main` | Repos (`owner/name`) that get a CI health dot. |
| `brand.logo` / `favicon` | none | Files in `brand/`. Use a light logo: the sidebar is dark. No logo = the `name` as text. |
| `copy` | none | Wording overrides: `linksSub`, `docsSub`, `referenceSub`, `issuesSub`, `searchExamples` (array), `askPlaceholder`. |

## apps.json: the Apps and Workspaces pages

```json
{
  "groups": [{ "id": "platform", "label": "Platform" }, { "id": "tools", "label": "Internal tools" }],
  "defaultStack": "platform",
  "apps": {
    "api":  { "name": "API", "type": "Go", "dir": "api", "group": "platform", "port": 8080, "bootSeconds": 60,
              "launch": { "cmd": "go run ./cmd/server", "env": { "PORT": "{{port}}", "DATABASE_URL": "mysql://root:root@localhost:3306/app" } } },
    "web":  { "name": "Web", "type": "Vue", "dir": "web", "group": "platform", "port": 5173,
              "launch": { "cmd": "npm run dev -- --port {{port}}", "env": { "VITE_API_URL": "http://localhost:{{port:api}}" } } },
    "docs": { "name": "Docs site", "type": "Static", "dir": "docs-site", "group": "tools", "port": 4310, "mainOnly": true,
              "launch": { "cmd": "npx --yes serve -l {{port}} ." } }
  },
  "stacks": {
    "platform": { "label": "Platform", "description": "MySQL, API, then web", "hint": "Compose up, API, then web",
      "apps": ["api", "web"],
      "steps": [
        { "cmd": "docker compose up -d mysql", "label": "Start MySQL", "timeoutMin": 3 },
        { "start": ["api"] },
        { "start": "rest" }
      ] }
  }
}
```

**App fields:** `name`, `type` (label), `dir` (workspace-relative folder; the app is "not cloned" when missing), `workDir` (a sub-folder, e.g. in a monorepo; also where the command runs), `group`, `port` (main-workspace port; the dashboard marks the app up when it answers. Leave it out for an app that never listens, like a queue worker: it counts as started once its process has stayed alive for a few seconds, and as running while that process is alive), `https`, `mainOnly` (never runs in worktrees; always its fixed port), `fallback: "main"` (in a worktree that isn't running this app, or hasn't cloned it, its dependents use main's instance: `{{port:<id>}}` names main's port, and a worktree stack that includes it starts or reuses main's; for shared backends and services a worktree usually doesn't change), `slotOffset` (its offset inside a worktree port slot; default its 1-based position in `apps`), `bootSeconds` (how long to wait before calling a start failed, default 120), `logFile` (an extra log the app writes; `{tmp}` and `{workspace}` expand).

**launch** is one of:
- `{ "cmd": "...", "cwd"?: "sub/folder", "env"?: { ... } }`: a shell command, run detached (it outlives the dashboard) in `workDir`/`dir` (+`cwd`). `{{port}}` (this app's port), `{{port:<appId>}}` and `{{workspace}}` expand in `cmd` and `env`. Stop sends its process tree SIGTERM, then SIGKILL after 10s if anything is left. Starting an app whose earlier launch is still alive but not answering stops that one first.
- `{ "launcher": "<args>", "detached"?: true }`: the team's own launcher script, `launcher.script` below, called as `node <script> <args> --workspace <path>`. `detached: true` for long-running commands; without it the command must start the app and return. Stop runs `launcher.stop` with `{app}` replaced.

**Top level:** `launcher: { script, stop: "stop {app}", workspaceArg: "--workspace" | null }`; `setup: { label, cmd | launcher, timeoutMin }` (a one-time setup step: stacks can run it, and the Machine page's "Run setup" button uses it); `groups` (display order and labels); `defaultStack` (what a workspace's "Start stack" button starts).

**Stack steps**, in order: `{ "setup": true }` · `{ "start": ["id", …] }` or `{ "start": "rest" }` (the ones not started yet, in parallel) · `{ "wait": "all" | ["id"] }` (`"all"` = every app started so far) · `{ "cmd": "...", "label", "timeoutMin" }` · `{ "launcher": "...", "label", "timeoutMin" }`. No `steps` = start every app at once.

**Worktrees.** The Workspaces page lists main plus every worktree it finds: entries in the ports file, `worktrees.dir/*` folders with a `.worktree.json`, and native `git worktree`s of the workspace's repos. A git worktree of the root repo (a monorepo, or a workspace that is itself a repo) is a workspace; a git worktree of an app's repo counts when it sits at `<workspace>/<repo folder>`, so `git -C api worktree add ../trees/ENG-7/api` and `git -C web worktree add ../trees/ENG-7/web` make one workspace, `trees/ENG-7`. Its ticket comes from `.worktree.json` `ticketId`, else from the branch name (`issues.ticketPattern`). Repos shown per workspace: `.worktree.json` `repos`, else the repo holding each app's `dir`, else the root itself (`.`). A worktree gets a Start button for each stack it has an app of, not just `defaultStack`.

**Ports in a worktree** come from the ports file. Kept by the team's tooling, or, with `worktrees.ports`, allocated by the dashboard on first start (locked with `<portsFile>.lock`, created exclusively and broken after 10s, so a team script writing the same file can take the same lock). Validate checks offsets are unique, fit in a slot, and that the first ten slots don't land on main's ports or the dashboard's.

Port rules: unique across apps, not the dashboard's, and not a database's host port. Frameworks' defaults (Vite 5173, Next 3000, Angular 4200, Laravel/Django 8000, Rails 3000, Spring 8080) are fine when they don't clash.

## machine.json: the Machine page

```json
{
  "checks": [
    { "use": "package-manager" },
    { "use": "node", "required": { "file": "web/.nvmrc", "min": "20.0.0" }, "apps": ["web"] },
    { "use": "go", "required": { "file": "api/go.mod", "regex": "^go (\\d+\\.\\d+)" }, "apps": ["api"], "group": "Backend" },
    { "use": "git" }, { "use": "gh" }, { "use": "claude" },
    { "use": "docker", "group": "Services" },
    { "use": "docker-container", "id": "mysql", "name": "app-mysql-1", "port": 3306, "label": "MySQL ({image})",
      "image": { "file": "docker-compose.yml", "regex": "image:\\s*(mysql:[^\\s]+)" }, "apps": ["api"], "group": "Services" },
    { "use": "path", "id": "web-deps", "label": "web dependencies", "repo": "web", "path": "web/node_modules",
      "install": { "label": "npm ci", "win": "npm ci", "mac": "npm ci", "linux": "npm ci", "cwd": "web" }, "apps": ["web"] },
    { "use": "python", "optional": true, "when": { "exists": "scripts" }, "group": "Optional" }
  ]
}
```

Each check picks a catalog entry with `use` and overrides any field, or defines one with `kind`. Fields: `id` (defaults to `use`; unique), `group` (section; order = first appearance; default "Everyone"), `label` (`{required}`, `{major}`, `{image}` expand), `apps` (app ids that can't start while it's missing: their cards say "Needs …"), `required` (`"1.2"` or `{ file, regex?, min?, default? }`: read from a repo file; `min` is a floor), `optional` (absent = info, not missing), `when: { exists: "<dir>", os: "win"|"mac"|"linux" }`, `install: { label?, win, mac, linux, cwd? }` (runs in a visible terminal when the user clicks Install; `null` for an OS = no button), `fix` (copyable text; string or per OS), `detail: { ok, missing }`.

**Catalog ids** (`dashboard/server/src/machine-catalog.ts`): `package-manager` (winget/Homebrew), `node`, `npm`, `pnpm`, `yarn`, `bun`, `python`, `uv`, `php`, `composer`, `go`, `java`, `maven`, `gradle`, `ruby`, `bundler`, `cargo`, `dotnet`, `dotnet-dev-cert`, `dotnet-user-secrets` (`project`: a csproj with UserSecretsId), `git`, `gh`, `glab`, `claude` (installed **and signed in**, via `claude auth status`; signed out shows a Sign in button that opens a terminal running `claude auth login`), `curl`, `az`, `aws`, `gcloud`, `terraform`, `kubectl`, `docker`, `docker-container` (`name`, `port`, `image`; `setup: false` hides Run setup), `psql`, `mysql`, `redis-cli`, `path` (`path`, `repo`, `cloneFix`; `{exe}` = `.exe` on Windows), `npm-global` (`package`), `env-var` (`name`), `port` (`port`).

**Kinds** for custom checks: `command` (`probe: { cmd: "tool" | { win, mac, linux }, args: [], stream?: "out"|"err"|"both" }`, optional `auth: { cmd, args, detail, signIn: { label, win, mac, linux } }`), plus every kind above. Never put secrets in checks: secrets checks only look for a file and tell the user where it comes from.

Always include: `package-manager`, `node` (the dashboard itself needs it; floor 24.15.0), `git`, the code host CLI (`gh`/`glab`), `claude`. Then each stack's toolchain (from its version pins), `docker` + one `docker-container` per database/service the apps need, and one `path` check per app's installed dependencies.

## docs.json: the Docs page (and search)

```json
{
  "sources": [
    { "key": "handbook", "name": "Engineering handbook", "kind": "notes", "dir": "handbook" },
    { "key": "site", "name": "Docs site", "kind": "site", "dir": "docs-site", "live": "https://docs.acme.com/", "port": 4335 },
    { "key": "wiki", "name": "Confluence", "kind": "external", "url": "https://acme.atlassian.net/wiki", "provider": "confluence", "spaces": ["ENG"], "description": "Runbooks and specs" }
  ]
}
```

`notes` = a folder of Markdown, rendered in the page. `site` = a static-site repo (HTML); `port` serves the working copy locally for the Page view (pick unused ports), `live` links the published site. `external` = docs elsewhere (Confluence, Notion, Google Drive, SharePoint, a wiki): a card that opens `url`, and "Ask Claude" starts a read-only run that uses that service's MCP connector (the user connects it in Claude). Local sources are also indexed by search.

With a `provider` that has an adapter (`dashboard/server/src/docs-providers/`: `confluence` so far), an external source is also **searchable**: the Docs page searches it and shows its pages, global search (Ctrl+K) lists its matches, and Ask and the launch dialog get a **Use <name>** checkbox that tells the run to search it through the MCP connector and cite pages. Each person reads it with their own key, pasted on the Docs page (kept in `.claude/ledger/`), so they only see what their account can.
- **Confluence**: `"provider": "confluence"`, `url` = `https://<site>.atlassian.net/wiki`, optional `spaces` (space keys; empty = every non-personal space). Key: `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN`, the pasted `email:api-token`, or, when `issues.kind` is `jira` on the same site, the Jira key (nothing more to paste).

## reference.json: the Reference page

```json
{
  "title": "Infrastructure reference",
  "file": "infra/docs/environments.md",
  "lastUpdatedHeader": "Last Updated",
  "groups": [
    { "title": "Accounts", "rows": [{ "label": "AWS account", "header": "AWS Account" }, { "label": "Region", "regex": "region: `([a-z0-9-]+)`" }] },
    { "title": "Egress IPs", "table": "NAT gateways", "label": "Name", "value": "Public IP", "note": "Environment" },
    { "title": "Databases", "kv": [{ "heading": "Production DB", "label": "Production" }, { "heading": "Staging DB", "label": "Staging" }], "value": "Host", "note": ["Engine", "Size"] },
    { "title": "Allowed inbound", "extract": { "table": "Firewall", "column": "Allow", "pattern": "([^,()]+?)\\s*\\((\\d{1,3}(?:\\.\\d{1,3}){3}(?:/\\d{1,2})?)\\)", "noteColumn": "Service" } }
  ]
}
```

The page shows the groups as click-to-copy fact tables, then the whole doc. Group kinds: `rows` (`header` = a `**Header:** value` line; `regex` = first capture group anywhere; `table`+`key`+`match`+`value` = one cell of a key/value table), `table` (one row per row of the pipe table under that exact heading; `label` may be a list of columns (first non-empty wins); `firstOf` keeps the first of a comma list; `noteFromHeading` notes which table it came from), `kv` (one row per key/value table), `extract` (every regex match in one column; merged by label). A group whose table is missing just doesn't show. No `groups` = just the doc. No doc yet? Offer to write one with the user (hosts, IPs, environments, accounts) and point `file` at it.

## links.json: the Links page

```json
{
  "categories": [
    { "title": "Apps", "description": "Our apps by environment.", "tiles": [
      { "title": "Web", "description": "Customer app.", "icon": "🌐", "repo": "web", "edit": true,
        "links": [{ "label": "Production", "url": "https://app.acme.com" }, { "label": "Staging", "url": "https://staging.acme.com" }] },
      { "title": "Grafana", "icon": "📈", "url": "https://grafana.acme.com" }
    ] }
  ]
}
```

A tile has one `url` or several `links`. `url`s are `https://…`, `http://…` or a dashboard page (`/docs`, `/reference`). `repo` (a top-level workspace folder) adds Info (its README); `edit: true` adds Make edits (a Claude run in that repo). Users add, edit and delete tiles from the page, for the team (this file) or just themselves (`.claude/ledger/links.local.json`). Seed it from discovery: each app's prod/staging URLs (deploy configs, README), the code host org, the tracker, CI, cloud consoles, monitoring.

## deck.json: skill cards, routines, limits, Issues view

```json
{
  "limits": { "maxConcurrentRuns": 3, "pauseAtSessionPct": 90, "pauseAtWeeklyPct": 90 },
  "defaults": { "model": "opus", "effort": "medium" },
  "presets": [
    { "id": "brief", "label": "Morning brief", "icon": "sun", "description": "Open PRs, red CI, my issues. Read-only.",
      "prompt": "Give me a short morning brief: my open PRs and their checks (gh), failing CI on main, and my in-progress issues. End with the 3 things to do first. Don't change anything.",
      "permissionMode": "auto" },
    { "id": "implement", "label": "Implement ticket", "icon": "bolt", "description": "Run /implement on a ticket.",
      "prompt": "/implement {ticket}",
      "args": [{ "name": "ticket", "label": "Ticket", "placeholder": "ENG-123", "pattern": "^[A-Z][A-Z0-9]*-\\d+$" }],
      "options": [{ "name": "auto", "label": "Decide open questions on its own (--auto)", "append": " --auto", "default": false }],
      "permissionMode": "auto" }
  ],
  "issues": { "teams": ["Engineering"], "states": ["Todo", "In Progress", "In Review"], "implementPreset": "implement", "implementTeams": ["Engineering"] },
  "routines": [{ "id": "weekday-brief", "preset": "brief", "at": "08:30", "days": "weekdays", "enabled": false }]
}
```

Presets are the Home page's skill cards: `prompt` (with `{arg}` placeholders), `args` (`pattern` validates), `options` (checkboxes that `append` text), `model`/`effort`/`permissionMode` (`auto` | `acceptEdits` | `dontAsk` | `plan`), `budgetUsd` (only used when the per-run cap is on in Settings), `pickWorkspace`, `workspace`. Icons: `sun`, `download`, `eye`, `package`, `shield`, `bolt`, `terminal`, and the nav icons. `issues`: which teams (Linear teams / Jira projects / GitHub repos) and states the board shows (empty = all; states in column order), the preset Implement runs, and which teams get Implement (empty = all). `routines` fire presets on a schedule while the dashboard runs (off by default). Everyone can override limits and defaults for themselves on the Settings page.

## brand/: the look

`brand/theme.css` is served at `/ds/theme.css`, after the dashboard's neutral defaults (`/ds/tokens.css`). It `@import`s the team's token files (copied into `brand/` verbatim) and maps them onto the contract. Other files in `brand/` (the logo, favicon, fonts) are served at `/ds/<file>`. See `branding.md`.

## plan.json: input to scaffold.mjs

```json
{
  "workspace": { … }, "apps": { … }, "machine": { … }, "docs": { … }, "reference": { … }, "links": { … }, "deck": { … },
  "repos": [{ "name": "API", "url": "https://github.com/acme/api.git", "directory": "api", "dependencies": [] }],
  "skills": ["dashboard"],
  "claudeMd": true
}
```

Only `workspace` is required. scaffold never overwrites an existing config file unless `--force`.

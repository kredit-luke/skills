# How the dashboard works

Read this when you need to change the engine, debug it, or explain a behavior. Everything here is the engine in `dashboard/`; nothing in it is team-specific.

## Shape

- **Server**: `dashboard/server/src/main.ts`, plain `node:http`, TypeScript run directly by Node ≥ 24 (type stripping; no server build, no npm dependencies). JSON API under `/api` (contract: `dashboard/shared/api.ts`), SSE for streaming run output, the built UI from `dashboard/dist/browser` (re-read from disk, so a UI rebuild needs no restart).
- **UI**: Angular (standalone components, signals, zoneless), no component library; global styles in `web/src/styles.scss`, pages under `web/src/app/pages/`. Built once on first start by `bin/dashboard.mjs`.
- **Config**: `server/src/config.ts` reads `.claude/dashboard/*.json` (cached by mtime). Each module reads its own file: `apps.ts`, `machine.ts` (+ `machine-catalog.ts`), `docs.ts` (+ `docs-providers/*`), `reference.ts`, `links.ts`, `deck.ts`, `issues/*`.
- **State**: `.claude/ledger/` (gitignored): `runs/<id>.json` + `.events.jsonl`, `apps/` job logs, `attachments/`, `settings.json`, tracker keys, `dashboard-token`, `dashboard.log`, `links.local.json`, `usage-snapshots.jsonl`.
- **Start/stop**: `bin/dashboard.mjs` (npm ci / ng build when stale, then a detached server; pid in the ledger).

## Runs (the heart of it)

A run is a conversation; **each turn is a new `claude -p` process**:
`claude -p <prompt> --output-format stream-json --verbose --session-id <uuid> | --resume <uuid> --permission-mode <mode> --permission-prompts none --append-system-prompt <HEADLESS_RULES [+ PLAN_MODE_RULE]> [--model] [--effort] [--max-budget-usd] [--add-dir <attachments>]`

- **Questions**: headless Claude can't use AskUserQuestion, so `HEADLESS_RULES` (in `runs.ts`) tells it to end the turn with `<<QUESTION>>{"questions":[…]}<</QUESTION>>`. The server strips it from the transcript, sets the run to `waiting`, and the page renders the options as buttons; the answer is the next turn.
- **Permissions**: `--permission-prompts none` denies anything that would prompt. Work that needs approvals belongs in a terminal ("Continue in terminal" hands the session to `claude --resume`).
- **Background work dies with the turn**: anything started with `run_in_background`, cron/loop schedules or monitors is killed when the process exits. The rules forbid it; the server flags runs that tried (`Background work stopped`).
- **PR watches** replace PR-monitor loops: Claude does one check, then ends the turn with `<<WATCH>>{"prs":["owner/repo#123"],"everyMinutes":5,"prompt":"…"}<</WATCH>>`. The watch is stored on the run (`RunMeta.watch`), and `server/src/watches.ts` checks the PRs with `gh` every 30 s tick once they're due. It wakes the run (a reply with the changes, then the prompt) only on a new review or comment from someone else, failing checks, a review-decision change, the branch going behind or conflicting, or checks passing on an approved PR. It checks only while the run is idle and done. It ends when every PR is merged or closed, after `days` (7 by default), after 100 wake-ups, on `<<WATCH>>{"stop":true}<</WATCH>>`, or from the run page's Stop watching.
- **Plan mode** is a per-run switch applied each turn.
- **Limits**: concurrent runs, and new runs pause when `/usage` says the session or weekly window is past the threshold; optional per-run cap (`--max-budget-usd`). `total_cost_usd` in results is cumulative across resumed turns (don't sum it).
- **Environment**: runs get the user's environment minus Claude session markers. `ANTHROPIC_API_KEY` is also removed when this machine is signed in to a Claude subscription (so a stray key can't silently switch runs to per-token billing), and kept when it isn't (teams on an API key, Bedrock or Vertex). Sign-in state comes from `claude auth status` (`server/src/claude.ts`, cached a minute); runs refuse to start with a clear message while Claude is missing or signed out.
- **Changes tab**: each turn snapshots every repo's HEAD + `git stash create` + untracked list; the tab diffs against the first snapshot.
- Restarting the dashboard kills in-flight turns (marked `interrupted`; replying resumes). Apps it started keep running.

## Apps

`apps.ts` runs `launch.cmd` (or the team's launcher) through a **two-hop launcher**: a detached `node -e` that starts the app non-detached with `windowsHide`, so the app gets a hidden console its children inherit (no terminal windows popping up on Windows) and survives dashboard restarts. "Up" = something answers on the app's port (IPv4 or IPv6). Each start/stop is a job with steps and a log.

## Workspaces

`workspaces.ts` finds them (ports file, `worktrees/*/.worktree.json`, and `git worktree list` on the root repo and each app's repo, cached 10s), their repos, and ports. A worktree's own port for an app comes from the ports file; with `worktrees.ports` set, `ensureSlot` allocates one on the first start, under `<portsFile>.lock`. `"fallback": "main"` is resolved when a command is launched: `{{port:<id>}}` names the worktree's instance if it answers on its port or is in the stack being started, else main's. A worktree stack starts (or reuses) main's instance of a fallback app it hasn't cloned; stopping that stack leaves main's alone.

## Security

The server can start processes as the user, so no other origin may reach it. Hosted mode (`hosted.ts`, [hosting.md](hosting.md)) replaces the loopback and Host/Origin checks with its own: the login proxy's secret on every request, the public Host and Origin, and the signed-in email matching the container's owner. Locally it binds 127.0.0.1 only; the `Host` header must be `localhost`/`127.0.0.1` on its port (DNS rebinding); foreign `Origin`s get 403; every POST needs the per-install token from `/api/boot` (same-origin only). Install buttons and app commands come only from config files, never from the browser (it sends an id). Explore and brand/file serving refuse paths outside their roots and `.git`. Tracker keys never go to the browser.

## Pitfalls we've hit

- **After an engine update the page looks broken** (empty lists, missing brand): the old server process is serving the new UI. Restart it.
- **Don't restart the dashboard from a run inside it**: that kills the run. Ask the user to do it in a terminal.
- **`(event)="cond && doSomething()"` in an Angular template** returns `false` when `cond` is false, and a `false` from a handler calls `preventDefault`, which breaks every input inside. Handlers return nothing.
- **Injecting `Router` into a custom `TitleStrategy`** is a DI cycle (NG0200, blank page). Keep a reference to the last snapshot instead.
- **Windows**: `.cmd` shims (npm, az, composer) need a shell to run; `cmd.exe` mangles `^` and `$` in arguments, so only fall back to a shell when the plain exec fails. `jq` output has CRLF.
- **Never kill terminal processes** (WindowsTerminal, conhost) to stop something: kill the app's own process tree or whatever listens on its port.
- **A `.gitignore` that starts with `*`** (allow-list style) hides new top-level folders until `!folder/` and `!folder/**` are added; scaffold adds the dashboard's.
- **Node version**: the dashboard needs ≥ 24.15 (type stripping, Angular 22). An older default Node shadowing a newer nvm one is common; `bin/dashboard.mjs` picks the nvm one.

## Searchable docs

`docs-providers/` reads external docs (Confluence first) with each person's own key: `/api/docs/external/*` for status, connect, search, a page, and search-all (global search, connected sources only). Page HTML is rendered through Angular's sanitizer, never bypassed. "Use <source>" on a run stores the sources on the run and appends each provider's `runNote` to the system prompt on every turn, which points Claude at that service's MCP tools; the dashboard's own key never reaches Claude.

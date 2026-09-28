# How the dashboard works

Read this when you need to change the engine, debug it, or explain a behavior. Everything here is the engine in `dashboard/`; nothing in it is team-specific.

## Shape

- **Server**: `dashboard/server/src/main.ts`, plain `node:http`, TypeScript run directly by Node ≥ 24 (type stripping; no server build, no npm dependencies). JSON API under `/api` (contract: `dashboard/shared/api.ts`), SSE for streaming run output, the built UI from `dashboard/dist/browser` (re-read from disk, so a UI rebuild needs no restart).
- **UI**: Angular (standalone components, signals, zoneless), no component library; global styles in `web/src/styles.scss`, pages under `web/src/app/pages/`. Built once on first start by `bin/dashboard.mjs`.
- **Config**: `server/src/config.ts` reads `.claude/dashboard/*.json` (cached by mtime). Each module reads its own file: `apps.ts`, `machine.ts` (+ `machine-catalog.ts`), `docs.ts`, `reference.ts`, `links.ts`, `deck.ts`, `issues/*`.
- **State**: `.claude/ledger/` (gitignored): `runs/<id>.json` + `.events.jsonl`, `apps/` job logs, `attachments/`, `settings.json`, tracker keys, `dashboard-token`, `dashboard.log`, `links.local.json`, `usage-snapshots.jsonl`.
- **Start/stop**: `bin/dashboard.mjs` (npm ci / ng build when stale, then a detached server; pid in the ledger).

## Runs (the heart of it)

A run is a conversation; **each turn is a new `claude -p` process**:
`claude -p <prompt> --output-format stream-json --verbose --session-id <uuid> | --resume <uuid> --permission-mode <mode> --permission-prompts none --append-system-prompt <HEADLESS_RULES [+ PLAN_MODE_RULE]> [--model] [--effort] [--max-budget-usd] [--add-dir <attachments>]`

- **Questions**: headless Claude can't use AskUserQuestion, so `HEADLESS_RULES` (in `runs.ts`) tells it to end the turn with `<<QUESTION>>{"questions":[…]}<</QUESTION>>`. The server strips it from the transcript, sets the run to `waiting`, and the page renders the options as buttons; the answer is the next turn.
- **Permissions**: `--permission-prompts none` denies anything that would prompt. Work that needs approvals belongs in a terminal ("Continue in terminal" hands the session to `claude --resume`).
- **Background work dies with the turn**: anything started with `run_in_background`, cron/loop schedules or monitors is killed when the process exits. The rules forbid it; the server flags runs that tried (`Background work stopped`).
- **Plan mode** is a per-run switch applied each turn.
- **Limits**: concurrent runs, and new runs pause when `/usage` says the session or weekly window is past the threshold; optional per-run cap (`--max-budget-usd`). `total_cost_usd` in results is cumulative across resumed turns (don't sum it).
- **Environment**: runs get the user's environment minus Claude session markers and minus `ANTHROPIC_API_KEY` (so they use the subscription, never silent per-token billing).
- **Changes tab**: each turn snapshots every repo's HEAD + `git stash create` + untracked list; the tab diffs against the first snapshot.
- Restarting the dashboard kills in-flight turns (marked `interrupted`; replying resumes). Apps it started keep running.

## Apps

`apps.ts` runs `launch.cmd` (or the team's launcher) through a **two-hop launcher**: a detached `node -e` that starts the app non-detached with `windowsHide`, so the app gets a hidden console its children inherit (no terminal windows popping up on Windows) and survives dashboard restarts. "Up" = something answers on the app's port (IPv4 or IPv6). Each start/stop is a job with steps and a log.

## Security

The server can start processes as the user, so no other origin may reach it: it binds 127.0.0.1 only; the `Host` header must be `localhost`/`127.0.0.1` on its port (DNS rebinding); foreign `Origin`s get 403; every POST needs the per-install token from `/api/boot` (same-origin only). Install buttons and app commands come only from config files, never from the browser (it sends an id). Explore and brand/file serving refuse paths outside their roots and `.git`. Tracker keys never go to the browser.

## Pitfalls we've hit

- **After an engine update the page looks broken** (empty lists, missing brand): the old server process is serving the new UI. Restart it.
- **Don't restart the dashboard from a run inside it**: that kills the run. Ask the user to do it in a terminal.
- **`(event)="cond && doSomething()"` in an Angular template** returns `false` when `cond` is false, and a `false` from a handler calls `preventDefault`, which breaks every input inside. Handlers return nothing.
- **Injecting `Router` into a custom `TitleStrategy`** is a DI cycle (NG0200, blank page). Keep a reference to the last snapshot instead.
- **Windows**: `.cmd` shims (npm, az, composer) need a shell to run; `cmd.exe` mangles `^` and `$` in arguments, so only fall back to a shell when the plain exec fails. `jq` output has CRLF.
- **Never kill terminal processes** (WindowsTerminal, conhost) to stop something: kill the app's own process tree or whatever listens on its port.
- **A `.gitignore` that starts with `*`** (allow-list style) hides new top-level folders until `!folder/` and `!folder/**` are added; scaffold adds the dashboard's.
- **Node version**: the dashboard needs ≥ 24.15 (type stripping, Angular 22). An older default Node shadowing a newer nvm one is common; `bin/dashboard.mjs` picks the nvm one.

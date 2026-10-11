## Workspace dashboard

A local dashboard at http://localhost:{{port}} is home base for this workspace: Claude runs (with questions answered from the page), the issue board, starting and stopping the apps, machine setup checks, docs, links and the team's infrastructure. It runs on this machine only.

- **Start it:** `node {{engineDir}}/bin/dashboard.mjs start --open` (first start installs packages and builds the UI; after that it takes a second and keeps running when the terminal closes). `stop`, `restart` (after pulling updates) and `status` work the same way.
- **Start or stop the apps through it:** `node {{engineDir}}/bin/dashboard.mjs apps start --stack <id>` (or `--app <id>`; also `apps stop`, `apps restart --app <id>`, `apps status` for the ids and what's up). It does what the Apps page does, for the workspace or worktree you're in: the apps run detached, so they keep running after the terminal or Claude session ends.
- **Its code is `{{engineDir}}/`, its config is `.claude/dashboard/`.** Everything about this team (apps and ports, machine checks, docs, links, issue tracker, brand) is in the JSON files there; change those, not the code, and the page picks it up on reload. The port is `dashboard.port` in `.claude/dashboard/workspace.json` (a `DASHBOARD_PORT` env var overrides it on one machine).
- **Local state** (run history, your settings, API keys you pasted, personal links) lives in `.claude/ledger/`, which is never committed.
- **Runs started from the dashboard are headless:** they can't answer permission prompts, and anything left running in the background when a turn ends is stopped (apps started with `apps start` above keep running). Ask questions with the dashboard's question block rather than AskUserQuestion; the dashboard explains this to each run itself.
- **Updating the engine:** the `natterjack` plugin's `upgrade` skill merges a newer dashboard into `{{engineDir}}/`, keeping local changes.

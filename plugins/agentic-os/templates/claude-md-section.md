## Workspace dashboard

A local dashboard at http://localhost:{{port}} is home base for this workspace: Claude runs (with questions answered from the page), the issue board, starting and stopping the apps, machine setup checks, docs, links and a quick reference. It runs on this machine only.

- **Start it:** `node dashboard/bin/dashboard.mjs start --open` (first start installs packages and builds the UI; after that it takes a second and keeps running when the terminal closes). `stop`, `restart` (after pulling updates) and `status` work the same way.
- **Its code is `dashboard/`, its config is `.claude/dashboard/`.** Everything about this team (apps and ports, machine checks, docs, links, issue tracker, brand) is in the JSON files there; change those, not the code, and the page picks it up on reload. The port is `dashboard.port` in `.claude/dashboard/workspace.json` (a `DASHBOARD_PORT` env var overrides it on one machine).
- **Local state** (run history, your settings, API keys you pasted, personal links) lives in `.claude/ledger/`, which is never committed.
- **Runs started from the dashboard are headless:** they can't answer permission prompts, and anything left running in the background when a turn ends is stopped. Ask questions with the dashboard's question block rather than AskUserQuestion; the dashboard explains this to each run itself.
- **Updating the engine:** the `agentic-os` plugin's `upgrade` skill merges a newer dashboard into `dashboard/`, keeping local changes.

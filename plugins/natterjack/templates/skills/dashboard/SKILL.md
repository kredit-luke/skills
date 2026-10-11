---
name: {{skill}}
description: Start, stop, restart or check the workspace dashboard (the local web console for runs, issues, apps, machine setup, docs and links), and start or stop the workspace's apps through it so they keep running. Use when the user wants to open, start, launch, restart, reload, stop or check the dashboard, or after pulling updates to {{engineDir}}/. Also use when a dashboard page looks broken right after an update (it usually just needs a restart), and to start, stop or check the workspace's apps or stacks (dev servers) from a terminal or a dashboard run.
argument-hint: "[start|stop|restart|status|apps ...]"
---

# Workspace dashboard

The dashboard lives in `{{engineDir}}/` (code) and `.claude/dashboard/` (this team's config). One script runs it:

```bash
node {{engineDir}}/bin/dashboard.mjs start --open   # install + build if needed, run detached, open the browser
node {{engineDir}}/bin/dashboard.mjs status
node {{engineDir}}/bin/dashboard.mjs restart        # after pulling changes to {{engineDir}}/
node {{engineDir}}/bin/dashboard.mjs stop
```

The same script starts and stops the workspace's **apps** through the running dashboard, exactly as its Apps page does (detached: they keep running after this terminal or Claude session ends, and show on the Apps page with their logs):

```bash
node {{engineDir}}/bin/dashboard.mjs apps status                    # the apps, their ports, up or down; the stack and app ids
node {{engineDir}}/bin/dashboard.mjs apps start --stack <id>        # or --app <id>; waits until they're up (or failed)
node {{engineDir}}/bin/dashboard.mjs apps stop --stack <id>         # or --app <id>
node {{engineDir}}/bin/dashboard.mjs apps restart --app <id>
node {{engineDir}}/bin/dashboard.mjs apps stop-all                  # every app in the workspace
node {{engineDir}}/bin/dashboard.mjs apps setup                     # the apps.json setup step
```

They act on the workspace holding the current folder (a worktree's own, else main); `--workspace <slug or path>` picks another. `--no-wait` returns once the job is accepted; `--timeout <sec>` caps the wait (default 540, under a headless run's 10-minute command limit; the job carries on in the dashboard if the wait ends first). Exit code 0 = it worked, 1 = it failed (the error and the log's path are printed), 2 = bad arguments. The dashboard must be running (start it first); it isn't available in a hosted dashboard.

Pick the command from what the user asked; `start` is the default. Run it in the foreground: the first start installs packages and builds the UI (a minute or two) and prints progress; after that it returns in a second. The server then keeps running on its own, so never use `run_in_background` for it.

Things to know:
- The port is `dashboard.port` in `.claude/dashboard/workspace.json` (default 3333). A `DASHBOARD_PORT` environment variable overrides it for one machine; `--port N` overrides it for one start.
- **Restarting or stopping ends any Claude run in progress in the dashboard** (it shows as interrupted, and replying to it carries on). If you are yourself running inside the dashboard (a headless run), don't restart it: that would end this run. Tell the user to use the restart link at the bottom of the dashboard's sidebar (or run the command in a terminal) instead.
- It needs Node.js at the version in `{{engineDir}}/package.json` `engines` or newer. If the default `node` is older, the script uses a newer one installed with nvm; if there isn't one, it says how to install it.
- If a page is empty or says "not set up", the matching file in `.claude/dashboard/` is missing or wrong; the page says which. Edits to those files apply on the next page load, no restart needed (except the port).
- Logs: `.claude/ledger/dashboard.log`.

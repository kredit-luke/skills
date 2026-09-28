---
name: doctor
description: Check a workspace's agentic-OS dashboard end to end - config valid and consistent, Node version, dashboard built and running on its port, engine up to date, repos cloned, machine requirements, issue tracker connected - and fix what's wrong. Use when the dashboard won't start, a page is empty or broken, after changing .claude/dashboard config, after cloning the workspace on a new machine, or when the user asks to check, diagnose or health-check the dashboard.
argument-hint: "[workspace folder]"
---

# Doctor

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" <workspace>
```

It runs `validate.mjs` (every `.claude/dashboard/*.json` against the engine and the workspace) and then checks this machine: Node version, dashboard packages/build, whether it's running on its port (and is *this* workspace's dashboard), whether this plugin copy is the latest release (Claude Code doesn't refresh cached plugins; the fix is the `claude plugin ... update` commands it prints, then a restart of Claude Code), engine version vs the plugin's, repos from repos.json cloned, `gh` signed in, and, if the dashboard is up, its own Machine and Issues status. Every problem comes with a fix.

Work through them in order: config errors first (a broken file blanks its page), then install/build, then start (`node <workspace>/dashboard/bin/dashboard.mjs start`), then what the running dashboard reports. For config, `${CLAUDE_PLUGIN_ROOT}/references/config.md` has every field. Machine-page problems are usually for the user to install (each check shows the command); don't run installers yourself unless asked. Re-run doctor at the end and report what's fixed and what's left.

Common causes:
- **Page empty right after an update**: the dashboard is still the old process serving the new UI. Restart it (ask the user to, if you're running inside it).
- **Port in use / another workspace's dashboard answering**: give this workspace its own `dashboard.port` in workspace.json (or `DASHBOARD_PORT` for one machine).
- **Brand not showing**: `brand/theme.css` missing, or it imports a file that isn't in `brand/` (validate flags it).
- **Issues not connected**: the Issues page shows the tracker's own connect steps; keys stay in `.claude/ledger/`.

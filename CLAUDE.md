# skills

A marketplace of Claude Code plugins (see README.md). The main one is `natterjack` (`plugins/natterjack/`, formerly agentic-os): skills, scripts and the dashboard engine (`engine/`) they install into team workspaces. Everything in the engine stays generic; team specifics belong in a workspace's `.claude/dashboard/` config.

## Dogfood dashboard

This repo runs the engine on itself, so engine changes can be tried without a team workspace.

- **Set up once:** link `dashboard/` to the engine (it's gitignored): `cmd /c mklink /J dashboard plugins\natterjack\engine` on Windows, `ln -s plugins/natterjack/engine dashboard` elsewhere. Edits under `plugins/natterjack/engine/` are the shipped engine; there's no copy to sync back.
- **Start it:** `node dashboard/bin/dashboard.mjs start --open` (http://localhost:3335; `--restart` after changing server code, `npm run build` in the engine or a restart after UI changes). The Apps page's "Dashboard UI (dev server)" runs `ng serve` on :4339 for live UI reloads.
- **Config** is `.claude/dashboard/` (committed, as an example workspace config); local state is `.claude/ledger/` (never committed). `.claude/dashboard/engine.json` is ignored here: this workspace always runs the engine source, so `upgrade` doesn't apply.
- **Check it:** `node plugins/natterjack/scripts/validate.mjs .` and `node plugins/natterjack/scripts/doctor.mjs .`.

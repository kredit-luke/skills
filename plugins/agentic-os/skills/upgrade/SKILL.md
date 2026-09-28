---
name: upgrade
description: Update a workspace's agentic-OS dashboard (dashboard/) to the engine version this plugin ships, keeping the team's own changes via a three-way merge. Use when the user wants to upgrade, update or refresh the dashboard engine, pull in new dashboard features, or when doctor says a newer engine is available.
argument-hint: "[workspace folder]"
---

# Upgrade the dashboard engine

The team's dashboard is a copy of this plugin's engine (`${CLAUDE_PLUGIN_ROOT}/engine/`) that they may have changed. `.claude/dashboard/engine.json` records the version they installed; that version is the merge base. Their config (`.claude/dashboard/*.json`, `brand/`) is never touched.

1. **Check the tree is clean first**: `git -C <workspace> status --short dashboard/`. If there are uncommitted changes there, ask the user to commit or stash them (so the upgrade is one reviewable diff), or get their OK to proceed.
2. **Dry run** and show the user what will happen:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade.mjs" <workspace> --dry
   ```
   `updated` = new engine files replacing untouched ones; `keptLocal` = their changes the new engine doesn't touch; `merged` = both changed, merged cleanly; `conflicts` = both changed the same lines; `added` / `deleted` = new or removed engine files. It fetches the old version from the release tag (`agentic-os-v<version>`); if that fails (offline), it says so. Don't guess without a base.
3. **Run it** without `--dry`. For each conflict, open the file, look at both sides (`yours` = the team's, `new engine` = upstream) and resolve it so both intents survive; ask the user when it's a real choice.
4. **Verify**: `cd <workspace>/dashboard && npm ci && npm test`, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" <workspace>` (new engine versions can add config options; the warnings say what's new).
5. **Restart** the dashboard: `node <workspace>/dashboard/bin/dashboard.mjs restart`. This ends any Claude run in progress in the dashboard, so if you are running inside it (headless), ask the user to run it in a terminal instead.
6. Summarize what changed and offer to commit (`dashboard/` and `.claude/dashboard/engine.json` together).

If `engine.json` is missing (the workspace predates this skill, or was set up by hand), ask which engine version it started from and pass `--base <folder with that engine>`, or treat it as a fresh install: back up `dashboard/`, run `scaffold.mjs --force`, and re-apply their changes from the backup by hand.

---
name: upgrade
description: Update a workspace's Natterjack dashboard engine (natterjack/, or wherever engine.json `dir` says) to the engine version this plugin ships, keeping the team's own changes via a three-way merge. Use when the user wants to upgrade, update or refresh the dashboard engine, pull in new dashboard features, or when doctor says a newer engine is available.
argument-hint: "[workspace folder]"
---

# Upgrade the dashboard engine

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`, `references/` and `engine/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`) wherever it appears.

The team's dashboard is a copy of this plugin's engine (`${CLAUDE_PLUGIN_ROOT}/engine/`) that they may have changed. `.claude/dashboard/engine.json` records the version they installed (the merge base) and its folder, `dir` (`<engine>` below; no `dir` means `dashboard/`, from before the folder was configurable). Their config (`.claude/dashboard/*.json`, `brand/`) is never touched.

1. **Get the latest plugin first.** Claude Code caches plugins and doesn't refresh them by itself, so this copy may be behind the latest release, and it would then "upgrade" to an old engine. Refresh it:
   ```bash
   claude plugin marketplace update <marketplace>
   claude plugin update natterjack@<marketplace>
   ```
   In GitHub Copilot CLI: `copilot plugin marketplace update <marketplace>` then `copilot plugin update natterjack@<marketplace>`. In OpenAI Codex CLI: `codex plugin marketplace upgrade <marketplace>`. (A local marketplace folder is read live: nothing to update.)
   (`<marketplace>` is the folder above `natterjack/` in `${CLAUDE_PLUGIN_ROOT}`, normally `lhoezee-skills`.) If it updated, this running skill still points at the old folder: use the new one for every script below. It's the sibling folder named after the new version (`<CLAUDE_PLUGIN_ROOT>/../<new version>/`); call it `$ROOT`, otherwise `$ROOT` is `${CLAUDE_PLUGIN_ROOT}`. Tell the user to restart Claude Code afterwards so the skills load from the new copy.
2. **Check the tree is clean**: `git -C <workspace> status --short <engine>/`. If there are uncommitted changes there, ask the user to commit or stash them (so the upgrade is one reviewable diff), or get their OK to proceed.
3. **Dry run** and show the user what will happen:
   ```bash
   node "$ROOT/scripts/upgrade.mjs" <workspace> --dry
   ```
   It checks the source repo for the newest release first. `stale: true` means this plugin copy is still behind: run the `update` commands it lists and use `newRoot`. Don't pass `--allow-stale` unless the user wants to stay on an older release. `downgrade: true` means the workspace already runs a newer engine than this copy: update the plugin, never force it. A `note` saying it couldn't reach the repo means it's offline; say so, since the upgrade then only goes as far as this copy.

   `updated` = new engine files replacing untouched ones; `keptLocal` = their changes the new engine doesn't touch; `merged` = both changed, merged cleanly; `conflicts` = both changed the same lines; `added` / `deleted` = new or removed engine files. It fetches the old version from the release tag (`natterjack-v<version>`); if that fails (offline), it says so. Don't guess without a base.
4. **Run it** without `--dry`. For each conflict, open the file, look at both sides (`yours` = the team's, `new engine` = upstream) and resolve it so both intents survive; ask the user when it's a real choice.
5. **Verify**: `cd <workspace>/<engine> && npm ci && npm test`, then `node "$ROOT/scripts/validate.mjs" <workspace>` (new engine versions can add config options; the warnings say what's new).
6. **Restart** the dashboard: `node <workspace>/<engine>/bin/dashboard.mjs restart`. This ends any Claude run in progress in the dashboard, so if you are running inside it (headless), ask the user to run it in a terminal instead.
7. Summarize what changed and offer to commit (`<engine>/` and `.claude/dashboard/engine.json` together).

If `engine.json` is missing (the workspace predates this skill, or was set up by hand), ask which engine version it started from and pass `--base <folder with that engine>`, or treat it as a fresh install: back up `dashboard/`, run `scaffold.mjs --force` (with `--engine-dir dashboard` to keep it there), and re-apply their changes from the backup by hand.

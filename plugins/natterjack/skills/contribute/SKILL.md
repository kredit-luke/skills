---
name: contribute
description: Send improvements a team made to its agentic-OS dashboard engine (dashboard/) back upstream as a pull request to the agentic-os plugin, so every team gets them on upgrade. Use when the user wants to contribute, upstream, share or send back a dashboard change, a new tracker adapter, machine-catalog entries or a fix.
argument-hint: "[workspace folder]"
---

# Contribute engine changes upstream

Only the **engine** goes upstream (`dashboard/`). The team's config and brand (`.claude/dashboard/`) stay theirs.

1. **See what changed** since the installed version:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/engine-diff.mjs" <workspace> --out <scratch>/engine.patch
   ```
2. **Pick what's general.** Go through the changed files with the user. Upstream-worthy: bug fixes, new adapters, catalog entries, features any team could use. Not: anything naming their company, product, people, repos, hosts or brand. Those belong in config; if a change hardcodes something team-specific, generalize it into a config option first (and document it in `references/config.md`).
3. **Prepare the PR** against https://github.com/lhoezee/skills with the `gh` CLI: fork (`gh repo fork lhoezee/skills --clone`), branch, apply the chosen changes under `plugins/agentic-os/engine/` (`git apply --directory=plugins/agentic-os/engine <patch>`, or copy the files), and check them the way the maintainer will: from the fork, `cd plugins/agentic-os/engine && npm ci && npm test`, and that nothing names your team, product, people or internal repos (the maintainer also checks a private denylist before each release). Update `references/` if behavior or config changed.
4. **Show the user the diff and the PR text before opening it.** Opening a PR publishes their code publicly: get an explicit yes. Then `gh pr create` with a description of what changed and why, and how it was tested.

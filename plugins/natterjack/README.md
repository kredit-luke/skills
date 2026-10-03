<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/natterjack-wordmark-on-dark.svg">
    <img src="assets/natterjack-wordmark.svg" alt="Ask Natterjack" width="320">
  </picture>
</p>

<p align="center"><b>Where the business meets the codebase.</b></p>

<p align="center">
  <a href="https://asknatterjack.com">asknatterjack.com</a> ·
  <a href="#install">Install</a> ·
  <a href="#skills">Skills</a> ·
  <a href="#maintaining">Maintaining</a>
</p>

---

Natterjack is a Claude Code plugin that turns your team's repos into one workspace with a local **dashboard**. Engineers run apps and Claude from the browser, and everyone else can ask the code questions directly.

- **Runs**: start Claude from the browser (type `/` in any chat box to pick a skill or command); when it needs a decision it asks on the page (buttons), and every run shows its transcript, subagents, and the code it changed. Type while Claude works and your message is queued for when the turn ends (edit or remove it until then), like typing ahead in the CLI. Turn on **Auto-send** and it goes out even if Claude stops to ask a question, so you can walk away.
- **Issues**: your tracker's board (Linear, Jira or GitHub Issues), with **Explain** (read-only, against the real code) and **Implement** (runs your `/implement` skill).
- **Apps & Workspaces**: start and stop your apps and stacks in the right order, per worktree, with logs.
- **Connections**: every MCP server Claude can reach (claude.ai connectors, plugins, your own), whether it's working, and one-click fixes: sign in, approve, add, and let dashboard runs use it.
- **Machine**: what this computer needs for your stack (Node, Go, PHP, Python, .NET, Java, Docker, databases…), checked live, with one-click installs.
- **Knowledge**: what the business knows, by area (Company, Customers, Finance…): notes in your own S3, Google Cloud Storage or Azure bucket that anyone can edit from the page (no GitHub seat needed), docs in the repos, and links to Notion, Confluence or Drive with whether Claude can reach them. Obsidian-style links, backlinks, tags and review dates; Claude reads all of it.
- **Links, Infrastructure**: link tiles anyone can add to (for the team or just themselves), and your infrastructure (accounts, environments, URLs, databases, IPs) with click-to-copy values.
- **Search, Skills, Usage, Memory, Explore, Settings**: search everything without spending tokens, run skills as cards, see plan usage, browse and edit files.

It's tailored to your team by **discovery, not forms**: Claude scans your repos (stacks, ports, run commands, databases, CI, deploy targets, ticket keys in your branches, your design system), asks only what it couldn't work out, and writes the config. The dashboard itself is a finished engine copied into your workspace. You own that copy (change anything), and `upgrade` merges newer versions around your changes.

## Install

In Claude Code:

```
/plugin marketplace add lhoezee/skills
/plugin install natterjack@lhoezee-skills
```

(or from a shell: `claude plugin marketplace add lhoezee/skills` and `claude plugin install natterjack@lhoezee-skills`)

Then, in the folder that holds (or will hold) your team's repos:

```
/natterjack:create
```

Needs: Claude Code, Git, and Node.js 24.15 or newer (the dashboard's Machine page helps with the rest).

### Coming from agentic-os

Natterjack was called `agentic-os` up to 0.7.1. Swap the plugin, then upgrade as usual:

```
claude plugin marketplace update lhoezee-skills
claude plugin uninstall agentic-os@lhoezee-skills
claude plugin install natterjack@lhoezee-skills
```

Existing workspaces keep their engine in `dashboard/` and their `/dashboard` skill; nothing moves. `/natterjack:upgrade` merges from the old `agentic-os-v<version>` release like any other.

## Skills

| Skill | What it does |
|---|---|
| `/natterjack:create` | Discover the workspace, interview you, install the dashboard and write its config, brand it, start it. |
| `/natterjack:doctor` | Check config, build, port, engine version, tracker connection and machine; fix what's wrong. |
| `/natterjack:upgrade` | Merge the latest dashboard engine into your copy, keeping your changes. |
| `/natterjack:add-adapter` | Support another issue tracker (Azure Boards, Shortcut, GitLab…) or code host. |
| `/natterjack:contribute` | Send your engine improvements back as a PR. |

## What ends up in your workspace

```
your-workspace/
├── natterjack/              the engine (Node server + Angular UI); yours to change
├── .claude/dashboard/       your config: workspace, apps, machine, docs, reference, links, deck (.json) + brand/
├── .claude/skills/natterjack/ the /natterjack skill (start / stop / restart)
├── .claude/ledger/          local state: run history, keys you paste, personal links (never committed)
├── CLAUDE.md                gets a "Workspace dashboard" section
└── repo-a/, repo-b/, …      your repos, side by side
```

The engine's folder is yours to choose when you create it: `natterjack/` by default, or anything else if that name is taken (`tools/natterjack`, `ops-console`…). The workspace skill is named after its last part. The choice is recorded in `.claude/dashboard/engine.json` (`dir`), and `upgrade` and `doctor` follow it.

Start it any time with `node natterjack/bin/dashboard.mjs start --open` (default http://localhost:3333; set `dashboard.port` in `.claude/dashboard/workspace.json`, or `DASHBOARD_PORT` on one machine).

## Maintaining

This folder is the source of truth for the engine: `engine/`. Change it here (directly, or by a PR from a fork; `/natterjack:contribute` prepares one from a workspace's edits), and workspaces, including the ones it's developed from, pick releases up with `/natterjack:upgrade`. This repo runs the engine on itself as a dogfood dashboard; see the root `CLAUDE.md`.

To release:

1. Run the tests: `node --test plugins/natterjack/scripts/test/*.test.mjs`, and the engine's own: `cd plugins/natterjack/engine && npm ci && npm test`.
2. Bump the engine version in `engine/package.json` and `engine/ENGINE.json`, and the plugin's in `.claude-plugin/plugin.json` (it can run ahead of the engine for script-only fixes; engine releases set both).
3. `claude plugin validate .` (from the repo root), commit, and tag **the commit that bumps the version**:

```bash
git tag natterjack-v0.8.0 && git push origin main --tags
```

The tag matters: a workspace's `upgrade` fetches the version it installed (by tag) as the merge base, so a tag on an earlier commit makes the version files look like local edits. Releases up to 0.7.1 are tagged `agentic-os-v<version>` with the engine under `plugins/agentic-os/`; `scripts/lib.mjs` (`RELEASE_LAYOUTS`) still finds them.

`tools/sync-engine.mjs <workspace>/<engine folder>` (repo root) still copies a workspace's whole engine over `engine/`. It **refuses** if any file names something team-specific on the maintainer's denylist: `NATTERJACK_DENYLIST`, else the gitignored `tools/denylist.local.txt`, format in `tools/denylist.example.txt`; the list names private teams, so it is never committed. It overwrites anything merged here that the workspace doesn't have, so upgrade that workspace to the latest release first, or use `/natterjack:contribute` instead.

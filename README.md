# skills

Claude Code plugins by Luke Hoezee.

## agentic-os

Set up an **agentic OS** for your team: a multi-repo workspace Claude Code works well in, plus a local **dashboard** that becomes home base for everyone:

- **Runs**: start Claude from the browser; when it needs a decision it asks on the page (buttons), and every run shows its transcript, subagents, and the code it changed.
- **Issues**: your tracker's board (Linear, Jira or GitHub Issues), with **Explain** (read-only, against the real code) and **Implement** (runs your `/implement` skill).
- **Apps & Workspaces**: start and stop your apps and stacks in the right order, per worktree, with logs.
- **Machine**: what this computer needs for your stack (Node, Go, PHP, Python, .NET, Java, Docker, databases…), checked live, with one-click installs.
- **Docs, Links, Reference**: your docs (repos, or Confluence/Notion/Drive), link tiles anyone can add to (for the team or just themselves), and a click-to-copy quick reference.
- **Search, Skills, Usage, Memory, Explore, Settings**: search everything without spending tokens, run skills as cards, see plan usage, browse and edit files.

It's tailored to your team by **discovery, not forms**: Claude scans your repos (stacks, ports, run commands, databases, CI, deploy targets, ticket keys in your branches, your design system), asks only what it couldn't work out, and writes the config. The dashboard itself is a finished engine copied into your workspace. You own that copy (change anything), and `upgrade` merges newer versions around your changes.

### Install

In Claude Code:

```
/plugin marketplace add lhoezee/skills
/plugin install agentic-os@lhoezee-skills
```

(or from a shell: `claude plugin marketplace add lhoezee/skills` and `claude plugin install agentic-os@lhoezee-skills`)

Then, in the folder that holds (or will hold) your team's repos:

```
/agentic-os:create
```

Needs: Claude Code, Git, and Node.js 24.15 or newer (the dashboard's Machine page helps with the rest).

### Skills

| Skill | What it does |
|---|---|
| `/agentic-os:create` | Discover the workspace, interview you, install the dashboard and write its config, brand it, start it. |
| `/agentic-os:doctor` | Check config, build, port, engine version, tracker connection and machine; fix what's wrong. |
| `/agentic-os:upgrade` | Merge the latest dashboard engine into your copy, keeping your changes. |
| `/agentic-os:add-adapter` | Support another issue tracker (Azure Boards, Shortcut, GitLab…) or code host. |
| `/agentic-os:contribute` | Send your engine improvements back as a PR. |

### What ends up in your workspace

```
your-workspace/
├── dashboard/               the engine (Node server + Angular UI); yours to change
├── .claude/dashboard/       your config: workspace, apps, machine, docs, reference, links, deck (.json) + brand/
├── .claude/skills/dashboard the /dashboard skill (start / stop / restart)
├── .claude/ledger/          local state: run history, keys you paste, personal links (never committed)
├── CLAUDE.md                gets a "Workspace dashboard" section
└── repo-a/, repo-b/, …      your repos, side by side
```

Start it any time with `node dashboard/bin/dashboard.mjs start --open` (default http://localhost:3333; set `dashboard.port` in `.claude/dashboard/workspace.json`, or `DASHBOARD_PORT` on one machine).

## Maintaining

This repo is the source of truth for the engine: `plugins/agentic-os/engine/`. Change it here (directly, or by a PR from a fork; `/agentic-os:contribute` prepares one from a workspace's edits), and workspaces, including the ones it's developed from, pick releases up with `/agentic-os:upgrade`.

To release:

1. Run the tests: `node --test plugins/agentic-os/scripts/test/*.test.mjs`, and the engine's own: `cd plugins/agentic-os/engine && npm ci && npm test`.
2. Bump the engine version in `plugins/agentic-os/engine/package.json` and `engine/ENGINE.json`, and the plugin's in `plugins/agentic-os/.claude-plugin/plugin.json` (it can run ahead of the engine for script-only fixes; engine releases set both).
3. `claude plugin validate .`, commit, and tag **the commit that bumps the version**:

```bash
git tag agentic-os-v0.4.0 && git push origin main --tags
```

The tag matters: a workspace's `upgrade` fetches the version it installed (by tag) as the merge base, so a tag on an earlier commit makes the version files look like local edits.

`tools/sync-engine.mjs <workspace>/dashboard` still copies a workspace's whole engine over `plugins/agentic-os/engine/` (it **refuses** if any file names something team-specific, `tools/denylist.txt`). It overwrites anything merged here that the workspace doesn't have, so upgrade that workspace to the latest release first, or use `/agentic-os:contribute` instead.

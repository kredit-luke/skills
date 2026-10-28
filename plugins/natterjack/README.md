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

- **Agents**: runs use Claude Code, GitHub Copilot CLI or OpenAI Codex CLI, whichever are installed: pick one next to Model and Effort.
- **Runs**: start an agent from the browser (type `/` in any chat box to pick a skill or command); when it needs a decision it asks on the page (buttons), and every run shows its transcript, subagents, and the code it changed. Type while Claude works and your message is queued for when the turn ends (edit or remove it until then), like typing ahead in the CLI. Turn on **Auto-send** and it goes out even if Claude stops to ask a question, so you can walk away.
- **Issues**: your tracker's board (Linear, Jira or GitHub Issues), with **Explain** (read-only, against the real code) and **Implement** (runs your implement skill: the [`multirepo`](../multirepo/) plugin's `/multirepo:implement`, or your own). Skills from Claude Code plugins enabled for the workspace are listed alongside the workspace's own, as `/<plugin>:<skill>`.
- **Factory**: agent work from ticket to merged PR, one card per ticket, in a column per stage and gate: Queued → Planning → plan gate → Building → Reviewing → Security → … → Done. Each card shows its repos' progress, agent, cost against budget and PRs. The team's policy (preset, stages, gates, the security stage's scanners, limits, the Approver) is edited on Factory → Policy and saved in `factory.json`. Three views: **Tickets** (a row per ticket with its whole pipeline, and each step's times, notes and gate decisions), **Board**, and **Line** (a lane per stage and gate: what's being worked on, what waits, and the bottleneck). A throughput strip shows items done this week, lead time, first-pass review, how much the Approver approved alone and cost per merged item. **Pull work in** takes the policy's intake tickets (by tracker state and label) assigned to you, up to the WIP limit, by hand or on a schedule; merged tickets get a **retro**. When a ticket needs someone (a gate waiting, a stage failed twice, a budget reached, a ticket stopped), it's on Home → Needs you and posted to the team's webhooks (Slack-compatible). **Audit log** exports every gate decision, Approver assessment and rating as CSV. **Spec readiness**: when a session reads a ticket it scores how ready it is to start on (0-100: problem, outcome, testable acceptance criteria, scope, constraints, affected areas, open questions, how to verify), with the team's levels and weights; the spec gate acts on it. A ticket waiting at a gate can be approved (and carried on) or rejected right on the page, with its plan readable there. `/multirepo:implement` reports to it; any pipeline that writes the same manifest gets a card.
- **Reviews**: open pull requests across every GitHub organization you can see, each with a one-sentence summary of what it does, plus its checks, reviews and files, so other people's work can be reviewed from one place. **Guided review** reads a PR in order (intent and its ticket, the core change, consequences, glue, risks, what to check) next to the diff grouped by what each hunk is for, with an on-demand security review of the diff. A guide that multirepo's `/multirepo:review-guide` posted on the PR (the Factory's guide stage, written with the repo checked out) is shown instead of writing one when it's for the PR's current commit and its poster can push to the repo (writing one here again shows the newer of the two). **Ask agent for review** has Claude Code, Copilot or Codex review the PR for bugs, performance, security and up to five nitpicks; pick the findings worth raising, edit them, and post them to the PR as line comments. Approve or request changes from the same panel. In a guided review, comment on any line of the diff: drafts are kept until you post them together as one review, and **Ask agent to change this** posts the comment and starts a run that makes the change on the PR's branch (a factory ticket's in its own work folder), pushes it and replies on the comment. The page picks up new commits as they're pushed.
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

In GitHub Copilot CLI (it reads the same marketplace):

```
copilot plugin marketplace add lhoezee/skills
copilot plugin install natterjack@lhoezee-skills
```

In OpenAI Codex CLI (`.agents/plugins/marketplace.json` and `.codex-plugin/plugin.json`):

```
codex plugin marketplace add lhoezee/skills
codex plugin add natterjack@lhoezee-skills
```

Then, in the folder that holds (or will hold) your team's repos, ask for the **create** skill (`/natterjack:create` in Claude Code; in Copilot or Codex, "use the natterjack create skill"). Ideally that folder is a git repo of its own (say `agent-os`) with every repo that makes up your product cloned inside it, so the dashboard serves engineering, product and business alike. **create** checks the folder first, and helps you set one up if you started inside a single repo or in a general folder like `~/Development`. The skills name their scripts with `${CLAUDE_PLUGIN_ROOT}`, which only Claude Code fills in; each skill tells other agents to use its plugin folder instead. Copilot asks before running a script outside the current folder (the plugin's): approve it.

Needs: Claude Code, GitHub Copilot CLI or OpenAI Codex CLI, plus Git and Node.js 24.15 or newer (the dashboard's Machine page helps with the rest). The dashboard runs any of the three (the Agent picker in Ask and Run).

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
| `/natterjack:doctor` | Check config, build, port, engine version, tracker connection and machine (and hosted dashboards, with `hosting.json`); fix what's wrong. |
| `/natterjack:host` | Set up hosted dashboards for people without a dev machine, or finish setting them up: platform, images, snapshot, repo token, router and login proxy, roles, People page, first person. Re-run it as a checklist. |
| `/natterjack:upgrade` | Merge the latest dashboard engine into your copy, keeping your changes. |
| `/natterjack:add-adapter` | Support another issue tracker (Azure Boards, Shortcut, GitLab…) or code host. |
| `/natterjack:contribute` | Send your engine improvements back as a PR. |

## What ends up in your workspace

```
your-workspace/            its own git repo: the dashboard, config and skills are shared from it
├── natterjack/              the engine (Node server + Angular UI); yours to change
├── .claude/dashboard/       your config: workspace, apps, machine, docs, reference, links, deck (.json) + brand/
├── .claude/skills/natterjack/ the /natterjack skill (start / stop / restart)
├── .claude/ledger/          local state: run history, keys you paste, personal links (never committed)
├── CLAUDE.md                gets a "Workspace dashboard" section
└── repo-a/, repo-b/, …      your repos, side by side (their own clones: gitignored, listed in repos.json)
```

The engine's folder is yours to choose when you create it: `natterjack/` by default, or anything else if that name is taken (`tools/natterjack`, `ops-console`…). The workspace skill is named after its last part. The choice is recorded in `.claude/dashboard/engine.json` (`dir`), and `upgrade` and `doctor` follow it.

Start it any time with `node natterjack/bin/dashboard.mjs start --open` (default http://localhost:3333; set `dashboard.port` in `.claude/dashboard/workspace.json`, or `DASHBOARD_PORT` on one machine).

## What it runs and connects to

The dashboard is a Node server on your machine (localhost by default). It has no telemetry and sends nothing about you or your workspace to the plugin's author. Apart from the update check below, it only reaches services you configure or click, with your own credentials:

- **Agents**: runs start the `claude`, `copilot` or `codex` CLI you have installed; they talk to their own providers as usual. The Usage page runs `claude -p /usage`. The Reviews page's PR summaries, guides and security reviews are `claude -p` calls with no tools (a small model for summaries, Sonnet for the rest), sending the PR's title, description, linked ticket, file list and diff. Ask agent for review runs one turn of the agent you pick in an empty temp folder, with none of your own permission rules, settings or MCP servers: Claude Code and Copilot may only run `gh pr view` and `gh pr diff` for that PR, and Codex reads the PR's description and diff from files the dashboard writes there. Nothing is posted to GitHub until you click. If you route a model through the Models page, requests go to the Anthropic API (or `ANTHROPIC_BASE_URL`), Ollama, or the endpoint you add.
- **Issue tracker and code host**: Linear (`api.linear.app`), Jira (your `*.atlassian.net` site, `api.atlassian.com`) or GitHub Issues, and GitHub for the Needs-you inbox and sign-in, using the tokens or CLI logins you provide.
- **Knowledge and docs**: your own S3, Google Cloud Storage or Azure Blob bucket for notes, Confluence for docs, and links to Notion, Google Drive or SharePoint (checked through the MCP connectors Claude already has).
- **Hosted dashboards** (only if you set them up with `/natterjack:host`): your Kubernetes cluster or Azure (`management.azure.com`), Google or Microsoft directory sign-in (`googleapis.com`, `graph.microsoft.com`), and the snapshot store you choose (S3, Azure Blob, Confluence or an HTTP server).
- **Meetings**: Roam (`api.ro.am`, and `ro.am` for sign-in), if configured. The Meetings page reads its API with each person's own sign-in or personal access token, and an agent run turns a meeting's action items into tickets once the person confirms.
- **Machine page**: checks run local commands (`node --version`, `docker info`…); one-click installs run the installer you click (winget, Homebrew, the vendor's install script).
- **Your apps**: Apps & Workspaces start and stop the commands in your `apps.json`.
- **Plugin scripts**: `create` reads your repos locally; `upgrade` fetches release tags from this repository on GitHub.
- **Update check**: a few times a day a local dashboard reads `https://asknatterjack.com/version.json` (a plain GET; nothing about you or your workspace is in it) and the sidebar shows `v<x.y.z> available` when there's a newer release; clicking it starts `/natterjack:upgrade`. Turn it off for the team with `"updateCheck": false` under `dashboard` in `workspace.json`, or on one machine with `NATTERJACK_UPDATE_CHECK=0`. Hosted dashboards never check.

Keys you paste are kept in `.claude/ledger/` in your workspace, which is never committed.

## Privacy

Natterjack runs entirely on your team's own machines and infrastructure. Its author runs no service for it: there is no telemetry, and no data is collected or retained outside your systems. The one request to the author's site is the update check (see above): it fetches a public file, sends nothing about you or your workspace, and can be turned off.

It does read and store data your team sets up, which can include personal data such as names and emails: the People page roster (committed to your workspace repo), run history and transcripts (in `.claude/ledger/`), and notes synced from your own bucket. That data stays in your workspace, your repos and the storage you configure, and you can delete it at any time. The services it connects to (your issue tracker, code host, storage, agents) handle data under your own agreements with them.

## License

MIT; see [LICENSE](LICENSE).

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

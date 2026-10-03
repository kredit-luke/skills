---
name: create
description: Set up Natterjack for a team in the current workspace - a multi-repo Claude Code workspace plus a local web dashboard (Claude runs with in-page questions, issue board with Explain/Implement, one-click app start/stop, machine setup checks, docs, links, quick reference, usage) tailored to the team's stack, issue tracker, docs and brand. Use when someone wants to create, set up, bootstrap, scaffold or install Natterjack (an agentic OS), an agent workspace dashboard for their team, or to make an existing multi-repo folder Claude-ready with a dashboard. Works with any stack (Node, PHP, Go, Python, .NET, Java, Ruby, Rust...), tracker (Linear, Jira, GitHub Issues, or none) and docs (repos, Confluence, Notion...).
argument-hint: "[workspace folder]"
---

# Set up Natterjack

You're setting up a workspace so a whole team can work with Claude: repos side by side under one root, workspace-level CLAUDE.md and skills, and a **dashboard** they run locally (default http://localhost:3333). The dashboard is a finished, generic engine you copy in; your job is to **discover** the team's world, **confirm** it with them, and write the **config** that makes the engine theirs. You don't write dashboard code unless a service they use has no adapter yet.

Everything bundled with this skill is under `${CLAUDE_PLUGIN_ROOT}`:
- `engine/`: the dashboard (Node server + prebuilt-on-first-start Angular UI). Copied to `<workspace>/natterjack/` by default (the install folder, below).
- `scripts/`: `discover.mjs`, `extract-brand.mjs`, `scaffold.mjs`, `validate.mjs`, `doctor.mjs`, `upgrade.mjs`, `engine-diff.mjs`. Plain Node, no installs.
- `references/`: read the one you need when you get to that step (listed below).
- `templates/`: the workspace's dashboard skill and the CLAUDE.md section scaffold installs.

The workspace is the folder the user names, or the current directory. Read `references/config.md` before writing any config file.

## 1. Discover (read-only)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/discover.mjs" <workspace> --out <scratch>/inventory.json
```

Read the JSON. It has repos (remote, stacks, run commands, ports, version pins, CI, deploy targets, README URLs), docker-compose services (databases), the code host, tracker hints (ticket keys seen in branches, mentions), docs candidates, design-system candidates, tools on this machine, and `suggestions` (draft `apps`, `machine` checks, a free dashboard port). It's a **guess**: every suggestion has a `why`.

Then look at what the script can't: skim each repo's README and CLAUDE.md, the root CLAUDE.md if any, and existing `.claude/skills/`. For a large workspace, fan out one Explore subagent per few repos ("what is this repo, how is it run locally, what does it need, which URLs does it deploy to") and merge their answers into your notes.

If `inventory.existing.dashboard` is true, this workspace already has one (in `inventory.existing.engineDir`): stop and offer `upgrade` or `doctor` instead.

## 2. Interview (only what discovery couldn't settle)

Read `references/discovery.md` for how to turn the inventory into questions. Keep it to one or two rounds of AskUserQuestion (or the dashboard's question block when you're running headless). Always confirm:
1. **Repos**: which folders are part of the workspace (and any to clone: their URLs go in repos.json).
2. **Issue tracker**: Linear / Jira / GitHub Issues / none, plus its settings (Linear org slug; Jira site + project keys; GitHub owner/repo list), which teams and states to show, and which state means "ready to build".
3. **Apps**: which to put on the Apps page, how each starts, its port, and which run together as a stack (and in what order, e.g. database, then API, then web).
4. **Docs**: where they live: folders/repos here, and/or Confluence, Notion, Google Drive, a wiki (URLs).
5. **Brand**: which design-system candidate (show the top 2-3 with their source files), and the logo (a light version for the dark sidebar).
6. **Links** worth a tile beyond what discovery found (cloud consoles, monitoring, vendor portals), and, if discovery found infrastructure code (Terraform, Helm, Kubernetes) or the user has cloud access, whether to write an Infrastructure doc from it.
7. **Dashboard port**: the suggested free one (3333 unless taken).
8. **Install folder**: where the engine goes (default `natterjack/`; pick another if the workspace already has a folder or skill by that name, e.g. `tools/natterjack`). The workspace skill takes its last segment as its name (`/natterjack`).

Don't ask what the inventory already answers with confidence; state it in the summary instead.

The **Knowledge** page (`docs.json`) is for the whole business, not just engineering: ask which areas matter (Company, Customers, Finance, Marketing…), who owns each and how often its notes should be reviewed, where that knowledge lives today (Notion, Confluence, Drive: an external source with its `connection`), and whether business people who don't use git need a bucket for notes (`kind: "store"`, S3 / Google Cloud Storage / Azure). Engineering docs in the repos are `notes` or `site` sources. Never put a bucket key in docs.json.

The **Infrastructure** page is for infrastructure only (accounts, environments, public URLs, databases, egress IPs, firewall rules, DNS). Write its doc only from real sources (shape and rules in `references/config.md`, "infrastructure.json"), never pad it with app or product docs, and never put secrets in it. No infrastructure code and no cloud access: leave `infrastructure.json` out. The page then explains what goes there and asks someone with infrastructure access to have Claude fill it in, so say that in the summary.

## 3. Write the plan, confirm, scaffold

Build a plan file (shape in `references/config.md`, "plan.json"): the contents of `workspace.json`, `apps.json`, `machine.json`, `docs.json`, `infrastructure.json` (only with infrastructure info; see below), `links.json`, `connections.json` (only when the team relies on MCP servers: their tracker or docs connector, e.g. `claude.ai Linear`, `claude.ai Atlassian`; see config.md), `deck.json`, plus `repos`, `engineDir` (only when it isn't `natterjack`), `skills: ["dashboard"]`, `claudeMd: true`. Show the user a short summary (apps with ports, tracker, docs, checks, port, install folder) and get a yes. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" <workspace> --plan <scratch>/plan.json
```

It copies the engine to the install folder (`<engine>/` from here on; it refuses a folder that's already something else), writes the config files (never overwriting existing ones unless `--force`), records the engine version and folder in `.claude/dashboard/engine.json`, updates `.gitignore`, installs the workspace's dashboard skill (named after the folder, e.g. `natterjack`) and adds a section to CLAUDE.md.

## 4. Brand

Read `references/branding.md`, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/extract-brand.mjs" <workspace>                      # candidates
node "${CLAUDE_PLUGIN_ROOT}/scripts/extract-brand.mjs" <workspace> --apply <n> [--logo <file>]
```

`--apply` copies the tokens into `.claude/dashboard/brand/`, drafts `brand/theme.css` and prints a contrast report. **Open theme.css and check it**: every contrast line should pass; fix any that don't by choosing a different source variable or a darker/lighter value. No design system at all is fine: skip this, and the neutral theme applies (ask for a logo anyway).

## 5. Validate, start, look

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" <workspace>
node <workspace>/<engine>/bin/dashboard.mjs start      # foreground; first start builds (1-2 min)
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" <workspace>
```

Fix every validate error. Then open the dashboard and look at it (a browser tool if you have one; otherwise ask the user): Home, Links, Apps, Machine, Issues, Docs, Infrastructure. Things that should be true: the logo and colors are theirs, Apps shows their apps with the right ports, Machine lists their toolchain (not Node-only, unless it is), Issues shows the connect card for their tracker (or their issues), Docs lists their sources. Fix config and reload; no restart is needed for config.

## 6. Workflow skills (offer, don't assume)

The dashboard works on its own. Teams usually also want the workflow skills the dashboard's Implement / presets call: `/implement <ticket>`, `/commit`, `/pr`, `/worktree`, `/pull`. Read `references/workflow-skills.md`, then ask which they want and write them for *their* tracker, ticket format, branch convention and code host. Add a matching `implement` preset to `deck.json` (with the ticket arg's `pattern` = their ticket regex) so the Issues page's Implement button works.

## 7. Hand over

Tell the user, briefly: the URL, how to start it (the workspace skill, e.g. `/natterjack`, or `node <engine>/bin/dashboard.mjs start`), what to commit (`<engine>/`, `.claude/dashboard/`, `.claude/skills/`, CLAUDE.md, repos.json, .gitignore; never `.claude/ledger/`), what teammates do after pulling (install Claude Code and sign in: the Machine page checks both and has buttons for them; start the dashboard; the Repos page clones the repos they don't have yet; the Issues page walks them through their own tracker key), and anything left open (a tracker without an adapter, missing tools the Machine page shows). Offer to commit.

## Adding what the engine doesn't have

- A tracker other than Linear / Jira / GitHub Issues (Azure Boards, Shortcut, GitLab, YouTrack...): the `add-adapter` skill.
- Machine checks for a tool not in the catalog: define them in `machine.json` with a `kind` (see config.md). Only extend the catalog if it's generally useful (and contribute it back).
- Anything else the team wants changed in the dashboard itself: fine to change `<engine>/` locally; `upgrade` keeps local changes. Suggest `contribute` if it'd help other teams.

## References

- `references/config.md`: every config file, field by field, with examples; plan.json.
- `references/discovery.md`: reading the inventory; what to ask; mapping stacks to apps and checks.
- `references/branding.md`: the token contract, choosing a source, fixing contrast, logos.
- `references/adapters.md`: the IssueTracker interface and how to add one.
- `references/workflow-skills.md`: implement / commit / pr / worktree / pull, parameterized by tracker.
- `references/how-it-works.md`: the dashboard's architecture, run protocol, security, and pitfalls.

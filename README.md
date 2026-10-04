# skills

Plugins by Luke Hoezee, published as one marketplace for Claude Code, GitHub Copilot CLI and OpenAI Codex CLI.

```
/plugin marketplace add lhoezee/skills
```

(or from a shell: `claude plugin marketplace add lhoezee/skills`; `copilot plugin marketplace add lhoezee/skills`; `codex plugin marketplace add lhoezee/skills`)

## Plugins

| Plugin | What it does | Install |
|---|---|---|
| [**natterjack**](plugins/natterjack/) | Turns a team's repos into one Claude Code workspace with a local dashboard: runs with in-page questions, the issue board, apps, machine setup, docs and links, tailored to the team's stack and brand. Formerly `agentic-os`. | `/plugin install natterjack@lhoezee-skills` |

Each plugin's README covers its skills, setup and release process.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per plugin
plugins/<name>/                   a plugin: .claude-plugin/plugin.json, skills/, README.md, and whatever else it ships
tools/                            maintainer scripts
.github/workflows/                CI for every plugin
```

## Adding a plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json` (name, version, description) and its `skills/<skill>/SKILL.md` files.
2. Add an entry to `.claude-plugin/marketplace.json` (`name`, `source: "./plugins/<name>"`, `description`) and a row to the table above. For Codex, add it to `.agents/plugins/marketplace.json` too and give the plugin a `.codex-plugin/plugin.json` (same name and version, `"skills": "./skills/"`); Copilot reads the Claude files.
3. Give it a `README.md`, and add its tests to `.github/workflows/test.yml`.
4. `claude plugin validate .`, then commit. Tag releases `<name>-v<version>` so each plugin versions on its own.

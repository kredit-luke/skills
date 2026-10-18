# From inventory to plan

`discover.mjs` gives you facts and guesses. This is how to turn them into a plan the user only has to confirm.

## Read the inventory like this

- **`workspace`**: whether this folder is a good home for the workspace, settled before anything else (the create skill's first step). `verdict` is one of:

  | verdict | means | evidence |
  |---|---|---|
  | `ok` | the root is a git repo holding (or declaring in repos.json) the product's repos | |
  | `empty` | no repos yet (a fresh `agent-os`): ask for them | no child repos, no repos.json, and nothing at the root but workspace files (README, CLAUDE.md, .gitignore, `.claude/`…) |
  | `single-repo` | one repo and nothing else: ask whether the product has others | the root is a product repo (any tracked file beyond workspace files) or a code folder, or holds just one repo. `suggested`: `here` for a folder holding one repo, `parent` when the folder above already holds this repo and its siblings (`suggestedIsRepo`), else `new` (`agent-os` beside it) |
  | `root-not-git` | the right repos side by side, but the root isn't a repo, so nothing it holds can be shared | two or more repos, no `.git` at the root |
  | `catch-all` | a general folder of unrelated projects: pick this product's repos, set up a new folder (`suggestedPath`) | never an empty folder. Strong: the home folder, subfolders holding their own sets of repos (not ones repos.json declares repos in, nor the worktrees folder). Weak, two needed: a general-purpose name (`Development`, `code`, `projects`…), sitting directly in the home folder, repos from 2+ owners, 10+ repos |
  | `inside-repo` | the folder is inside another git repo | `git rev-parse --show-toplevel` is a parent (a repo at the home folder, i.e. dotfiles, doesn't count) |

  `reasons` explains the verdict in plain words; `rootIsRepo`, `rootRemote` and `productRepos` are the facts behind it. It's a guess like everything else here: the user can say a `single-repo` is a monorepo, or that a `catch-all` folder really is one product.
- **`repos[]`**: each cloned repo with `stacks[]` (language, frameworks, `kind`: backend / frontend / fullstack / site / library, `run.cmd`, `port`, `install`, pins), `ci`, `deploy`, `readmeUrls`. A repo with only `library` stacks isn't an app. A `site` (plain HTML) is usually a **docs source**, not an app, unless people preview it locally a lot (then both).
- **`compose[]`**: docker-compose services. `kind` postgres/mysql/redis/… are what apps need running: Machine checks (`docker-container`) and often a stack step (`docker compose up -d <service>`). `container` null means compose names it `<project>-<service>-1` (project = the compose file's folder name, lowercased) unless the file sets `name:`. `hostPort` is the first published host port (compose's full port syntax is read: IPs, `${VAR:-default}`, ranges, the long `target`/`published` form); `hostPortVar` names its variable when it can differ per machine, so the suggested Machine check goes by container name only. `build` is the service's build context: a service built from an app's own folder is that app in a container, so its port doesn't push the app's port aside.
- **`codeHost`**: where the repos live. GitHub → `gh` check, Needs-you inbox on, `ciRepos` = the app repos' `owner/name`.
- **`tracker.candidates`**: evidence per tracker, strongest first; **`tracker.ticketKeys`**: `KEY` prefixes seen in branch names and commits (e.g. `ENG` 135×). Keys + Linear evidence → Linear team key; keys + Jira evidence → Jira project keys. Only `#123` references → GitHub Issues. No evidence → ask.
- **`docs[]`**: local docs folders and sites. External docs (Confluence/Notion/Drive) can't be discovered from files: ask.
- **`services[]`**: third-party services named in `.env.example` files: good link tiles (their consoles), never secrets.
- **`brand[]`**: design-system candidates, best first (see branding.md).
- **`suggestions.apps`**: one per runnable stack, ids from folder names, ports de-clashed; `why` says where the command and port came from. **`suggestions.machine`**: checks derived from the stacks, pins and compose. **`suggestions.dashboardPort`**: 3333 or the next free one.

## What to fix before showing the user

- App ids: short camelCase (`api`, `web`, `admin`), names as people say them.
- Ports: confirm unknowns (`port: null`), and check the command actually uses `{{port}}` / `PORT`; if the app can't be told its port, drop `{{port}}` and use its fixed port.
- Commands that need env (database URLs, API URLs of other apps): put them in `launch.env`, using `{{port:<appId>}}` for sibling apps. Secrets stay in the repo's own `.env` (never in apps.json).
- Stacks: group apps that are run together; order `steps` by dependency (datastores → backends that run migrations → the rest). Pick the most-used stack as `defaultStack`.
- Machine: dedupe; set `required` from pins (`.nvmrc`, `go.mod`, `global.json`, `composer.json`'s php); keep Node's floor at 24.15.0 (the dashboard's). Each check's `apps` = the app ids that need it.
- Links: prod/staging URLs per app (from `deploy[].urls`, `readmeUrls`, `homepage`), plus the code host org, the tracker, CI, and consoles for `services`.

## The interview

One round of AskUserQuestion (up to 4 questions) is usually enough; a second only if answers open new questions. Good questions are specific and offer the discovered answer as the first option ("Linear (ENG tickets in 135 commits)" / "Jira" / "GitHub Issues" / "None"). Things you should always settle:

1. Issue tracker + its settings (Linear org slug; Jira site and projects; GitHub repos), and "ready to build" state.
2. Apps and stacks: show the table (id, folder, command, port) and ask what's wrong or missing, not to re-enter it.
3. Docs outside the repos (Confluence space, Notion workspace, Drive folder URLs).
4. Brand source + logo (top candidates with file paths), when there's more than one plausible choice.

Also worth one question each when relevant: which repos are *not* part of this workspace; extra link tiles; whether they have (or want) an Infrastructure doc (only from infrastructure code or cloud access: see config.md, "infrastructure.json"); the dashboard port if 3333 is taken; teams/states for the board.

Don't ask about: things with strong evidence (say them in the summary), secrets (never collect them: the dashboard asks each person for their own tracker key, and machine checks only point at where secrets come from), or dashboard internals.

## The summary before scaffolding

A short table: apps (name, port, start command), stacks, tracker (kind, settings), code host + CI repos, docs sources, Machine check groups, links count, brand source, dashboard port. Then: "Write this? (you can change any of it later in `.claude/dashboard/`)".

# From inventory to plan

`discover.mjs` gives you facts and guesses. This is how to turn them into a plan the user only has to confirm.

## Read the inventory like this

- **`repos[]`**: each cloned repo with `stacks[]` (language, frameworks, `kind`: backend / frontend / fullstack / site / library, `run.cmd`, `port`, `install`, pins), `ci`, `deploy`, `readmeUrls`. A repo with only `library` stacks isn't an app. A `site` (plain HTML) is usually a **docs source**, not an app, unless people preview it locally a lot (then both).
- **`compose[]`**: docker-compose services. `kind` postgres/mysql/redis/… are what apps need running: Machine checks (`docker-container`) and often a stack step (`docker compose up -d <service>`). `container` null means compose names it `<project>-<service>-1` (project = the compose file's folder name, lowercased) unless the file sets `name:`.
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

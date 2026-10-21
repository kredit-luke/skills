# Hosting the dashboard for people without a dev machine

The dashboard normally runs on each person's own computer. Hosted mode runs it on the company's own infrastructure instead, for people who don't have a dev machine: product, operations, support. Engineers keep running it locally; the same workspace serves both.

It is not multi-user: **each person gets their own container**, with their own disk, Claude sign-in, chat history and tracker key. Claude runs can use a shell, so separate containers are what keeps one person's runs away from another person's credentials.

```
browser ── login proxy (oauth2-proxy or a cloud identity-aware proxy; your company's
        │   identity provider: Google Workspace, Entra ID, Okta, Cognito, Keycloak...)
        │   adds X-Forwarded-Email and X-Dashboard-Proxy-Secret
        └─ this person's container: dashboard + claude CLI + git
              volume /data: workspace/ (clone; .claude/ledger = runs, tracker key)
                            claude/    (Claude sign-in, transcripts, memory)
```

Nothing in it is tied to a cloud: it needs a container platform with a persistent volume and a login proxy in front. `templates/hosted/` has an image and a Kubernetes starting point.

## One address, or one per person

- **One for everyone** (`dashboard.example.com`), recommended: one login proxy and the router (`router/`) in front of everyone's containers. The router sends each signed-in person to their own container, starts it on their first visit and stops it when idle. One DNS record, one certificate and one redirect URI. See "One address for everyone" below; templates: `kubernetes-router.yaml` once, `kubernetes-person.yaml` per person.
- **One per person** (`ana.dashboard.example.com`): each person's pod has its own login proxy sidecar that lets only them in, and runs all the time; template: `kubernetes.yaml`. Needs a DNS record and TLS for each host (or one wildcard record and certificate), and each host registered as a redirect URI with the identity provider (or a wildcard, where it allows one).

## Settings

Hosted mode is set by the container's environment, never by `workspace.json`:

| Variable | Default | Notes |
|---|---|---|
| `DASHBOARD_HOSTED` | off | `1` turns hosted mode on. |
| `DASHBOARD_PUBLIC_URL` | (required) | The address people open, e.g. `https://ana.dashboard.example.com`. Its host is the only `Host` accepted and its origin the only `Origin`. |
| `DASHBOARD_PROXY_SECRET` | (required) | 32+ characters. The login proxy sends it as `X-Dashboard-Proxy-Secret` on every request; anything without it gets 401. It's what makes the email header trustworthy. |
| `DASHBOARD_OWNER` | none | The one email this container serves; anyone else gets 403. Set it: it guards against a misrouted request. |
| `DASHBOARD_IDENTITY_HEADER` | `X-Forwarded-Email` | Where the proxy puts the signed-in email. |
| `DASHBOARD_ALLOWED_HOSTS` | none | Extra `Host` values, comma-separated, for a proxy or router that rewrites Host. |
| `DASHBOARD_BIND` | `0.0.0.0` | `127.0.0.1` when the proxy is a sidecar in the same pod (the Kubernetes template does this). |
| `DASHBOARD_CLAUDE_BIN` | `claude` on PATH | The exact CLI to run. The image sets it. |
| `DASHBOARD_MAX_CONCURRENT_RUNS` | `deck.json` `limits` | 1–10. Caps this person's runs at once, over `deck.json` and their own settings. The People page sets it from their profile. |
| `DASHBOARD_ROLE` | none | A `workspace.json` role id. That role is theirs from the first start: they're never asked, and Settings shows it without a way to change it. The People page sets it when you assign a role. An id that isn't one of the team's roles is logged and ignored. |
| `DASHBOARD_ACCESS` | none | `full` or `read`: what they can do with the code, over their role's default (config.md, "Roles"). Locked like the role. The People page sets it when you give someone their own access. |

The dashboard refuses to start when `DASHBOARD_HOSTED` is on and the URL or secret is missing. `GET /healthz` answers `ok` without any of the checks, for liveness probes.

What changes for the person:
- The Apps and Workspaces pages are hidden, and the server refuses app actions, Machine-page installs, "Continue in terminal", "Implement in terminal" and local docs previews. All of those open something on the server's own screen or ports.
- Runs started on an engineer's own dashboard can be moved here with **Send to hosted** ("Moving a run from your computer" below).
- Knowledge stores (docs.json `kind: "store"`) read their key from `KNOWLEDGE_<SOURCE KEY>_KEY` (uppercased, `-` as `_`), so nobody pastes one and the page says the admin connects it. To set one up: create a bucket (or a folder in one) per area that only some people should read; create a key that can list, read, write and delete there (an IAM user or role for S3; an HMAC key for Google Cloud Storage; a container SAS with read, add, create, write, delete and list for Azure, from a stored access policy so it can be revoked); put it in the deployment's secrets under that name for the people who should read and edit that area. The tool list on the Knowledge page is the workspace repo's config: change it from a local dashboard and commit it.
- The Connections page's **Sign in** works in the page: the person signs in in their own browser, which ends on a `http://localhost:<port>/callback` page that can't load (that's their own computer). They paste its address into the page, and it's typed at the prompt of the `claude mcp login` waiting in the container (run under `script` for a pseudo-terminal; `script` comes with every Debian image). Only an address on the port and path that CLI named is accepted. claude.ai connectors sign in on claude.ai.
- The Machine page's Claude Code check gets an in-page sign-in (below). The container's tools are the image's job, so it has no install buttons.
- Files a run makes for the person (a PDF, a spreadsheet, an export) are downloadable from the run page, under **Files**: each run is told to write them to its outputs folder (see "Files a run makes" in `how-it-works.md`). Anything it writes elsewhere stays in the container.

## The image

`templates/hosted/Dockerfile` is Node 24 plus git, the Claude CLI and the engine's server code, with everything personal on a volume at `/data`. Build it from `plugins/natterjack` once per workspace, and run one container per person. The workspace's engine has a script that builds it, and the router's, from the plugin release the engine is:

```sh
node <engine>/bin/hosted-images.mjs --all --dry-run              # what it would run
node <engine>/bin/hosted-images.mjs --all --push --update-hosting
```

- **Where they go:** `--registry <server>`. On App Service it defaults to hosting.json's `registry` (`<name>.azurecr.io`, signed in to with `az acr login`); other registries need `docker login` first.
- **The tag:** `--tag`, default `<engine version>-<yyyymmddhhmm>`, so each build is new and the containers actually move to it.
- **`--update-hosting`** (App Service) points hosting.json's `image` at the new dashboard image, so the People page shows who needs an update. On Kubernetes, change the image in your copy of the template.
- **The router** isn't moved for you: point its Web App or Deployment at the new tag.
- **One fixed command** (`node <engine>/bin/hosted-images.mjs`) is easy to allow for Claude in `.claude/settings.local.json`, so a run can rebuild the images when you ask.

By hand it's one `docker build` per image (`router/Dockerfile` for the router):

```sh
docker build -f plugins/natterjack/templates/hosted/Dockerfile --pull --no-cache -t <registry>/natterjack-dashboard:<tag> plugins/natterjack
```

**When to rebuild.** Most engine upgrades don't need it: hosted dashboards run the engine from the published snapshot. Rebuild when:
- **A release changes the images.** `upgrade` says so (its `hostedImages`).
- **You want a newer Claude CLI.** Auto-update is off in the image, so everyone runs the version it was built with.
- **For OS security fixes**, every month or so. Both images upgrade Debian's packages at build time, because the `node:24-trixie-slim` base often doesn't have them yet. Without `--pull --no-cache` Docker reuses the cached upgrade layer and the rebuild changes nothing (the script always passes both).

On start, `entrypoint.sh` puts the workspace in `/data/workspace` or updates it. Then it runs `node <engine>/bin/dashboard.mjs run` (`<engine>` is the engine folder: `natterjack/` by default, `dashboard/` in older workspaces; `.claude/dashboard/engine.json` `dir` says which), which is the server in the foreground. The workspace comes from one of two places.

**From a published snapshot** (recommended). This needs no git and no code-host account, in the container or for the person. Set `SNAPSHOT_CONFIG` to `repos.json`'s `snapshot` block as JSON, and the source's credentials in the environment (`SNAPSHOT_AZURE_SAS`, `SNAPSHOT_S3_*`, `SNAPSHOT_HTTP_TOKEN`, ...).
- **On boot**, it runs `snapshot.mjs install --repos` from the image. That installs or updates the workspace from the published workspace zip, then the prebuilt UI, then every repo, all as read-only copies (config.md "Snapshots").
- **With a prebuilt UI** (publish from where the engine folder is built), the first start skips `npm ci` and `ng build` entirely.
- **The key** comes from the environment, so the person never connects anything. Inject a read-only one: read and list for blobs, GetObject and ListBucket for S3.
- **To publish**, run publish from CI or from the Repos page on an engineer's machine, with a key that can write.

**From git:** `WORKSPACE_REPO` is cloned the first time and pulled afterwards. Add `GIT_TOKEN` if the repo is private; it goes through `GIT_ASKPASS`, so it's never written to disk. The first start runs `npm ci` and `ng build` on the volume, which takes a minute or two and about 1.6 GB of memory. Later starts skip the build. The person's app repos come from the Repos page: clones with a token the container can use, or read-only snapshots.

**The latest repos on every start.** In either mode, set `GIT_TOKEN` to a read token for the repos in `repos.json`. On GitHub, use a fine-grained token owned by the organization, with Contents: Read on those repos. Every start then brings each repo to its latest default branch with git (`snapshot.mjs pull-repos`). It runs in the background, so the dashboard is up at once: the first start's clones take a few minutes, and the Repos page shows each repo as it lands.
- **A snapshot copy, or a missing repo**, becomes a clone. Blobs are fetched as they're needed, so it's quick.
- **A clone on its default branch with nothing uncommitted** is fast-forwarded.
- **A clone with uncommitted work, on another branch, or with commits that aren't on origin** is left alone, and the start log says why.

A failure is logged and never stops the start. With a snapshot, this keeps the prebuilt UI and the fast boot, and the repos no longer wait for someone to publish. The snapshot install never replaces a clone. On App Service, put the token in the Key Vault and name it in the template's `gitTokenSecret`.

## Signing in to Claude

Each person signs in with their own seat on the company's Claude Team or Enterprise plan. On the Machine page, **Sign in to Claude** runs `claude auth login` in the container and shows two steps:
1. Open the sign-in page, which is pre-filled with the proxy's email, and sign in.
2. Paste the code the page shows back into the dashboard.

This works without a browser in the container: when the CLI's local callback can't be reached, the sign-in page shows a code instead of redirecting.

The login lands in `/data/claude`, so it survives restarts, and it's a full claude.ai login, so the person's claude.ai connectors (Atlassian, Google Drive, ...) work in their runs with nothing to set up in the container. They connect those once on claude.ai. Don't use `claude setup-token` instead: its token can only make model requests and doesn't get connectors.

To refuse personal accounts, put managed settings in the image (commented lines in the Dockerfile): `"forceLoginMethod": "claudeai"` and `"forceLoginOrgUUID": ["<org id>"]`. The org id is in `claude auth status` on a signed-in machine.

The tracker key for the dashboard's own Issues page is pasted on its Connect card, as locally, or injected per person (`JIRA_EMAIL` + `JIRA_API_TOKEN` for Jira, for example).

## Signing in to GitHub

To let a person's runs commit, push branches and open pull requests as themselves, list `{ "use": "gh" }` in machine.json. On a hosted dashboard, its check gets a **Sign in to GitHub** button. The button runs `gh auth login --web` in the container, which uses GitHub's device flow:
1. The page shows a one-time code, already copied.
2. The person enters it on github.com/login/device and authorizes.

The page polls until GitHub answers, so there's nothing to paste back. Nothing calls back into the container, so it works behind the router and the proxy.

When the sign-in finishes, `gh auth setup-git` makes git use the token for https remotes. The commit name becomes the person's GitHub name, and the commit email the proxy's (their work email), so GitHub attributes the commits to them. The token and git's global config live on the volume (`GH_CONFIG_DIR=/data/gh`, `GIT_CONFIG_GLOBAL=/data/gitconfig`), so they survive restarts. **Sign out of GitHub** deletes the token.

Commits are **signed**, so GitHub shows them as Verified, like ones made on a laptop that has a signing key:
- The first sign-in makes an ed25519 key beside gh's config (`/data/gh/signing_ed25519`), and later sign-ins reuse it.
- It adds the key to the person's GitHub account as a signing key, titled "Natterjack dashboard (\<address\>)".
- It sets git to sign with it (`gpg.format ssh`, `user.signingkey`, `commit.gpgsign`, `tag.gpgsign`).
- Signing out removes that key from their account and turns signing off. A commit signed with a key GitHub no longer knows would show as Unverified, which is worse than unsigned.
- People who signed in before signing existed sign in again once, to grant the extra scope.

Only hosted dashboards do this; a local dashboard leaves the machine's own signing setup alone.

- **No OAuth app of your own.** The device flow uses the GitHub CLI's. If your organization restricts third-party OAuth apps, an owner approves "GitHub CLI" once, which most teams have already done for local use.
- **Scopes:**
  - `repo`, `read:org` and `gist`: gh's defaults.
  - `workflow`: without it, GitHub refuses pushes that touch `.github/workflows`.
  - `admin:ssh_signing_key`: to add the signing key and remove it again. What a person can push to is still decided by their own GitHub permissions.
- **`GIT_TOKEN` stays the workspace's read token.** `entrypoint.sh` fetches the workspace with `git -c credential.helper=`, so a person's sign-in never affects boot. In runs, git asks the credential helper (the person's token) before `GIT_ASKPASS` (`GIT_TOKEN`), so a signed-in person pushes as themselves, and someone who isn't signed in can still read.
- **Egress:** the container needs HTTPS to `github.com`, `api.github.com` and `*.githubusercontent.com`. Pushes use https, not ssh.
- **Egress for the Meetings page:** with `meetings.json` `source` `roam`, the container also needs HTTPS to `api.ro.am` (the API) and `ro.am` (the sign-in's token exchange and refresh). The router needs neither.
- **Sign-ins come back to the dashboard.** Roam's and Atlassian's sign-ins send the person's browser back to `<DASHBOARD_PUBLIC_URL>/api/oauth/<roam|atlassian>/callback`. It's a redirect in their own browser, so it passes the login proxy (and anything in front of it, such as a client certificate or a country allowlist) like any other page, and the router hands it to their container: no ingress exception, nothing to paste. Register that address with each app (config.md, meetings.json and Connect to Atlassian).
- **Connect to Atlassian** (workspace.json `atlassian.clientId`): give every container the Atlassian app's client secret as `ATLASSIAN_CLIENT_SECRET`, from the router's secret (e.g. `valueFrom.secretKeyRef`), never from the repo. Anyone signed in to a hosted dashboard can read it there; that's acceptable because the secret alone reads nothing without a person's own sign-in. Egress: HTTPS to `auth.atlassian.com` (sign-in and refresh) and `api.atlassian.com` (the API gateway), as well as the site itself (`*.atlassian.net`) for API tokens.

**Only some roles.** To offer the sign-in to some roles and not others, give the check a `when`, e.g. `{ "use": "gh", "when": { "role": ["engineering"] } }`, and assign roles from the People page.
- **Roles left out** don't get the check, and the server refuses to start a GitHub sign-in for them.
- **What they can still do:** their runs use only `GIT_TOKEN`, so they can read the code but can't push or open pull requests.
- **Who else matters:** keep that token read-only, since everyone's container has it.

## One address for everyone (the router)

`router/` is a small Node service with no packages. It runs behind the login proxy at the shared address:

```
browser ── login proxy (adds the email and ROUTER_PROXY_SECRET)
        └─ router: email → that person's container (started if stopped)
              └─ their dashboard (DASHBOARD_PUBLIC_URL = the shared address,
                 DASHBOARD_PROXY_SECRET = ROUTER_BACKEND_SECRET, DASHBOARD_OWNER = their email)
```

- **What it forwards.** It passes requests through, run streams included, with the backend secret and the person's email. It keeps the browser's Host and Origin, so every dashboard's `DASHBOARD_PUBLIC_URL` is the shared address.
- **Each dashboard still checks.** Every dashboard still checks the secret and its owner, so a wrong route is refused, not served.
- **People without a container** get a page saying so.
- **A stopped container** gets a "Starting your dashboard…" page that reloads itself, while the router starts it.

| Variable | Default | Notes |
|---|---|---|
| `ROUTER_PUBLIC_URL` | (required) | The shared address, e.g. `https://dashboard.example.com`. |
| `ROUTER_PROXY_SECRET` | (required) | 32+ characters; the login proxy sends it as `X-Dashboard-Proxy-Secret`. |
| `ROUTER_BACKEND_SECRET` | (required) | 32+ characters; every dashboard's `DASHBOARD_PROXY_SECRET`. |
| `ROUTER_BACKEND` | (required) | `kubernetes`, `azure-app-service` or `static` (below). |
| `ROUTER_IDLE_MINUTES` | 0 (never) | Stop a container this long after its last request. Never while a run is going (it asks the dashboard), and not while a page has a stream open. Only for backends that can stop containers. |
| `ROUTER_ADMIN` | none | Who to ask for a dashboard, shown to people without one. |
| `ROUTER_IDENTITY_HEADER` / `ROUTER_BACKEND_IDENTITY_HEADER` | `X-Forwarded-Email` | Where the login proxy puts the email, and where the dashboards expect it. |
| `ROUTER_ALLOWED_HOSTS` | none | Extra `Host` values, comma-separated. |
| `ROUTER_PORT` / `ROUTER_BIND` | 8080 / `0.0.0.0` | `127.0.0.1` when the login proxy is a sidecar. |

Backends:
- **`kubernetes`.** Each person's dashboard is a StatefulSet with the label `app=natterjack-dashboard` and the annotation `natterjack/owner: <email>`.
  - The router reaches it at `http://<serviceName>.<namespace>.svc:3333`. Change that with `ROUTER_K8S_URL_TEMPLATE` (`{service}`, `{namespace}`, `{port}`) and `ROUTER_K8S_PORT`.
  - Starting and stopping is scaling between 1 and 0, which keeps the volume.
  - Inside the cluster it uses its service account, which needs `list` on statefulsets and `patch` on statefulsets/scale (the Role in `kubernetes-router.yaml`).
  - `ROUTER_K8S_NAMESPACE` and `ROUTER_K8S_SELECTOR` override the defaults.
- **`azure-app-service`.** Each person's dashboard is a Web App (`templates/hosted/app-service-person.bicep`) in one resource group, naming them in the `natterjack-owner` tag. (One set up by hand before the People page, tagged `owner` and `purpose: hosted-workspace-dashboard`, counts too.)
  - Set `ROUTER_AZ_SUBSCRIPTION` and `ROUTER_AZ_RESOURCE_GROUP`. The router runs as a Web App itself, with its system-assigned managed identity turned on; give that identity **Reader** and **Website Contributor** on the resource group, nothing else.
  - It reaches each dashboard at `https://<app>.azurewebsites.net` with that as the Host (App Service routes by Host); the template lists it in the dashboard's `DASHBOARD_ALLOWED_HOSTS`.
  - Starting and stopping is `start` / `stop` on the Web App, which keeps its file share.
  - Azure says Running as soon as it starts the container, minutes before a first start has installed the workspace. So the router also asks the dashboard's `/healthz`, and shows the starting page until it answers. Without that, a request would be held by App Service until the login proxy gave up (a Cloudflare 524).
- **`static`.** `ROUTER_STATIC_FILE` names a JSON file of `{ "<email>": "<dashboard URL>" }`, re-read when it changes. Use it for containers someone else keeps running: a VM with Docker, ECS services. The router never starts or stops them.
- **Another platform.** Implement `Backend` in `router/src/backends.ts` (find a person's URL, and optionally start/stop/list running ones) and add it to `makeBackend()`.

Build it from `plugins/natterjack`, so it gets the engine's shared request checks: `node <engine>/bin/hosted-images.mjs --router --push` ("The image" above), or by hand:

```sh
docker build -f plugins/natterjack/router/Dockerfile --pull --no-cache -t <registry>/natterjack-router:<tag> plugins/natterjack
```

## Managing people from your dashboard

The **People** page sets people up, changes their profile and removes them, from an engineer's own local dashboard, on Kubernetes or Azure App Service. It needs `.claude/dashboard/hosting.json` ([config.md](config.md#hostingjson-the-people-page-who-has-a-hosted-dashboard)) and the CLIs that engineer already uses: `kubectl` or `az` for where the dashboards run, `gcloud` or `az` for the directory, and `git`. Natterjack has no credentials of its own for any of them, and the page doesn't exist on a hosted dashboard.

It puts three things side by side, one row per person:
- **The directory:** everyone in the company's domain, or one Google OU or Entra department. Nobody gets a dashboard automatically: an engineer clicks **Set up**.
- **The roster:** `.claude/dashboard/people.json`, committed with the rest of the config: who has a dashboard, their profile, and who set them up and when. Natterjack has no database; this is the shared record, and git history is its audit log. After a change the page shows what isn't committed yet, with a **Commit** button that commits just that file; pushing is yours. A change that isn't pushed yet shows up for other engineers as **Not in roster** or **Missing**, so nothing goes unnoticed. It holds names and emails, no secrets (hosted dashboards that get the workspace can read it).
- **Where they run:** each person's StatefulSet (Kubernetes) or Web App (App Service), the same ones the router finds, so the page shows whether it's running or stopped.

What it shows and offers:
- **Not set up:** in the directory, no dashboard. **Set up…** picks a profile (and a role, when `workspace.json` has `roles`) and applies the template. To set up someone the list doesn't show (the directory isn't readable yet, or misses them), type their email in the box at the top; it has to be in the company's domain.
- **Running / Stopped:** **Start**, **Stop**, change the **Profile** or **Role** (re-applies and restarts it), **Remove** (keeps their volume or file share unless you tick "also delete").
- **Needs update:** the template, their profile or the image changed since it was applied. **Update** re-applies it.
- **Left:** their account is suspended or gone, or they've left the OU. **Remove** them.
- **Not in roster:** a dashboard someone made by hand. **Adopt** adds it to the roster without changing it; **Update** then brings it in line with the template.
- **Missing:** in the roster, but its StatefulSet or Web App is gone. **Set up again**, or **Forget** it.

Every change is checked first: the page shows the platform's own preview (`kubectl apply --dry-run=server`, or `az deployment group what-if`) and only applies after you confirm. Deleting someone's volume or file share asks you to type their email.

**Profiles** are what a person can do, set per person on the page: which knowledge areas they get, their run limit, and their size. On Kubernetes an area is a Secret mounted with `envFrom` and the size is the `dashboard` container's limits; on App Service an area is a Key Vault reference in the app's settings and the size is which plan they're on. Everything else in the template is yours.

**Roles** (`workspace.json` `roles`, [config.md](config.md#workspacejson-who-this-workspace-is)) can be assigned on the page too. The default, **Let them choose**, leaves it to the person as on a local dashboard. An assigned role is stored in `people.json` and passed as `DASHBOARD_ROLE`, and the person can't change it; on App Service it's the template's `role` parameter, so a copy of `app-service-person.bicep` from before roles needs that parameter added.

**Access** is set apart from the role, in its own column.
- **The choices:** the role's default, **Full stack** (GitHub sign-in, push and pull requests, Implement, Publish), or **Read-only** (their runs only have the read token).
- **How it arrives:** stored in `people.json` and passed as `DASHBOARD_ACCESS`, through the template's `access` parameter on App Service.
- **Who can push:** limit the GitHub check to full access with `{ "use": "gh", "when": { "access": "full" } }`, and the server refuses a GitHub sign-in to everyone else.

The **Roles** section under the table edits the team's roles: name, description, default access, and the output style Claude answers in (the team's `.claude/output-styles/*.md`, or Claude Code's own). Like the roster, it shows what isn't committed in `workspace.json` and commits it on its own. A role someone in the roster has can't be removed until they're given another.

### Setting it up

1. Copy the template into the workspace (e.g. `hosting/`), fill in your settings, and commit it:
   - **Kubernetes:** `templates/hosted/kubernetes-person.yaml`. `${PERSON}` and `${EMAIL}` are filled in per person. For each area, create its Secret in the namespace: `kubectl create secret generic natterjack-area-finance --from-literal=KNOWLEDGE_FINANCE_KEY=...`.
   - **App Service:** `templates/hosted/app-service-person.bicep`, and the one-time Azure setup under "Azure App Service" below.
2. Write `hosting.json` (the page's **Ask Claude to set it up** does this from what your CLIs can see).
3. Sign in to the directory:
   - **Microsoft:** `az login`. Members can read the directory by default.
   - **Google:** Google blocks the directory scope for gcloud's own sign-in ("This app is blocked"), so the team makes its own internal OAuth client once:
     1. In a Google Cloud project in your Workspace's organization, enable the **Admin SDK API**.
     2. **Google Auth Platform → Branding/Audience:** set the audience to **Internal** (only your Workspace's accounts; no Google review). Under **Data access**, add the `admin.directory.user.readonly` scope.
     3. **Clients → Create client → Desktop app**, and download its JSON. Share it with the engineers who manage people (it identifies the app, it isn't a password; keep it out of the repo all the same).

     Set `directory.project` in hosting.json to that project, so the Admin SDK calls are billed to it.

     Then each of those engineers signs in once. They need a Workspace admin role that can read users (a custom role with Users > Read is enough).
     - **From the Machine page** (easiest): a Google directory in hosting.json adds a **Google Workspace directory** check under "People page".
       1. **Choose client file…** takes the client JSON. The page checks it's a Desktop app client and keeps it in `.claude/ledger/` (never committed, never in a snapshot).
       2. **Sign in** opens a terminal running the command below, then the browser.
       3. The check turns green once Google confirms the sign-in can read the directory, whichever way it was made.
     - **By hand:**
       ```sh
       gcloud auth application-default login --client-id-file=<the client JSON> --scopes="https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/cloud-platform"
       ```
       In PowerShell, run it through cmd with the whole line in single quotes, `cmd /c 'gcloud auth application-default login ...'`. PowerShell drops the inner quotes, and gcloud then splits the scopes at the comma ("cloud-platform scope is required but not requested").

## Running it

### Kubernetes (GKE, EKS, AKS, or your own)

- **One address for everyone:** apply `templates/hosted/kubernetes-router.yaml` once. It has the router, its oauth2-proxy sidecar, a Role to scale dashboards, an Ingress, and a NetworkPolicy that lets only the router reach them. Then apply `kubernetes-person.yaml` per person (`envsubst` fills in their name and email). It starts at 0 replicas, and the router scales it up when they first open the address.
- **One per person:** `templates/hosted/kubernetes.yaml` has one person's StatefulSet with a 10 GB volume, an oauth2-proxy sidecar, a Service, an Ingress, and a NetworkPolicy, filled in per person the same way.

The parts that differ by cloud:

| | GKE | EKS | AKS |
|---|---|---|---|
| Volume (`storageClassName`) | default `standard-rwo` / pd-balanced | `gp3` (EBS CSI driver) | `managed-csi` |
| Ingress and TLS | GKE Ingress + managed certificates, or ingress-nginx + cert-manager | AWS Load Balancer Controller (ALB) + ACM, or ingress-nginx + cert-manager | Application Gateway for Containers, or ingress-nginx + cert-manager |
| Identity provider (oauth2-proxy `oidc`) | Google Workspace | any: Cognito, Okta, Entra ID, Google | Entra ID |
| No cloud credentials in the pod | no Workload Identity binding | no IRSA / Pod Identity role | no workload identity |

On every cloud:
- **Separate nodes.** Put the pods on their own node pool with a taint, away from production workloads.
- **Keep one node in that pool if your CNI taints new nodes** (Cilium's `node.cilium.io/agent-not-ready`, until its agent is up). From 0 nodes the cluster autoscaler simulates a node with that taint and never scales up ("Pod didn't trigger scale-up: untolerated taint"); with one real node it simulates from that, so growing works. Don't make the pods tolerate the taint instead: they could start before the CNI enforces network policy. A pool in one zone keeps replacement nodes where people's zonal volumes are. Some platforms (GKE) don't grow a pool to its new minimum by themselves; resize it to 1 once.
- **Network policy.** Keep the NetworkPolicy, and check your CNI enforces it. It blocks the cluster's own network and the metadata endpoint, and allows HTTPS out.
- **Long streams.** Raise the ingress read timeout: runs stream over server-sent events.

### Without Kubernetes

- **A VM with Docker:** one container per person, each with its own volume, plus oauth2-proxy and the router with the `static` backend, behind Caddy or Traefik for TLS. This is the simplest setup for a handful of people.
- **Azure App Service** (Web App for Containers, Linux): see the next section.
- **Managed container services** (Cloud Run, ECS on Fargate, Azure Container Apps) work if they can keep a persistent volume (a filesystem mount; EFS for Fargate, Azure Files for Container Apps) and keep the CPU allocated between requests. Runs carry on in the background after the page closes, so don't let the platform throttle or scale the container to zero while a run is going.

### Azure App Service

One Web App per person, on a shared App Service plan, behind the router at one address of your own (e.g. `natterjack.example.com`). The People page creates and updates them from `templates/hosted/app-service-person.bicep`.

```
browser ── login proxy (Cloudflare Access, or oauth2-proxy) at natterjack.example.com
        │   adds the email and ROUTER_PROXY_SECRET
        └─ router (a Web App, ROUTER_BACKEND=azure-app-service, managed identity)
              └─ dash-<person>.azurewebsites.net, one Web App each
                    /data = Azure Files share <app name>; secrets = Key Vault references
```

- **The shared address.** Point a subdomain of yours (`natterjack.example.com`, `agent-os.example.com`) at the router's Web App and bind it there. The login proxy in front adds the signed-in email and the router's proxy secret:
  - **Cloudflare Access:** proxy the DNS record through Cloudflare, protect the hostname with an Access application for your identity provider, and add a Transform Rule that sets `X-Dashboard-Proxy-Secret`. Set `ROUTER_IDENTITY_HEADER=Cf-Access-Authenticated-User-Email`.
  - **oauth2-proxy:** run it as a sidecar container in the router's Web App, in front of the router, as in `kubernetes-router.yaml`.
  - App Service's built-in sign-in (Easy Auth) can't add the proxy secret, so on its own it isn't enough.
- **One-time setup**, in one resource group:
  - an App Service plan (Linux, B2 or bigger; several dashboards share it, and a profile can pick a bigger plan);
  - a storage account for the file shares (the template makes each person's share);
  - a container registry with the dashboard image (`templates/hosted/Dockerfile`);
  - a Key Vault using Azure RBAC, holding the router's backend secret as `dashboard-backend-secret`, the snapshot SAS as `snapshot-azure-sas` if you install from a snapshot, and each area's key;
  - the router's Web App (`router/Dockerfile`), with its managed identity, `ROUTER_BACKEND=azure-app-service`, `ROUTER_AZ_SUBSCRIPTION`, `ROUTER_AZ_RESOURCE_GROUP`, and Reader and Website Contributor on the resource group.
- **Each person's app** (the template): their own managed identity reads their secrets from the vault (Key Vault Secrets User) and pulls the image (AcrPull), so no password sits in the app's settings. **Always On** is on, or idle apps are unloaded mid-run. The router stops idle ones (`ROUTER_IDLE_MINUTES`), which frees room on the plan.
- **Who deploys** needs Contributor on the resource group, permission to create role assignments on the vault and registry (Owner, or Role Based Access Control Administrator), and to list the storage account's keys (for the `/data` mount).
- **Dashboards set up by hand** before the People page (tagged `owner` and `purpose: hosted-workspace-dashboard`) show as **Not in roster**. **Adopt** them, then **Update** to move them onto the template; their name and file share stay.

## Moving a run from your computer

An engineer who starts a run on their own dashboard can carry on with it on their hosted one, e.g. before closing the laptop. Set `url` in hosting.json to the shared address ([config.md](config.md)); local run pages then have **Send to hosted** next to Continue in terminal (Claude runs, between turns).

1. **Send to hosted** packs the run (`server/src/handoff.ts`) and locks it here. The pack holds:
   - Claude's transcript of the session and its subagents;
   - the run's files;
   - the worktree it worked in, if any (the same one its Changes tab shows). For each repo it carries the commits that aren't on any remote (a git bundle, after a `git fetch --prune`), uncommitted changes and untracked files that git doesn't ignore. It also carries the worktree's own files outside its repos (a copied `.claude/`, CLAUDE.md), but not `.claude/ledger`.
2. A tab opens on the hosted dashboard's **Move a run here** page, which asks first. It then fetches the pack straight from `http://localhost:<port>` with a single-use token. Chrome asks once whether the page may reach your local network: allow it. Only the hosted address may make that request (CORS), and only a dashboard on `localhost` is accepted as the source.
3. The hosted dashboard recreates the run in the same place relative to its workspace. A worktree is added with `git worktree add` from its own clone of each repo, on the run's branch (fast-forwarded if it exists and isn't checked out, else detached with a warning). Then the changes are applied and the transcript goes where `claude --resume` finds it from the new folder. Every later turn is told the old paths now live under the hosted workspace. A failure undoes everything it did.
   The import runs in the background (the page polls it), so a proxy's response timeout can't cut it off. Files are only written through real folders: never through a link, including one the run's own commits made.
4. The page confirms back to your computer, whose copy becomes read-only ("Moved to hosted", with a link). If the tab is closed before then, the run unlocks after 5 minutes (not fetched) or 30 (not confirmed), or at once with **Cancel send**. A send that was cancelled, or continued in a terminal, meanwhile can't be confirmed: the page then says the run is now open in both places.

What doesn't move: running apps and services, Continue-in-terminal sessions, PR watches (the hosted dashboard picks the watch up from the run), and anything outside the run's worktree. The pack is capped at 20 MB (gzipped). The hosted ingress must take a request that big: ingress-nginx's default is 1 MB, which the router template raises (`proxy-body-size: 25m`; on NGINX Inc's controller, `nginx.org/client-max-body-size`).

## Hosting a model for the team

An open model on the team's own GPU gives everyone (hosted dashboards too) a free model for code search and exploring. List it in `models.json` `endpoints` ([config.md](config.md#modelsjson-the-models-page-local-and-team-open-models)) and it shows up in every Model select.

- **The server.** Anything that speaks Anthropic's Messages API (`POST /v1/messages`, with tool use and streaming):
  - **Ollama** on a GPU machine (`OLLAMA_HOST=0.0.0.0`, `OLLAMA_CONTEXT_LENGTH=65536`). It's the simplest; one model at a time per GPU.
  - **vLLM** (`vllm serve <model> --enable-auto-tool-choice --tool-call-parser <the model's>`) for many people at once.
  - **LiteLLM**'s proxy in front of either. It adds per-person keys, rate limits and logs, and gives an Anthropic-format endpoint for servers that only speak OpenAI's.
- **The model.** One that calls tools reliably, with at least a 64k context window (Claude Code's own instructions are ~20k tokens). The Models page's recommended list is a good start; a 24–48 GB GPU runs the 27–35B ones at full speed, and an 80 GB one runs the next size up.
- **Sign-in.** Put it behind a token (LiteLLM keys, or a reverse proxy that checks a bearer token). Write the token as `"${TEAM_LLM_TOKEN}"` in models.json. Hosted dashboards get the variable from the deployment's secrets; people running the dashboard locally set it, or save their own token on the Models page.
- **Network.** The hosted containers' NetworkPolicy blocks the cluster's own network. Allow egress to the model server's Service (or give it an internal HTTPS address outside the cluster) and keep everything else blocked. Turns on the team model don't leave your network; Claude's own models still go to Anthropic.
- **Check it.** The Models page's **Test** calls `/v1/models` with the token. A run on the model shows `backend team endpoint <id>` on its page.

## Sizing (measured)

| | Memory | Notes |
|---|---|---|
| Dashboard, idle | ~115 MB | CPU near zero. |
| One Claude run | ~300 MB more | Subagents run inside the same process, so a run with three parallel subagents peaked at 444 MB in total. |
| First start | ~1.6 GB for a minute or two | The `npm ci` + `ng build` on the volume. |
| Disk | under 1 GB | The workspace and its repos (11 repos were 445 MB), plus transcripts. 10 GB is plenty. |

So: request 100m CPU and 512 MiB, limit 1 CPU and 2 GiB, and keep `deck.json` `limits.maxConcurrentRuns` at its default of 3. Twenty people then reserve about 2 vCPU and 10 GiB, one 4 vCPU / 16 GB node.

## Security checklist

- The proxy secret is set, long and random, and only the login proxy has it.
- `DASHBOARD_OWNER` is set on every container.
- The containers have no cloud or cluster credentials, and can't reach the cluster network or the metadata endpoint.
- The dashboard is reachable only through the login proxy, not directly from the network.
- Each person's volume is theirs alone. Back it up if losing chat history matters.

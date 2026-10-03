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

The dashboard refuses to start when `DASHBOARD_HOSTED` is on and the URL or secret is missing. `GET /healthz` answers `ok` without any of the checks, for liveness probes.

What changes for the person:
- The Apps and Workspaces pages are hidden, and the server refuses app actions, Machine-page installs, "Continue in terminal", "Implement in terminal" and local docs previews. All of those open something on the server's own screen or ports.
- The Machine page's Claude Code check gets an in-page sign-in (below). The container's tools are the image's job, so it has no install buttons.

## The image

`templates/hosted/Dockerfile` is Node 24 plus git, the Claude CLI and the engine's server code, with everything personal on a volume at `/data`. Build it from `plugins/natterjack` once per workspace, and run one container per person:

```sh
docker build -f plugins/natterjack/templates/hosted/Dockerfile -t <registry>/natterjack-dashboard:1 plugins/natterjack
```

On start, `entrypoint.sh` puts the workspace in `/data/workspace` or updates it. Then it runs `node <engine>/bin/dashboard.mjs run` (`<engine>` is the engine folder: `natterjack/` by default, `dashboard/` in older workspaces; `.claude/dashboard/engine.json` `dir` says which), which is the server in the foreground. The workspace comes from one of two places.

**From a published snapshot** (recommended). This needs no git and no code-host account, in the container or for the person. Set `SNAPSHOT_CONFIG` to `repos.json`'s `snapshot` block as JSON, and the source's credentials in the environment (`SNAPSHOT_AZURE_SAS`, `SNAPSHOT_S3_*`, `SNAPSHOT_HTTP_TOKEN`, ...).
- **On boot**, it runs `snapshot.mjs install --repos` from the image. That installs or updates the workspace from the published workspace zip, then the prebuilt UI, then every repo, all as read-only copies (config.md "Snapshots").
- **With a prebuilt UI** (publish from where the engine folder is built), the first start skips `npm ci` and `ng build` entirely.
- **The key** comes from the environment, so the person never connects anything. Inject a read-only one: read and list for blobs, GetObject and ListBucket for S3.
- **To publish**, run publish from CI or from the Repos page on an engineer's machine, with a key that can write.

**From git:** `WORKSPACE_REPO` is cloned the first time and pulled afterwards. Add `GIT_TOKEN` if the repo is private; it goes through `GIT_ASKPASS`, so it's never written to disk. The first start runs `npm ci` and `ng build` on the volume, which takes a minute or two and about 1.6 GB of memory. Later starts skip the build. The person's app repos come from the Repos page: clones with a token the container can use, or read-only snapshots.

## Signing in to Claude

Each person signs in with their own seat on the company's Claude Team or Enterprise plan. On the Machine page, **Sign in to Claude** runs `claude auth login` in the container and shows two steps:
1. Open the sign-in page, which is pre-filled with the proxy's email, and sign in.
2. Paste the code the page shows back into the dashboard.

This works without a browser in the container: when the CLI's local callback can't be reached, the sign-in page shows a code instead of redirecting.

The login lands in `/data/claude`, so it survives restarts, and it's a full claude.ai login, so the person's claude.ai connectors (Atlassian, Google Drive, ...) work in their runs with nothing to set up in the container. They connect those once on claude.ai. Don't use `claude setup-token` instead: its token can only make model requests and doesn't get connectors.

To refuse personal accounts, put managed settings in the image (commented lines in the Dockerfile): `"forceLoginMethod": "claudeai"` and `"forceLoginOrgUUID": ["<org id>"]`. The org id is in `claude auth status` on a signed-in machine.

The tracker key for the dashboard's own Issues page is pasted on its Connect card, as locally, or injected per person (`JIRA_EMAIL` + `JIRA_API_TOKEN` for Jira, for example).

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
| `ROUTER_BACKEND` | (required) | `kubernetes` or `static` (below). |
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
- **`static`.** `ROUTER_STATIC_FILE` names a JSON file of `{ "<email>": "<dashboard URL>" }`, re-read when it changes. Use it for containers someone else keeps running: a VM with Docker, App Service apps, ECS services. The router never starts or stops them.
- **Another platform.** Implement `Backend` in `router/src/backends.ts` (find a person's URL, and optionally start/stop/list running ones) and add it to `makeBackend()`.

Build it from `plugins/natterjack`, so it gets the engine's shared request checks:

```sh
docker build -f plugins/natterjack/router/Dockerfile -t <registry>/natterjack-router:1 plugins/natterjack
```

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
- **Network policy.** Keep the NetworkPolicy, and check your CNI enforces it. It blocks the cluster's own network and the metadata endpoint, and allows HTTPS out.
- **Long streams.** Raise the ingress read timeout: runs stream over server-sent events.

### Without Kubernetes

- **A VM with Docker:** one container per person, each with its own volume, plus oauth2-proxy and the router with the `static` backend, behind Caddy or Traefik for TLS. This is the simplest setup for a handful of people.
- **Azure App Service** (Web App for Containers, Linux): one app per person. Either put the router (with `static`) in front of them all, or give each app its own address.
  - Run the image with oauth2-proxy as a sidecar container in front of it, and point the app's port (`WEBSITES_PORT`) at the sidecar's 4180. App Service's built-in sign-in (Easy Auth) passes the person's identity in `X-MS-CLIENT-PRINCIPAL-NAME`, but it can't add the proxy secret, so on its own it isn't enough.
  - Mount an Azure Files share at `/data` (path mappings).
  - Publish the snapshots to a blob container (`azure-blob`) and inject a read-only SAS as `SNAPSHOT_AZURE_SAS`. Issue it from a stored access policy so you can revoke it.
  - Turn on **Always On**, or idle apps are unloaded mid-run.
  - Pick a plan with 2 GB+ per app for the first start's build.
- **Managed container services** (Cloud Run, ECS on Fargate, Azure Container Apps) work if they can keep a persistent volume (a filesystem mount; EFS for Fargate, Azure Files for Container Apps) and keep the CPU allocated between requests. Runs carry on in the background after the page closes, so don't let the platform throttle or scale the container to zero while a run is going.

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

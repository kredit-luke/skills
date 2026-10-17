---
name: host
description: Set up, or finish setting up, hosted Natterjack dashboards for people without a dev machine (product, operations, support) - one shared address, a container per person, managed from the People page - on Kubernetes (GKE, EKS, AKS) or Azure App Service. Walks through the platform, images, snapshot, repo token, router and login proxy, hosting.json, roles, directory sign-in and the first person, checking what's already there at each step. Use when someone wants hosted, cloud or shared dashboards, wants to add people, asks how the People page or the router fits together, is setting this up for a new team, or when doctor reports hosted problems. Re-run it any time as a checklist.
argument-hint: "[workspace folder]"
---

# Hosted dashboards

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`, `references/` and `engine/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`) wherever it appears.

Hosted mode runs a dashboard per person on the team's own cloud, at one address. Engineers keep their local dashboards and manage everyone else's from the People page. `references/hosting.md` is the reference for every part; read the section a step names before doing it. `<engine>` below is the workspace's engine folder (`.claude/dashboard/engine.json` `dir`; `natterjack/` by default).

```
browser ── login proxy (Cloudflare Access, oauth2-proxy, IAP...; adds the email + the router's secret)
        └─ router at the shared address: email → that person's container (started if stopped)
              └─ their dashboard (workspace from the published snapshot; repos pulled with a read token)
```

**Ground rules.**
- **Discover before asking.** Read what's already there (the CLIs the user is signed in to: `az`, `kubectl`, `gcloud`, `gh`, `git`) before asking them anything, and match what exists.
- **Cloud changes need an OK.** Never create, change or delete anything in the cloud, a registry, DNS or a vault without showing the command or the preview and getting the user's OK. Secrets go straight from one store to another and are never printed: read a SAS's expiry, never its signature.
- **This repo is public.** Nothing team-specific goes into the plugin's own files.

## 0. Where things stand

The workspace needs Natterjack itself first (no `.claude/dashboard/engine.json`? run the `create` skill). Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" <workspace>
```

With `hosting.json` present, its `hosted:` lines say which steps below are done. Show the user a short checklist of the steps and their state, and start at the first one that isn't done. Without `hosting.json`, start at 1.

## 1. Decide (one round of questions)

Ask only what you can't see. Recommend, with the reason:
1. **Who gets one**, and from which directory: Google Workspace, Microsoft Entra ID, or typed in by hand (`manual`). Their email domain, and optionally one OU or department.
2. **Platform:** Kubernetes they already run, or Azure App Service. A team with neither and a handful of people can use a VM with Docker (hosting.md, "Without Kubernetes"); this skill covers the first two.
3. **Shared address and login proxy:** a subdomain they own (e.g. `agents.example.com`). In front of it, Cloudflare Access if the domain's DNS is on Cloudflare, else oauth2-proxy (or the cloud's own identity-aware proxy).
4. **How the workspace reaches each container.** A **published snapshot** (recommended: no git in the container, prebuilt UI, quick starts), **plus a read token for the repos** so every start pulls them to their latest `main`.
5. **Roles:** who builds and pushes code (they get the GitHub sign-in), who only reads and asks.

## 2. The platform (one time)

- **App Service:** hosting.md, "Azure App Service". One resource group holding:
  - a Linux plan (B2 or bigger);
  - a storage account (each person's file share, and the snapshot container);
  - a container registry;
  - a Key Vault using Azure RBAC.
- **Kubernetes:** hosting.md, "Kubernetes". A namespace, a node pool with a taint, a storage class, an ingress, and a NetworkPolicy the CNI enforces.

`az resource list -g <rg>` or `kubectl get ns,deploy,sts -n <ns>` first: reuse what exists. Whoever deploys needs Contributor on the group and the right to create role assignments on the vault and registry.

## 3. The snapshot

- **Where it's published:** `repos.json` `snapshot`, e.g. `{ "source": "azure-blob", "account": "<storage>", "container": "snapshots" }`. On Azure, give the container two stored access policies: one that reads and lists, one that publishes (`racwdl`).
- **The read key:** generate a SAS from the read policy and store it in the vault as `snapshot-azure-sas`. On Kubernetes, put it in a Secret.
- **Publish:** run `node <engine>/bin/snapshot.mjs publish`, with the publish key in the environment, or use the Repos page's **Publish now**.
  - It packages **origin's** default branch, so push first. A local commit isn't published.
  - Hosted dashboards install what was published last. Publish again after every config or engine change.

## 4. The repo token

A read token for the workspace's repos, so each start pulls every repo in `repos.json` to its latest default branch (hosting.md, "The latest repos on every start").
- **On GitHub:** a fine-grained token owned by the organization, with Contents: Read-only on those repos. Approve it under the org's personal access token settings if they're required.
- **App Service:** the user stores it in the vault through the portal, so it stays out of shell history. Name it in `hosting.json` `platform.parameters.gitTokenSecret` (e.g. `git-token`).
- **Kubernetes:** a Secret with `GIT_TOKEN`, mounted into the person template.

## 5. The images

```bash
node <engine>/bin/hosted-images.mjs --all --dry-run
node <engine>/bin/hosted-images.mjs --all --push --update-hosting
```

These build from the plugin release the engine is (hosting.md, "The image"). Show the dry run, push only with the user's OK, and offer to allow the command for Claude in `.claude/settings.local.json`.

## 6. The router and the shared address

hosting.md, "One address for everyone".
- **App Service:**
  - the router as a Web App: the router image, a system-assigned identity with Reader and Website Contributor on the group, `ROUTER_BACKEND=azure-app-service`, the subscription and group, `ROUTER_PUBLIC_URL`, `ROUTER_IDLE_MINUTES`;
  - its two secrets: `ROUTER_PROXY_SECRET`, and `ROUTER_BACKEND_SECRET`, which goes in the vault as `dashboard-backend-secret`;
  - `ROUTER_IDENTITY_HEADER=Cf-Access-Authenticated-User-Email` behind Cloudflare Access.
- **Kubernetes:** `kubectl apply -f` your copy of `templates/hosted/kubernetes-router.yaml`.

The address, on App Service behind Cloudflare, in this order:
1. **The domain:** the user adds a CNAME `<sub>` → `<router>.azurewebsites.net` as **DNS only**, and a TXT `asuid.<sub>` set to the router app's `customDomainVerificationId`.
2. **The binding:** `az webapp config hostname add`.
3. **The login proxy:** an Access application for the hostname, with the company's identity provider and an allow rule for their domain.
4. **The secret header:** a Transform Rule that sets `X-Dashboard-Proxy-Secret` to the `router-proxy-secret` value, read from the vault by the user.
5. **The proxy:** turn on proxying (SSL/TLS **Full**).

Check it:
- `https://<router>.azurewebsites.net/healthz` answers `ok`, and the router refuses anything else without the secret (401);
- the public address redirects to sign-in.

## 7. hosting.json and the template

Write `.claude/dashboard/hosting.json` (config.md, "hosting.json") from what steps 1-6 set up. Copy the plugin's `templates/hosted/app-service-person.bicep` or `kubernetes-person.yaml` into the workspace (e.g. `hosting/`) and fill in their settings. Then:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" <workspace>`
- `az bicep build` (App Service).

The People page's **Ask Claude to set it up** runs this step alone.

## 8. Roles

A role is who someone is and how Claude answers them; **access** (full stack or read-only) is what they can do with the code. The role only sets the default access (config.md, "Roles").
1. **Add the roles** in the People page's **Roles** section: name, default access, output style. Then Commit there.
2. **Give non-engineering roles a plain-language output style.** If the team has none yet, write `.claude/output-styles/<name>.md`, with `keep-coding-instructions: true` so Claude still reads code properly. Tell it to name the app, screen or report rather than files and methods.
3. **Limit the GitHub check to full access** in `machine.json`: `{ "use": "gh", "when": { "access": "full" } }`. Read-only people never get the sign-in, so their runs use only the read token.
4. **On the People page,** each person gets a role, plus their own access when it differs from the role's (a technical ops person: Operations with full stack). They can't change either.

Every local dashboard asks its user for their role once, after this. Tell the team.

## 9. The directory sign-in (each engineer who manages people)

- **Google:** the Machine page's **Google Workspace directory** check takes the team's Desktop-app OAuth client file, then signs in. hosting.md, "Setting it up", says how to make the client, once per team.
- **Entra:** `az login`.

## 10. The first person, end to end

Set up one engineer, ideally the user, on the People page: preview, then **Set up**, with their role. Then open the shared address and check, in order:
1. **The start:** sign-in, the "Starting your dashboard…" page, then the dashboard. The first start downloads the workspace; the repos clone in the background after that.
2. **The Repos page:** every repo is a clone on its default branch.
3. **Settings:** shows their role, and they can't change it.
4. **GitHub (engineering only):** the Machine page offers **Sign in to GitHub**, with a device code.
5. **A pushed commit:** push a test branch and look at its verification.
   - `gh api repos/<o>/<r>/commits/<sha> --jq .commit.verification` should say `verified: true`.
   - `reason: no_user` means their work email isn't a verified email on their GitHub account. They add it under GitHub → Settings → Emails.

If the first start is refused with "Key Vault reference ... denied" (App Service): the app's own role on the vault wasn't in effect yet when it first started. Refresh its references (`az rest --method post --url .../sites/<app>/config/configreferences/appsettings/refresh?api-version=2023-12-01`), then restart it.

## 11. Finish

Commit and push the config (`hosting.json`, the template copy, `people.json`, `workspace.json`, `machine.json`, `repos.json`), publish the snapshot, and run doctor again. Then tell the user how this is kept running:
- **After a natterjack upgrade:**
  - `upgrade`'s `hostedImages`: rebuild the images and move the router.
  - `hostedTemplates`: bring the change into their template copy.
- **After config changes:** push, then publish.
- **Monthly:** rebuild both images for OS security fixes.
- **When a token or SAS expires:** replace it in the vault, then restart the dashboards (People page).
- **Anytime:** `doctor` checks all of the above.

## Known snags

- **`az` calls that drop randomly** (`ConnectionResetError 10054`, curl error 35): the machine's IPv6 route to `management.azure.com`.
  - Test it: `curl -6` vs `curl -4`.
  - Fix it: prefer IPv4 in the OS (Windows: raise `::ffff:0:0/96` in `netsh interface ipv6 show prefixpolicies`, keeping the default rows).
- **A 32-bit or old Azure CLI** is slow and noisy. Install the current 64-bit one.
- **A Cloudflare timeout (524) while a dashboard starts:** the router is older than this release. Rebuild and move it; current routers show the starting page instead.
- **The hosted dashboard runs an old engine:** the snapshot wasn't republished after the upgrade, or the upgrade wasn't pushed.

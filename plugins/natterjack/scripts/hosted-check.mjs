/**
 * Doctor's checks for hosted dashboards (references/hosting.md), when the workspace has
 * .claude/dashboard/hosting.json. Read-only: the engineer's own az / kubectl, git, HTTPS
 * to the public address and the router, and the local dashboard's snapshot status.
 *
 * Each catches something that otherwise shows up as a broken hosted dashboard:
 *   - the workspace isn't pushed (hosted dashboards install origin's default branch);
 *   - the published snapshot is behind it (they run what was last published);
 *   - the template copy lacks parameters the People page passes (role, gitTokenSecret...);
 *   - App Service: the plan, storage, registry or Key Vault isn't there; the image hosting.json
 *     names isn't in the registry; a secret the template reads isn't in the vault;
 *   - the router runs an older image than the dashboards, or doesn't answer;
 *   - the public address doesn't resolve or answer;
 *   - Kubernetes: the context or namespace can't be read.
 *
 *   node hosted-check.mjs <workspace> [--json]     (doctor.mjs runs it too)
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { args, isMain, readJson, PLUGIN_DIR } from "./lib.mjs";

const IS_WIN = process.platform === "win32";

/** A CLI's JSON output, or { error }. az and kubectl are .cmd shims on Windows (a shell runs them; no argument here has spaces). */
export function cliJson(cmd, a, timeout = 60000) {
  try {
    const out = execFileSync(IS_WIN ? [cmd, ...a].join(" ") : cmd, IS_WIN ? [] : a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout, shell: IS_WIN });
    return { data: out.trim() ? JSON.parse(out) : null };
  } catch (e) {
    const err = String(e.stderr || e.message || "").split(/\r?\n/).filter((l) => l.trim() && !/\.py:\d+: \w*Warning: /.test(l)).pop() || "failed";
    return { error: e.code === "ENOENT" || /not recognized|not found/i.test(err) ? `${cmd} isn't installed` : err.slice(0, 200) };
  }
}

const git = (root, a) => { try { return execFileSync("git", ["-C", root, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }).trim(); } catch { return null; } };

/** "natterjack-dashboard:0.15.0-202610171817" → { repo, tag, version: "0.15.0" } */
export function parseImage(ref) {
  const s = String(ref || "").replace(/^DOCKER\|/, "");
  const at = s.lastIndexOf(":");
  const slash = s.lastIndexOf("/");
  const repo = at > slash ? s.slice(0, at) : s;
  const tag = at > slash ? s.slice(at + 1) : "latest";
  return { repo, tag, version: (/^(\d+\.\d+\.\d+)/.exec(tag) || [])[1] || null };
}

const cmpVer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/** Bicep `param <name>` declarations. */
export const bicepParams = (text) => new Set([...String(text).matchAll(/^\s*param\s+(\w+)/gm)].map((m) => m[1]));

/** Parameters the plugin's template declares that the team's copy doesn't (the People page may pass them). */
export function missingParams(copyText, pluginText) {
  const have = bicepParams(copyText);
  return [...bicepParams(pluginText)].filter((p) => !have.has(p));
}

/** Key Vault secrets the template reads, from hosting.json and the template's own references. */
export function requiredSecrets(hosting, templateText) {
  const p = hosting?.platform?.parameters || {};
  const want = new Set();
  if (/dashboard-backend-secret/.test(templateText)) want.add("dashboard-backend-secret");
  if (p.snapshotConfig && /snapshot-azure-sas/.test(templateText)) want.add("snapshot-azure-sas");
  if (p.gitTokenSecret) want.add(p.gitTokenSecret);
  for (const a of Object.values(hosting?.areas || {})) if (a && a.secret) want.add(a.secret);
  return [...want];
}

async function reachable(url, timeoutMs = 10000) {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status };
  } catch (e) {
    return { error: String(e?.cause?.code || e?.cause?.message || e.message) };
  }
}

/**
 * @param o.cli       (cmd, args) → { data } | { error }   (tests fake it)
 * @param o.http      (url) → { status } | { error }
 * @param o.snapshot  the local dashboard's GET /api/snapshot, or null when it isn't running
 */
export async function hostedChecks(root, o = {}) {
  root = path.resolve(root);
  const cli = o.cli || cliJson;
  const http = o.http || reachable;
  const out = [];
  const add = (status, what, detail = "", fix = "") => out.push({ status, what: `hosted: ${what}`, detail, fix });
  const cfgDir = path.join(root, ".claude", "dashboard");
  const hosting = readJson(path.join(cfgDir, "hosting.json"));
  if (!hosting) return out;
  const platform = hosting.platform || {};
  const p = platform.parameters || {};

  // ---- the workspace hosted dashboards install: origin's default branch, as the publisher packages it
  // (not the checked-out branch's upstream: on a feature branch that would be the wrong thing to compare).
  const originDefault = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    || (git(root, ["rev-parse", "--verify", "--quiet", "origin/main"]) ? "origin/main" : null);
  const localDefault = originDefault && originDefault.replace(/^origin\//, "");
  const ahead = localDefault && git(root, ["rev-parse", "--verify", "--quiet", localDefault]) ? git(root, ["rev-list", "--count", `${originDefault}..${localDefault}`]) : null;
  if (ahead !== null && Number(ahead) > 0) add("warn", "workspace", `${ahead} commit(s) on ${localDefault} aren't pushed; hosted dashboards install ${originDefault}`, "git push, then publish the snapshot (Repos page → Publish now).");
  const dirty = git(root, ["status", "--porcelain", "--", ".claude/dashboard", "hosting", "repos.json"]);
  // Porcelain lines are "XY path"; the output was trimmed, so the first may have lost its leading space.
  if (dirty) add("warn", "workspace", `uncommitted config: ${dirty.split(/\r?\n/).map((l) => l.replace(/^\s*\S{1,2}\s+/, "")).join(", ")}`, "Commit and push it, then publish, or hosted dashboards won't have it.");

  const snap = o.snapshot;
  if (snap && snap.workspace && snap.workspace.latest) {
    const head = originDefault ? git(root, ["rev-parse", originDefault]) : null;
    const published = snap.workspace.latest.sha;
    if (!head) add("ok", "snapshot", `published workspace is ${published.slice(0, 10)}; not compared (couldn't tell origin's default branch: git remote set-head origin --auto)`);
    else if (published && !head.startsWith(published) && !published.startsWith(head.slice(0, published.length))) {
      add("warn", "snapshot", `published workspace is ${published.slice(0, 10)} (built ${String(snap.builtAt || snap.workspace.latest.builtAt || "").slice(0, 10)}), ${originDefault} is at ${head.slice(0, 10)}`, "Publish the snapshot (Repos page → Publish now, or node <engine>/bin/snapshot.mjs publish).");
    } else if (published) add("ok", "snapshot", `published workspace is ${originDefault}'s ${published.slice(0, 10)}`);
  } else if (hosting.platform?.parameters?.snapshotConfig || readJson(path.join(root, "repos.json"))?.snapshot) {
    add("ok", "snapshot", snap
      ? "not compared with origin: connect the snapshot source on the Repos page so the dashboard can read what's published"
      : "not compared with origin: start the dashboard (and connect the snapshot source on its Repos page)");
  }

  // ---- the template copy
  const tplRel = platform.template;
  const tplFile = tplRel ? path.join(root, tplRel) : null;
  const tplText = tplFile && fs.existsSync(tplFile) ? fs.readFileSync(tplFile, "utf-8") : null;
  if (!tplText) add("fail", "template", `${tplRel || "platform.template"} isn't there`, "Copy the plugin's templates/hosted template into the workspace and point platform.template at it (the host skill does this).");
  else if (platform.type === "azure-app-service") {
    const plugin = path.join(PLUGIN_DIR, "templates", "hosted", "app-service-person.bicep");
    const missing = fs.existsSync(plugin) ? missingParams(tplText, fs.readFileSync(plugin, "utf-8")) : [];
    if (missing.length) add("warn", "template", `${tplRel} is missing parameters the plugin's template has: ${missing.join(", ")}`, `Bring them over from ${path.relative(root, plugin) || plugin}, keeping your settings (the People page fails to deploy when it passes one).`);
    else add("ok", "template", `${tplRel} has every parameter the People page passes`);
  }

  // ---- roles: who can sign in to GitHub
  const machine = readJson(path.join(cfgDir, "machine.json"));
  const ws = readJson(path.join(cfgDir, "workspace.json")) || {};
  const gh = (machine?.checks || []).find((c) => c && c.use === "gh");
  if (ws.roles && gh && !gh.when) add("warn", "roles", "everyone gets the GitHub sign-in (machine.json's gh check has no when)", 'Give it "when": { "access": "full" }; read-only people keep only the read token.');
  if (!p.gitTokenSecret && platform.type === "azure-app-service") add("ok", "repos", "no gitTokenSecret: hosted repos are as fresh as the last snapshot publish (set one to pull them on every start)");

  // ---- App Service
  if (platform.type === "azure-app-service") {
    const rg = platform.resourceGroup;
    const sub = platform.subscription ? ["--subscription", platform.subscription] : [];
    const acct = cli("az", ["account", "show", "-o", "json", "--only-show-errors"]);
    if (acct.error) { add("fail", "azure", `az: ${acct.error}`, "az login (the People page and these checks use your own sign-in)."); return out; }
    const res = cli("az", ["resource", "list", "-g", rg, ...sub, "-o", "json", "--only-show-errors"]);
    if (res.error) { add("fail", "azure", `can't list resource group ${rg}: ${res.error}`, "Check the name, and that your account can read it."); return out; }
    const have = new Map((res.data || []).map((r) => [`${String(r.type).toLowerCase()}/${String(r.name).toLowerCase()}`, r]));
    const need = [["plan", "microsoft.web/serverfarms", "App Service plan"], ["storageAccount", "microsoft.storage/storageaccounts", "storage account"], ["registry", "microsoft.containerregistry/registries", "container registry"], ["keyVault", "microsoft.keyvault/vaults", "Key Vault"]];
    const gone = need.filter(([k, t]) => p[k] && !have.has(`${t}/${String(p[k]).toLowerCase()}`)).map(([k, , label]) => `${label} ${p[k]}`);
    add(gone.length ? "fail" : "ok", "azure", gone.length ? `not in ${rg}: ${gone.join(", ")}` : `${rg} has the plan, storage, registry and Key Vault`, gone.length ? "Create them (the host skill walks through it), or fix the names in hosting.json platform.parameters." : "");

    const img = parseImage(p.image);
    if (p.registry && p.image) {
      const tags = cli("az", ["acr", "repository", "show-tags", "-n", p.registry, "--repository", img.repo, "-o", "json", "--only-show-errors"]);
      if (tags.error) add("warn", "image", `couldn't list ${p.registry}/${img.repo}: ${tags.error}`);
      else if (!(tags.data || []).includes(img.tag)) add("fail", "image", `${p.image} isn't in ${p.registry}`, "Build and push it: node <engine>/bin/hosted-images.mjs --push --update-hosting.");
      else add("ok", "image", `${p.image} is in ${p.registry}`);
    }

    if (p.keyVault && tplText) {
      const want = requiredSecrets(hosting, tplText);
      const sec = cli("az", ["keyvault", "secret", "list", "--vault-name", p.keyVault, "-o", "json", "--only-show-errors"]);
      if (sec.error) add("warn", "secrets", `couldn't list ${p.keyVault}'s secrets: ${sec.error}`, "You need Key Vault Secrets User (or Officer) on it to check; dashboards read them with their own identity.");
      else {
        const names = new Set((sec.data || []).map((s) => s.name));
        const lack = want.filter((n) => !names.has(n));
        add(lack.length ? "fail" : "ok", "secrets", lack.length ? `${p.keyVault} has no ${lack.join(", ")}` : `${p.keyVault} has ${want.join(", ")}`, lack.length ? "Add them in the portal (Key Vault → Secrets → Generate/Import); hosting.md says what each one is." : "");
      }
    }

    // The router: a site in the group that isn't a person's dashboard and runs the router image.
    const sites = (res.data || []).filter((r) => String(r.type).toLowerCase() === "microsoft.web/sites");
    const owned = (t) => Object.keys(t || {}).some((k) => k.toLowerCase() === "natterjack-owner") || (t && String(t.purpose || "").toLowerCase() === "hosted-workspace-dashboard" && t.owner);
    let router = null;
    for (const s of sites.filter((x) => !owned(x.tags))) {
      const c = cli("az", ["webapp", "config", "show", "-g", rg, "-n", s.name, ...sub, "-o", "json", "--only-show-errors"]);
      const fx = c.data && c.data.linuxFxVersion;
      if (fx && /natterjack-router|agentic-router/.test(fx)) { router = { name: s.name, image: parseImage(fx) }; break; }
    }
    if (!router) add("warn", "router", `no Web App in ${rg} runs the router image`, "Hosted dashboards need the router at the shared address (hosting.md, \"Azure App Service\").");
    else {
      const behind = img.version && (!router.image.version || cmpVer(router.image.version, img.version) < 0);
      add(behind ? "warn" : "ok", "router", `${router.name} runs ${router.image.repo.split("/").pop()}:${router.image.tag}${behind ? `, older than the dashboards' ${img.version}` : ""}`,
        behind ? `node <engine>/bin/hosted-images.mjs --router --push, then point ${router.name} at the new tag.` : "");
      const h = await http(`https://${router.name}.azurewebsites.net/healthz`);
      if (h.status !== 200) add("fail", "router", `${router.name} doesn't answer /healthz (${h.error || `HTTP ${h.status}`})`, "Check its log stream in the portal.");
    }

    if (p.publicUrl) {
      const r = await http(p.publicUrl);
      // A login proxy answers with a redirect to sign in (or 401/403): anything but a failure or a gateway error means it's there.
      const bad = r.error || r.status >= 500;
      add(bad ? "fail" : "ok", "address", bad ? `${p.publicUrl} ${r.error ? `doesn't answer (${r.error})` : `answers HTTP ${r.status}`}` : `${p.publicUrl} answers (HTTP ${r.status})`,
        bad ? "Check its DNS record, the custom domain on the router app, and the login proxy in front (hosting.md, \"The shared address\")." : "");
    }
  }

  // ---- Kubernetes
  if (platform.type === "kubernetes") {
    const ctx = platform.context ? ["--context", platform.context] : [];
    const ns = cli("kubectl", [...ctx, "get", "namespace", platform.namespace, "-o", "json"]);
    if (ns.error) { add("fail", "kubernetes", `can't read namespace ${platform.namespace}${platform.context ? ` in ${platform.context}` : ""}: ${ns.error}`, "Get credentials for the cluster (gcloud container clusters get-credentials / az aks get-credentials / aws eks update-kubeconfig)."); return out; }
    const deps = cli("kubectl", [...ctx, "-n", platform.namespace, "get", "deployments", "-o", "json"]);
    const images = (deps.data?.items || []).flatMap((d) => (d.spec?.template?.spec?.containers || []).map((c) => c.image));
    const router = images.find((i) => /natterjack-router|agentic-router/.test(i));
    const dashImg = tplText && (/image:\s*["']?([^\s"']*natterjack-dashboard[^\s"']*)/.exec(tplText) || [])[1];
    if (!router) add("warn", "router", `no deployment in ${platform.namespace} runs the router image`, "Apply templates/hosted/kubernetes-router.yaml (hosting.md).");
    else {
      const r = parseImage(router), d = parseImage(dashImg);
      const behind = d.version && (!r.version || cmpVer(r.version, d.version) < 0);
      add(behind ? "warn" : "ok", "router", `runs ${r.repo.split("/").pop()}:${r.tag}${behind ? `, older than the dashboards' ${d.version}` : ""}`, behind ? "Rebuild and push it (hosted-images.mjs --router --push), then set the deployment's image." : "");
    }
  }
  return out;
}

if (isMain(import.meta)) {
  const a = args();
  const checks = await hostedChecks(a._[0] || process.cwd(), { snapshot: undefined });
  if (a.json) console.log(JSON.stringify(checks, null, 2));
  else for (const c of checks) console.log(`${c.status === "ok" ? "  ok  " : c.status === "warn" ? " warn " : " FAIL "} ${c.what}: ${c.detail}${c.fix ? `\n        → ${c.fix}` : ""}`);
  process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
}

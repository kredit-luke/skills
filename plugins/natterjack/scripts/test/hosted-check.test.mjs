// hosted-check.mjs: doctor's hosted-dashboard checks against a fake az / kubectl and a fake HTTP probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostedChecks, missingParams, parseImage, requiredSecrets } from "../hosted-check.mjs";

const TEMPLATE = `param appName string
param role string = ''
param gitTokenSecret string = ''
param image string
var x = '@Microsoft.KeyVault(SecretUri=\${kvRef}/dashboard-backend-secret)'
var y = '@Microsoft.KeyVault(SecretUri=\${kvRef}/snapshot-azure-sas)'
`;

function workspace({ hosting, machine, workspace = {}, template = TEMPLATE }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nj-hosted-"));
  const cfg = path.join(root, ".claude", "dashboard");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, "hosting.json"), JSON.stringify(hosting));
  fs.writeFileSync(path.join(cfg, "workspace.json"), JSON.stringify(workspace));
  if (machine) fs.writeFileSync(path.join(cfg, "machine.json"), JSON.stringify(machine));
  if (template !== null) { fs.mkdirSync(path.join(root, "hosting")); fs.writeFileSync(path.join(root, "hosting", "person.bicep"), template); }
  return root;
}

const APP_SERVICE = {
  directory: { type: "google", domain: "acme.com" },
  platform: {
    type: "azure-app-service", resourceGroup: "dash-rg", template: "hosting/person.bicep",
    parameters: { plan: "dash-asp", storageAccount: "acmedata", registry: "acmeacr", image: "natterjack-dashboard:0.16.0-1", keyVault: "acme-kv", publicUrl: "https://agents.acme.com", snapshotConfig: "{}", gitTokenSecret: "git-token" },
  },
  profiles: { member: { name: "Member" } },
};

/** A fake az: answers by command, or as `answers` overrides. */
function fakeAz(answers = {}) {
  const base = {
    "account show": { data: { id: "sub" } },
    "resource list": { data: [
      { type: "Microsoft.Web/serverFarms", name: "dash-asp" }, { type: "Microsoft.Storage/storageAccounts", name: "acmedata" },
      { type: "Microsoft.ContainerRegistry/registries", name: "acmeacr" }, { type: "Microsoft.KeyVault/vaults", name: "acme-kv" },
      { type: "Microsoft.Web/sites", name: "acme-router", tags: {} }, { type: "Microsoft.Web/sites", name: "dash-ana", tags: { "natterjack-owner": "ana@acme.com" } },
    ] },
    "acr repository": { data: ["0.15.0-3", "0.16.0-1"] },
    "keyvault secret": { data: [{ name: "dashboard-backend-secret" }, { name: "snapshot-azure-sas" }, { name: "git-token" }] },
    "webapp config": { data: { linuxFxVersion: "DOCKER|acmeacr.azurecr.io/natterjack-router:0.16.0-1" } },
  };
  const calls = [];
  const cli = (cmd, a) => {
    calls.push(`${cmd} ${a.join(" ")}`);
    const key = Object.keys({ ...base, ...answers }).find((k) => a.join(" ").startsWith(k));
    return key ? ({ ...base, ...answers })[key] : { error: `unexpected ${a.join(" ")}` };
  };
  return { cli, calls };
}
const okHttp = async (url) => ({ status: url.endsWith("/healthz") ? 200 : 302 });
const byWhat = (checks) => Object.fromEntries(checks.map((c) => [c.what.replace("hosted: ", ""), c]));

test("parseImage, missingParams and requiredSecrets", () => {
  assert.deepEqual(parseImage("DOCKER|acme.azurecr.io/natterjack-router:0.15.0-202610171823"), { repo: "acme.azurecr.io/natterjack-router", tag: "0.15.0-202610171823", version: "0.15.0" });
  assert.deepEqual(parseImage("natterjack-router:1"), { repo: "natterjack-router", tag: "1", version: null });
  assert.deepEqual(missingParams("param appName string\nparam image string", TEMPLATE), ["role", "gitTokenSecret"]);
  assert.deepEqual(requiredSecrets({ ...APP_SERVICE, areas: { fin: { secret: "area-fin" } } }, TEMPLATE).sort(), ["area-fin", "dashboard-backend-secret", "git-token", "snapshot-azure-sas"]);
  assert.deepEqual(requiredSecrets({ platform: { parameters: {} } }, TEMPLATE), ["dashboard-backend-secret"], "no snapshot or token configured: only the backend secret");
});

test("App Service: all there is all ok", async () => {
  const root = workspace({ hosting: APP_SERVICE });
  const c = byWhat(await hostedChecks(root, { cli: fakeAz().cli, http: okHttp, snapshot: undefined }));
  for (const k of ["azure", "image", "secrets", "router", "address"]) assert.equal(c[k].status, "ok", `${k}: ${c[k].detail}`);
  assert.match(c.router.detail, /acme-router runs natterjack-router:0\.16\.0-1/);
});

test("App Service: what's missing or stale fails or warns, each with a fix", async () => {
  const root = workspace({ hosting: APP_SERVICE, template: "param appName string\nparam image string\nvar k = 'dashboard-backend-secret' 'snapshot-azure-sas'" });
  const az = fakeAz({
    "resource list": { data: [{ type: "Microsoft.Web/serverFarms", name: "dash-asp" }, { type: "Microsoft.Storage/storageAccounts", name: "acmedata" }, { type: "Microsoft.ContainerRegistry/registries", name: "acmeacr" }, { type: "Microsoft.Web/sites", name: "acme-router", tags: {} }] },
    "acr repository": { data: ["0.15.0-3"] },
    "keyvault secret": { data: [{ name: "dashboard-backend-secret" }] },
    "webapp config": { data: { linuxFxVersion: "DOCKER|acmeacr.azurecr.io/natterjack-router:1" } },
  });
  const http = async (url) => (url.endsWith("/healthz") ? { error: "ECONNRESET" } : { status: 524 });
  const checks = await hostedChecks(root, { cli: az.cli, http, snapshot: undefined });
  const c = byWhat(checks);
  assert.equal(c.azure.status, "fail");
  assert.match(c.azure.detail, /Key Vault acme-kv/);
  assert.equal(c.image.status, "fail");
  assert.match(c.image.fix, /hosted-images\.mjs --push/);
  assert.equal(c.secrets.status, "fail");
  assert.match(c.secrets.detail, /no snapshot-azure-sas, git-token/);
  assert.equal(c.template.status, "warn");
  assert.match(c.template.detail, /missing parameters the plugin's template has: .*role/);
  const router = checks.filter((x) => x.what === "hosted: router");
  assert.equal(router[0].status, "warn", "an unversioned router tag is older than any release");
  assert.equal(router[1].status, "fail", "and it doesn't answer");
  assert.equal(c.address.status, "fail");
  assert.match(c.address.detail, /HTTP 524/);
  assert.ok(checks.every((x) => x.status === "ok" || x.fix), "every problem says what to do");
});

test("App Service: not signed in to az stops there, saying so", async () => {
  const root = workspace({ hosting: APP_SERVICE });
  const az = fakeAz({ "account show": { error: "Please run 'az login' to setup account." } });
  const c = byWhat(await hostedChecks(root, { cli: az.cli, http: okHttp }));
  assert.equal(c.azure.status, "fail");
  assert.match(c.azure.fix, /az login/);
  assert.equal(az.calls.length, 1, "nothing else is asked");
});

test("roles: a GitHub check without when gives every role the sign-in", async () => {
  const root = workspace({ hosting: APP_SERVICE, workspace: { roles: { eng: { label: "Eng" }, ops: { label: "Ops", profile: "reader" } } }, machine: { checks: [{ use: "gh" }] } });
  const c = byWhat(await hostedChecks(root, { cli: fakeAz().cli, http: okHttp }));
  assert.equal(c.roles.status, "warn");
  const limited = workspace({ hosting: APP_SERVICE, workspace: { roles: { eng: { label: "Eng" } } }, machine: { checks: [{ use: "gh", when: { role: ["eng"] } }] } });
  assert.equal(byWhat(await hostedChecks(limited, { cli: fakeAz().cli, http: okHttp })).roles, undefined);
});

test("the published snapshot is compared with the workspace's commit", async () => {
  const root = workspace({ hosting: APP_SERVICE });
  // Not a git repo here: there's nothing to compare with, so it says it couldn't.
  const c = byWhat(await hostedChecks(root, { cli: fakeAz().cli, http: okHttp, snapshot: { builtAt: "2026-10-03", workspace: null } }));
  assert.match(c.snapshot.detail, /connect the snapshot source/);
});

test("Kubernetes: an unreadable namespace fails with how to get credentials", async () => {
  const hosting = { directory: { type: "manual" }, platform: { type: "kubernetes", context: "gke_x", namespace: "dashboards", template: "hosting/person.yaml" }, profiles: { m: { name: "M" } } };
  const root = workspace({ hosting, template: null });
  fs.mkdirSync(path.join(root, "hosting"), { recursive: true });
  fs.writeFileSync(path.join(root, "hosting", "person.yaml"), "image: europe-docker.pkg.dev/acme/natterjack-dashboard:0.16.0-1\n");
  const cli = (cmd, a) => (cmd === "kubectl" ? { error: "Unable to connect to the server" } : { error: "?" });
  const c = byWhat(await hostedChecks(root, { cli, http: okHttp }));
  assert.equal(c.kubernetes.status, "fail");
  assert.match(c.kubernetes.fix, /get-credentials/);
});

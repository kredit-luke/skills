// bin/hosted-images.mjs: the build-and-push plan, where it builds from, and the one-line hosting.json change.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { parseArgs, defaultTag, registryFromHosting, acrName, dashboardRepo, findPlugin, plan, withImage } = await import("../../bin/hosted-images.mjs");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hosted-images-")));

/** A fake natterjack plugin folder: its manifest and both Dockerfiles. */
function fakePlugin(dir: string, name = "natterjack") {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  fs.mkdirSync(path.join(dir, "templates", "hosted"), { recursive: true });
  fs.writeFileSync(path.join(dir, "templates", "hosted", "Dockerfile"), "FROM scratch\n");
  fs.mkdirSync(path.join(dir, "router"), { recursive: true });
  fs.writeFileSync(path.join(dir, "router", "Dockerfile"), "FROM scratch\n");
  return dir;
}

test("parseArgs: the dashboard image by default; --router, --all and the flags", () => {
  assert.deepEqual(parseArgs([]), { which: "dashboard", registry: null, tag: null, push: false, updateHosting: false, plugin: null, workspace: null, dryRun: false });
  const o = parseArgs(["--all", "--registry", "acme.azurecr.io/", "--tag", "0.16.0-1", "--push", "--update-hosting", "--dry-run"]);
  assert.equal(o.which, "all");
  assert.equal(o.registry, "acme.azurecr.io", "a trailing slash is dropped");
  assert.equal(o.tag, "0.16.0-1");
  assert.ok(o.push && o.updateHosting && o.dryRun);
  assert.equal(parseArgs(["--router"]).which, "router");
});

test("parseArgs refuses what would go wrong later", () => {
  assert.throws(() => parseArgs(["--tag"]), /needs a value/);
  assert.throws(() => parseArgs(["--tag", "--push"]), /needs a value/);
  assert.throws(() => parseArgs(["--tag", "has space"]), /valid image tag/);
  assert.throws(() => parseArgs(["--update-hosting"]), /needs --push/, "hosting.json only names a pushed image");
  assert.throws(() => parseArgs(["--router", "--push", "--update-hosting"]), /dashboard image/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
});

test("defaultTag is the engine version and a UTC minute, so every build gets a new one", () => {
  assert.equal(defaultTag("0.15.0", new Date(Date.UTC(2026, 9, 6, 4, 5))), "0.15.0-202610060405");
});

test("the registry comes from an App Service hosting.json; az acr login gets its name", () => {
  assert.equal(registryFromHosting({ platform: { type: "azure-app-service", parameters: { registry: "acmedashacr" } } }), "acmedashacr.azurecr.io");
  assert.equal(registryFromHosting({ platform: { type: "azure-app-service", parameters: { registry: "acme.azurecr.io" } } }), "acme.azurecr.io");
  assert.equal(registryFromHosting({ platform: { type: "kubernetes", namespace: "d" } }), null, "Kubernetes names its image in the template");
  assert.equal(registryFromHosting(null), null);
  assert.equal(acrName("acmedashacr.azurecr.io"), "acmedashacr");
  assert.equal(acrName("europe-docker.pkg.dev/acme/dash"), null);
});

test("dashboardRepo keeps the repository hosting.json already uses", () => {
  assert.equal(dashboardRepo({ platform: { parameters: { image: "team/dash:1" } } }), "team/dash");
  assert.equal(dashboardRepo({}), "natterjack-dashboard");
});

test("findPlugin: --plugin, then the checkout the engine is in, then the installed release of its version", () => {
  const checkout = fakePlugin(path.join(TMP, "skills", "plugins", "natterjack"));
  fs.mkdirSync(path.join(checkout, "engine"), { recursive: true });
  assert.equal(findPlugin({ engineDir: path.join(checkout, "engine"), version: "9.9.9", claudeDir: path.join(TMP, "nothing") }).dir, checkout);

  const claudeDir = path.join(TMP, "claude");
  fakePlugin(path.join(claudeDir, "plugins", "cache", "market", "natterjack", "0.14.0"));
  const wanted = fakePlugin(path.join(claudeDir, "plugins", "cache", "market", "natterjack", "0.15.0"));
  const workspaceEngine = path.join(TMP, "workspace", "dashboard");
  fs.mkdirSync(workspaceEngine, { recursive: true });
  assert.equal(findPlugin({ engineDir: workspaceEngine, version: "0.15.0", claudeDir }).dir, wanted, "the release the engine is, not just any");
  assert.throws(() => findPlugin({ engineDir: workspaceEngine, version: "0.16.0", claudeDir }), /0\.16\.0 .*isn't installed \(installed: 0\.14\.0, 0\.15\.0\)/);

  assert.equal(findPlugin({ plugin: wanted, engineDir: workspaceEngine, version: "0.16.0", claudeDir }).dir, wanted);
  const other = fakePlugin(path.join(TMP, "other"), "something-else");
  assert.throws(() => findPlugin({ plugin: other, engineDir: workspaceEngine, version: null, claudeDir }), /isn't the natterjack plugin/);
});

test("plan: --pull --no-cache builds, then az acr login and the pushes", () => {
  const pluginDir = path.join(TMP, "p");
  const { steps, refs } = plan({ which: "all", registry: "acme.azurecr.io", tag: "t1", push: true, pluginDir, repo: "natterjack-dashboard" });
  assert.deepEqual(refs, { dashboard: "acme.azurecr.io/natterjack-dashboard:t1", router: "acme.azurecr.io/natterjack-router:t1" });
  assert.deepEqual(steps.map((s: any[]) => `${s[1]} ${s[2][0]}`), ["docker build", "docker build", "az acr", "docker push", "docker push"]);
  const build = steps[0][2];
  assert.ok(build.includes("--pull") && build.includes("--no-cache"), "a cached layer would keep the old Debian packages");
  assert.equal(build[build.indexOf("-f") + 1], path.join(pluginDir, "templates", "hosted", "Dockerfile"));
  assert.equal(build.at(-1), pluginDir, "built from the plugin folder, so the engine's files come along");
  assert.deepEqual(steps[2][2], ["acr", "login", "--name", "acme"]);

  const other = plan({ which: "router", registry: "europe-docker.pkg.dev/acme/dash", tag: "t2", push: true, pluginDir, repo: "x" });
  assert.deepEqual(other.steps.map((s: any[]) => s[1]), ["docker", "docker"], "no az outside Azure: docker login is the user's");
  assert.equal(plan({ which: "dashboard", registry: "r.io", tag: "t", push: false, pluginDir, repo: "d" }).steps.length, 1, "no push without --push");
});

test("withImage changes the image and nothing else in hosting.json", () => {
  const text = '{\n  "platform": { "parameters": { "plan": "asp", "image": "natterjack-dashboard:1",\n    "keyVault": "kv" } },\n  "profiles": { "member": { "name": "Member" } }\n}\n';
  assert.equal(withImage(text, "natterjack-dashboard:0.16.0-2"), text.replace('"natterjack-dashboard:1"', '"natterjack-dashboard:0.16.0-2"'));
  assert.throws(() => withImage('{ "platform": {} }', "x:1"), /no "image" setting/);
  assert.throws(() => withImage('{ "image": "a:1", "b": { "image": "c:2" } }', "x:1"), /more than one/);
});

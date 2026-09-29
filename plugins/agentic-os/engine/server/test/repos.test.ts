// repos.json: normalizing both field-name styles, what's on disk, and cloning a missing repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cloneStep, cloneTargets, normalizeRepo, readRepos, repoState, reposStatus, safeRelativePath } from "../src/repos.ts";

const scratch = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `dash-repos-${name}-`));
const writeRepos = (root: string, data: unknown) => fs.writeFileSync(path.join(root, "repos.json"), typeof data === "string" ? data : JSON.stringify(data));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim();

test("relative paths: nested folders are fine, anything leaving the workspace isn't", () => {
  assert.equal(safeRelativePath("bff/admin-service"), "bff/admin-service");
  assert.equal(safeRelativePath("./ui\\web/"), "ui/web");
  for (const bad of ["", ".", "/etc", "C:\\x", "c:/x", "../up", "a/../../b", 7, null]) assert.equal(safeRelativePath(bad), null, String(bad));
});

test("both repos.json styles normalize to relativePath / remote", () => {
  assert.deepEqual(normalizeRepo({ name: "admin-service", layer: "bff", relativePath: "bff/admin-service", remote: "https://x/admin-service.git" }), {
    name: "admin-service", relativePath: "bff/admin-service", remote: "https://x/admin-service.git", layer: "bff", defaultBranch: null, dependencies: [],
  });
  const old = normalizeRepo({ name: "API", url: "https://x/api.git", directory: "api", dependencies: ["web", 3] });
  assert.equal(old!.relativePath, "api");
  assert.equal(old!.remote, "https://x/api.git");
  assert.deepEqual(old!.dependencies, ["web"]);
  assert.equal(normalizeRepo({ name: "web" })!.relativePath, "web", "the path defaults to the name");
  assert.equal(normalizeRepo({ relativePath: "x" }), null, "a name is required");
  assert.equal(normalizeRepo({ name: "evil", relativePath: "../outside" }), null);
});

test("readRepos: no file, bad JSON, and duplicate paths", () => {
  const root = scratch("read");
  assert.deepEqual(readRepos(root), { configured: false, repos: [], error: null });
  writeRepos(root, "{ nope");
  assert.match(readRepos(root).error!, /isn't valid JSON/);
  writeRepos(root, { nope: [] });
  assert.match(readRepos(root).error!, /"repos" array/);
  writeRepos(root, "\uFEFF" + JSON.stringify({ repos: [{ name: "a" }, { name: "b", relativePath: "a" }, { name: "c", relativePath: "/abs" }] }));
  const r = readRepos(root);
  assert.equal(r.error, null, "a BOM is fine");
  assert.deepEqual(r.repos.map((x) => x.name), ["a"], "the second use of a path and the unsafe one are dropped");
});

test("state on disk: cloned, missing (absent or empty) and not-git; only missing ones with a remote get cloned", async () => {
  const root = scratch("state");
  fs.mkdirSync(path.join(root, "svc", "a", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "empty"));
  fs.mkdirSync(path.join(root, "loose"));
  fs.writeFileSync(path.join(root, "loose", "file.txt"), "x");
  writeRepos(root, { repos: [
    { name: "a", relativePath: "svc/a", remote: "https://x/a.git" },
    { name: "empty", remote: "https://x/empty.git" },
    { name: "loose", remote: "https://x/loose.git" },
    { name: "gone", relativePath: "svc/gone", remote: "https://x/gone.git" },
    { name: "noremote", relativePath: "svc/noremote" },
  ] });
  assert.equal(repoState(root, "svc/a"), "cloned");
  assert.equal(repoState(root, "empty"), "missing");
  assert.equal(repoState(root, "loose"), "not-git");
  assert.equal(repoState(root, "svc/gone"), "missing");
  assert.deepEqual(cloneTargets(root, null).map((r) => r.name), ["empty", "gone"]);
  assert.deepEqual(cloneTargets(root, ["gone", "loose"]).map((r) => r.name), ["gone"]);
  const status = await reposStatus(root);
  assert.equal(status.configured, true);
  assert.deepEqual(status.repos.map((r) => r.state), ["cloned", "missing", "not-git", "missing", "missing"]);
});

test("cloneStep clones into a nested folder, reports branch and changes, and won't touch a folder with files", async () => {
  const src = scratch("src");
  git(src, "init", "-q", "-b", "trunk");
  fs.writeFileSync(path.join(src, "README.md"), "hi\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "init");

  const root = scratch("clone");
  writeRepos(root, { repos: [{ name: "svc", relativePath: "services/svc", remote: src }] });
  const [target] = cloneTargets(root, null);
  const lines: string[] = [];
  await cloneStep(root, target)((t) => lines.push(t));
  assert.ok(lines[0].startsWith("$ git clone"));
  assert.equal(repoState(root, "services/svc"), "cloned");
  fs.writeFileSync(path.join(root, "services", "svc", "README.md"), "edited\n");
  const [info] = (await reposStatus(root)).repos;
  assert.equal(info.branch, "trunk");
  assert.equal(info.changes, 1);

  await assert.rejects(cloneStep(root, target)(() => {}), /already has files/);
  assert.deepEqual(cloneTargets(root, null), [], "nothing left to clone");
});

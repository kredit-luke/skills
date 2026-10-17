// pull.mjs against bare local remotes: what moves, what's left alone and why.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allRepos, resolveTargets, runPull } from "../pull.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const ident = (dir) => {
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
};

/**
 * A bare origin at <remotes>/<name>.git, a "seed" clone used to push upstream
 * commits, and a working clone at <ws>/<name>. Returns { work, push(msg) }.
 */
function makeCloned(remotes, ws, name) {
  const bare = path.join(remotes, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = path.join(remotes, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  ident(seed);
  fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  const work = path.join(ws, name);
  execFileSync("git", ["clone", "-q", bare, work]);
  ident(work);
  let n = 0;
  const push = (file = `up${++n}.txt`) => {
    fs.writeFileSync(path.join(seed, file), `${file}\n`);
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", `upstream ${file}`);
    git(seed, "push", "-q", "origin", "main");
  };
  return { work, seed, push };
}

function workspace(names, extra = {}) {
  const base = tmp("pull-");
  const remotes = path.join(base, "remotes");
  const ws = path.join(base, "ws");
  fs.mkdirSync(remotes);
  fs.mkdirSync(ws);
  const repos = Object.fromEntries(names.map((n) => [n, makeCloned(remotes, ws, n)]));
  fs.writeFileSync(
    path.join(ws, "repos.json"),
    JSON.stringify({ repos: names.map((n) => ({ name: n, relativePath: n, layer: extra.layers?.[n] ?? null })) })
  );
  return { ws, remotes, repos };
}

const head = (dir) => git(dir, "rev-parse", "HEAD");
const byName = (summary) => Object.fromEntries(summary.repos.map((r) => [r.name, r]));

test("behind+clean fast-forwards; dirty, feature branch, diverged, ahead and up to date are left alone", async () => {
  const { ws, repos } = workspace(["behind", "dirty", "feature", "diverged", "ahead", "current"]);
  for (const n of ["behind", "dirty", "feature", "diverged"]) repos[n].push();
  fs.writeFileSync(path.join(repos.dirty.work, "a.txt"), "local edit\n");
  git(repos.feature.work, "switch", "-q", "-c", "feature/ENG-1");
  for (const n of ["diverged", "ahead"]) {
    fs.writeFileSync(path.join(repos[n].work, "local.txt"), "x\n");
    git(repos[n].work, "add", ".");
    git(repos[n].work, "commit", "-q", "-m", "local");
  }
  const before = Object.fromEntries(Object.entries(repos).map(([n, r]) => [n, head(r.work)]));

  const s = await runPull({ root: ws });
  const r = byName(s);
  assert.equal(s.errors, 0);
  assert.equal(r.behind.state, "fast-forwarded");
  assert.equal(head(repos.behind.work), git(repos.behind.work, "rev-parse", "origin/main"));
  assert.equal(r.dirty.state, "dirty");
  assert.equal(r.feature.state, "other-branch");
  assert.match(r.feature.detail, /on feature\/ENG-1/);
  assert.equal(r.diverged.state, "diverged");
  assert.equal(r.ahead.state, "ahead");
  assert.equal(r.current.state, "up-to-date");

  for (const n of ["dirty", "feature", "diverged", "ahead", "current"]) assert.equal(head(repos[n].work), before[n], n);
  assert.equal(fs.readFileSync(path.join(repos.dirty.work, "a.txt"), "utf-8"), "local edit\n");
  assert.equal(git(repos.feature.work, "rev-parse", "--abbrev-ref", "HEAD"), "feature/ENG-1");
  assert.equal(git(repos.dirty.work, "stash", "list"), "");
});

test("dry run fetches nothing and changes nothing", async () => {
  const { ws, repos } = workspace(["api"]);
  repos.api.push();
  const before = head(repos.api.work);
  let s = await runPull({ root: ws, dryRun: true });
  assert.equal(s.repos[0].state, "up-to-date"); // not fetched, so origin/main is still the old one
  git(repos.api.work, "fetch", "-q", "origin");
  s = await runPull({ root: ws, dryRun: true });
  assert.equal(s.repos[0].state, "would-ff");
  assert.equal(head(repos.api.work), before);
});

test("named and layer targets; unknown names list the valid ones", async () => {
  const { ws, repos } = workspace(["api", "core", "web"], { layers: { api: "backend", core: "backend", web: "frontend" } });
  for (const r of Object.values(repos)) r.push();

  assert.deepEqual(resolveTargets(ws, ["WEB"]).map((r) => r.name), ["web"]);
  assert.deepEqual(resolveTargets(ws, ["backend"]).map((r) => r.name), ["api", "core"]);
  assert.deepEqual(resolveTargets(ws, [], { layer: "frontend" }).map((r) => r.name), ["web"]);
  assert.throws(() => resolveTargets(ws, ["nope"]), (e) => /nope/.test(e.message) && e.valid.repos.includes("api") && e.valid.layers.includes("backend"));

  const s = await runPull({ root: ws, layer: "backend" });
  assert.deepEqual(s.repos.map((r) => [r.name, r.state]), [["api", "fast-forwarded"], ["core", "fast-forwarded"]]);
  assert.equal(git(repos.web.work, "rev-list", "--count", "HEAD..origin/main"), "0"); // web wasn't even fetched
});

test("the root repo is included by default; an engine change asks for a dashboard restart", async () => {
  const base = tmp("pull-root-");
  const remotes = path.join(base, "remotes");
  fs.mkdirSync(remotes);
  const root = makeCloned(remotes, base, "workspace");
  const sub = makeCloned(remotes, root.work, "api");
  // The root ignores its sub-repo, as a workspace does.
  fs.writeFileSync(path.join(root.seed, ".gitignore"), "api/\n");
  fs.writeFileSync(path.join(root.seed, "repos.json"), JSON.stringify({ repos: ["api"] }));
  fs.mkdirSync(path.join(root.seed, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(root.seed, ".claude", "dashboard", "engine.json"), JSON.stringify({ dir: "engine" }));
  root.push("seedcfg.txt");
  git(root.work, "pull", "-q", "--ff-only");
  fs.mkdirSync(path.join(root.seed, "engine"));
  root.push(path.join("engine", "server.js"));
  sub.push();

  assert.deepEqual(resolveTargets(root.work, ["root"]).map((r) => r.relativePath), ["."]);
  const s = await runPull({ root: root.work });
  assert.deepEqual(s.repos.map((r) => [r.isRoot, r.state]), [[true, "fast-forwarded"], [false, "fast-forwarded"]]);
  assert.equal(s.engineChanged, "engine");

  root.push("other.txt");
  const again = await runPull({ root: root.work, targets: ["root"] });
  assert.equal(again.repos.length, 1);
  assert.equal(again.engineChanged, null);
});

test("refuses inside a worktree", async () => {
  const { ws } = workspace(["api"]);
  fs.writeFileSync(path.join(ws, ".worktree.json"), JSON.stringify({ name: "ENG-1", repos: ["api"] }));
  await assert.rejects(runPull({ root: ws }), (e) => e.worktree && /pull the main workspace/.test(e.message));

  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pull.mjs");
  const res = (() => {
    try {
      execFileSync(process.execPath, [script, "--root", ws], { stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  })();
  assert.equal(res, 2);
});

test("a fetch failure is an error (non-zero) and the repo isn't moved", async () => {
  const { ws, repos, remotes } = workspace(["api"]);
  git(repos.api.work, "remote", "set-url", "origin", path.join(remotes, "missing.git"));
  const s = await runPull({ root: ws });
  assert.equal(s.repos[0].state, "fetch-failed");
  assert.equal(s.errors, 1);
});

test("a repos.json entry for the root keeps its metadata (name, defaultBranch, layer) and is the root", async () => {
  const base = tmp("pull-rootcfg-");
  const remotes = path.join(base, "remotes");
  fs.mkdirSync(remotes);
  const root = makeCloned(remotes, base, "workspace");
  makeCloned(remotes, root.work, "api");
  fs.writeFileSync(path.join(root.work, "repos.json"), JSON.stringify({
    repos: [{ name: "hub", relativePath: ".", defaultBranch: "main", layer: "meta" }, { name: "api", relativePath: "api" }],
  }));
  const repos = allRepos(root.work);
  assert.deepEqual(repos.map((r) => [r.name, r.isRoot, r.defaultBranch, r.layer]), [["hub", true, "main", "meta"], ["api", false, null, null]]);
  assert.deepEqual(resolveTargets(root.work, ["meta"]).map((r) => r.name), ["hub"]);
  assert.deepEqual(resolveTargets(root.work, ["root"]).map((r) => r.name), ["hub"]);
});

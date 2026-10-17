// lib.mjs: config, repo listing, default branches, tickets, dependency order.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultBranch, dependencyOrder, findRoot, findTicket, isRepoTop, listRepos, parseArgs, readWorkspaceConfig, samePath, ticketRegex } from "../lib.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function makeRepo(dir, base = "main") {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", base);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("dependencyOrder: consumers after what they consume, listed order otherwise, cycles kept", () => {
  const repos = [
    { name: "web", dependencies: ["api"] },
    { name: "docs" },
    { name: "api", dependencies: ["core"] },
    { name: "core" },
  ];
  assert.deepEqual(dependencyOrder(repos).map((r) => r.name), ["core", "api", "web", "docs"]);
  const cyc = [{ name: "a", dependencies: ["b"] }, { name: "b", dependencies: ["a"] }, { name: "c", dependencies: ["zzz"] }];
  assert.deepEqual(dependencyOrder(cyc).map((r) => r.name).sort(), ["a", "b", "c"]);
});

test("ticket ids: workspace pattern, else KEY-123, case-insensitive, upper-cased", () => {
  assert.equal(findTicket(["feature/eng-12-thing"]), "ENG-12");
  assert.equal(findTicket(["main", "worktrees/OPS-3"]), "OPS-3");
  assert.equal(findTicket(["main"]), null);
  const cfg = { issues: { ticketPattern: "^[\\w.-]+#\\d+$" } };
  assert.ok(ticketRegex(cfg).test("fix/acme#7"));
});

test("listRepos: repos.json, .worktree.json (with source workspace info), single repo, subfolders", () => {
  const ws = tmp("mr-lib-ws-");
  makeRepo(path.join(ws, "api"), "develop");
  makeRepo(path.join(ws, "web"));
  fs.writeFileSync(
    path.join(ws, "repos.json"),
    JSON.stringify({ repos: [{ name: "api", relativePath: "api", defaultBranch: "develop" }, { name: "web", dependencies: ["api"] }, { name: "missing" }] })
  );
  const repos = listRepos(ws);
  assert.deepEqual(repos.map((r) => [r.name, r.exists]), [["api", true], ["web", true], ["missing", false]]);
  assert.equal(repos[0].defaultBranch, "develop");

  const wt = path.join(ws, "worktrees", "ENG-1");
  makeRepo(path.join(wt, "web"));
  fs.writeFileSync(path.join(wt, ".worktree.json"), JSON.stringify({ name: "ENG-1", repos: ["web"], sourceWorkspace: ws }));
  const inWt = listRepos(wt);
  assert.deepEqual(inWt.map((r) => r.name), ["web"]);
  assert.deepEqual(inWt[0].dependencies, ["api"]);
  assert.equal(findRoot(path.join(wt, "web")), wt);

  const single = makeRepo(tmp("mr-lib-single-"));
  assert.deepEqual(listRepos(single).map((r) => r.relativePath), ["."]);

  const loose = tmp("mr-lib-loose-");
  makeRepo(path.join(loose, "one"));
  fs.mkdirSync(path.join(loose, "not-a-repo"));
  assert.deepEqual(listRepos(loose).map((r) => r.name), ["one"]);
});

test("isRepoTop / samePath see through symlinks and junctions (git reports the real path)", () => {
  const real = makeRepo(tmp("mr-lib-real-"));
  const link = path.join(tmp("mr-lib-link-"), "via-link");
  fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(isRepoTop(link), true);
  assert.equal(samePath(link, real), true);
  assert.deepEqual(listRepos(link).map((r) => r.relativePath), ["."]);
  fs.mkdirSync(path.join(real, "sub"));
  assert.equal(isRepoTop(path.join(link, "sub")), false);
});

test("defaultBranch: configured, else a branch that exists", () => {
  const repo = makeRepo(tmp("mr-lib-db-"), "master");
  assert.equal(defaultBranch(repo, "trunk"), "trunk");
  assert.equal(defaultBranch(repo), "master");
});

test("parseArgs: flags, booleans, positionals", () => {
  const a = parseArgs(["all", "--dry-run", "--root", "x", "API"], { booleans: ["dry-run"] });
  assert.deepEqual(a, { _: ["all", "API"], "dry-run": true, root: "x" });
});

test("listRepos: a plain folder inside a git-backed workspace is missing, not the parent repo", () => {
  const ws = makeRepo(tmp("mr-lib-parent-"));
  makeRepo(path.join(ws, "api"));
  fs.mkdirSync(path.join(ws, "child"));
  fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({ repos: ["api", "child"] }));
  assert.deepEqual(listRepos(ws).map((r) => [r.name, r.exists]), [["api", true], ["child", false]]);
});

test("readWorkspaceConfig: a worktree without its own workspace.json reads its source workspace's", () => {
  const ws = tmp("mr-lib-cfg-");
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "workspace.json"), JSON.stringify({ issues: { ticketPattern: "[a-z]+#\\d+" } }));
  const wt = path.join(ws, "worktrees", "w");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".worktree.json"), JSON.stringify({ name: "w", repos: [], sourceWorkspace: ws }));
  assert.equal(readWorkspaceConfig(wt).issues.ticketPattern, "[a-z]+#\\d+");
  // Its own file wins.
  fs.mkdirSync(path.join(wt, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".claude", "dashboard", "workspace.json"), JSON.stringify({ issues: { kind: "none" } }));
  assert.deepEqual(readWorkspaceConfig(wt), { issues: { kind: "none" } });
  assert.deepEqual(readWorkspaceConfig(tmp("mr-lib-none-")), {});
});

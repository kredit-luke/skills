// repo-status.mjs on throwaway repos: file classification, tickets, eligibility, discovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectStatus, discoverRepos, formatText, parseNameStatus, walkRepos } from "../repo-status.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function makeRepo(dir, { base = "main", branch = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", base);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.writeFileSync(path.join(dir, "old.txt"), "a file long enough that git sees the move as a rename\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  if (branch) git(dir, "switch", "-q", "-c", branch);
  return dir;
}

test("parseNameStatus: plain entries and renames", () => {
  const raw = ["M", "src/a.ts", "R100", "old.txt", "new.txt", "A", "b c.txt", ""].join("\0");
  assert.deepEqual(parseNameStatus(raw), [
    { status: "M", path: "src/a.ts" },
    { status: "R100", path: "new.txt", oldPath: "old.txt" },
    { status: "A", path: "b c.txt" },
  ]);
  assert.deepEqual(parseNameStatus(""), []);
});

test("staged, unstaged, untracked and renames are classified separately; ticket from the branch", () => {
  const root = makeRepo(tmp("rs-single-"), { branch: "feature/ENG-77-thing" });
  fs.writeFileSync(path.join(root, "staged.txt"), "new\n");
  git(root, "add", "staged.txt");
  git(root, "mv", "old.txt", "new.txt");
  fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "fresh.ts"), "export {};\n");

  const { repos, ticket } = collectStatus({ root });
  assert.equal(repos.length, 1);
  const r = repos[0];
  assert.equal(r.branch, "feature/ENG-77-thing");
  assert.equal(r.ticket, "ENG-77");
  assert.equal(r.defaultBranch, "main");
  assert.equal(r.onDefault, false);
  assert.equal(ticket, "ENG-77");
  assert.equal(r.eligible, true);
  assert.deepEqual(
    r.staged.map((f) => [f.status[0], f.path, f.oldPath]),
    [["R", "new.txt", "old.txt"], ["A", "staged.txt", undefined]]
  );
  assert.deepEqual(r.unstaged, [{ status: "M", path: "a.txt" }]);
  assert.deepEqual(r.untracked, [{ status: "?", path: "src/fresh.ts" }]);
  assert.match(r.diffStat, /2 files changed/);
  assert.equal(r.ahead, null); // no origin
  assert.match(formatText({ root, ticket, repos, clean: [] }), /old\.txt -> new\.txt/);
});

test("workspace: only changed repos unless --all; default-branch and other-ticket repos aren't eligible", () => {
  const root = tmp("rs-ws-");
  makeRepo(path.join(root, "api"), { branch: "feature/ENG-5" });
  makeRepo(path.join(root, "web"), { branch: "feature/ENG-5" });
  makeRepo(path.join(root, "docs"));
  makeRepo(path.join(root, "infra"), { branch: "feature/ENG-9" });
  makeRepo(path.join(root, "tools"));
  for (const d of ["api", "docs", "infra"]) fs.writeFileSync(path.join(root, d, "a.txt"), "dirty\n");
  fs.writeFileSync(
    path.join(root, "repos.json"),
    JSON.stringify({ repos: ["api", "web", "docs", "infra", "tools"].map((n) => ({ name: n, relativePath: n })) })
  );

  const s = collectStatus({ root, ticket: "eng-5" });
  assert.equal(s.ticket, "ENG-5");
  assert.deepEqual(s.repos.map((r) => r.name), ["api", "docs", "infra"]);
  assert.deepEqual(s.clean.sort(), ["tools", "web"]);
  const elig = Object.fromEntries(s.repos.map((r) => [r.name, r.eligible]));
  assert.deepEqual(elig, { api: true, docs: false, infra: false });

  const all = collectStatus({ root, all: true, ticket: "ENG-5" });
  assert.equal(all.repos.length, 5);
  assert.equal(all.repos.find((r) => r.name === "web").eligible, true);

  // Two tickets among the changed branches and nothing explicit: no ticket guessed.
  assert.equal(collectStatus({ root }).ticket, null);
});

test("the workspace root is reported too, without its nested repos as untracked files", () => {
  const root = makeRepo(tmp("rs-root-"));
  makeRepo(path.join(root, "api"));
  fs.writeFileSync(path.join(root, "api", "a.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ repos: ["api"] }));
  const s = collectStatus({ root, all: true });
  const rootRepo = s.repos.find((r) => r.isRoot);
  assert.ok(rootRepo);
  assert.deepEqual(rootRepo.untracked.map((f) => f.path), ["repos.json"]);
  assert.deepEqual(s.repos.find((r) => r.name === "api").unstaged, [{ status: "M", path: "a.txt" }]);
});

test("ahead/behind against origin/<default> when there's a remote", () => {
  const dir = tmp("rs-remote-");
  const bare = path.join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = makeRepo(path.join(dir, "seed"));
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  const work = path.join(dir, "work");
  execFileSync("git", ["clone", "-q", bare, work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "T");
  fs.writeFileSync(path.join(work, "a.txt"), "local\n");
  git(work, "commit", "-q", "-am", "local");
  fs.writeFileSync(path.join(work, "z.txt"), "z\n");
  const [r] = collectStatus({ root: work }).repos;
  assert.equal(r.ahead, 1);
  assert.equal(r.behind, 0);
  assert.equal(r.onDefault, true);
  assert.equal(r.eligible, false);
});

test("walkRepos: depth-limited, skips node_modules / worktrees / dot-folders, doesn't descend into repos", () => {
  const root = tmp("rs-walk-");
  makeRepo(path.join(root, "services", "api"));
  makeRepo(path.join(root, "services", "api", "nested"));
  makeRepo(path.join(root, "node_modules", "pkg"));
  makeRepo(path.join(root, "worktrees", "ENG-1", "api"));
  makeRepo(path.join(root, ".cache", "x"));
  makeRepo(path.join(root, "a", "b", "c", "d", "e", "deep"));
  assert.deepEqual(walkRepos(root).map((r) => r.relativePath), ["services/api"]);
});

test("a repos.json entry for the root keeps its metadata and is reported once, as the root", () => {
  const root = makeRepo(tmp("rs-rootcfg-"));
  makeRepo(path.join(root, "api"));
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ repos: [{ name: "hub", relativePath: ".", defaultBranch: "trunk" }, "api"] }));
  const repos = discoverRepos(root);
  assert.deepEqual(repos.map((r) => [r.name, r.isRoot, r.defaultBranch]), [["hub", true, "trunk"], ["api", false, null]]);
  assert.equal(collectStatus({ root, all: true }).repos.find((r) => r.isRoot).defaultBranch, "trunk");
});

test("in a worktree, the ticket pattern comes from the source workspace's workspace.json", () => {
  const ws = tmp("rs-wtcfg-");
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "workspace.json"), JSON.stringify({ issues: { ticketPattern: "[a-z]+#\\d+" } }));
  const wt = path.join(ws, "worktrees", "w");
  makeRepo(path.join(wt, "api"), { branch: "fix/acme#7" });
  fs.writeFileSync(path.join(wt, "api", "a.txt"), "dirty\n");
  fs.writeFileSync(path.join(wt, ".worktree.json"), JSON.stringify({ name: "w", repos: ["api"], sourceWorkspace: ws }));
  const s = collectStatus({ root: wt });
  assert.equal(s.repos[0].ticket, "ACME#7");
  assert.equal(s.ticket, "ACME#7");
  assert.equal(s.repos[0].eligible, true);
});

// implement.mjs against throwaway workspaces whose repos are clones of bare local
// remotes: placement, worktree classification, freshness and branch guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  branchHasTicket, branchPrefix, checkFreshness, classifyWorktree, createBranches, docKind, findTicketWorktree, isPartialClone, normalizeTicket,
  recentChanges, resolvePlacement, stagesOf, worktreeName,
} from "../implement.mjs";
import { createWorktree } from "../worktree.mjs";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
});

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "implement.mjs");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
};
const commit = (repo, file, body, msg) => {
  write(path.join(repo, file), body);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", msg);
};
const head = (dir) => git(dir, "rev-parse", "HEAD");
const branchOf = (dir) => git(dir, "branch", "--show-current");
const slash = (p) => p.replace(/\\/g, "/");

/**
 * A main workspace with repos cloned from bare remotes. Each remote has a seed
 * clone; push(name) adds an upstream commit. workspace.json is written only when
 * `workspace` is given.
 */
function makeWorkspace({ names = ["api", "web"], workspace = null, deps = {} } = {}) {
  const base = tmp("mr-impl-");
  const root = path.join(base, "ws");
  const seeds = {};
  for (const n of names) {
    const bare = path.join(base, "remotes", `${n}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
    const seed = path.join(base, "seed", n);
    execFileSync("git", ["clone", "-q", bare, seed], { stdio: "pipe" });
    commit(seed, "README.md", "hello\n", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    seeds[n] = seed;
    execFileSync("git", ["clone", "-q", bare, path.join(root, n)], { stdio: "pipe" });
  }
  write(path.join(root, "repos.json"), { repos: names.map((n) => ({ name: n, relativePath: n, dependencies: deps[n] || [] })) });
  if (workspace) write(path.join(root, ".claude", "dashboard", "workspace.json"), workspace);
  let k = 0;
  const push = (n) => {
    commit(seeds[n], `up${++k}.txt`, "x\n", `upstream ${k}`);
    git(seeds[n], "push", "-q", "origin", "HEAD:main");
  };
  return { base, root, seeds, push, repo: (n) => path.join(root, n) };
}

const wsWithWorktrees = () => makeWorkspace({ workspace: { issues: { kind: "linear" }, worktrees: {} } });

// ------------------------------------------------------------------ naming

test("worktree names and branch prefixes follow the worktree skill's rules", () => {
  assert.equal(worktreeName("ENG-123"), "ENG-123");
  assert.equal(worktreeName("acme/api#7"), "acme-api-7");
  assert.equal(worktreeName("#42"), "42");
  assert.equal(worktreeName("///"), null);
  assert.equal(branchPrefix("Bug"), "fix/");
  assert.equal(branchPrefix("chore"), "chore/");
  assert.equal(branchPrefix("Story"), "feature/");
  assert.equal(branchPrefix(undefined), "feature/");
  assert.ok(branchHasTicket("fix/ENG-1", "eng-1"));
  assert.ok(branchHasTicket("feature/acme-api-7", "acme/api#7"));
  assert.ok(!branchHasTicket("feature/ENG-2", "ENG-1"));
});

test("normalizeTicket: a pasted tracker URL becomes its id; a plain id is kept; a URL with no id is null", () => {
  assert.equal(normalizeTicket(" ENG-9 "), "ENG-9");
  assert.equal(normalizeTicket("acme/api#7"), "acme/api#7");
  assert.equal(normalizeTicket("https://linear.app/acme/issue/ENG-9/add-thing"), "ENG-9");
  assert.equal(normalizeTicket("https://linear.app/team-2/issue/ENG-9/add-thing"), "ENG-9"); // not the workspace slug
  assert.equal(normalizeTicket("https://acme.atlassian.net/browse/KEY-12"), "KEY-12");
  assert.equal(normalizeTicket("https://acme.atlassian.net/jira/software/projects/KEY/boards/3?selectedIssue=KEY-1"), "KEY-1");
  assert.equal(normalizeTicket("https://github.com/acme/api/issues/42"), "acme/api#42");
  assert.equal(normalizeTicket("https://github.com/acme/api/pull/43#discussion"), "acme/api#43");
  assert.equal(normalizeTicket("https://github.com/acme/api"), null);
  assert.equal(normalizeTicket("https://example.com/nothing/here"), null);
  assert.equal(normalizeTicket("https://"), null);
  assert.equal(normalizeTicket("   "), null);
});

test("stages: a repo comes one stage after the latest repo it consumes; independent repos share a stage", () => {
  const r = (name, dependencies = []) => ({ name, dependencies });
  assert.deepEqual(stagesOf([r("web", ["api"]), r("admin", ["api"]), r("api", ["core"]), r("core"), r("docs")]), [["core", "docs"], ["api"], ["web", "admin"]]);
  assert.deepEqual(stagesOf([r("a", ["b"]), r("b", ["a"])]).flat().sort(), ["a", "b"]); // a cycle drops nothing
  assert.deepEqual(stagesOf([r("a", ["unknown"])]), [["a"]]);
  const ws = makeWorkspace({ names: ["api", "web"], deps: { web: ["api"] } });
  assert.deepEqual(resolvePlacement({ ticket: "ENG-1", root: ws.root }).stages, [["api"], ["web"]]);
});

// ------------------------------------------------------------------ placement

test("flat: no worktrees configured or present → work in place, convention branch", () => {
  const ws = makeWorkspace();
  const r = resolvePlacement({ ticket: "ENG-1", root: ws.root });
  assert.equal(r.placement, "flat");
  assert.equal(r.baseDir, slash(ws.root));
  assert.equal(r.worktree.state, "absent");
  assert.equal(r.branch, "feature/ENG-1");
  assert.equal(r.branchSource, "convention");
  assert.deepEqual(r.repos.map((x) => [x.name, x.branch, x.onDefault, x.dirty, x.ahead, x.behind]), [
    ["api", "main", true, false, 0, 0], ["web", "main", true, false, 0, 0],
  ]);
  assert.equal(resolvePlacement({ ticket: "ENG-1", root: ws.root, type: "Bug" }).branch, "fix/ENG-1");
});

test("worktree-missing: worktrees are configured (or the folder exists) but this ticket has none", () => {
  const ws = wsWithWorktrees();
  assert.equal(resolvePlacement({ ticket: "ENG-1", root: ws.root }).placement, "worktree-missing");
  const plain = makeWorkspace();
  fs.mkdirSync(path.join(plain.root, "worktrees"));
  assert.equal(resolvePlacement({ ticket: "ENG-1", root: plain.root }).placement, "worktree-missing");
});

test("worktree-exists (complete), in-worktree and in-other-worktree; branch precedence flag > worktree > convention", () => {
  const ws = wsWithWorktrees();
  createWorktree({ root: ws.root, name: "ENG-1", repos: "api,web", branch: "fix/ENG-1", ticket: "ENG-1", install: false });
  const wt = path.join(ws.root, "worktrees", "ENG-1");

  const fromMain = resolvePlacement({ ticket: "ENG-1", root: ws.root });
  assert.equal(fromMain.placement, "worktree-exists");
  assert.equal(fromMain.worktree.state, "complete");
  assert.equal(fromMain.baseDir, slash(wt));
  assert.equal(fromMain.branch, "fix/ENG-1"); // not feature/: the worktree chose fix/
  assert.equal(fromMain.branchSource, "worktree");
  assert.ok(fromMain.repos.every((x) => x.onBranch && x.path.startsWith(slash(wt))));
  assert.equal(resolvePlacement({ ticket: "ENG-1", root: ws.root, branch: "feature/x" }).branch, "feature/x");

  const inside = resolvePlacement({ ticket: "eng-1", root: path.join(wt, "api") });
  assert.equal(inside.placement, "in-worktree");
  assert.equal(inside.baseDir, slash(wt));
  assert.equal(inside.mainRoot, slash(ws.root));

  const other = resolvePlacement({ ticket: "ENG-2", root: wt });
  assert.equal(other.placement, "in-other-worktree");
  assert.equal(other.worktree.name, "ENG-1");
  assert.equal(other.worktree.ticketId, "ENG-1");
  assert.equal(other.branch, "feature/ENG-2"); // never the other ticket's branch
});

test("worktree lookup: found by .worktree.json ticketId (legacy linearId too) whatever the folder is called, else by name case-insensitively", () => {
  const ws = wsWithWorktrees();
  const wts = path.join(ws.root, "worktrees");
  write(path.join(wts, "payments-redo", ".worktree.json"), { ticketId: "ENG-9", branch: "feature/ENG-9", repos: ["api"] });
  const r = resolvePlacement({ ticket: "eng-9", root: ws.root });
  assert.equal(r.placement, "worktree-exists");
  assert.equal(r.worktree.name, "payments-redo");
  assert.equal(r.worktree.matchedBy, "metadata");
  assert.equal(r.baseDir, slash(path.join(wts, "payments-redo")));
  assert.equal(r.branch, "feature/ENG-9");
  assert.deepEqual(r.worktree.duplicates, []);

  write(path.join(wts, "old-one", ".worktree.json"), { linearId: "ENG-8", repos: ["api"] });
  assert.equal(findTicketWorktree(wts, "ENG-8").matchedBy, "metadata");

  fs.mkdirSync(path.join(wts, "eng-7")); // created lower-case, looked up upper-case
  const byName = findTicketWorktree(wts, "ENG-7");
  assert.equal(path.basename(byName.path), "eng-7");
  assert.equal(byName.matchedBy, "name");

  write(path.join(wts, "ENG-6", ".worktree.json"), { ticketId: "ENG-5", repos: [] }); // the name is another ticket's metadata
  assert.equal(path.basename(findTicketWorktree(wts, "ENG-5").path), "ENG-6");
  assert.equal(findTicketWorktree(wts, "ENG-6"), null);

  fs.mkdirSync(path.join(wts, "ENG-9"));
  const dup = resolvePlacement({ ticket: "ENG-9", root: ws.root });
  assert.equal(dup.worktree.name, "payments-redo"); // the metadata match wins
  assert.deepEqual(dup.worktree.duplicates, [slash(path.join(wts, "ENG-9"))]);
  assert.equal(findTicketWorktree(path.join(ws.root, "nope"), "ENG-9"), null);
});

test("--ticket as a pasted URL resolves to its id; a URL with no id exits 2", () => {
  const ws = wsWithWorktrees();
  const r = resolvePlacement({ ticket: "https://linear.app/acme/issue/ENG-9/add-thing", root: ws.root });
  assert.equal(r.ticket, "ENG-9");
  assert.equal(r.branch, "feature/ENG-9");
  assert.equal(resolvePlacement({ ticket: "https://github.com/acme/api/issues/42", root: ws.root }).branch, "feature/acme-api-42");
  assert.throws(() => resolvePlacement({ ticket: "https://example.com/x", root: ws.root }), (e) => e.usage && /Can't find a ticket id/.test(e.message));
  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--ticket", "https://example.com/x", "--resolve", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 2);
  status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--branches", "--branch", "feature/x", "--repos", "api", "--ticket", "https://example.com/x", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 2);
  assert.equal(branchOf(ws.repo("api")), "main");
});

test("incomplete worktrees: a failed clone with no metadata, or a listed repo missing", () => {
  const ws = wsWithWorktrees();
  fs.mkdirSync(path.join(ws.root, "worktrees", "ENG-3", "web"), { recursive: true }); // half-made, no .worktree.json
  const r = resolvePlacement({ ticket: "ENG-3", root: ws.root });
  assert.equal(r.placement, "worktree-exists");
  assert.equal(r.worktree.state, "incomplete");
  assert.match(r.worktree.problems.join(), /no \.worktree\.json/);

  createWorktree({ root: ws.root, name: "ENG-4", repos: "api", branch: "feature/ENG-4", install: false });
  const wt = path.join(ws.root, "worktrees", "ENG-4");
  const meta = JSON.parse(fs.readFileSync(path.join(wt, ".worktree.json"), "utf-8"));
  write(path.join(wt, ".worktree.json"), { ...meta, repos: ["api", "web"] });
  const c = classifyWorktree(wt);
  assert.equal(c.state, "incomplete");
  assert.deepEqual(c.missingRepos, ["web"]);
  assert.equal(classifyWorktree(path.join(ws.root, "worktrees", "nope")).state, "absent");
});

test("--here: the current checkout, no worktree lookup", () => {
  const ws = wsWithWorktrees();
  createWorktree({ root: ws.root, name: "ENG-5", repos: "api", branch: "feature/ENG-5", install: false });
  const r = resolvePlacement({ ticket: "ENG-5", root: ws.root, here: true });
  assert.equal(r.placement, "here");
  assert.equal(r.baseDir, slash(ws.root));
  assert.equal(r.branch, "feature/ENG-5");
});

test("ports come from the ports file entry for the worktree", () => {
  const base = tmp("mr-impl-ports-");
  const portsFile = path.join(base, "ports.json");
  const ws = makeWorkspace({ workspace: { worktrees: { portsFile } } });
  createWorktree({ root: ws.root, name: "ENG-6", repos: "api", branch: "feature/ENG-6", install: false });
  const wt = path.join(ws.root, "worktrees", "ENG-6");
  write(portsFile, { worktrees: { "ENG-6": { slot: 2, workspace: wt, ports: { api: 24102 } } } });
  const r = resolvePlacement({ ticket: "ENG-6", root: ws.root });
  assert.deepEqual(r.ports.ports, { api: 24102 });
  assert.equal(r.ports.slot, 2);
  assert.equal(resolvePlacement({ ticket: "ENG-7", root: ws.root }).ports, null);
});

test("CLI: --resolve --json prints the placement; a missing --ticket exits 2", () => {
  const ws = makeWorkspace({ names: ["api"] });
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, "--ticket", "ENG-1", "--resolve", "--root", ws.root, "--json"], { encoding: "utf-8" }));
  assert.equal(out.placement, "flat");
  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--resolve", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 2);
});

// ------------------------------------------------------------------ freshness

test("freshness: fast-forwards only clean+default+behind; dirty, other-branch, diverged, ahead reported and untouched", async () => {
  const names = ["behind", "dirty", "feature", "diverged", "ahead", "current"];
  const ws = makeWorkspace({ names });
  for (const n of ["behind", "dirty", "feature", "diverged"]) ws.push(n);
  write(path.join(ws.repo("dirty"), "README.md"), "local edit\n");
  git(ws.repo("feature"), "switch", "-q", "-c", "feature/ENG-1");
  for (const n of ["diverged", "ahead"]) commit(ws.repo(n), "local.txt", "x\n", "local");
  const before = Object.fromEntries(names.map((n) => [n, head(ws.repo(n))]));

  const dry = await checkFreshness({ root: ws.root });
  const d = Object.fromEntries(dry.repos.map((x) => [x.name, x]));
  assert.equal(d.behind.state, "behind");
  assert.equal(head(ws.repo("behind")), before.behind); // without --pull nothing moves
  assert.equal(dry.pulled, false);

  const s = await checkFreshness({ root: ws.root, pull: true });
  const r = Object.fromEntries(s.repos.map((x) => [x.name, x]));
  assert.equal(r.behind.state, "fast-forwarded");
  assert.equal(head(ws.repo("behind")), git(ws.repo("behind"), "rev-parse", "origin/main"));
  assert.equal(r.dirty.state, "dirty");
  assert.equal(r.feature.state, "other-branch");
  assert.match(r.feature.detail, /1 behind origin\/main/);
  assert.equal(r.diverged.state, "diverged");
  assert.equal(r.ahead.state, "ahead");
  assert.equal(r.current.state, "up-to-date");
  assert.deepEqual(s.fastForwarded, ["behind"]);
  assert.deepEqual(s.needsDecision.sort(), ["dirty", "diverged", "feature"]);

  for (const n of ["dirty", "feature", "diverged", "ahead", "current"]) assert.equal(head(ws.repo(n)), before[n], n);
  assert.equal(fs.readFileSync(path.join(ws.repo("dirty"), "README.md"), "utf-8"), "local edit\n");
  assert.equal(branchOf(ws.repo("feature")), "feature/ENG-1");
  assert.equal(git(ws.repo("dirty"), "stash", "list"), "");
});

test("freshness: fetch failures and missing repos; --repos and --layer filters", async () => {
  const ws = makeWorkspace({ names: ["api", "web", "gone"] });
  write(path.join(ws.root, "repos.json"), { repos: [
    { name: "api", relativePath: "api", layer: "backend" },
    { name: "web", relativePath: "web", layer: "frontend" },
    { name: "gone", relativePath: "not-here", layer: "backend" },
  ] });
  git(ws.repo("api"), "remote", "set-url", "origin", path.join(ws.base, "remotes", "missing.git"));
  const s = await checkFreshness({ root: ws.root, layer: "backend" });
  assert.deepEqual(s.repos.map((x) => [x.name, x.state]), [["api", "fetch-failed"], ["gone", "missing"]]);
  assert.ok(s.needsDecision.includes("api"));
  assert.doesNotMatch(s.repos[0].detail, /as of the last fetch/); // there are no counts on a failed fetch
  assert.equal(s.repos[0].behind, null);
  git(ws.repo("web"), "remote", "remove", "origin");
  const local = await checkFreshness({ root: ws.root, repos: ["web"] });
  assert.equal(local.repos[0].state, "no-origin");
  assert.deepEqual(local.needsDecision, []); // a local-only repo isn't a decision
  const one = await checkFreshness({ root: ws.root, repos: ["web"] });
  assert.deepEqual(one.repos.map((x) => x.name), ["web"]);
  await assert.rejects(checkFreshness({ root: ws.root, repos: ["nope"] }), /Unknown repo\(s\): nope.*Valid: api, web, gone/);
});

// ------------------------------------------------------------------ recent changes

/** Runs fn with every git commit dated `date` (author and committer). */
function at(date, fn) {
  const keep = { GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE };
  Object.assign(process.env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

/**
 * api's default branch: history before 2026-02-01 (the ticket's creation), then
 * work merged after it, including a feature branch committed before the date
 * and merged (--no-ff) after it. The workspace clone has fetched all of it.
 */
function recentWorkspace() {
  const ws = at("2026-01-01T00:00:00Z", () => makeWorkspace({ names: ["api", "web"] }));
  const seed = ws.seeds.api;
  const push = () => git(seed, "push", "-q", "origin", "HEAD:main");
  at("2026-01-05T00:00:00Z", () => { commit(seed, "infra/old.txt", "x\n", "old infra"); commit(seed, "docs/adr/0001-old.md", "# old\n", "old adr"); commit(seed, "infra/keep.cs", "class Keep { /* unique */ }\n", "old keep"); });
  at("2026-01-20T00:00:00Z", () => {
    git(seed, "switch", "-q", "-c", "feature/x");
    commit(seed, "infra/feature.tf", "x\n", "feature work written before the ticket");
    git(seed, "switch", "-q", "main");
  });
  push();
  at("2026-02-05T00:00:00Z", () => commit(seed, "infra/README.md", "# infra: new layout\n", "docs(infra): new layout"));
  at("2026-02-06T00:00:00Z", () => {
    for (const f of ["docs/adr/0002-layout.md", "docs/decisions/use-x.md", "notes/ADR-7.md", "notes/cache.adr.md", "CONTRIBUTING.md", "docs/adr/diagram.png"]) write(path.join(seed, f), "x\n");
    fs.rmSync(path.join(seed, "docs/adr/0001-old.md"));
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "docs: decisions");
  });
  at("2026-02-07T00:00:00Z", () => { commit(seed, "web/app.ts", "x\n", "feat(web): app"); commit(seed, "web/README.md", "x\n", "docs(web): readme"); });
  at("2026-02-08T00:00:00Z", () => git(seed, "merge", "-q", "--no-ff", "-m", "Merge feature/x", "feature/x"));
  push();
  git(ws.repo("api"), "fetch", "-q", "origin");
  return ws;
}

test("recent: files, commits and docs on origin/<default> since a date; a branch merged after it counts", () => {
  const ws = recentWorkspace();
  const r = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"] });
  assert.equal(r.since, "2026-02-01T00:00:00Z");
  assert.deepEqual(r.changed, ["api"]);
  const api = r.repos[0];
  assert.deepEqual([api.name, api.state, api.ref], ["api", "ok", "origin/main"]);
  const files = Object.fromEntries(api.files.map((f) => [f.path, f.status]));
  assert.deepEqual(Object.keys(files).sort(), [
    "CONTRIBUTING.md", "docs/adr/0001-old.md", "docs/adr/0002-layout.md", "docs/adr/diagram.png", "docs/decisions/use-x.md",
    "infra/README.md", "infra/feature.tf", "notes/ADR-7.md", "notes/cache.adr.md", "web/README.md", "web/app.ts",
  ]);
  assert.equal(files["docs/adr/0001-old.md"], "deleted");
  assert.equal(files["infra/README.md"], "added");
  assert.deepEqual(api.docs.map((d) => [d.path, d.kind]), [
    ["CONTRIBUTING.md", "contributing"], ["docs/adr/0002-layout.md", "decision"], ["docs/decisions/use-x.md", "decision"],
    ["infra/README.md", "readme"], ["notes/ADR-7.md", "decision"], ["notes/cache.adr.md", "decision"], ["web/README.md", "readme"],
  ]); // not the deleted ADR, not the diagram
  const subjects = api.commits.map((c) => c.subject);
  assert.ok(subjects.includes("feature work written before the ticket"), subjects.join());
  assert.ok(subjects.includes("docs(infra): new layout"));
  assert.ok(!subjects.some((s) => /^old /.test(s)), subjects.join());
  assert.match(api.commits[0].sha, /^[0-9a-f]{7,}$/);
  assert.match(api.commits[0].date, /^2026-02-08T/); // newest first
});

test("recent: --paths limits files and commits to those folders, but keeps the repo's root decision records and guides", () => {
  const ws = recentWorkspace();
  const api = recentChanges({ root: ws.root, since: "2026-02-01T00:00:00Z", repos: ["api"], paths: ["infra/"] }).repos[0];
  assert.deepEqual(api.paths, ["infra"]);
  assert.deepEqual(api.files.map((f) => f.path).sort(), [
    "CONTRIBUTING.md", "docs/adr/0001-old.md", "docs/adr/0002-layout.md", "docs/decisions/use-x.md",
    "infra/README.md", "infra/feature.tf",
  ]); // not web/, not web/README.md, not the diagram, not the decision records inside notes/
  assert.equal(api.detail, null);
  assert.ok(!api.commits.some((c) => /web/.test(c.subject)), api.commits.map((c) => c.subject).join());
  assert.ok(api.commits.some((c) => c.subject === "docs: decisions"));
});

test("recent: repo-wide docs are the root ones; another top-level folder's decision records and CONTRIBUTING count only when it's watched", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  at("2026-02-09T00:00:00Z", () => {
    for (const f of ["web/docs/adr/0003-web.md", "web/CONTRIBUTING.md", "web/adr/0004.md", "ADR-9-root.md", "adr/0005.md", "docs/ADR-10.md", "docs/architecture/decisions/0006.md", ".github/CONTRIBUTING.md"]) write(path.join(seed, f), "x\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "docs: more decisions");
  });
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("api"), "fetch", "-q", "origin");
  const infra = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra"] }).repos[0].files.map((f) => f.path);
  for (const p of ["ADR-9-root.md", "adr/0005.md", "docs/ADR-10.md", "docs/architecture/decisions/0006.md", "docs/adr/0002-layout.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md"]) assert.ok(infra.includes(p), p);
  for (const p of ["web/docs/adr/0003-web.md", "web/CONTRIBUTING.md", "web/adr/0004.md", "web/README.md", "notes/ADR-7.md"]) assert.ok(!infra.includes(p), p);
  const web = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["web"] }).repos[0];
  for (const p of ["web/docs/adr/0003-web.md", "web/CONTRIBUTING.md", "web/adr/0004.md", "web/README.md", "ADR-9-root.md", "CONTRIBUTING.md"]) assert.ok(web.files.some((f) => f.path === p), p);
  assert.ok(web.docs.some((d) => d.path === "web/docs/adr/0003-web.md" && d.kind === "decision"));
});

test("recent: a --paths folder that isn't on the tip (a typo, the wrong case) is named in detail", () => {
  const ws = recentWorkspace();
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["Infra", "nope/x", "infra"] }).repos[0];
  assert.deepEqual(api.missingPaths, ["Infra", "nope/x"]);
  assert.match(api.detail, /'Infra'/);
  assert.match(api.detail, /'nope\/x'/);
  assert.match(api.detail, /origin\/main/);
  const text = execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026-12-01", "--repos", "api", "--paths", "nope", "--root", ws.root], { encoding: "utf-8" });
  assert.match(text, /api: nothing on origin\/main since 2026-12-01 \(.*'nope'/); // not a bare "nothing changed"
  const ok = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra"] }).repos[0];
  assert.deepEqual([ok.missingPaths, ok.detail], [[], null]);
});

test("recent: --since takes an ISO 8601 date, optionally with a time; a time without an offset is UTC", () => {
  const ws = recentWorkspace();
  const since = (s) => recentChanges({ root: ws.root, since: s, repos: ["api"] }).since;
  assert.equal(since("2026-02-01"), "2026-02-01T00:00:00Z");
  assert.equal(since("2026-02-01T09:30"), "2026-02-01T09:30:00Z");
  assert.equal(since("2026-02-01T09:30:15.250"), "2026-02-01T09:30:15Z");
  assert.equal(since("2026-02-01 09:30:00"), "2026-02-01T09:30:00Z");
  assert.equal(since("2026-02-01T09:30:00+02:00"), "2026-02-01T07:30:00Z");
  assert.equal(since("2026-02-01T09:30:00.000+0200"), "2026-02-01T07:30:00Z");
  assert.equal(since("2026-02-01T09:30:00z"), "2026-02-01T09:30:00Z");
  for (const bad of ["5", "2026", "2026-02", "20260201", "2026-13-01", "2026-02-30", "2026-02-01T25:00", "02/01/2026", "Feb 1 2026", "2026-02-01T09", "last tuesday"]) {
    assert.throws(() => recentChanges({ root: ws.root, since: bad }), (e) => e.usage && /ISO/.test(e.message), bad);
  }
  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 2);
});

test("recent: git output past the buffer is an error, for the diff and for the log, never an empty list", () => {
  const ws = recentWorkspace();
  const tiny = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], maxBuffer: 8 }).repos[0];
  assert.deepEqual([tiny.state, tiny.files, tiny.commits], ["error", [], []]);
  assert.match(tiny.detail, /git diff failed: .*(ENOBUFS|maxBuffer)/);

  const full = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"] }).repos[0];
  const repo = ws.repo("api");
  const diffLen = Buffer.byteLength(execFileSync("git", ["-C", repo, "diff", "--no-ext-diff", "--name-status", "-z", "-M", full.base, "origin/main"], { encoding: "utf-8" }));
  const logLen = Buffer.byteLength(execFileSync("git", ["-C", repo, "--literal-pathspecs", "log", "--format=%h%x1f%cI%x1f%s", `${full.base}..origin/main`, "--"], { encoding: "utf-8" }));
  assert.ok(logLen > diffLen + 16, `fixture: the log (${logLen} bytes) must outgrow the diff (${diffLen})`);
  const log = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], maxBuffer: diffLen + 8 }).repos[0];
  assert.deepEqual([log.state, log.commits], ["error", []]);
  assert.match(log.detail, /git log failed/);
});

test("recent: nothing since the date, an unfetched push, no origin and a missing repo all give empty lists", () => {
  const ws = recentWorkspace();
  ws.push("api"); // on the remote, not fetched: the helper reads origin/<default> as last fetched
  const none = recentChanges({ root: ws.root, since: "2026-12-01", repos: ["api"] }).repos[0];
  assert.deepEqual([none.state, none.files, none.commits, none.docs], ["ok", [], [], []]);
  write(path.join(ws.root, "repos.json"), { repos: ["api", "web", { name: "gone", relativePath: "gone" }] });
  git(ws.repo("web"), "remote", "remove", "origin");
  const r = recentChanges({ root: ws.root, since: "2026-02-01" });
  const by = Object.fromEntries(r.repos.map((x) => [x.name, x]));
  assert.deepEqual([by.web.state, by.web.files, by.web.docs], ["no-origin", [], []]);
  assert.deepEqual([by.gone.state, by.gone.files], ["missing", []]);
  assert.deepEqual(r.changed, ["api"]);
  assert.throws(() => recentChanges({ root: ws.root }), (e) => e.usage && /--since is required/.test(e.message));
  assert.throws(() => recentChanges({ root: ws.root, since: "last tuesday" }), (e) => e.usage && /--since/.test(e.message));
});

test("recent: --paths keeps a file renamed out of a watched folder, with its commit", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  at("2026-02-09T00:00:00Z", () => {
    fs.mkdirSync(path.join(seed, "shared"), { recursive: true });
    git(seed, "mv", "infra/keep.cs", "shared/keep.cs");
    git(seed, "commit", "-q", "-m", "refactor: move keep to shared");
  });
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("api"), "fetch", "-q", "origin");
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra"] }).repos[0];
  const moved = api.files.find((f) => f.path === "shared/keep.cs");
  assert.deepEqual(moved, { path: "shared/keep.cs", status: "renamed", from: "infra/keep.cs" });
  assert.ok(api.commits.some((c) => c.subject === "refactor: move keep to shared"), api.commits.map((c) => c.subject).join());
});

test("recent: --paths keeps a repo-wide doc moved out of the root, with its commit", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  at("2026-02-09T00:00:00Z", () => {
    fs.mkdirSync(path.join(seed, "guides"), { recursive: true });
    git(seed, "mv", "README.md", "guides/README.md");
    git(seed, "commit", "-q", "-m", "docs: move the readme to guides");
  });
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("api"), "fetch", "-q", "origin");
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra"] }).repos[0];
  assert.deepEqual(api.files.find((f) => f.path === "guides/README.md"), { path: "guides/README.md", status: "renamed", from: "README.md" });
  assert.deepEqual(api.docs.find((d) => d.path === "guides/README.md"), { path: "guides/README.md", kind: "readme", status: "renamed" });
  assert.ok(api.commits.some((c) => c.subject === "docs: move the readme to guides"), api.commits.map((c) => c.subject).join());
});

test("recent: --paths still lists the commits of a root doc changed and then reverted (no net diff)", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  const readme = fs.readFileSync(path.join(seed, "README.md"), "utf-8");
  const adr = fs.readFileSync(path.join(seed, "docs/adr/0002-layout.md"), "utf-8");
  at("2026-02-09T00:00:00Z", () => { commit(seed, "README.md", "# changed\n", "docs: change the readme"); commit(seed, "docs/adr/0002-layout.md", "# changed\n", "docs: change the adr"); });
  at("2026-02-10T00:00:00Z", () => { commit(seed, "README.md", readme, "Revert \"docs: change the readme\""); commit(seed, "docs/adr/0002-layout.md", adr, "Revert \"docs: change the adr\""); });
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("api"), "fetch", "-q", "origin");
  for (const pathspecLimit of [8000, 20]) {
    const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra"], pathspecLimit }).repos[0];
    assert.equal(api.state, "ok", api.detail);
    assert.ok(!api.files.some((f) => f.path === "README.md"), "no net change to the readme");
    const subjects = api.commits.map((c) => c.subject);
    for (const s of ["docs: change the readme", "Revert \"docs: change the readme\"", "docs: change the adr", "Revert \"docs: change the adr\""]) assert.ok(subjects.includes(s), `${s} (limit ${pathspecLimit}): ${subjects.join()}`);
    assert.ok(!subjects.some((s) => /web/.test(s)), subjects.join());
  }
});

test("recent: a shallow clone whose history doesn't reach the date says so and lists only what it holds", () => {
  const ws = recentWorkspace();
  fs.rmSync(ws.repo("api"), { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", "--depth", "2", pathToFileURL(path.join(ws.base, "remotes", "api.git")).href, ws.repo("api")], { stdio: "pipe" });
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"] }).repos[0];
  assert.equal(api.state, "shallow");
  assert.match(api.detail, /shallow/i);
  assert.match(api.detail, /2026-02-01/);
  assert.match(api.detail, /--unshallow/);
  assert.ok(api.base, "base is the oldest commit the clone has");
  // depth 2: the merge and the commits right before it; only the merged branch's file is after the oldest
  assert.deepEqual(api.files.map((f) => f.path), ["infra/feature.tf"]);
  assert.ok(api.commits.some((c) => c.subject === "feature work written before the ticket"));
});

test("recent: a date before a full clone's first commit diffs from the empty tree and says so", () => {
  const ws = recentWorkspace();
  const api = recentChanges({ root: ws.root, since: "2025-06-01", repos: ["api"] }).repos[0];
  assert.equal(api.state, "ok");
  assert.equal(api.base, null);
  assert.ok(api.files.some((f) => f.path === "README.md" && f.status === "added"));
  assert.match(api.detail, /before the first commit/);
});

test("recent: a failed history read is an error, not 'before the first commit'; an absolute --paths is a usage error", () => {
  const ws = recentWorkspace();
  const repo = ws.repo("api");
  // A tip whose parent is missing: walking back to the date fails, which isn't "before the first commit".
  const tree = git(repo, "rev-parse", "origin/main^{tree}");
  const broken = execFileSync("git", ["-C", repo, "hash-object", "-t", "commit", "-w", "--stdin"], {
    input: `tree ${tree}\nparent ${"1".repeat(40)}\nauthor T <t@example.com> 1770681600 +0000\ncommitter T <t@example.com> 1770681600 +0000\n\nbroken\n`, encoding: "utf-8",
  }).trim();
  git(repo, "update-ref", "refs/remotes/origin/main", broken);
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"] }).repos[0];
  assert.deepEqual([api.state, api.base, api.files, api.commits, api.docs], ["error", null, [], [], []]);
  assert.match(api.detail, /git rev-list failed/);
  assert.doesNotMatch(api.detail, /first commit/);
  // The CLI prints it and exits 1 (no-origin, missing and shallow are informational and exit 0).
  let cli = { status: 0, stdout: "" };
  try { execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026-02-01", "--repos", "api", "--root", ws.root], { encoding: "utf-8", stdio: "pipe" }); } catch (e) { cli = e; }
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /api: error: git rev-list failed/);
  let jsonCli = { status: 0, stdout: "" };
  try { execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026-02-01", "--repos", "api", "--root", ws.root, "--json"], { encoding: "utf-8", stdio: "pipe" }); } catch (e) { jsonCli = e; }
  assert.equal(jsonCli.status, 1);
  assert.equal(JSON.parse(jsonCli.stdout).repos[0].state, "error");
  // A tip that isn't a commit at all: the diff fails, an error too.
  const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: "not a commit\n", encoding: "utf-8" }).trim();
  git(repo, "update-ref", "refs/remotes/origin/main", blob);
  const notCommit = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"] }).repos[0];
  assert.deepEqual([notCommit.state, notCommit.files], ["error", []]);
  assert.match(notCommit.detail, /^git diff failed/);

  const abs = path.join(ws.root, "api", "infra");
  assert.throws(() => recentChanges({ root: ws.root, since: "2026-02-01", paths: [abs] }), (e) => e.usage && /relative/.test(e.message));
  assert.throws(() => recentChanges({ root: ws.root, since: "2026-02-01", paths: ["/infra"] }), (e) => e.usage);
  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026-02-01", "--paths", abs, "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 2);
});

test("recent: many extra pathspec entries are split over several log calls; the commits are the same, once each, newest first", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  fs.mkdirSync(path.join(seed, "shared"), { recursive: true });
  at("2026-02-09T00:00:00Z", () => { git(seed, "mv", "infra/keep.cs", "shared/keep.cs"); git(seed, "commit", "-q", "-m", "refactor: move keep"); });
  at("2026-02-10T00:00:00Z", () => { git(seed, "mv", "infra/old.txt", "shared/old.txt"); git(seed, "commit", "-q", "-m", "refactor: move old"); });
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("api"), "fetch", "-q", "origin");
  const opts = { root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra"] };
  const whole = recentChanges(opts).repos[0];
  const split = recentChanges({ ...opts, pathspecLimit: 20 }).repos[0]; // about one entry per call
  assert.equal(split.state, "ok");
  assert.deepEqual(split.commits, whole.commits);
  const subjects = split.commits.map((c) => c.subject);
  for (const s of ["refactor: move keep", "refactor: move old", "docs: decisions", "docs(infra): new layout"]) assert.ok(subjects.includes(s), s);
  assert.equal(new Set(split.commits.map((c) => c.sha)).size, split.commits.length);
  const dates = split.commits.map((c) => Date.parse(c.date));
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
});

test("recent: the git reads take a timeout (longer than gitRun's default), overridable", () => {
  const ws = recentWorkspace();
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], timeout: 1 }).repos[0];
  assert.equal(api.state, "error");
  assert.match(api.detail, /ETIMEDOUT|timed out/i);
});

test("recent: a partial clone diffs without rename detection (no blob fetches) and says so", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  fs.mkdirSync(path.join(seed, "shared"), { recursive: true });
  at("2026-02-09T00:00:00Z", () => {
    git(seed, "mv", "infra/keep.cs", "shared/keep.cs");
    fs.appendFileSync(path.join(seed, "shared/keep.cs"), "// moved\n"); // an inexact rename: -M would need the old blob
    git(seed, "commit", "-q", "-am", "refactor: move keep");
  });
  git(seed, "push", "-q", "origin", "HEAD:main");
  const bare = path.join(ws.base, "remotes", "api.git");
  git(bare, "config", "uploadpack.allowFilter", "true");
  assert.equal(isPartialClone(ws.repo("api")), false);
  fs.rmSync(ws.repo("api"), { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", pathToFileURL(bare).href, ws.repo("api")], { stdio: "pipe" });
  assert.equal(isPartialClone(ws.repo("api")), true);
  git(ws.repo("api"), "remote", "set-url", "origin", pathToFileURL(path.join(ws.base, "gone.git")).href); // any lazy fetch now fails
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra"] }).repos[0];
  assert.equal(api.state, "ok", api.detail);
  assert.match(api.detail, /partial clone/);
  assert.deepEqual(api.files.filter((f) => /keep\.cs$/.test(f.path)), [{ path: "infra/keep.cs", status: "deleted" }]); // the add lands outside infra/
  const all = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"] }).repos[0];
  assert.ok(all.files.some((f) => f.path === "shared/keep.cs" && f.status === "added"));
});

test("recent: a --paths folder removed or moved since the date is in removedPaths, not called a typo", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  at("2026-02-09T00:00:00Z", () => { git(seed, "rm", "-r", "-q", "infra"); git(seed, "commit", "-q", "-m", "chore: drop infra"); });
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("api"), "fetch", "-q", "origin");
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra", "nope"] }).repos[0];
  assert.deepEqual([api.removedPaths, api.missingPaths], [["infra"], ["nope"]]);
  assert.match(api.detail, /'infra' was removed or moved on origin\/main since 2026-02-01/);
  assert.match(api.detail, /'nope' isn't a path/);
  assert.doesNotMatch(api.detail, /'infra' isn't/);
  assert.ok(api.files.some((f) => f.path === "infra/keep.cs" && f.status === "deleted"));
  assert.ok(api.commits.some((c) => c.subject === "chore: drop infra"));
});

test("recent: no net change still lists the commits (merged, then reverted)", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  at("2026-02-09T00:00:00Z", () => commit(seed, "infra/tmp.txt", "x\n", "feat: try tmp"));
  at("2026-02-10T00:00:00Z", () => git(seed, "revert", "--no-edit", "HEAD"));
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("api"), "fetch", "-q", "origin");
  for (const paths of [[], ["infra"]]) {
    const r = recentChanges({ root: ws.root, since: "2026-02-08T12:00:00Z", repos: ["api"], paths });
    const api = r.repos[0];
    assert.deepEqual([api.state, api.files, r.changed], ["ok", [], []]);
    assert.deepEqual(api.commits.map((c) => c.subject), ['Revert "feat: try tmp"', "feat: try tmp"], String(paths));
  }
  const text = execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026-02-08T12:00:00Z", "--repos", "api", "--root", ws.root], { encoding: "utf-8" });
  assert.match(text, /api: no net change on origin\/main since 2026-02-08 \(2 commits\)/);
});

test("recent: the doc matcher", () => {
  for (const [p, kind] of [
    ["README.md", "readme"], ["api/readme.rst", "readme"], ["README", "readme"], ["CONTRIBUTING.md", "contributing"], [".github/CONTRIBUTING.md", "contributing"],
    ["docs/adr/0001-x.md", "decision"], ["docs/adrs/x.md", "decision"], ["arch/decisions/x.md", "decision"], ["docs/decision-records/x.mdx", "decision"],
    ["ADR-12-cache.md", "decision"], ["x/adr_3.md", "decision"], ["notes/cache.adr.md", "decision"],
    ["docs/adr/diagram.png", null], ["src/readme.ts", null], ["docs/guide.md", null], ["src/decisions/rules.ts", null], ["READMEFIRST.md", null],
  ]) assert.equal(docKind(p), kind, p);
});

test("CLI: --recent --json; bad --since exits 2", () => {
  const ws = recentWorkspace();
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026-02-01", "--repos", "api", "--paths", "infra", "--root", ws.root, "--json"], { encoding: "utf-8" }));
  assert.equal(out.repos[0].name, "api");
  assert.ok(out.repos[0].docs.some((d) => d.path === "infra/README.md"));
  const text = execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026-02-01", "--root", ws.root], { encoding: "utf-8" });
  assert.match(text, /api: \d+ files?, \d+ commits? on origin\/main since 2026-02-01/);
  assert.match(text, /web: nothing on origin\/main since/);
  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "nope", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 2);
});

test("recent: renames past the rename limit say so; the default limit detects them", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  at("2026-02-09T00:00:00Z", () => {
    for (const n of ["a", "b"]) write(path.join(seed, `infra/${n}.txt`), Array.from({ length: 50 }, (_, i) => `${n} line ${i}\n`).join(""));
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "add a and b");
  });
  at("2026-02-10T00:00:00Z", () => {
    for (const n of ["a", "b"]) {
      git(seed, "mv", `infra/${n}.txt`, `infra/${n}2.txt`);
      fs.appendFileSync(path.join(seed, `infra/${n}2.txt`), "extra\n");
    }
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "rename a and b, with edits");
  });
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("api"), "fetch", "-q", "origin");
  const since = "2026-02-09T12:00:00Z";
  const capped = recentChanges({ root: ws.root, since, repos: ["api"], renameLimit: 1 }).repos[0];
  assert.equal(capped.state, "ok");
  assert.ok(capped.files.some((f) => f.path === "infra/a.txt" && f.status === "deleted"), JSON.stringify(capped.files));
  assert.match(capped.detail, /too many files for rename detection: renames show as a delete and an add/);
  const full = recentChanges({ root: ws.root, since, repos: ["api"] }).repos[0];
  assert.deepEqual(full.files.map((f) => [f.status, f.from, f.path]), [["renamed", "infra/a.txt", "infra/a2.txt"], ["renamed", "infra/b.txt", "infra/b2.txt"]]);
  assert.equal(full.detail, null);
});

test("recent: with several repos, a --paths folder only some have isn't a typo in the others (notInRepo)", () => {
  const ws = recentWorkspace();
  const web = ws.seeds.web;
  at("2026-02-09T00:00:00Z", () => commit(web, "client/app.ts", "x\n", "feat(web): client"));
  git(web, "push", "-q", "origin", "HEAD:main");
  git(ws.repo("web"), "fetch", "-q", "origin");
  const r = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api", "web"], paths: ["infra", "client", "nope"] });
  const by = Object.fromEntries(r.repos.map((x) => [x.name, x]));
  assert.deepEqual([by.api.missingPaths, by.api.notInRepo], [["nope"], ["client"]]);
  assert.deepEqual([by.web.missingPaths, by.web.notInRepo], [["nope"], ["infra"]]);
  assert.match(by.api.detail, /'nope' isn't a path/);
  assert.doesNotMatch(by.api.detail, /client/);
  assert.doesNotMatch(by.web.detail, /infra/);
  assert.deepEqual(by.web.files.map((f) => f.path), ["client/app.ts"]);
  const one = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api", "web"], paths: ["infra", "client"] });
  for (const x of one.repos) assert.equal(x.detail, null, x.name);
  const single = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["client"] }).repos[0];
  assert.deepEqual([single.missingPaths, single.notInRepo], [["client"], []]); // one repo: missing is a typo
});

test("recent: an error keeps the notes and path lists gathered before it", () => {
  const ws = recentWorkspace();
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"], paths: ["infra", "nope"], maxBuffer: 8 }).repos[0];
  assert.equal(api.state, "error");
  assert.deepEqual(api.missingPaths, ["nope"]);
  assert.match(api.detail, /^git diff failed: .*; 'nope' isn't a path/);
});

test("recent: a --paths entry with a '..' segment is a usage error", () => {
  const ws = recentWorkspace();
  for (const p of ["..", "../web", "infra/../x", "infra\\..\\x"]) {
    assert.throws(() => recentChanges({ root: ws.root, since: "2026-02-01", paths: [p] }), (e) => e.usage && /\.\./.test(e.message), p);
  }
  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--recent", "--since", "2026-02-01", "--paths", "../web", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 2);
});

test("recent: a shallow clone's oldest-commit date is the UTC day", () => {
  const ws = recentWorkspace();
  const seed = ws.seeds.api;
  at("2026-02-09T23:30:00-05:00", () => commit(seed, "infra/late.txt", "x\n", "late"));
  at("2026-02-11T00:00:00Z", () => commit(seed, "infra/next.txt", "x\n", "next"));
  git(seed, "push", "-q", "origin", "HEAD:main");
  fs.rmSync(ws.repo("api"), { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", "--depth", "2", pathToFileURL(path.join(ws.base, "remotes", "api.git")).href, ws.repo("api")], { stdio: "pipe" });
  const api = recentChanges({ root: ws.root, since: "2026-02-01", repos: ["api"] }).repos[0];
  assert.equal(api.state, "shallow");
  assert.match(api.detail, /\(2026-02-10\)/);
});

// ------------------------------------------------------------------ branches

test("branches: created from origin/<default> (fetched first), with no upstream", () => {
  const ws = makeWorkspace({ names: ["api"] });
  ws.push("api"); // local main is behind and unfetched: the branch still starts at origin's tip
  const r = createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["api"] });
  assert.equal(r.ticket, "ENG-1");
  assert.deepEqual([r.repos[0].state, r.repos[0].from], ["created", "origin/main"]);
  assert.equal(branchOf(ws.repo("api")), "feature/ENG-1");
  assert.equal(head(ws.repo("api")), git(ws.repo("api"), "rev-parse", "origin/main"));
  assert.throws(() => git(ws.repo("api"), "rev-parse", "--abbrev-ref", "@{u}")); // the first push -u sets it
});

test("branches: an existing remote or local branch is switched to; then already-on", () => {
  const ws = makeWorkspace({ names: ["web", "lib"] });
  git(ws.seeds.web, "push", "-q", "origin", "HEAD:feature/ENG-1");
  git(ws.repo("web"), "fetch", "-q", "origin");
  git(ws.repo("lib"), "branch", "feature/ENG-1");
  const r = createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["web", "lib"] });
  assert.deepEqual(r.repos.map((x) => [x.name, x.state]), [["web", "switched"], ["lib", "switched"]]);
  assert.equal(git(ws.repo("web"), "rev-parse", "--abbrev-ref", "@{u}"), "origin/feature/ENG-1");
  const again = createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["web"] });
  assert.equal(again.repos[0].state, "already-on");
});

test("branches: unrelated branch, same ticket on another branch, dirty and missing repos are skipped; nothing stashed", () => {
  const ws = makeWorkspace({ names: ["other", "same", "dirty", "ok"] });
  git(ws.repo("other"), "switch", "-q", "-c", "feature/ENG-9");
  git(ws.repo("same"), "switch", "-q", "-c", "fix/ENG-1");
  write(path.join(ws.repo("dirty"), "README.md"), "edit\n");
  write(path.join(ws.root, "repos.json"), { repos: ["other", "same", "dirty", "ok", { name: "gone", relativePath: "gone" }] });

  const r = createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["other", "same", "dirty", "ok", "gone"] });
  const by = Object.fromEntries(r.repos.map((x) => [x.name, x]));
  assert.equal(by.other.state, "skipped");
  assert.match(by.other.reason, /unrelated/);
  assert.equal(by.same.state, "skipped");
  assert.match(by.same.reason, /--branch fix\/ENG-1/);
  assert.equal(by.dirty.state, "skipped");
  assert.match(by.dirty.reason, /uncommitted/);
  assert.equal(by.gone.state, "missing");
  assert.equal(by.ok.state, "created");
  assert.equal(branchOf(ws.repo("other")), "feature/ENG-9");
  assert.equal(branchOf(ws.repo("same")), "fix/ENG-1");
  assert.equal(branchOf(ws.repo("dirty")), "main");
  assert.equal(fs.readFileSync(path.join(ws.repo("dirty"), "README.md"), "utf-8"), "edit\n");
  assert.equal(git(ws.repo("dirty"), "stash", "list"), "");
});

test("branches: refused in the main workspace when the ticket's worktree exists; works inside it", () => {
  const ws = wsWithWorktrees();
  createWorktree({ root: ws.root, name: "ENG-1", repos: "api", install: false }); // no --branch: clone on main
  const wt = path.join(ws.root, "worktrees", "ENG-1");
  assert.throws(() => createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["api"] }), (e) => e.refused && /worktrees\/ENG-1/.test(slash(e.message)));
  assert.equal(branchOf(ws.repo("api")), "main");

  let status = 0;
  try { execFileSync(process.execPath, [SCRIPT, "--branches", "--branch", "feature/ENG-1", "--repos", "api", "--root", ws.root], { stdio: "pipe" }); } catch (e) { status = e.status; }
  assert.equal(status, 1);

  const r = createBranches({ root: wt, branch: "feature/ENG-1", repos: ["api"] });
  assert.equal(r.repos[0].state, "created");
  assert.equal(branchOf(path.join(wt, "api")), "feature/ENG-1");
  assert.equal(branchOf(ws.repo("api")), "main");
});

test("branches: refused from the main workspace when the ticket's worktree has another folder name", () => {
  const ws = wsWithWorktrees();
  createWorktree({ root: ws.root, name: "payments-redo", repos: "api", ticket: "ENG-9", install: false });
  assert.throws(
    () => createBranches({ root: ws.root, branch: "feature/ENG-9", repos: ["api"], ticket: "eng-9" }),
    (e) => e.refused && e.reason === "in the main workspace" && /worktrees\/payments-redo/.test(slash(e.message)),
  );
  assert.equal(branchOf(ws.repo("api")), "main");
});

test("branches: refused in another ticket's worktree (exit 1, refused JSON)", () => {
  const ws = wsWithWorktrees();
  createWorktree({ root: ws.root, name: "ENG-2", repos: "api", ticket: "ENG-2", install: false });
  const wt = path.join(ws.root, "worktrees", "ENG-2");
  assert.throws(() => createBranches({ root: wt, branch: "feature/ENG-1", repos: ["api"], ticket: "ENG-1" }), (e) => e.refused && e.reason === "in another ticket's worktree");
  let status = 0;
  let stdout = "";
  try { execFileSync(process.execPath, [SCRIPT, "--branches", "--branch", "feature/ENG-1", "--repos", "api", "--root", wt, "--json"], { stdio: "pipe", encoding: "utf-8" }); } catch (e) { status = e.status; stdout = e.stdout; }
  assert.equal(status, 1);
  assert.deepEqual([JSON.parse(stdout).refused, JSON.parse(stdout).reason], [true, "in another ticket's worktree"]);
  assert.equal(branchOf(path.join(wt, "api")), "main");
  assert.equal(createBranches({ root: wt, branch: "feature/ENG-2", repos: ["api"], ticket: "eng-2" }).repos[0].state, "created"); // its own ticket, any case
});

test("branches: bad arguments", () => {
  const ws = makeWorkspace({ names: ["api"] });
  assert.throws(() => createBranches({ root: ws.root, repos: ["api"] }), /--branch is required/);
  assert.throws(() => createBranches({ root: ws.root, branch: "bad..name", repos: ["api"] }), /Invalid branch/);
  assert.throws(() => createBranches({ root: ws.root, branch: "feature/ENG-1" }), /--repos is required/);
  assert.throws(() => createBranches({ root: ws.root, branch: "feature/ENG-1", repos: ["nope"] }), /Unknown repo/);
});

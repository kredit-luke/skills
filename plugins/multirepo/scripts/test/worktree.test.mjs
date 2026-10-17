// worktree.mjs against throwaway workspaces whose repos are clones of bare local
// "remotes", so fetch, push and merge detection all run offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  allocatePorts, copyConfig, createWorktree, decidePrMerged, gatherWorktrees, ghRepoFromUrl, parseGhAuthHosts, readApps, releasePorts, removeWorktree,
  slotOffsets, syncWorktree, vsMain, writeMeta,
} from "../worktree.mjs";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com",
});

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

/** A bare remote with one commit on main, plus a scratch clone to push "merges" from. */
function makeRemote(base, name) {
  const bare = path.join(base, "remotes", `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = path.join(base, "seed", name);
  execFileSync("git", ["clone", "-q", bare, seed], { stdio: "pipe" });
  commit(seed, "README.md", "hello\n", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { bare, seed };
}

/**
 * A main workspace: repos cloned from bare remotes at their relativePath, Claude
 * config (including skills/agents that must not be copied) and workspace.json.
 */
function makeWorkspace({ repos = [{ name: "api", relativePath: "api" }], worktrees = {}, apps = null } = {}) {
  const base = tmp("mr-wt-");
  const root = path.join(base, "ws");
  const remotes = {};
  for (const r of repos) {
    remotes[r.name] = makeRemote(base, r.name);
    fs.mkdirSync(path.dirname(path.join(root, r.relativePath)), { recursive: true });
    execFileSync("git", ["clone", "-q", remotes[r.name].bare, path.join(root, r.relativePath)], { stdio: "pipe" });
  }
  write(path.join(root, "repos.json"), { repos });
  write(path.join(root, "CLAUDE.md"), "# ws\n");
  write(path.join(root, ".claude", "settings.json"), { permissions: {} });
  write(path.join(root, ".claude", "skills", "x", "SKILL.md"), "skill\n");
  write(path.join(root, ".claude", "agents", "a.md"), "agent\n");
  write(path.join(root, ".claude", "references", "ref.md"), "ref\n");
  write(path.join(root, "docs", "guide.md"), "guide\n");
  write(path.join(root, ".claude", "dashboard", "workspace.json"), {
    issues: { kind: "linear" },
    worktrees: { portsFile: path.join(base, "ports.json"), ...worktrees },
  });
  if (apps) write(path.join(root, ".claude", "dashboard", "apps.json"), { apps });
  return { base, root, remotes, portsFile: path.join(base, "ports.json") };
}

const launch = { cmd: "x" };

test("create (clone): nested relativePath, branch off origin/main, metadata, config copy, no skills, ports", () => {
  const ws = makeWorkspace({
    repos: [{ name: "api", relativePath: "api" }, { name: "web", relativePath: "services/web" }],
    worktrees: { ports: { base: 24000, slotSize: 100 }, copy: ["docs", ".claude/references", ".claude/skills"] },
    apps: { api: { name: "API", dir: "api", port: 8080, launch }, web: { name: "Web", dir: "services/web", port: 5173, launch } },
  });
  const r = createWorktree({ root: ws.root, name: "ENG-1", repos: "api,services/web", branch: "feature/ENG-1", install: false });
  const wt = path.join(ws.root, "worktrees", "ENG-1");
  assert.equal(r.path, wt.replace(/\\/g, "/"));
  assert.deepEqual(r.failures, []);
  for (const rel of ["api", "services/web"]) {
    const repo = path.join(wt, rel);
    assert.equal(git(repo, "branch", "--show-current"), "feature/ENG-1");
    // The clone's origin is the real remote, not the main checkout.
    assert.equal(path.resolve(git(repo, "remote", "get-url", "origin")), path.resolve(ws.remotes[rel === "api" ? "api" : "web"].bare));
    // No upstream: a new branch must not track origin/main.
    assert.throws(() => git(repo, "rev-parse", "@{u}"));
  }
  const meta = JSON.parse(fs.readFileSync(path.join(wt, ".worktree.json"), "utf-8"));
  assert.equal(meta.name, "ENG-1");
  assert.equal(meta.ticketId, "ENG-1");
  assert.equal(meta.tracker, "linear");
  assert.equal(meta.branch, "feature/ENG-1");
  assert.deepEqual(meta.repos, ["api", "services/web"]);
  assert.equal(path.resolve(meta.sourceWorkspace), path.resolve(ws.root));
  assert.ok(meta.created);

  assert.ok(fs.existsSync(path.join(wt, "CLAUDE.md")));
  assert.ok(fs.existsSync(path.join(wt, "repos.json")));
  assert.ok(fs.existsSync(path.join(wt, ".claude", "settings.json")));
  assert.ok(fs.existsSync(path.join(wt, "docs", "guide.md")));
  assert.ok(fs.existsSync(path.join(wt, ".claude", "references", "ref.md")));
  // Never copied, even when worktrees.copy names them.
  assert.equal(fs.existsSync(path.join(wt, ".claude", "skills")), false);
  assert.equal(fs.existsSync(path.join(wt, ".claude", "agents")), false);

  assert.equal(r.ports.slot, 1);
  assert.deepEqual(r.ports.ports, { api: 24101, web: 24102 });
  const ports = JSON.parse(fs.readFileSync(ws.portsFile, "utf-8"));
  assert.equal(ports.worktrees["ENG-1"].slot, 1);
  assert.equal(path.resolve(ports.worktrees["ENG-1"].workspace), path.resolve(wt));
  assert.equal(fs.existsSync(ws.portsFile + ".lock"), false);
});

test("create: refuses unknown repos (naming valid ones), an existing worktree, and running inside a worktree", () => {
  const ws = makeWorkspace();
  assert.throws(() => createWorktree({ root: ws.root, name: "x", repos: "nope", install: false }), /Unknown repo\(s\): nope\. Valid: api/);
  assert.throws(() => createWorktree({ root: ws.root, name: "bad/name", repos: "api", install: false }), /Invalid name/);
  const r = createWorktree({ root: ws.root, name: "spike", repos: "api", install: false });
  assert.equal(r.ticketId, null);
  assert.equal(r.tracker, null);
  assert.equal(r.portsConfigured, false);
  assert.equal(r.ports, null);
  assert.equal(git(path.join(ws.root, "worktrees", "spike", "api"), "branch", "--show-current"), "main");
  assert.throws(() => createWorktree({ root: ws.root, name: "spike", repos: "api", install: false }), /already exists/);
  assert.throws(() => createWorktree({ root: path.join(ws.root, "worktrees", "spike"), name: "y", repos: "api", install: false }), /is a worktree/);
});

test("create: an existing remote branch is checked out, not recreated", () => {
  const ws = makeWorkspace();
  git(ws.remotes.api.seed, "switch", "-q", "-c", "feature/ENG-3");
  commit(ws.remotes.api.seed, "f.txt", "x\n", "ENG-3 start");
  git(ws.remotes.api.seed, "push", "-q", "origin", "feature/ENG-3");
  createWorktree({ root: ws.root, name: "ENG-3", repos: "api", branch: "feature/ENG-3", install: false });
  const repo = path.join(ws.root, "worktrees", "ENG-3", "api");
  assert.ok(fs.existsSync(path.join(repo, "f.txt")));
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{u}"), "origin/feature/ENG-3");
});

test("create --native: git worktree of the main repo; list finds it; remove cleans it up", async () => {
  const ws = makeWorkspace();
  assert.throws(() => createWorktree({ root: ws.root, name: "n0", repos: "api", native: true, install: false }), /No repo could be set up.*needs --branch/);
  const r = createWorktree({ root: ws.root, name: "ENG-2", repos: "api", branch: "feature/ENG-2", native: true, install: false });
  assert.deepEqual(r.failures, []);
  const repo = path.join(ws.root, "worktrees", "ENG-2", "api");
  assert.ok(fs.statSync(path.join(repo, ".git")).isFile());
  assert.match(git(path.join(ws.root, "api"), "worktree", "list"), /ENG-2/);

  const [wt] = await gatherWorktrees(ws.root, { fetch: false, pr: false });
  assert.equal(wt.name, "ENG-2");
  assert.equal(wt.repos.length, 1);
  assert.equal(wt.repos[0].native, true);
  assert.equal(wt.repos[0].branch, "feature/ENG-2");

  const out = removeWorktree({ root: ws.root, name: "ENG-2" });
  assert.equal(out.removed, true);
  assert.equal(fs.existsSync(path.join(ws.root, "worktrees", "ENG-2")), false);
  assert.doesNotMatch(git(path.join(ws.root, "api"), "worktree", "list"), /ENG-2/);
});

test("list: a native git worktree without .worktree.json is grouped by its folder", async () => {
  const ws = makeWorkspace();
  git(path.join(ws.root, "api"), "worktree", "add", "-q", "-b", "fix/ENG-9", path.join(ws.root, "worktrees", "ENG-9", "api"));
  const [wt] = await gatherWorktrees(ws.root, { fetch: false, pr: false });
  assert.equal(wt.name, "ENG-9");
  assert.equal(wt.hasMetadata, false);
  assert.deepEqual(wt.repos.map((r) => [r.repo, r.native, r.branch]), [["api", true, "fix/ENG-9"]]);
});

test("list: merge ladder against a bare remote (merged, squash by trees, patches after main moved on, grep, not merged, unpushed)", async () => {
  const ws = makeWorkspace();
  const seed = ws.remotes.api.seed;
  const mk = (name) => {
    createWorktree({ root: ws.root, name, repos: "api", branch: `feature/${name}`, install: false });
    return path.join(ws.root, "worktrees", name, "api");
  };
  const toMain = (fn) => { git(seed, "switch", "-q", "main"); git(seed, "pull", "-q", "--ff-only", "origin", "main"); fn(); git(seed, "push", "-q", "origin", "main"); };

  // Normal merge, then main moves on.
  const merged = mk("ENG-10");
  commit(merged, "m.txt", "m\n", "ENG-10 work");
  git(merged, "push", "-q", "-u", "origin", "feature/ENG-10");
  toMain(() => { git(seed, "fetch", "-q", "origin"); git(seed, "merge", "-q", "--ff-only", "origin/feature/ENG-10"); commit(seed, "later.txt", "l\n", "later"); });

  // Each worktree below is cloned after the previous step pushed, so it starts at the latest main.
  // Squash merged, then main moved on: every patch is on main.
  const patches = mk("ENG-12");
  commit(patches, "p.txt", "p\n", "ENG-12 work");
  toMain(() => { commit(seed, "p.txt", "p\n", "Squash (#12)"); commit(seed, "other.txt", "o\n", "unrelated"); });

  // Content drifted, but main's log names the ticket.
  const grep = mk("ENG-13");
  commit(grep, "g.txt", "branch version\n", "ENG-13 work");
  toMain(() => commit(seed, "g.txt", "what landed\n", "ENG-13: the feature (#13)"));

  // Squash merged, nothing since (the last change to main): trees match.
  const squash = mk("ENG-11");
  commit(squash, "s.txt", "s1\n", "ENG-11 part 1");
  commit(squash, "s.txt", "s2\n", "ENG-11 part 2");
  toMain(() => commit(seed, "s.txt", "s2\n", "Squash (#11)"));

  // Not merged, no upstream.
  const open = mk("ENG-14");
  commit(open, "o.txt", "o\n", "work");

  // Pushed, then one more local commit.
  const ahead = mk("ENG-15");
  commit(ahead, "a.txt", "1\n", "one");
  git(ahead, "push", "-q", "-u", "origin", "feature/ENG-15");
  commit(ahead, "a.txt", "2\n", "two");

  const list = await gatherWorktrees(ws.root, { fetch: true, pr: false });
  const by = Object.fromEntries(list.map((w) => [w.name, w.repos[0]]));

  assert.equal(by["ENG-10"].merged, true);
  assert.equal(by["ENG-10"].behindMain > 0, true);
  assert.match(vsMain(by["ENG-10"]), /^merged → origin\/main$/);

  assert.equal(by["ENG-11"].merged, false);
  assert.equal(by["ENG-11"].treesIdentical, true);
  assert.equal(vsMain(by["ENG-11"]), "squash-merged → origin/main");

  assert.equal(by["ENG-12"].treesIdentical, false);
  assert.equal(by["ENG-12"].allPatchesOnMain, true);
  assert.match(vsMain(by["ENG-12"]), /^squash-merged → origin\/main \(-\d+\)$/);

  assert.equal(by["ENG-13"].allPatchesOnMain, false);
  assert.equal(by["ENG-13"].squashMergedByGrep, true);
  assert.equal(by["ENG-13"].prMerged, null); // --no-pr
  assert.match(vsMain(by["ENG-13"]), /^squash-merged \(\+1\/-\d+ since\)$/);

  assert.equal(by["ENG-14"].unpushed, null);
  assert.equal(by["ENG-14"].merged, false);
  assert.equal(by["ENG-14"].squashMergedByGrep, false);
  assert.match(vsMain(by["ENG-14"]), /^not merged \(\+1/);

  assert.equal(by["ENG-15"].unpushed, 1);
  assert.equal(by["ENG-15"].aheadOfMain, 2);
});

test("list: legacy .worktree.json (linearId, mode) reads as ticketId + tracker linear", async () => {
  const ws = makeWorkspace();
  const wt = path.join(ws.root, "worktrees", "OLD");
  execFileSync("git", ["clone", "-q", ws.remotes.api.bare, path.join(wt, "api")], { stdio: "pipe" });
  write(path.join(wt, ".worktree.json"), { name: "OLD", created: "2025-01-01T00:00:00Z", mode: "linear", linearId: "ENG-77", branch: null, repos: ["api", "gone"] });
  const [entry] = await gatherWorktrees(ws.root, { fetch: false, pr: false });
  assert.equal(entry.metadata.ticketId, "ENG-77");
  assert.equal(entry.metadata.tracker, "linear");
  assert.deepEqual(entry.repos.map((r) => [r.repo, r.missing]), [["api", false], ["gone", true]]);

  // Re-writing metadata keeps `created` and drops the legacy fields.
  const meta = writeMeta(wt, { ticketId: "ENG-77", tracker: "linear", repos: ["api"] });
  assert.equal(meta.created, "2025-01-01T00:00:00Z");
  assert.equal("linearId" in meta, false);
  assert.equal("mode" in meta, false);
});

test("remove: refuses dirty or unpushed work, --force removes and frees the port slot", () => {
  const ws = makeWorkspace({ worktrees: { ports: { base: 30000, slotSize: 10 } }, apps: { api: { name: "API", dir: "api", port: 8080, launch } } });
  createWorktree({ root: ws.root, name: "ENG-20", repos: "api", branch: "feature/ENG-20", install: false });
  const repo = path.join(ws.root, "worktrees", "ENG-20", "api");

  commit(repo, "c.txt", "c\n", "local only"); // no upstream, on no remote
  assert.throws(() => removeWorktree({ root: ws.root, name: "ENG-20" }), (e) => e.unsaved?.[0]?.type === "unpushed (no upstream)");
  write(path.join(repo, "dirty.txt"), "x\n");
  assert.throws(() => removeWorktree({ root: ws.root, name: "ENG-20" }), (e) => e.unsaved.some((u) => u.type === "uncommitted"));
  assert.ok(fs.existsSync(repo));
  assert.ok(JSON.parse(fs.readFileSync(ws.portsFile, "utf-8")).worktrees["ENG-20"]);

  const out = removeWorktree({ root: ws.root, name: "ENG-20", force: true });
  assert.equal(out.removed, true);
  assert.deepEqual(out.portsFreed, ["ENG-20"]);
  assert.equal(fs.existsSync(path.join(ws.root, "worktrees", "ENG-20")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(ws.portsFile, "utf-8")).worktrees, {});
  assert.throws(() => removeWorktree({ root: ws.root, name: "ENG-20" }), /not found/);
});

test("remove --delete-remote-branches deletes the pushed branch", () => {
  const ws = makeWorkspace();
  createWorktree({ root: ws.root, name: "ENG-21", repos: "api", branch: "feature/ENG-21", install: false });
  const repo = path.join(ws.root, "worktrees", "ENG-21", "api");
  commit(repo, "d.txt", "d\n", "ENG-21");
  git(repo, "push", "-q", "-u", "origin", "feature/ENG-21");
  const out = removeWorktree({ root: ws.root, name: "ENG-21", deleteRemoteBranches: true });
  assert.deepEqual(out.remoteBranches.map((b) => b.status), ["deleted"]);
  assert.equal(git(ws.remotes.api.bare, "branch", "--list", "feature/ENG-21"), "");
});

test("sync: recopies config from the source workspace and deletes stale skills/agents", () => {
  const ws = makeWorkspace({ worktrees: { copy: ["docs"] } });
  createWorktree({ root: ws.root, name: "s1", repos: "api", install: false });
  const wt = path.join(ws.root, "worktrees", "s1");
  write(path.join(wt, ".claude", "skills", "old", "SKILL.md"), "stale\n");
  write(path.join(wt, ".claude", "agents", "old.md"), "stale\n");
  write(path.join(wt, "docs", "removed.md"), "gone upstream\n");
  write(path.join(ws.root, "CLAUDE.md"), "# updated\n");
  const r = syncWorktree({ path: wt });
  assert.equal(fs.readFileSync(path.join(wt, "CLAUDE.md"), "utf-8"), "# updated\n");
  assert.deepEqual(r.removed.sort(), [".claude/agents", ".claude/skills"]);
  assert.equal(fs.existsSync(path.join(wt, ".claude", "skills")), false);
  assert.equal(fs.existsSync(path.join(wt, "docs", "removed.md")), false); // folders are replaced
  assert.ok(fs.existsSync(path.join(wt, "docs", "guide.md")));
  assert.throws(() => syncWorktree({ path: ws.root }), /Not a worktree/);
});

test("ports: lowest free slot, offsets as the dashboard computes them, stale lock broken, release", () => {
  const base = tmp("mr-ports-");
  const root = path.join(base, "ws");
  write(path.join(root, ".claude", "dashboard", "apps.json"), {
    apps: {
      api: { name: "API", dir: "api", launch },
      bad: { name: "Bad", dir: "../x", launch }, // dropped by the dashboard: doesn't take a position
      web: { name: "Web", dir: "web", launch, slotOffset: 50 },
      docs: { name: "Docs", dir: "docs", launch, mainOnly: true },
      worker: { name: "Worker", dir: "worker", launch },
    },
  });
  const apps = readApps(root);
  assert.deepEqual(Object.keys(apps), ["api", "web", "docs", "worker"]);
  assert.deepEqual(slotOffsets(apps), { api: 1, web: 50, worker: 4 });

  const portsFile = path.join(base, "ports.json");
  const wtDir = path.join(root, "worktrees");
  write(portsFile, { keep: true, worktrees: { a: { slot: 1, workspace: path.join(wtDir, "a"), ports: {} }, c: { slot: 3, workspace: path.join(wtDir, "c"), ports: {} } } });
  write(portsFile + ".lock", "{}");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(portsFile + ".lock", old, old);

  const rule = { base: 20000, slotSize: 100 };
  const wtPath = path.join(wtDir, "b");
  const r = allocatePorts({ portsFile, rule, apps, wtPath, name: "b", wtDir });
  assert.equal(r.slot, 2);
  assert.deepEqual(r.ports, { api: 20201, web: 20250, worker: 20204 });
  assert.equal(fs.existsSync(portsFile + ".lock"), false);
  // Re-running keeps the slot.
  assert.equal(allocatePorts({ portsFile, rule, apps, wtPath, name: "b", wtDir }).slot, 2);
  const data = JSON.parse(fs.readFileSync(portsFile, "utf-8"));
  assert.equal(data.keep, true);

  assert.deepEqual(releasePorts({ portsFile, wtPath, name: "b", wtDir }), ["b"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(portsFile, "utf-8")).worktrees), ["a", "c"]);
});

test("ports: same result as the dashboard's ensureSlot on the same file", async (t) => {
  let ws;
  try {
    ws = await import(new URL("../../../natterjack/engine/server/src/workspaces.ts", import.meta.url));
  } catch {
    t.skip("this Node can't import the dashboard's TypeScript");
    return;
  }
  const apps = { api: { dir: "api", port: 1 }, web: { dir: "web", port: 2, slotOffset: 7 }, docs: { dir: "d", port: 3, mainOnly: true }, job: { dir: "j", port: null } };
  const rule = { base: 24000, slotSize: 100 };
  const base = tmp("mr-dash-");
  const wtDir = path.join(base, "worktrees");
  const seed = { worktrees: { x: { slot: 1, workspace: path.join(wtDir, "x"), ports: {} } } };
  const mine = path.join(base, "mine.json");
  const theirs = path.join(base, "theirs.json");
  write(mine, seed);
  write(theirs, seed);
  const wtPath = path.join(wtDir, "ENG-5");
  const a = allocatePorts({ portsFile: mine, rule, apps, wtPath, name: "ENG-5", wtDir });
  const b = ws.ensureSlot(theirs, { slug: "eng-5", name: "ENG-5", path: wtPath }, apps, rule, wtDir);
  assert.deepEqual(a.ports, b);
  const strip = (f) => {
    const d = JSON.parse(fs.readFileSync(f, "utf-8"));
    for (const e of Object.values(d.worktrees)) delete e.allocatedAt;
    return d;
  };
  assert.deepEqual(strip(mine), strip(theirs));
});

test("worktrees.copy: '.', './', '', '..', absolute and root-normalizing entries are skipped, never deleting the worktree", () => {
  const abs = path.resolve(os.tmpdir(), "elsewhere");
  const ws = makeWorkspace({ worktrees: { copy: [".", "./", "", "docs/..", "../x", abs, "./docs/"] } });
  const r = createWorktree({ root: ws.root, name: "c1", repos: "api", install: false });
  const wt = path.join(ws.root, "worktrees", "c1");
  assert.ok(fs.existsSync(path.join(wt, "api", ".git")));
  assert.ok(fs.existsSync(path.join(wt, ".worktree.json")));
  assert.ok(fs.existsSync(path.join(wt, "docs", "guide.md")));
  assert.deepEqual(r.copySkipped.map((s) => s.path).sort(), ["", ".", "../x", "./", "docs/..", abs].sort());
  assert.ok(r.copied.includes("docs"));

  // copyConfig itself refuses the root too (callers that skip worktreeSettings).
  const direct = copyConfig(ws.root, wt, [".", "./", "a/.."]);
  assert.equal(direct.skipped.length, 3);
  assert.ok(fs.existsSync(path.join(wt, "api", ".git")));
  const s = syncWorktree({ path: wt });
  assert.equal(s.copySkipped.length, 6);
  assert.ok(fs.existsSync(path.join(wt, "api", ".git")));
});

test("single-repo worktree: tracked .claude/skills are kept on create and sync; untracked stale copies are removed", () => {
  const base = tmp("mr-wt-single-");
  const { bare, seed } = makeRemote(base, "app");
  commit(seed, ".claude/skills/own/SKILL.md", "project skill\n", "add skill");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const root = path.join(base, "ws");
  execFileSync("git", ["clone", "-q", bare, root], { stdio: "pipe" });
  write(path.join(root, "repos.json"), { repos: [{ name: "app", relativePath: "." }] });
  write(path.join(root, "CLAUDE.md"), "# app\n");

  const r = createWorktree({ root, name: "ENG-40", repos: "app", branch: "feature/ENG-40", install: false });
  const wt = path.join(root, "worktrees", "ENG-40");
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.kept, [".claude/skills"]);
  assert.ok(fs.existsSync(path.join(wt, ".claude", "skills", "own", "SKILL.md")));

  write(path.join(wt, ".claude", "agents", "stale.md"), "stale\n");
  const s = syncWorktree({ path: wt });
  assert.deepEqual(s.kept, [".claude/skills"]);
  assert.deepEqual(s.removed, [".claude/agents"]);
  assert.ok(fs.existsSync(path.join(wt, ".claude", "skills", "own", "SKILL.md")));
  assert.equal(fs.existsSync(path.join(wt, ".claude", "agents")), false);
  assert.equal(git(wt, "status", "--porcelain"), "");
});

test("create without --branch switches to the configured default branch even when origin HEAD points elsewhere", () => {
  const ws = makeWorkspace({ repos: [{ name: "api", relativePath: "api", defaultBranch: "main" }] });
  const { bare, seed } = ws.remotes.api;
  git(seed, "switch", "-q", "-c", "develop");
  commit(seed, "dev.txt", "d\n", "develop work");
  git(seed, "push", "-q", "origin", "develop");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/develop");
  const r = createWorktree({ root: ws.root, name: "adhoc", repos: "api", install: false });
  const repo = path.join(ws.root, "worktrees", "adhoc", "api");
  assert.equal(r.repos[0].base, "main");
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{u}"), "origin/main");
  assert.equal(fs.existsSync(path.join(repo, "dev.txt")), false);
});

test("decidePrMerged: only a merged PR into the default branch whose head is (or contains) HEAD proves it", () => {
  // A toy history: a ← b ← c (c newest). isAncestor(x, y): x is at or before y.
  const order = ["a", "b", "c"];
  const isAncestor = (x, y) => order.includes(x) && order.includes(y) && order.indexOf(x) <= order.indexOf(y);
  const countAhead = (oid) => order.length - 1 - order.indexOf(oid);
  const pr = (number, headRefOid, baseRefName = "main", mergedAt = "2026-01-01T00:00:00Z") => ({ number, headRefOid, baseRefName, mergedAt });
  const decide = (prs, headOid) => decidePrMerged(prs, { defaultBranch: "main", headOid, isAncestor, countAhead });

  assert.deepEqual(decide([pr(7, "c")], "c"), { prMerged: true, prNumber: 7, prMergedStale: false, prAheadBy: 0 });
  assert.equal(decide([pr(7, "c")], "b").prMerged, true); // HEAD is an ancestor of what merged
  assert.equal(decide([pr(7, "c", "release")], "c").prMerged, false); // merged elsewhere
  assert.deepEqual(decide([pr(5, "a")], "c"), { prMerged: false, prNumber: 5, prMergedStale: true, prAheadBy: 2 });
  assert.deepEqual(decide([pr(5, "x")], "c"), { prMerged: false, prNumber: null, prMergedStale: false, prAheadBy: null }); // unknown oid
  assert.equal(decide([pr(5, "a"), pr(6, "c", "main", "2026-02-01T00:00:00Z")], "c").prNumber, 6);
  assert.equal(decide([], "c").prMerged, false);
  assert.equal(decide(null, "c").prMerged, false);

  const row = { merged: false, treesIdentical: false, allPatchesOnMain: false, prMerged: false, prMergedStale: true, prNumber: 5, prAheadBy: 2, mainRef: "origin/main" };
  assert.match(vsMain(row), /^pr-merged #5 \(\+2 since\)/);
  assert.equal(ghRepoFromUrl("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(ghRepoFromUrl("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(ghRepoFromUrl("https://git.example.com/acme/widgets.git", ["git.example.com"]), "git.example.com/acme/widgets");
  assert.equal(ghRepoFromUrl("/tmp/remotes/widgets.git"), null);
});

test("remove without .worktree.json: finds checkouts (repos.json paths and a scan) and refuses on unsaved work", () => {
  const ws = makeWorkspace();
  const wt = path.join(ws.root, "worktrees", "loose");
  execFileSync("git", ["clone", "-q", ws.remotes.api.bare, path.join(wt, "api")], { stdio: "pipe" });
  commit(path.join(wt, "api"), "x.txt", "x\n", "local only");
  assert.throws(() => removeWorktree({ root: ws.root, name: "loose" }), (e) => e.unsaved?.some((u) => u.repo === "api"));

  // A checkout repos.json doesn't name, deeper down, is found by the scan.
  const wt2 = path.join(ws.root, "worktrees", "deep");
  execFileSync("git", ["clone", "-q", ws.remotes.api.bare, path.join(wt2, "services", "x", "api")], { stdio: "pipe" });
  write(path.join(wt2, "services", "x", "api", "dirty.txt"), "d\n");
  assert.throws(() => removeWorktree({ root: ws.root, name: "deep" }), (e) => e.unsaved?.some((u) => u.repo === "services/x/api"));
  assert.ok(fs.existsSync(wt2));

  // Nothing inspectable but not empty: refuse without --force.
  const wt3 = path.join(ws.root, "worktrees", "junk");
  write(path.join(wt3, "notes.txt"), "keep me?\n");
  assert.throws(() => removeWorktree({ root: ws.root, name: "junk" }), /no git checkout could be inspected.*--force/);
  assert.ok(fs.existsSync(path.join(wt3, "notes.txt")));
  assert.equal(removeWorktree({ root: ws.root, name: "junk", force: true }).removed, true);
  assert.equal(fs.existsSync(wt3), false);

  // A clean, pushed checkout without metadata is removable.
  git(path.join(wt, "api"), "reset", "-q", "--hard", "origin/main");
  assert.equal(removeWorktree({ root: ws.root, name: "loose" }).removed, true);
});

test("worktrees.copy never overwrites a checkout: repo folders, .git paths, paths inside repos, folders holding repos", () => {
  const ws = makeWorkspace({
    repos: [{ name: "api", relativePath: "api" }, { name: "web", relativePath: "services/web" }],
    worktrees: { copy: ["api", "api/.git", ".git", "api/README.md", "services", "docs"] },
  });
  const r = createWorktree({ root: ws.root, name: "g1", repos: "api,services/web", branch: "feature/g1", install: false });
  const wt = path.join(ws.root, "worktrees", "g1");
  const api = path.join(wt, "api");
  commit(api, "local.txt", "only here\n", "unpushed work");
  const head = git(api, "rev-parse", "HEAD");
  const reasons = Object.fromEntries(r.copySkipped.map((x) => [x.path, x.reason]));
  assert.deepEqual(Object.keys(reasons).sort(), [".git", "api", "api/.git", "api/README.md", "services"]);
  assert.match(reasons[".git"], /\.git path/);
  assert.match(reasons["api/.git"], /\.git path/);
  assert.match(reasons.api, /repo checkout/);
  assert.match(reasons["api/README.md"], /inside a repo checkout/);
  assert.match(reasons.services, /contains a repo checkout/);
  assert.ok(r.copied.includes("docs"));

  const s = syncWorktree({ path: wt });
  assert.equal(s.copySkipped.length, 5);
  assert.equal(git(api, "rev-parse", "HEAD"), head);
  assert.ok(fs.existsSync(path.join(api, "local.txt")));
  assert.ok(fs.existsSync(path.join(wt, "services", "web", ".git")));

  // Without metadata or repo paths: a folder holding a checkout is still never replaced.
  const loose = tmp("mr-wt-loose-");
  execFileSync("git", ["clone", "-q", ws.remotes.api.bare, path.join(loose, "api")], { stdio: "pipe" });
  commit(path.join(loose, "api"), "mine.txt", "x\n", "local");
  const direct = copyConfig(ws.root, loose, ["api", "services"]);
  assert.ok(!direct.copied.includes("api"));
  assert.match(direct.skipped.find((x) => x.path === "api").reason, /checkout|tracked/);
  assert.ok(fs.existsSync(path.join(loose, "api", "mine.txt")));
});

test("single-repo worktree: worktrees.copy never replaces a folder holding git-tracked files", () => {
  const base = tmp("mr-wt-tracked-");
  const { bare, seed } = makeRemote(base, "app");
  commit(seed, ".claude/references/own.md", "tracked\n", "add refs");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const root = path.join(base, "ws");
  execFileSync("git", ["clone", "-q", bare, root], { stdio: "pipe" });
  write(path.join(root, "repos.json"), { repos: [{ name: "app", relativePath: "." }] });
  write(path.join(root, ".claude", "dashboard", "workspace.json"), { worktrees: { copy: [".claude/references", ".git", "notes"] } });
  write(path.join(root, "notes", "n.md"), "untracked notes\n");
  const r = createWorktree({ root, name: "T-1", repos: "app", branch: "feature/T-1", install: false });
  const wt = path.join(root, "worktrees", "T-1");
  write(path.join(wt, ".claude", "references", "own.md"), "edited in the worktree\n");
  const s = syncWorktree({ path: wt });
  for (const out of [r.copySkipped, s.copySkipped]) {
    assert.match(out.find((x) => x.path === ".claude/references").reason, /git-tracked/);
    assert.match(out.find((x) => x.path === ".git").reason, /\.git path/);
  }
  assert.ok(s.copied.includes("notes"));
  assert.equal(fs.readFileSync(path.join(wt, ".claude", "references", "own.md"), "utf-8"), "edited in the worktree\n");
  assert.ok(fs.existsSync(path.join(wt, ".git")));
});

test("remove: an unreadable checkout (broken gitdir, corrupt repo) or a stash refuses without --force", () => {
  const ws = makeWorkspace();
  // No metadata: a clean clone plus a folder whose .git points at a missing gitdir.
  const wt = path.join(ws.root, "worktrees", "broken");
  execFileSync("git", ["clone", "-q", ws.remotes.api.bare, path.join(wt, "api")], { stdio: "pipe" });
  write(path.join(wt, "broken", ".git"), `gitdir: ${path.join(ws.base, "nowhere", ".git")}\n`);
  write(path.join(wt, "broken", "notes.txt"), "keep me\n");
  assert.throws(() => removeWorktree({ root: ws.root, name: "broken" }),
    (e) => e.unsaved?.some((u) => u.repo === "broken" && u.type === "uninspectable"));
  assert.ok(fs.existsSync(path.join(wt, "broken", "notes.txt")));
  // Only the broken folder left: nothing inspectable.
  fs.rmSync(path.join(wt, "api"), { recursive: true, force: true });
  assert.throws(() => removeWorktree({ root: ws.root, name: "broken" }), /no git checkout could be inspected/);
  assert.ok(fs.existsSync(path.join(wt, "broken", "notes.txt")));
  assert.equal(removeWorktree({ root: ws.root, name: "broken", force: true }).removed, true);

  // With metadata: a corrupt repo (HEAD gone) is uninspectable, not clean.
  createWorktree({ root: ws.root, name: "corrupt", repos: "api", branch: "feature/c", install: false });
  const cwt = path.join(ws.root, "worktrees", "corrupt");
  fs.rmSync(path.join(cwt, "api", ".git", "HEAD"));
  assert.throws(() => removeWorktree({ root: ws.root, name: "corrupt" }),
    (e) => e.unsaved?.some((u) => u.repo === "api" && u.type === "uninspectable"));
  assert.ok(fs.existsSync(cwt));

  // A stash goes with the folder: it's unsaved work.
  createWorktree({ root: ws.root, name: "stashed", repos: "api", install: false });
  const swt = path.join(ws.root, "worktrees", "stashed", "api");
  write(path.join(swt, "README.md"), "changed\n");
  git(swt, "stash", "-q");
  assert.equal(git(swt, "status", "--porcelain"), "");
  assert.throws(() => removeWorktree({ root: ws.root, name: "stashed" }), (e) => e.unsaved?.some((u) => u.type === "stashed"));
  assert.equal(removeWorktree({ root: ws.root, name: "stashed", force: true }).removed, true);
});

test("ghRepoFromUrl: --repo only for github.com or a logged-in host; SSH aliases and unknown hosts resolve in the repo folder", () => {
  assert.equal(ghRepoFromUrl("git@github.com:acme/api.git"), "acme/api");
  assert.equal(ghRepoFromUrl("ssh://git@ssh.github.com:443/acme/api.git"), "acme/api");
  assert.equal(ghRepoFromUrl("https://GitHub.com/acme/api"), "acme/api");
  assert.equal(ghRepoFromUrl("git@github-work:acme/api.git"), null);
  assert.equal(ghRepoFromUrl("git@github-work:acme/api.git", ["github.com"]), null);
  assert.equal(ghRepoFromUrl("https://ghe.example.com/acme/api.git"), null);
  assert.equal(ghRepoFromUrl("https://ghe.example.com/acme/api.git", ["github.com", "GHE.example.com"]), "ghe.example.com/acme/api");
  assert.equal(ghRepoFromUrl("ssh://git@ghe.example.com:2222/acme/api.git", ["ghe.example.com"]), "ghe.example.com/acme/api");
  assert.equal(ghRepoFromUrl("C:/remotes/acme/api.git"), null);
  assert.equal(ghRepoFromUrl(""), null);
  const status = [
    "github.com", "  ✓ Logged in to github.com account someone (keyring)",
    "ghe.example.com", "  X Failed to log in to ghe.example.com using token (GH_TOKEN)",
    "other.example.com", "  ✓ Logged in to other.example.com as someone (oauth_token)",
  ].join("\n");
  assert.deepEqual(parseGhAuthHosts(status), ["github.com", "other.example.com"]);
  assert.deepEqual(parseGhAuthHosts(""), []);
});

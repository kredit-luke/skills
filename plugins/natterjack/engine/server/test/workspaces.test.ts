// Workspace discovery (ports file, worktrees/ folders, native git worktrees), repos in a
// workspace (multi-repo, nested, monorepo), ports, fallback to main, and slot allocation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensureSlot, gitWorktrees, listRepos, listWorkspaces, worktreeRefreshes, ownPort, parseWorktreeList, repoDirOf, resolvePort,
  slotOffsets, withFileLock,
} from "../src/workspaces.ts";

// Not .native: on Windows CI the temp dir stays an 8.3 short name (C:\Users\RUNNER~1\...)
// while git prints the long one, which is the case discovery has to match.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-ws-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TICKET = /[A-Z][A-Z0-9]*-\d+/;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

function repo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}
const mkdir = (p: string) => { fs.mkdirSync(p, { recursive: true }); return p; };
const same = (a: string, b: string) => fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();

test("parseWorktreeList reads git's porcelain output", () => {
  const list = parseWorktreeList([
    "worktree /src/app", "HEAD abc", "branch refs/heads/main", "",
    "worktree /src/app-ENG-12", "HEAD def", "branch refs/heads/feature/ENG-12", "",
    "worktree /src/app-detached", "HEAD 123", "detached", "",
    "worktree /src/gone", "HEAD 456", "branch refs/heads/old", "prunable gitdir file points to non-existent location", "",
  ].join("\n"));
  assert.equal(list.length, 4);
  assert.equal(list[1].branch, "feature/ENG-12");
  assert.equal(list[2].detached, true);
  assert.equal(list[2].branch, null);
  assert.equal(list[3].prunable, true);
});

test("repos: multi-repo with nested app folders, .worktree.json, and a monorepo root", () => {
  const multi = mkdir(path.join(TMP, "multi"));
  repo(path.join(multi, "api"));
  repo(path.join(multi, "services", "billing"));
  mkdir(path.join(multi, "services", "billing", "src"));
  const apps = {
    api: { dir: "api", port: 8080 },
    billing: { dir: "services/billing/src", port: 8081 }, // an app in a sub-folder of a nested repo
    docs: { dir: "docs", port: 4000 },                    // not cloned
  };
  assert.equal(repoDirOf(multi, "services/billing/src"), "services/billing");
  assert.deepEqual(listRepos(multi, apps).sort(), ["api", "services/billing"]);

  fs.writeFileSync(path.join(multi, ".worktree.json"), JSON.stringify({ repos: ["api", "missing"] }));
  assert.deepEqual(listRepos(multi, apps), ["api"], ".worktree.json wins; uncloned entries dropped");

  const mono = repo(path.join(TMP, "mono"));
  mkdir(path.join(mono, "apps", "web"));
  assert.deepEqual(listRepos(mono, { web: { dir: "apps/web", port: 5173 } }), ["."]);

  assert.deepEqual(listRepos(mkdir(path.join(TMP, "empty")), apps), []);
});

test("native git worktrees of a monorepo are workspaces, with the ticket from the branch", () => {
  const root = repo(path.join(TMP, "shop"));
  mkdir(path.join(root, "apps", "web"));
  const wt = path.join(TMP, "shop-ENG-12");
  git(root, "worktree", "add", "-q", "-b", "feature/ENG-12", wt);

  const list = listWorkspaces({ root, wtRoot: path.join(root, "worktrees"), portsData: {}, apps: { web: { dir: "apps/web", port: 5173 } }, ticketInText: TICKET });
  assert.equal(list[0].slug, "main");
  const found = list.find((w) => same(w.path, wt));
  assert.ok(found, "the git worktree is listed");
  assert.equal(found.source, "git");
  assert.equal(found.branch, "feature/ENG-12");
  assert.equal(found.ticketId, "ENG-12");
  assert.equal(found.slug, "shop-eng-12");
  assert.deepEqual(listRepos(wt, { web: { dir: "apps/web", port: 5173 } }), ["."], "a monorepo worktree's repo is its root");
});

test("native git worktrees of app repos make one workspace when they mirror the layout", () => {
  const root = mkdir(path.join(TMP, "acme")); // the workspace itself is not a repo
  const api = repo(path.join(root, "api"));
  const web = repo(path.join(root, "web"));
  const apps = { api: { dir: "api", port: 8080 }, web: { dir: "web", port: 5173 } };
  const ticketDir = path.join(TMP, "acme-trees", "ENG-7");
  git(api, "worktree", "add", "-q", "-b", "feature/ENG-7", path.join(ticketDir, "api"));
  git(web, "worktree", "add", "-q", "-b", "feature/ENG-7", path.join(ticketDir, "web"));
  git(api, "worktree", "add", "-q", "-b", "scratch", path.join(TMP, "acme-scratch")); // doesn't mirror <ws>/api

  const list = listWorkspaces({ root, wtRoot: path.join(root, "worktrees"), portsData: {}, apps, ticketInText: TICKET });
  const hits = list.filter((w) => w.source === "git");
  assert.equal(hits.length, 1, "api + web worktrees under ENG-7 are one workspace; the scratch one is ignored");
  assert.ok(same(hits[0].path, ticketDir));
  assert.equal(hits[0].ticketId, "ENG-7");
  assert.deepEqual(listRepos(ticketDir, apps).sort(), ["api", "web"]);
});

test("the ports file and worktrees/ folders are listed once, ahead of git discovery", () => {
  const root = mkdir(path.join(TMP, "reg"));
  const wtRoot = mkdir(path.join(root, "worktrees"));
  const a = mkdir(path.join(wtRoot, "ENG-1"));
  const b = mkdir(path.join(wtRoot, "ENG-2"));
  mkdir(path.join(wtRoot, "not-a-worktree"));
  fs.writeFileSync(path.join(b, ".worktree.json"), JSON.stringify({ ticketId: "ENG-2", repos: [] }));
  const portsData = { worktrees: { "ENG-1": { workspace: a, ports: {} }, "ENG-2": { ports: {} }, gone: { workspace: path.join(TMP, "nope") } } };
  const list = listWorkspaces({ root, wtRoot, portsData, apps: {}, ticketInText: TICKET });
  assert.deepEqual(list.map((w) => [w.name, w.source]), [["Main Workspace", "main"], ["ENG-1", "ports"], ["ENG-2", "ports"]]);
  assert.equal(list[2].ticketId, "ENG-2");
});

const APPS = {
  api: { dir: "api", port: 8080, fallback: "main" as const },
  web: { dir: "web", port: 5173 },
  docs: { dir: "docs", port: 4000, mainOnly: true },
};
const main = { slug: "main", name: "Main Workspace", path: path.join(TMP, "p-main") };
const wt = { slug: "eng-3", name: "ENG-3", path: path.join(TMP, "p-main", "worktrees", "ENG-3") };
const PORTS = { worktrees: { "ENG-3": { slot: 1, ports: { api: 9081, web: 9082 } } } };
const own = (ws, key) => ownPort(ws, key, APPS, PORTS, path.join(TMP, "p-main", "worktrees"));

test("ownPort: main uses apps.json, a worktree its ports-file entry, mainOnly apps always main's", () => {
  assert.equal(own(main, "api"), 8080);
  assert.equal(own(wt, "api"), 9081);
  assert.equal(own(wt, "docs"), 4000);
  assert.equal(own({ ...wt, path: path.join(TMP, "elsewhere") }, "api"), null);
});

test("resolvePort: a fallback app a worktree isn't running (or hasn't cloned) resolves to main's", async () => {
  const up = new Set<number>();
  const opts = (cloned = true, starting = new Set<string>()) => ({ own, isUp: async (p) => up.has(p), starting, cloned: () => cloned });
  assert.deepEqual(await resolvePort(main, "api", APPS, opts()), { port: 8080, usingMain: false });
  assert.deepEqual(await resolvePort(wt, "api", APPS, opts()), { port: 8080, usingMain: true }, "not running here");
  assert.deepEqual(await resolvePort(wt, "api", APPS, opts(true, new Set(["api"]))), { port: 9081, usingMain: false }, "being started with the caller");
  up.add(9081);
  assert.deepEqual(await resolvePort(wt, "api", APPS, opts()), { port: 9081, usingMain: false }, "running here");
  assert.deepEqual(await resolvePort(wt, "api", APPS, opts(false)), { port: 8080, usingMain: true }, "not cloned here");
  assert.deepEqual(await resolvePort(wt, "web", APPS, opts()), { port: 9082, usingMain: false }, "no fallback: always its own");
});

test("ensureSlot allocates the next free slot, keeps other entries and fills in new apps", () => {
  const file = path.join(TMP, "ports.json");
  fs.writeFileSync(file, JSON.stringify({ worktrees: { old: { slot: 1, ports: { api: 1 } } }, somethingElse: { keep: true } }));
  const rule = { base: 20000, slotSize: 100 };
  const wtRoot = path.join(TMP, "slot-root", "worktrees");
  const a = { slug: "eng-4", name: "ENG-4", path: path.join(wtRoot, "ENG-4") };

  const apps = { api: { dir: "api", port: 8080 }, web: { dir: "web", port: 5173, slotOffset: 50 }, docs: { dir: "docs", port: 4000, mainOnly: true } };
  assert.deepEqual(slotOffsets(apps), { api: 1, web: 50 });
  assert.deepEqual(ensureSlot(file, a, apps, rule, wtRoot), { api: 20201, web: 20250 }, "slot 2: slot 1 is taken");

  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(data.somethingElse, { keep: true });
  assert.equal(data.worktrees["ENG-4"].slot, 2);
  assert.equal(data.worktrees["ENG-4"].workspace, a.path);
  assert.ok(!fs.existsSync(`${file}.lock`), "the lock is released");

  // Same worktree again: same slot. A new app is filled in on it; existing ports stay.
  data.worktrees["ENG-4"].tasks = { api: { pid: 1 } };
  fs.writeFileSync(file, JSON.stringify(data));
  const more = { ...apps, admin: { dir: "admin", port: 4200 } };
  assert.deepEqual(ensureSlot(file, a, more, rule, wtRoot), { api: 20201, web: 20250, admin: 20204 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")).worktrees["ENG-4"].tasks, { api: { pid: 1 } });

  // A second worktree, and a missing ports file.
  const b = { slug: "eng-5", name: "ENG-5", path: path.join(wtRoot, "ENG-5") };
  assert.equal(ensureSlot(file, b, apps, rule, wtRoot).api, 20301);
  const fresh = path.join(TMP, "sub", "fresh-ports.json");
  assert.equal(ensureSlot(fresh, b, apps, rule, wtRoot).api, 20101);
});

test("withFileLock breaks a stale lock and waits for a live one", async () => {
  const file = path.join(TMP, "locked.json");
  fs.writeFileSync(`${file}.lock`, "{}");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  assert.equal(withFileLock(file, () => 42), 42, "a lock older than 10s is a crashed writer's");

  // Another process holds the lock; it marks that it's done, then releases. The lock spins
  // synchronously, so only another process can release it. Ordering, not timing, is checked.
  const marker = path.join(TMP, "released.txt");
  const lockFile = `${file}.lock`;
  fs.writeFileSync(lockFile, "{}");
  const holder = `const fs = require("fs"); setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, "done"); fs.unlinkSync(${JSON.stringify(lockFile)}); }, 200)`;
  const { spawn } = await import("node:child_process");
  spawn(process.execPath, ["-e", holder], { stdio: "ignore" }).unref();
  assert.equal(withFileLock(file, () => fs.existsSync(marker)), true, "ran only after the other writer released the lock");
});

test("gitWorktrees: a worktree added or removed later is picked up without waiting out the cache", async () => {
  const root = repo(path.join(TMP, "later"));
  assert.deepEqual(gitWorktrees(root), []); // first call: git, synchronously
  const wt = path.join(TMP, "later-ENG-3");
  git(root, "worktree", "add", "-q", "-b", "feature/ENG-3", wt);
  // .git/worktrees changed: this call starts a background refresh; a later one has the result.
  const until = async (ok: (n: number) => boolean) => {
    for (const end = Date.now() + 10000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok(gitWorktrees(root).length)) return true;
    return false;
  };
  assert.ok(await until((n) => n === 1), "the new worktree is listed");
  git(root, "worktree", "remove", "--force", wt);
  assert.equal(gitWorktrees(root).length, 0, "a removed worktree's folder is gone, so it drops out at once");
  await worktreeRefreshes(); // Windows won't delete TMP while git's cwd is in it
});

test("gitWorktrees: a refresh that fails keeps the last good list", async () => {
  const root = repo(path.join(TMP, "flaky"));
  const wt = path.join(TMP, "flaky-ENG-4");
  git(root, "worktree", "add", "-q", "-b", "feature/ENG-4", wt);
  assert.equal(gitWorktrees(root).length, 1);
  const head = path.join(root, ".git", "HEAD");
  const good = fs.readFileSync(head, "utf-8");
  fs.writeFileSync(head, "not a ref\n"); // git now fails in this repo
  fs.mkdirSync(path.join(root, ".git", "worktrees", "stamp-change")); // makes the next call refresh
  try {
    gitWorktrees(root);
    await worktreeRefreshes();
    assert.equal(gitWorktrees(root).length, 1, "the worktree is still listed after git failed");
  } finally {
    fs.writeFileSync(head, good);
    fs.rmdirSync(path.join(root, ".git", "worktrees", "stamp-change"));
    await worktreeRefreshes();
  }
});

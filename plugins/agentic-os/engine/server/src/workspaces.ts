/**
 * Workspaces: the main checkout plus every worktree the dashboard can find, the
 * git repos inside each, the port each app uses there, and worktree port slots.
 *
 * Worktrees come from three places (the first to name a path wins):
 *  1. the ports file (workspace.json worktrees.portsFile), the registry a team's
 *     worktree tooling (or this dashboard's slot allocation) keeps;
 *  2. folders under worktrees.dir with a .worktree.json;
 *  3. native `git worktree`s of the workspace's repos. A worktree of the root repo
 *     (a monorepo, or a workspace that is itself a repo) is a workspace. A worktree
 *     of an app's repo counts when it mirrors the layout, <workspace>/<repo dir>, so
 *     several repos' worktrees under one folder make one workspace.
 *
 * Repos in a workspace: .worktree.json `repos`, else the repo holding each app's
 * folder (nested folders like services/api included), else the workspace root
 * itself when it's the repo (a monorepo): "." then.
 *
 * Ports: main uses apps.json's port; a worktree uses its entry in the ports file.
 * With workspace.json worktrees.ports ({ base, slotSize }) the dashboard allocates
 * that entry itself on first start: port = base + slot * slotSize + slotOffset.
 * An app with "fallback": "main" that a worktree isn't running (or hasn't cloned)
 * resolves to main's instance, so its dependents talk to that one.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

export interface Ws {
  slug: string;
  name: string;
  path: string;
  ticketId?: string | null;
  /** Where it was found: the main checkout, the ports file, worktrees/<name>/.worktree.json, or `git worktree list`. */
  source?: "main" | "ports" | "folder" | "git";
  branch?: string | null;
}

/** The parts of an apps.json app this module needs. */
export interface WsApp { dir: string; port: number | null; mainOnly?: boolean; fallback?: "main" | null; slotOffset?: number | null }
export interface SlotRule { base: number; slotSize: number }

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Real paths, so a Windows 8.3 short name (C:\Users\RUNNER~1) or a macOS /var symlink
// matches the long path git prints. A path that doesn't exist compares as resolved.
// Memoised briefly: a status pass compares the same few paths once per app per workspace.
const REAL_TTL_MS = 30_000;
const realCache = new Map<string, { at: number; real: string }>();
const real = (p: string) => {
  const hit = realCache.get(p);
  if (hit && Date.now() - hit.at < REAL_TTL_MS) return hit.real;
  let r: string;
  try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
  realCache.set(p, { at: Date.now(), real: r });
  return r;
};

const same = (a: string, b: string) => {
  const norm = (p: string) => real(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
};

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, "")); } catch { return null; }
}

export function readPortsData(file: string): any {
  return readJson(file) || {};
}

/** A path is a git checkout (repo or worktree: `.git` is a folder or a file). */
export function isGitCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

// ------------------------------------------------------------------ git worktree list

export interface GitWorktree { path: string; branch: string | null; head: string | null; bare: boolean; detached: boolean; prunable: boolean }

/** `git worktree list --porcelain` output → entries (the first is the repo's own checkout). */
export function parseWorktreeList(text: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      cur = { path: path.resolve(line.slice(9)), branch: null, head: null, bare: false, detached: false, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare") cur.bare = true;
    else if (line === "detached") cur.detached = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  return out;
}

const WORKTREE_TTL_MS = 10_000;
/** How long a list is trusted while the repo's .git/worktrees folder looks unchanged. */
const WORKTREE_MAX_AGE_MS = 120_000;
const worktreeCache = new Map<string, { at: number; stamp: string; list: GitWorktree[]; refreshing?: boolean }>();
const worktreeRefreshing = new Set<Promise<void>>();

/** Resolves once no background worktree refresh is running (tests: before deleting the repo it runs in). */
export function worktreeRefreshes(): Promise<void> {
  return Promise.all(worktreeRefreshing).then(() => {});
}

/**
 * Linked worktrees of the repo at repoPath (not its own checkout), cached. git adds
 * and removes an entry under .git/worktrees for each one, so while that folder's
 * stamp is unchanged the list is kept (up to WORKTREE_MAX_AGE_MS) without running
 * git: starting a process takes ~60 ms of the event loop on Windows, per repo.
 * Only a repo's first call waits for git; after that a stale entry is returned as
 * is and refreshed in the background.
 */
export function gitWorktrees(repoPath: string): GitWorktree[] {
  const hit = worktreeCache.get(repoPath);
  const stamp = worktreesStamp(repoPath);
  if (hit) {
    const age = Date.now() - hit.at;
    // No .git folder to watch (a worktree checkout, where .git is a file): the plain TTL.
    const stale = stamp === null ? age >= WORKTREE_TTL_MS : stamp !== hit.stamp || age >= WORKTREE_MAX_AGE_MS;
    if (stale && !hit.refreshing) {
      hit.refreshing = true;
      const done = new Promise<void>((resolve) => {
        execFile("git", WORKTREE_ARGS, { cwd: repoPath, encoding: "utf-8", timeout: 5000, windowsHide: true }, (err, text) => {
          worktreeCache.set(repoPath, { at: Date.now(), stamp: stamp ?? "", list: err ? [] : linkedWorktrees(text, repoPath) });
          resolve();
        });
      });
      worktreeRefreshing.add(done);
      done.then(() => worktreeRefreshing.delete(done));
    }
    return hit.list.filter((w) => fs.existsSync(w.path)); // one deleted by hand drops out at once
  }
  let list: GitWorktree[] = [];
  try {
    list = linkedWorktrees(execFileSync("git", WORKTREE_ARGS, { cwd: repoPath, encoding: "utf-8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }), repoPath);
  } catch { /* not a repo, or git missing */ }
  worktreeCache.set(repoPath, { at: Date.now(), stamp: stamp ?? "", list });
  return list;
}

/** The repo's .git/worktrees folder: its mtime and entries, "" when it has none, null when .git isn't a folder. */
function worktreesStamp(repoPath: string): string | null {
  const git = path.join(repoPath, ".git");
  try { if (!fs.statSync(git).isDirectory()) return null; } catch { return null; }
  const dir = path.join(git, "worktrees");
  try { return `${fs.statSync(dir).mtimeMs}:${fs.readdirSync(dir).join("/")}`; } catch { return ""; }
}

const WORKTREE_ARGS = ["worktree", "list", "--porcelain"];

function linkedWorktrees(text: string, repoPath: string): GitWorktree[] {
  return parseWorktreeList(text).filter((w) => !w.bare && !w.prunable && !same(w.path, repoPath) && fs.existsSync(w.path));
}

// ------------------------------------------------------------------ repos

/**
 * The workspace-relative folder of the repo holding an app: the app's dir or the
 * nearest parent of it that is a git checkout. null when none is.
 */
export function repoDirOf(wsPath: string, appDir: string): string | null {
  const parts = appDir.split("/").filter(Boolean);
  for (let n = parts.length; n > 0; n--) {
    const rel = parts.slice(0, n).join("/");
    if (isGitCheckout(path.join(wsPath, rel))) return rel;
  }
  return null;
}

/** Git repos in a workspace, workspace-relative ("." = the workspace root is the repo). */
export function listRepos(wsPath: string, apps: Record<string, WsApp>): string[] {
  const meta = readJson(path.join(wsPath, ".worktree.json"));
  if (meta && Array.isArray(meta.repos)) {
    return meta.repos.filter((d: unknown) => typeof d === "string" && isGitCheckout(path.join(wsPath, d)));
  }
  const dirs = new Set<string>();
  for (const app of Object.values(apps)) {
    const d = repoDirOf(wsPath, app.dir);
    if (d) dirs.add(d);
  }
  if (!dirs.size && isGitCheckout(wsPath)) return ["."];
  return [...dirs];
}

// ------------------------------------------------------------------ workspaces

export interface ListOptions {
  root: string;
  wtRoot: string;
  portsData: any;
  apps: Record<string, WsApp>;
  /** Finds a ticket id inside a branch name (unanchored). */
  ticketInText: RegExp;
  /** Include native git worktrees (default true). */
  git?: boolean;
}

/** The worktree's ticket: .worktree.json ticketId (linearId from older worktrees), else from the branch name. */
export function ticketOf(wsPath: string, branch: string | null | undefined, ticketInText: RegExp): string | null {
  const meta = readJson(path.join(wsPath, ".worktree.json"));
  if (meta && (meta.ticketId || meta.linearId)) return meta.ticketId || meta.linearId;
  const m = branch ? branch.match(ticketInText) : null;
  return m ? m[0] : null;
}

/** Main + every worktree, main first. */
export function listWorkspaces(o: ListOptions): Ws[] {
  const out: Ws[] = [{ slug: "main", name: "Main Workspace", path: o.root, source: "main" }];
  const seen = [path.resolve(o.root)];
  const known = (p: string) => seen.some((s) => same(s, p));
  const add = (ws: Ws) => {
    if (known(ws.path)) return;
    seen.push(path.resolve(ws.path));
    // Two worktrees with the same folder name elsewhere on disk get distinct slugs.
    let slug = slugify(ws.name) || "worktree";
    for (let i = 2; out.some((w) => w.slug === slug); i++) slug = `${slugify(ws.name)}-${i}`;
    out.push({ ...ws, slug });
  };

  for (const [name, entry] of Object.entries<any>(o.portsData.worktrees || {})) {
    const p = entry && entry.workspace ? entry.workspace : path.join(o.wtRoot, name);
    if (fs.existsSync(p)) add({ slug: "", name, path: p, source: "ports", ticketId: ticketOf(p, null, o.ticketInText) });
  }
  try {
    for (const e of fs.readdirSync(o.wtRoot, { withFileTypes: true })) {
      const p = path.join(o.wtRoot, e.name);
      if (e.isDirectory() && fs.existsSync(path.join(p, ".worktree.json"))) {
        add({ slug: "", name: e.name, path: p, source: "folder", ticketId: ticketOf(p, null, o.ticketInText) });
      }
    }
  } catch { /* no worktrees dir */ }

  if (o.git !== false) {
    const repos: { rel: string; abs: string }[] = [];
    if (isGitCheckout(o.root)) repos.push({ rel: ".", abs: o.root });
    for (const app of Object.values(o.apps)) {
      const rel = repoDirOf(o.root, app.dir);
      if (rel && !repos.some((r) => r.rel === rel)) repos.push({ rel, abs: path.join(o.root, rel) });
    }
    for (const repo of repos) {
      for (const wt of gitWorktrees(repo.abs)) {
        let wsPath: string | null = null;
        if (repo.rel === ".") wsPath = wt.path;
        else {
          // A worktree of an app's repo maps to a workspace only if it sits at <ws>/<repo dir>.
          const parts = repo.rel.split("/");
          const candidate = path.resolve(wt.path, ...parts.map(() => ".."));
          const tail = path.relative(candidate, wt.path).split(path.sep).join("/");
          const caseless = process.platform === "win32" || process.platform === "darwin";
          if (caseless ? tail.toLowerCase() === repo.rel.toLowerCase() : tail === repo.rel) wsPath = candidate;
        }
        if (!wsPath || known(wsPath)) continue;
        add({ slug: "", name: path.basename(wsPath), path: wsPath, source: "git", branch: wt.branch, ticketId: ticketOf(wsPath, wt.branch, o.ticketInText) });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ ports

/** The ports-file entry for a worktree path, with its name. */
export function worktreeEntry(portsData: any, wsPath: string, wtRoot: string): { name: string; entry: any } | null {
  for (const [name, entry] of Object.entries<any>(portsData.worktrees || {})) {
    const p = entry && entry.workspace ? entry.workspace : path.join(wtRoot, name);
    if (same(p, wsPath)) return { name, entry };
  }
  return null;
}

/** The port an app uses in a workspace (its own instance), or null when a worktree has none allocated yet. */
export function ownPort(ws: Ws, key: string, apps: Record<string, WsApp>, portsData: any, wtRoot: string): number | null {
  const app = apps[key];
  if (!app) return null;
  if (ws.slug === "main" || app.mainOnly) return app.port;
  const hit = worktreeEntry(portsData, ws.path, wtRoot);
  return hit ? Number((hit.entry.ports || {})[key]) || null : null;
}

/**
 * The port a workspace's apps should use to reach `key`. For an app with
 * "fallback": "main" in a worktree: this worktree's own instance when it is
 * running here or is being started with the caller (`starting`), else main's.
 */
export async function resolvePort(
  ws: Ws, key: string, apps: Record<string, WsApp>,
  opts: { own: (ws: Ws, key: string) => number | null; isUp: (port: number) => Promise<boolean>; starting?: Set<string>; cloned: (ws: Ws, key: string) => boolean },
): Promise<{ port: number | null; usingMain: boolean }> {
  const app = apps[key];
  const own = opts.own(ws, key);
  if (!app || ws.slug === "main" || app.fallback !== "main") return { port: own, usingMain: false };
  if (!opts.cloned(ws, key)) return { port: app.port, usingMain: true };
  if (opts.starting && opts.starting.has(key)) return { port: own, usingMain: false };
  if (own && (await opts.isUp(own))) return { port: own, usingMain: false };
  return { port: app.port, usingMain: true };
}

// ------------------------------------------------------------------ slot allocation

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Run fn while holding `<file>.lock` (created exclusively; broken when older than
 * 10s, i.e. its writer crashed). The same convention a team's own scripts can use
 * to write the ports file safely alongside the dashboard.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

/** Each app's offset in a slot: its slotOffset, else its 1-based position in apps.json. */
export function slotOffsets(apps: Record<string, WsApp>): Record<string, number> {
  const out: Record<string, number> = {};
  Object.entries(apps).forEach(([key, app], i) => {
    if (app.mainOnly) return;
    out[key] = Number.isInteger(app.slotOffset) && app.slotOffset! >= 0 ? app.slotOffset! : i + 1;
  });
  return out;
}

/**
 * Give a worktree a port slot in the ports file, unless it already has one.
 * Returns its ports. Slots already used by any entry are skipped; apps missing
 * from an existing entry (added to apps.json later) are filled in on the same slot.
 */
export function ensureSlot(file: string, ws: Ws, apps: Record<string, WsApp>, rule: SlotRule, wtRoot: string): Record<string, number> {
  return withFileLock(file, () => {
    const data = readPortsData(file);
    if (!data.worktrees || typeof data.worktrees !== "object") data.worktrees = {};
    const offsets = slotOffsets(apps);
    const hit = worktreeEntry(data, ws.path, wtRoot);
    let name = hit ? hit.name : ws.name;
    let entry = hit ? hit.entry : null;
    if (!hit) for (let i = 2; data.worktrees[name]; i++) name = `${ws.name}-${i}`;

    let slot = entry && Number.isInteger(entry.slot) && entry.slot > 0 ? entry.slot : 0;
    if (!slot) {
      const used = new Set(Object.values<any>(data.worktrees).map((e) => e && e.slot));
      slot = 1;
      while (used.has(slot)) slot++;
    }
    entry = { ...(entry || {}), slot, workspace: ws.path, ports: { ...((entry && entry.ports) || {}) } };
    let changed = !hit;
    for (const [key, offset] of Object.entries(offsets)) {
      if (!entry.ports[key]) { entry.ports[key] = rule.base + slot * rule.slotSize + offset; changed = true; }
    }
    if (!entry.allocatedAt) entry.allocatedAt = new Date().toISOString();
    if (changed || !hit || hit.entry.slot !== slot) {
      data.worktrees[name] = entry;
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
    }
    return entry.ports;
  });
}

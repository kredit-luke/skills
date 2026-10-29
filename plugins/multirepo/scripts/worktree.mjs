#!/usr/bin/env node
/**
 * worktree.mjs: isolated per-ticket workspaces for multi-repo work.
 *
 *   create --name <name> [--repos a,b] [--branch <b>] [--ticket <id>] [--tracker <kind>]
 *          [--native] [--root <workspace>] [--no-install] [--json]
 *   list   [--root <workspace>] [--json] [--no-fetch] [--no-pr]
 *   remove --name <name> [--force] [--delete-remote-branches] [--root <workspace>] [--json]
 *   sync   [--path <worktree>] [--json]
 *
 * A worktree is <workspace>/<worktrees.dir>/<name>/ (default dir "worktrees"), holding
 * the chosen repos at their repos.json relativePath (nested ones like services/api
 * too), each on the ticket branch, plus a copy of the workspace's Claude config and
 * a .worktree.json:
 *   { name, ticketId, tracker, branch, repos: [relativePath...], created, sourceWorkspace }
 * Older files with `linearId` (and `mode`) are read as ticketId + tracker "linear".
 *
 * Repos are put there either as independent clones (default; the clone's origin is
 * the main checkout's origin) or, with --native, as `git worktree add` checkouts of
 * the main repos (fast, shared objects; the branch can't be checked out in main too).
 *
 * Ports: when .claude/dashboard/workspace.json has worktrees.ports { base, slotSize },
 * create gives the worktree a slot in the per-user ports file (worktrees.portsFile)
 * exactly as the Natterjack dashboard does, so both can share the file:
 *   { worktrees: { <name>: { slot, workspace, ports: { <appId>: port } } } }
 *   port = base + slot * slotSize + slotOffset   (apps.json slotOffset, else the
 *   app's 1-based position in apps.json; mainOnly apps get none), lowest free slot,
 *   written while holding <portsFile>.lock (created exclusively, broken after 10s).
 * Without worktrees.ports nothing is allocated. remove frees the slot.
 *
 * Config copied into a worktree (create, and again by sync): CLAUDE.md, AGENTS.md,
 * repos.json, .mcp.json, .claude/settings.json, .claude/settings.local.json, plus
 * workspace.json worktrees.copy (extra relative files or folders). .claude/skills and
 * .claude/agents are never copied: Claude Code finds them walking up the tree, so a
 * copy only duplicates them. Settings are copied because Claude Code reads them from
 * one project root and doesn't merge an ancestor's.
 *
 * git runs through execFileSync/spawn with argument arrays (no shell).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  defaultBranch, expandHome, findRoot, findTicket, git, gitRun, isMain, isRepoTop, listRepos,
  normalizeRepo, parseArgs, readJson, readReposJson, readWorkspaceConfig, readWorktreeMeta, slash,
} from "./lib.mjs";

export const NAME_RE = /^[A-Za-z0-9_.-]+$/;
export const BASE_COPY = ["CLAUDE.md", "AGENTS.md", "repos.json", ".mcp.json", ".claude/settings.json", ".claude/settings.local.json"];
const NEVER_COPY = [".claude/skills", ".claude/agents"];
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_DELETE_WAIT_MS = 500; // Windows EPERM/EACCES/EBUSY while another writer deletes its lock

// ------------------------------------------------------------------ small helpers

const hasGit = (dir) => fs.existsSync(path.join(dir, ".git"));
const caseless = process.platform === "win32" || process.platform === "darwin";
const realOr = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};
export function samePath(a, b) {
  const norm = (p) => realOr(p).replace(/[\\/]+$/, "");
  return caseless ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
const isInside = (child, parent) => {
  const rel = path.relative(realOr(parent), realOr(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
const firstLine = (s) => String(s || "").split("\n")[0].trim();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const relPath = (root, rel) => path.join(root, String(rel).replace(/[\\/]+/g, path.sep));

/**
 * A workspace-relative path that stays strictly inside it, normalized ("./a/b/" →
 * "a/b"), or null for anything that isn't: "", ".", "./", "/x", "C:\x", "../x",
 * "a/../b". The workspace root itself is never a valid entry.
 */
export function normalizeRel(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  const s = slash(p.trim());
  if (path.isAbsolute(p) || s.startsWith("/") || /^[A-Za-z]:/.test(s)) return null;
  if (s.split("/").some((x) => x === "..")) return null;
  const n = path.posix.normalize(s).replace(/\/+$/, "");
  return n === "" || n === "." ? null : n;
}

const isNeverCopy = (rel) => NEVER_COPY.some((n) => rel === n || rel.startsWith(n + "/"));
/** A path with a .git segment (a repo's metadata): never copied over or deleted. */
export const isGitPath = (rel) => slash(rel).split("/").some((x) => x.toLowerCase() === ".git");
const NOT_RELATIVE = "not a relative path inside the workspace";
const GIT_PATH = "a .git path (repo metadata is never copied)";

/**
 * worktrees settings from workspace.json, resolved: { dir, portsFile, ports, copy,
 * copyRejected } (copyRejected: [{ path, reason }] for worktrees.copy entries that aren't
 * safe relative paths or that name a .git path).
 */
export function worktreeSettings(root, config = readWorkspaceConfig(root)) {
  const wt = config.worktrees || {};
  const str = (v, d) => (typeof v === "string" && v.trim() ? v : d);
  const base = Number(wt.ports && wt.ports.base);
  const slotSize = Number(wt.ports && wt.ports.slotSize);
  const ports = Number.isInteger(base) && base > 0 && Number.isInteger(slotSize) && slotSize > 0 && base + slotSize < 65535
    ? { base, slotSize } : null;
  const copy = [];
  const copyRejected = [];
  for (const p of Array.isArray(wt.copy) ? wt.copy : []) {
    const n = normalizeRel(p);
    if (!n) copyRejected.push({ path: String(p), reason: NOT_RELATIVE });
    else if (isGitPath(n)) copyRejected.push({ path: n, reason: GIT_PATH });
    else if (!isNeverCopy(n) && !copy.includes(n)) copy.push(n);
  }
  return {
    dir: path.resolve(root, str(wt.dir, "worktrees")),
    portsFile: path.resolve(expandHome(str(wt.portsFile, "~/.agentic-workspace-ports.json"))),
    ports,
    copy,
    copyRejected,
  };
}

/** .worktree.json with legacy fields read: linearId → ticketId, tracker "linear". */
export function normalizeMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ticketId = raw.ticketId || raw.linearId || null;
  const tracker = raw.tracker || (raw.linearId ? "linear" : null);
  return { ...raw, ticketId, tracker };
}

/** Writes (or refreshes) .worktree.json; `created` is kept from an earlier one. */
export function writeMeta(wtPath, fields) {
  const file = path.join(wtPath, ".worktree.json");
  const previous = readJson(file) || {};
  const { linearId, mode, ...rest } = previous; // superseded by ticketId/tracker
  const meta = {
    ...rest,
    name: fields.name ?? previous.name ?? path.basename(wtPath),
    ticketId: fields.ticketId ?? null,
    tracker: fields.tracker ?? null,
    branch: fields.branch ?? null,
    repos: fields.repos ?? previous.repos ?? [],
    created: previous.created || new Date().toISOString(),
    sourceWorkspace: fields.sourceWorkspace ?? previous.sourceWorkspace ?? null,
  };
  writeJson(file, meta);
  return meta;
}

// ------------------------------------------------------------------ config copy

/**
 * Whether dir holds no git-tracked files: true when `git ls-files` there lists
 * nothing, or when dir isn't inside any git work tree at all (nothing can be
 * tracked). Any other git failure → false (keep the folder).
 */
export function hasNoTrackedFiles(dir) {
  const inside = gitRun(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return /not a git repository/i.test(inside.err);
  if (inside.out !== "true") return false; // e.g. inside a .git dir
  const r = gitRun(dir, ["ls-files", "--", "."]);
  return r.ok && r.out === "";
}

/** Whether dir (or anything under it) has a .git entry, i.e. holds a checkout. */
function containsGitDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.name.toLowerCase() === ".git") return true;
    if (e.isDirectory() && !e.isSymbolicLink() && containsGitDir(path.join(dir, e.name))) return true;
  }
  return false;
}

/**
 * Checkouts in a worktree that config copies must never touch: the given repo
 * paths, the repos in its .worktree.json, and the worktree itself when it is a repo.
 * Each: { path, root } (root: the worktree folder itself).
 */
function protectedRepos(target, repoPaths = []) {
  const out = [];
  const add = (p) => { if (p && !out.some((x) => samePath(x.path, p))) out.push({ path: path.resolve(p), root: samePath(p, target) }); };
  for (const p of repoPaths) add(p);
  const meta = normalizeMeta(readWorktreeMeta(target));
  for (const r of Array.isArray(meta?.repos) ? meta.repos.map(normalizeRepo) : []) {
    add(r.relativePath === "." || r.relativePath === "" ? target : relPath(target, r.relativePath));
  }
  if (hasGit(target)) add(target);
  return out;
}

/**
 * Why copying to dst must be skipped, or null. Never: a .git path; a destination that
 * is, contains or sits inside one of the worktree's checkouts (a repo at the worktree
 * root only counts when it would be replaced whole); a folder holding git-tracked files
 * or a nested .git (replacing it would delete them).
 */
function unsafeDestination(rel, dst, srcIsDir, repos) {
  if (isGitPath(rel)) return GIT_PATH;
  for (const r of repos) {
    if (samePath(dst, r.path) || isInside(r.path, dst)) return "it is or contains a repo checkout in the worktree";
    if (!r.root && isInside(dst, r.path)) return "it is inside a repo checkout in the worktree";
  }
  if (srcIsDir && fs.existsSync(dst)) {
    if (!fs.statSync(dst).isDirectory()) return "the destination is a file, not a folder";
    if (containsGitDir(dst)) return "the destination holds a git checkout";
    if (!hasNoTrackedFiles(dst)) return "the destination holds git-tracked files";
  }
  return null;
}

/**
 * Copies the config list from source into target (files and folders; a folder is
 * replaced so deletions carry over) and deletes stale .claude/skills|agents copies.
 * Entries that aren't safe relative paths, that would resolve to (or contain) the
 * target root, or whose destination would overwrite a checkout (see
 * unsafeDestination) are skipped and returned in `skipped` with a reason. repoPaths:
 * the worktree's checkouts (absolute), on top of those in its .worktree.json. A stale
 * skills/agents folder holding git-tracked files (a single-repo worktree's own project
 * files) is kept and returned in `kept`.
 */
export function copyConfig(source, target, extra = [], repoPaths = []) {
  const repos = protectedRepos(target, repoPaths);
  const copied = [];
  const removed = [];
  const skipped = [];
  const kept = [];
  for (const raw of [...BASE_COPY, ...extra]) {
    const rel = normalizeRel(raw);
    if (!rel) { skipped.push({ path: String(raw), reason: NOT_RELATIVE }); continue; }
    const src = relPath(source, rel);
    const dst = relPath(target, rel);
    const lexical = path.relative(path.resolve(target), path.resolve(dst));
    if (!lexical || lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical) || samePath(dst, target)) {
      skipped.push({ path: rel, reason: "resolves to the worktree root or outside it" });
      continue;
    }
    if (!fs.existsSync(src)) continue;
    const srcIsDir = fs.statSync(src).isDirectory();
    const unsafe = unsafeDestination(rel, dst, srcIsDir, repos);
    if (unsafe) { skipped.push({ path: rel, reason: unsafe }); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (srcIsDir) {
      fs.rmSync(dst, { recursive: true, force: true, maxRetries: 3 });
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
    copied.push(rel);
  }
  for (const rel of NEVER_COPY) {
    const stale = relPath(target, rel);
    if (!fs.existsSync(stale)) continue;
    if (!hasNoTrackedFiles(stale)) { kept.push(rel); continue; }
    fs.rmSync(stale, { recursive: true, force: true, maxRetries: 3 });
    removed.push(rel);
  }
  return { copied, removed, skipped, kept };
}

// ------------------------------------------------------------------ ports

/** Runs fn holding `<file>.lock`: created exclusively, broken when older than 10s. */
export function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  let deletingSince = 0;
  while (fd === null) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch (e) {
      // On Windows, opening a lock another writer is deleting fails with EPERM (or EACCES, EBUSY): wait it out
      // too, but only briefly; one that lasts is a real permission error, so it's rethrown.
      const deleting = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(e.code);
      if (e.code !== "EEXIST" && !deleting) throw e;
      deletingSince = deleting ? deletingSince || Date.now() : 0;
      if (deleting && Date.now() - deletingSince > LOCK_DELETE_WAIT_MS) throw e;
      if (!deleting) try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}${deleting ? ` (last error: ${e.code})` : ""}`);
      sleep(25);
    }
  }
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

/**
 * apps.json's apps as the dashboard reads them (entries it would drop are dropped
 * here too, so positions match): { <id>: { mainOnly, slotOffset } } in file order.
 */
export function readApps(root) {
  const raw = readJson(path.join(root, ".claude", "dashboard", "apps.json")) || {};
  const SAFE_KEY = /^[A-Za-z][\w-]{0,63}$/;
  const dirOk = (d) => typeof d === "string" && /^[\w.-]+(\/[\w.-]+)*$/.test(d) && !d.split("/").some((s) => /^\.+$/.test(s));
  const out = {};
  for (const [key, a] of Object.entries(raw.apps || {})) {
    if (!SAFE_KEY.test(key) || !a || typeof a.name !== "string" || !dirOk(a.dir)) continue;
    const launch = a.launch && typeof a.launch === "object" ? a.launch : {};
    if (typeof launch.launcher !== "string" && typeof launch.cmd !== "string") continue;
    out[key] = {
      mainOnly: a.mainOnly === true,
      slotOffset: Number.isInteger(a.slotOffset) && a.slotOffset >= 0 ? a.slotOffset : null,
    };
  }
  return out;
}

/** Each app's offset in a slot: its slotOffset, else its 1-based position; mainOnly apps none. */
export function slotOffsets(apps) {
  const out = {};
  Object.entries(apps).forEach(([key, app], i) => {
    if (app.mainOnly) return;
    out[key] = Number.isInteger(app.slotOffset) && app.slotOffset >= 0 ? app.slotOffset : i + 1;
  });
  return out;
}

/** Ports file contents with older layouts read: `allocations.<name>` groups flattened into worktrees. */
function readPorts(file) {
  const data = readJson(file) || {};
  if (!data.worktrees || typeof data.worktrees !== "object") data.worktrees = {};
  for (const [name, alloc] of Object.entries(data.allocations || {})) {
    if (data.worktrees[name] || !alloc) continue;
    const ports = {};
    const rest = {};
    for (const [k, v] of Object.entries(alloc)) {
      if (k === "ports" || (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(Number.isInteger))) Object.assign(ports, v);
      else rest[k] = v;
    }
    data.worktrees[name] = { ...rest, ports };
  }
  delete data.allocations;
  return data;
}

function writePorts(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}

const entryPath = (name, entry, wtDir) => (entry && entry.workspace ? entry.workspace : path.join(wtDir, name));

/**
 * Gives the worktree at wtPath a port slot (the dashboard's ensureSlot): reuses its
 * entry, else the lowest slot no entry uses; fills in apps missing from an entry.
 * Returns { name, slot, ports, collisions } (collisions: other entries sharing a port).
 */
export function allocatePorts({ portsFile, rule, apps, wtPath, name, wtDir }) {
  return withFileLock(portsFile, () => {
    const data = readPorts(portsFile);
    const offsets = slotOffsets(apps);
    const hitName = Object.keys(data.worktrees).find((n) => samePath(entryPath(n, data.worktrees[n], wtDir), wtPath));
    let key = hitName || name;
    if (!hitName) for (let i = 2; data.worktrees[key]; i++) key = `${name}-${i}`;
    const prev = hitName ? data.worktrees[hitName] : null;
    let slot = prev && Number.isInteger(prev.slot) && prev.slot > 0 ? prev.slot : 0;
    if (!slot) {
      const used = new Set(Object.values(data.worktrees).map((e) => e && e.slot));
      slot = 1;
      while (used.has(slot)) slot++;
    }
    const entry = { ...(prev || {}), slot, workspace: wtPath, ports: { ...((prev && prev.ports) || {}) } };
    for (const [app, offset] of Object.entries(offsets)) {
      if (!entry.ports[app]) entry.ports[app] = rule.base + slot * rule.slotSize + offset;
    }
    if (!entry.allocatedAt) entry.allocatedAt = new Date().toISOString();
    data.worktrees[key] = entry;
    writePorts(portsFile, data);

    const mine = new Set(Object.values(entry.ports));
    const collisions = [];
    for (const [other, e] of Object.entries(data.worktrees)) {
      if (other === key) continue;
      const overlap = Object.values((e && e.ports) || {}).filter((p) => mine.has(p));
      if (overlap.length) collisions.push({ worktree: other, slot: e.slot, overlap });
    }
    return { name: key, slot, ports: entry.ports, collisions };
  });
}

/** Removes the ports-file entries for a worktree (by path, or by name). Returns the names freed. */
export function releasePorts({ portsFile, wtPath, name, wtDir }) {
  if (!fs.existsSync(portsFile)) return [];
  return withFileLock(portsFile, () => {
    const data = readPorts(portsFile);
    const freed = Object.keys(data.worktrees).filter((n) =>
      samePath(entryPath(n, data.worktrees[n], wtDir), wtPath) || (n === name && !data.worktrees[n]?.workspace));
    if (!freed.length) return [];
    for (const n of freed) delete data.worktrees[n];
    writePorts(portsFile, data);
    return freed;
  });
}

// ------------------------------------------------------------------ create

function cloneUrl(mainRepo, repo) {
  if (hasGit(mainRepo)) {
    const url = git(mainRepo, ["remote", "get-url", "origin"]);
    if (!url) return mainRepo;
    const isUrl = /^[\w+.-]+:\/\//.test(url) || /^[^/\\]+@[^:/\\]+:/.test(url);
    return isUrl || path.isAbsolute(url) ? url : path.resolve(mainRepo, url);
  }
  return repo.remote || null;
}

const refExists = (repo, ref) => gitRun(repo, ["rev-parse", "--verify", "--quiet", ref]).ok;

function must(r, what) {
  if (!r.ok) throw new Error(`${what}: ${firstLine(r.err) || "failed"}`);
  return r;
}

function cloneRepo(mainRepo, repo, dst, branch) {
  const url = cloneUrl(mainRepo, repo);
  if (!url) throw new Error("not cloned in the main workspace and repos.json has no remote for it");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  must(gitRun(path.dirname(dst), ["clone", "--quiet", url, dst], { timeout: 600000 }), "git clone");
  const base = defaultBranch(dst, repo.defaultBranch);
  if (branch) {
    if (refExists(dst, `refs/remotes/origin/${branch}`)) {
      must(gitRun(dst, ["switch", "--quiet", branch]), `git switch ${branch}`);
    } else {
      const start = refExists(dst, `refs/remotes/origin/${base}`) ? [`origin/${base}`] : [];
      must(gitRun(dst, ["switch", "--quiet", "--no-track", "-c", branch, ...start]), `git switch -c ${branch}`);
    }
  } else if (git(dst, ["branch", "--show-current"]) !== base) {
    // Ad hoc (no --branch): the default branch, even when origin's HEAD points elsewhere.
    if (refExists(dst, `refs/heads/${base}`)) must(gitRun(dst, ["switch", "--quiet", base]), `git switch ${base}`);
    else if (refExists(dst, `refs/remotes/origin/${base}`)) {
      must(gitRun(dst, ["switch", "--quiet", "--track", "-c", base, `origin/${base}`]), `git switch -c ${base}`);
    }
  }
  return { base };
}

function nativeRepo(mainRepo, repo, dst, branch) {
  if (!hasGit(mainRepo)) throw new Error("not cloned in the main workspace (native mode adds a worktree of it)");
  if (!branch) throw new Error("native mode needs --branch (main already has the default branch checked out)");
  gitRun(mainRepo, ["fetch", "--quiet", "origin"], { timeout: 120000 }); // offline is fine
  const base = defaultBranch(mainRepo, repo.defaultBranch);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let args;
  if (refExists(mainRepo, `refs/heads/${branch}`)) args = ["worktree", "add", dst, branch];
  else if (refExists(mainRepo, `refs/remotes/origin/${branch}`)) args = ["worktree", "add", "--track", "-b", branch, dst, `origin/${branch}`];
  else {
    const start = refExists(mainRepo, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;
    args = ["worktree", "add", "--no-track", "-b", branch, dst, start];
  }
  const r = gitRun(mainRepo, args, { timeout: 300000 });
  if (!r.ok) {
    const msg = firstLine(r.err.split("\n").find((l) => /fatal|error/i.test(l)) || r.err);
    throw new Error(`git worktree add: ${msg}${/already (checked out|used by worktree)/i.test(r.err) ? " (switch main off that branch first)" : ""}`);
  }
  return { base };
}

function runNpm(cwd, args) {
  // npm is npm.cmd on Windows, which needs a shell; the arguments are fixed words.
  const opts = { cwd, stdio: ["ignore", 2, 2] };
  const r = process.platform === "win32"
    ? spawnSync(`npm ${args.join(" ")}`, { ...opts, shell: true })
    : spawnSync("npm", args, opts);
  if (r.error) return r.error.message;
  return r.status === 0 ? null : `npm ${args.join(" ")} exited ${r.status}`;
}

/** Repos picked by name or relativePath; throws naming the valid ones on an unknown one. */
export function pickRepos(root, wanted) {
  const all = listRepos(root);
  const out = [];
  const unknown = [];
  for (const w of wanted) {
    const key = slash(w).replace(/\/+$/, "");
    const hit = all.find((r) => r.name === key || r.relativePath === key) ||
      all.find((r) => r.name.toLowerCase() === key.toLowerCase() || r.relativePath.toLowerCase() === key.toLowerCase());
    if (!hit) unknown.push(w);
    else if (!out.includes(hit)) out.push(hit);
  }
  if (unknown.length) {
    throw new Error(`Unknown repo(s): ${unknown.join(", ")}. Valid: ${all.map((r) => r.name === r.relativePath ? r.name : `${r.name} (${r.relativePath})`).join(", ") || "(none found)"}`);
  }
  return out;
}

/**
 * Creates the worktree. Returns { name, path, branch, ticketId, tracker, native,
 * repos: [{ name, relativePath, base }], failures, copied, ports, installs }.
 */
export function createWorktree(opts, log = () => {}) {
  const root = path.resolve(opts.root || findRoot(process.cwd()));
  const name = opts.name;
  if (!name || name === true) throw new Error("--name is required");
  if (!NAME_RE.test(name) || /^\.+$/.test(name)) throw new Error(`Invalid name '${name}': use letters, digits, _ . -`);
  if (fs.existsSync(path.join(root, ".worktree.json"))) {
    const src = normalizeMeta(readWorktreeMeta(root))?.sourceWorkspace;
    throw new Error(`${slash(root)} is a worktree; create worktrees from the main workspace${src ? ` (--root ${slash(src)})` : ""}`);
  }
  const config = readWorkspaceConfig(root);
  const settings = worktreeSettings(root, config);
  const wtPath = path.join(settings.dir, name);
  if (fs.existsSync(wtPath)) throw new Error(`Worktree '${name}' already exists at ${slash(wtPath)}`);

  const wanted = typeof opts.repos === "string" ? opts.repos.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (!wanted.length) throw new Error("--repos is required (comma-separated repo names or relativePaths)");
  const repos = pickRepos(root, wanted);
  const branch = typeof opts.branch === "string" ? opts.branch : null;
  const native = opts.native === true;

  // A repo at "." (the workspace is itself the repo) becomes the worktree folder itself.
  const rootRepo = repos.find((r) => r.relativePath === "." || r.relativePath === "");
  if (!rootRepo) fs.mkdirSync(wtPath, { recursive: true });

  const done = [];
  const failures = [];
  for (const repo of rootRepo ? [rootRepo, ...repos.filter((r) => r !== rootRepo)] : repos) {
    const isRoot = repo === rootRepo;
    const dst = isRoot ? wtPath : relPath(wtPath, repo.relativePath);
    const mainRepo = isRoot ? root : repo.path;
    log(`${native ? "Adding worktree of" : "Cloning"} ${repo.name} → ${slash(path.relative(root, dst))}`);
    try {
      const { base } = (native ? nativeRepo : cloneRepo)(mainRepo, repo, dst, branch);
      done.push({ name: repo.name, relativePath: isRoot ? "." : repo.relativePath, base, path: slash(dst) });
    } catch (e) {
      log(`  failed: ${e.message}`);
      failures.push({ repo: repo.name, step: native ? "worktree add" : "clone", error: e.message });
      if (isRoot) break;
    }
  }
  if (!done.length) {
    fs.rmSync(wtPath, { recursive: true, force: true, maxRetries: 3 });
    const err = new Error(`No repo could be set up: ${failures.map((f) => `${f.repo}: ${f.error}`).join("; ")}`);
    err.failures = failures;
    throw err;
  }

  const { copied, skipped, kept } = copyConfig(root, wtPath, settings.copy, done.map((d) => relPath(wtPath, d.relativePath)));
  const copySkipped = [...settings.copyRejected, ...skipped];
  for (const s of copySkipped) log(`warning: worktrees.copy entry '${s.path}' skipped (${s.reason})`);
  if (rootRepo && done.some((d) => d.relativePath === ".")) excludeFromRepo(wtPath, [...copied, ".worktree.json"]);

  const ticketId = (typeof opts.ticket === "string" && opts.ticket) || findTicket([name, branch], config);
  const kind = config.issues && config.issues.kind;
  const tracker = ticketId ? (typeof opts.tracker === "string" && opts.tracker) || (kind && kind !== "none" ? kind : null) : null;
  const meta = writeMeta(wtPath, {
    name, ticketId: ticketId || null, tracker, branch, repos: done.map((d) => d.relativePath), sourceWorkspace: slash(root),
  });

  const installs = [];
  if (opts.install !== false) {
    for (const d of done) {
      const dir = relPath(wtPath, d.relativePath);
      if (!fs.existsSync(path.join(dir, "package.json"))) continue;
      const args = fs.existsSync(path.join(dir, "package-lock.json")) ? ["ci"] : ["install"];
      log(`npm ${args[0]} in ${d.relativePath}`);
      const error = runNpm(dir, args);
      installs.push({ repo: d.name, command: `npm ${args[0]}`, ok: !error, error });
      if (error) failures.push({ repo: d.name, step: `npm ${args[0]}`, error });
    }
  }

  let ports = null;
  if (settings.ports) {
    try {
      ports = { file: slash(settings.portsFile), ...allocatePorts({
        portsFile: settings.portsFile, rule: settings.ports, apps: readApps(root), wtPath, name, wtDir: settings.dir,
      }) };
    } catch (e) {
      failures.push({ repo: null, step: "ports", error: e.message });
    }
  }

  return {
    name, path: slash(wtPath), branch, ticketId: meta.ticketId, tracker: meta.tracker, native,
    repos: done, failures, copied, copySkipped, kept, installs, ports, portsConfigured: !!settings.ports, created: meta.created,
  };
}

function excludeFromRepo(repoPath, entries) {
  // The file git actually reads: in a linked worktree, the shared repo's info/exclude.
  const rel = git(repoPath, ["rev-parse", "--git-path", "info/exclude"]);
  if (!rel) return;
  const file = path.resolve(repoPath, rel);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let body = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    const have = new Set(body.split(/\r?\n/).map((l) => l.trim()));
    const add = entries.map((e) => `/${slash(e)}`).filter((e) => !have.has(e));
    if (add.length) fs.writeFileSync(file, (body && !body.endsWith("\n") ? body + "\n" : body) + add.join("\n") + "\n");
  } catch { /* best effort */ }
}

// ------------------------------------------------------------------ discovery

/** `git worktree list --porcelain` → linked worktrees (not the repo's own checkout). */
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) out.push((cur = { path: path.resolve(line.slice(9)), branch: null, bare: false, prunable: false }));
    else if (!cur) continue;
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare") cur.bare = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  return out;
}

/**
 * The worktrees of a main workspace, without git status: every folder under
 * worktrees.dir (with or without .worktree.json), plus native git worktrees of the
 * main repos, grouped into the workspace folder they mirror (<ws>/<relativePath>).
 * Each: { name, path, hasMetadata, metadata, source, repos: [{ rel, path, native, mainRepo }] }.
 */
export function discoverWorktrees(root, settings = worktreeSettings(root)) {
  const entries = [];
  const find = (p) => entries.find((e) => samePath(e.path, p));
  const ensure = (p, source) => {
    let e = find(p);
    if (!e) {
      const meta = normalizeMeta(readJson(path.join(p, ".worktree.json")));
      e = { name: path.basename(p), path: p, hasMetadata: !!meta, metadata: meta, source, repos: [] };
      entries.push(e);
    }
    return e;
  };

  try {
    for (const d of fs.readdirSync(settings.dir, { withFileTypes: true })) {
      if (d.isDirectory()) ensure(path.join(settings.dir, d.name), "folder");
    }
  } catch { /* no worktrees dir */ }

  for (const e of entries) {
    if (e.metadata && Array.isArray(e.metadata.repos)) {
      for (const r of e.metadata.repos.map(normalizeRepo)) {
        const p = r.relativePath === "." ? e.path : relPath(e.path, r.relativePath);
        e.repos.push({ rel: r.relativePath, path: p, native: fs.existsSync(path.join(p, ".git")) && fs.statSync(path.join(p, ".git")).isFile(), mainRepo: null });
      }
    }
  }

  for (const repo of listRepos(root)) {
    if (!hasGit(repo.path)) continue;
    const r = gitRun(repo.path, ["worktree", "list", "--porcelain"], { timeout: 10000 });
    if (!r.ok) continue;
    for (const wt of parseWorktreeList(r.out).slice(1)) {
      if (wt.bare || wt.prunable || !fs.existsSync(wt.path) || samePath(wt.path, repo.path)) continue;
      let wsPath = null;
      if (repo.relativePath === ".") wsPath = wt.path;
      else {
        const parts = repo.relativePath.split("/");
        const candidate = path.resolve(wt.path, ...parts.map(() => ".."));
        const tail = slash(path.relative(candidate, wt.path));
        if (caseless ? tail.toLowerCase() === repo.relativePath.toLowerCase() : tail === repo.relativePath) wsPath = candidate;
        else if (isInside(wt.path, settings.dir) && !samePath(wt.path, settings.dir)) {
          wsPath = path.join(settings.dir, path.relative(realOr(settings.dir), realOr(wt.path)).split(path.sep)[0]);
        }
      }
      if (!wsPath || samePath(wsPath, root)) continue;
      const e = ensure(wsPath, "git");
      const existing = e.repos.find((x) => samePath(x.path, wt.path));
      if (existing) { existing.native = true; existing.mainRepo = repo.path; }
      else e.repos.push({ rel: slash(path.relative(wsPath, wt.path)) || ".", path: wt.path, native: true, mainRepo: repo.path });
    }
  }
  return entries;
}

// ------------------------------------------------------------------ status

/** origin/<base>, else <base>, else null. */
function mainRefOf(repoPath, base) {
  for (const ref of [`origin/${base}`, base]) if (refExists(repoPath, ref)) return ref;
  return null;
}

function spawnQuiet(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

/** origin's URL → { host, owner, name } (host lower-cased), or null for a path or anything else. */
export function parseRemoteUrl(url) {
  const m = String(url || "").trim().match(/^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m || /^[A-Za-z]$/.test(m[1])) return null; // a drive-letter path
  return { host: m[1].toLowerCase(), owner: m[2], name: m[3] };
}

const isGitHubDotCom = (host) => host === "github.com" || host === "ssh.github.com";

/**
 * gh's --repo value for origin's URL, or null to run gh in the repo folder instead
 * (it then resolves the remote itself, SSH host aliases like git@github-work:o/r
 * included). github.com (and ssh.github.com, its SSH-over-443 host) → "owner/name";
 * a host gh is logged in to (loggedInHosts, from `gh auth status`) → "host/owner/name";
 * any other host → null.
 */
export function ghRepoFromUrl(url, loggedInHosts = []) {
  const r = parseRemoteUrl(url);
  if (!r) return null;
  if (isGitHubDotCom(r.host)) return `${r.owner}/${r.name}`;
  return loggedInHosts.some((h) => String(h).toLowerCase() === r.host) ? `${r.host}/${r.owner}/${r.name}` : null;
}

/** Hosts `gh auth status` reports logged in ("Logged in to <host> ..."). */
export function parseGhAuthHosts(text) {
  const hosts = [];
  for (const m of String(text || "").matchAll(/Logged in to (\S+)/g)) {
    const h = m[1].toLowerCase();
    if (!hosts.includes(h)) hosts.push(h);
  }
  return hosts;
}

let ghHostsPromise = null;
/** gh's logged-in hosts, asked once per process ([] when gh is missing or fails). */
function ghLoggedInHosts(timeoutMs = 8000) {
  if (!ghHostsPromise) {
    ghHostsPromise = new Promise((resolve) => {
      let out = "";
      let child;
      try {
        child = spawn("gh", ["auth", "status"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch {
        resolve([]);
        return;
      }
      // Older gh prints to stderr; it exits non-zero when any host's token is bad.
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => { child.kill(); resolve(parseGhAuthHosts(out)); }, timeoutMs);
      child.on("close", () => { clearTimeout(timer); resolve(parseGhAuthHosts(out)); });
      child.on("error", () => { clearTimeout(timer); resolve([]); });
    });
  }
  return ghHostsPromise;
}

/** Merged PRs for a head branch per gh ([{ number, baseRefName, headRefOid, mergedAt }]), or null (no gh, offline). */
async function ghMergedPrs(repoPath, branch, timeoutMs = 8000) {
  const url = git(repoPath, ["remote", "get-url", "origin"]);
  const parsed = parseRemoteUrl(url);
  const repo = ghRepoFromUrl(url, parsed && !isGitHubDotCom(parsed.host) ? await ghLoggedInHosts() : []);
  // No --repo: gh runs in the repo folder (cwd) and resolves its remotes itself.
  const args = ["pr", "list", ...(repo ? ["--repo", repo] : []), "--head", branch, "--state", "merged",
    "--json", "number,baseRefName,headRefOid,mergedAt", "--limit", "20"];
  const out = await spawnQuiet("gh", args, repoPath, timeoutMs);
  if (out === null) return null;
  try {
    const arr = JSON.parse(out.trim() || "[]");
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * Whether a merged PR proves the local HEAD landed. Only PRs into defaultBranch
 * count, newest first; one proves it when its headRefOid is HEAD or HEAD is an
 * ancestor of it. When HEAD instead has commits beyond a merged PR's head, that's
 * "stale": prMerged false, prMergedStale true, prAheadBy = those commits.
 *   isAncestor(a, b): a is an ancestor of b (false when either isn't available).
 *   countAhead(oid):  commits in HEAD not in oid (optional).
 * Returns { prMerged, prNumber, prMergedStale, prAheadBy }.
 */
export function decidePrMerged(prs, { defaultBranch: base, headOid, isAncestor, countAhead = () => null }) {
  const none = { prMerged: false, prNumber: null, prMergedStale: false, prAheadBy: null };
  if (!Array.isArray(prs) || !headOid) return none;
  const candidates = prs
    .filter((p) => p && p.baseRefName === base && typeof p.headRefOid === "string" && p.headRefOid)
    .sort((a, b) => String(b.mergedAt || "").localeCompare(String(a.mergedAt || "")));
  for (const p of candidates) {
    if (p.headRefOid === headOid || isAncestor(headOid, p.headRefOid)) {
      return { prMerged: true, prNumber: p.number ?? null, prMergedStale: false, prAheadBy: 0 };
    }
  }
  for (const p of candidates) {
    if (isAncestor(p.headRefOid, headOid)) {
      return { prMerged: false, prNumber: p.number ?? null, prMergedStale: true, prAheadBy: countAhead(p.headRefOid) };
    }
  }
  return none;
}

/** isAncestor for decidePrMerged in a repo: fetches a missing commit once (may fail: then not proven). */
function repoAncestry(repoPath) {
  const have = (oid) => gitRun(repoPath, ["cat-file", "-e", `${oid}^{commit}`]).ok;
  const ensure = (oid) => have(oid) || (gitRun(repoPath, ["fetch", "--quiet", "origin", oid], { timeout: 30000 }).ok && have(oid));
  return {
    isAncestor: (a, b) => ensure(a) && ensure(b) && gitRun(repoPath, ["merge-base", "--is-ancestor", a, b]).ok,
    countAhead: (oid) => {
      const n = parseInt(git(repoPath, ["rev-list", "--count", `${oid}..HEAD`]), 10);
      return Number.isNaN(n) ? null : n;
    },
  };
}

/**
 * One repo's state. merged / treesIdentical / allPatchesOnMain / squashMergedByGrep
 * are the merge-detection ladder (prMerged is filled in by gatherWorktrees).
 */
export function collectRepoStatus(repoPath, { base, ticketId = null } = {}) {
  const info = {
    branch: "unknown", uncommitted: 0, unpushed: null, aheadOfMain: null, behindMain: null,
    base, mainRef: null, merged: null, treesIdentical: false, allPatchesOnMain: false,
    squashMergedByGrep: false, prMerged: null, prNumber: null, prMergedStale: false, prAheadBy: null,
  };
  info.branch = git(repoPath, ["branch", "--show-current"]) || "(detached)";
  const porcelain = git(repoPath, ["status", "--porcelain"]);
  info.uncommitted = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
  const up = gitRun(repoPath, ["rev-list", "--count", "@{u}..HEAD"]);
  info.unpushed = up.ok ? parseInt(up.out, 10) || 0 : null;

  const mainRef = mainRefOf(repoPath, base);
  info.mainRef = mainRef;
  if (!mainRef) return info;
  const counts = git(repoPath, ["rev-list", "--left-right", "--count", `${mainRef}...HEAD`]);
  const [behind, ahead] = counts.split(/\s+/).map((n) => parseInt(n, 10));
  info.behindMain = Number.isNaN(behind) ? null : behind;
  info.aheadOfMain = Number.isNaN(ahead) ? null : ahead;
  info.merged = gitRun(repoPath, ["merge-base", "--is-ancestor", "HEAD", mainRef]).ok;
  // Squash merged with nothing since: the trees match.
  info.treesIdentical = gitRun(repoPath, ["diff", "--quiet", mainRef, "HEAD"]).ok;
  // Squash merged, main moved on: every branch commit's patch is on main (`git cherry` "-").
  if (info.aheadOfMain > 0 && !info.merged) {
    const lines = git(repoPath, ["cherry", mainRef, "HEAD"]).split("\n").filter(Boolean);
    info.allPatchesOnMain = lines.length > 0 && lines.every((l) => l.startsWith("- "));
  }
  // Last resort: main's log mentions the ticket (squash merges inherit the PR title).
  if (ticketId && info.aheadOfMain > 0 && !info.merged && !info.allPatchesOnMain) {
    info.squashMergedByGrep = git(repoPath, ["log", mainRef, "--fixed-strings", `--grep=${ticketId}`, "--oneline", "-n", "1"]).length > 0;
  }
  return info;
}

/** discoverWorktrees + per-repo status, after a parallel fetch; gh only where git is inconclusive. */
export async function gatherWorktrees(root, { fetch = true, pr = true } = {}) {
  const settings = worktreeSettings(root);
  const mainRepos = listRepos(root);
  const baseFor = (rel, repoPath) => {
    const known = mainRepos.find((r) => r.relativePath === rel) || readReposJson(root).find((r) => r.relativePath === rel || r.name === rel);
    return defaultBranch(repoPath, known && known.defaultBranch);
  };
  const entries = discoverWorktrees(root, settings);

  const plan = [];
  for (const e of entries) {
    for (const r of e.repos) {
      const exists = fs.existsSync(path.join(r.path, ".git"));
      plan.push({ e, r, exists, base: exists ? baseFor(r.rel, r.path) : null });
    }
  }

  if (fetch) {
    const seen = new Set();
    const jobs = [];
    for (const p of plan) {
      if (!p.exists || !refExists(p.r.path, `refs/remotes/origin/${p.base}`)) continue;
      const common = realOr(path.resolve(p.r.path, git(p.r.path, ["rev-parse", "--git-common-dir"]) || ".git"));
      const key = `${caseless ? common.toLowerCase() : common}|${p.base}`;
      if (seen.has(key)) continue; // native worktrees of one repo share its refs
      seen.add(key);
      jobs.push(spawnQuiet("git", ["-C", p.r.path, "fetch", "--quiet", "origin", p.base], p.r.path, 8000));
    }
    await Promise.all(jobs);
  }

  const result = entries.map((e) => ({
    name: e.name, path: slash(e.path), hasMetadata: e.hasMetadata, metadata: e.metadata, source: e.source, repos: [],
  }));
  const config = readWorkspaceConfig(root);
  for (const p of plan) {
    const out = result[entries.indexOf(p.e)];
    const base = { repo: p.r.rel, path: slash(p.r.path), native: p.r.native };
    if (!p.exists) { out.repos.push({ ...base, missing: true }); continue; }
    const ticketId = (p.e.metadata && p.e.metadata.ticketId) || findTicket([p.e.name], config);
    out.repos.push({ ...base, missing: false, ...collectRepoStatus(p.r.path, { base: p.base, ticketId }) });
  }

  if (pr) {
    const checks = [];
    for (const wt of result) {
      for (const r of wt.repos) {
        if (r.missing || r.merged || r.treesIdentical || r.allPatchesOnMain) continue;
        if (!r.branch || r.branch === r.base || ["main", "master", "(detached)", "unknown"].includes(r.branch)) continue;
        checks.push(ghMergedPrs(r.path, r.branch).then((prs) => {
          if (prs === null) return; // gh unavailable: stays unknown
          const headOid = git(r.path, ["rev-parse", "HEAD"]);
          Object.assign(r, decidePrMerged(prs, { defaultBranch: r.base, headOid, ...repoAncestry(r.path) }));
        }));
      }
    }
    await Promise.all(checks);
  }
  return result;
}

// ------------------------------------------------------------------ list rendering

export function vsMain(r) {
  const delta = (suffix = "") => {
    const parts = [];
    if (r.aheadOfMain > 0) parts.push(`+${r.aheadOfMain}`);
    if (r.behindMain > 0) parts.push(`-${r.behindMain}`);
    return parts.length ? ` (${parts.join("/")}${suffix})` : "";
  };
  if (r.merged === null) return "unknown";
  if (r.merged) return r.aheadOfMain === 0 && r.behindMain === 0 ? `no commits yet (= ${r.mainRef})` : `merged → ${r.mainRef}`;
  if (r.treesIdentical) return `squash-merged → ${r.mainRef}`;
  if (r.allPatchesOnMain) return `squash-merged → ${r.mainRef}${r.behindMain > 0 ? ` (-${r.behindMain})` : ""}`;
  if (r.prMerged) return `pr-merged → ${r.mainRef} #${r.prNumber}${delta(" since")}`;
  if (r.prMergedStale) return `pr-merged #${r.prNumber}${r.prAheadBy > 0 ? ` (+${r.prAheadBy} since)` : ""}, newer commits not merged`;
  if (r.squashMergedByGrep) return `squash-merged${delta(" since")}`;
  return `not merged${delta()}`;
}

function repoRow(r) {
  if (r.missing) return [r.repo, "(missing)", "", "", ""];
  const local = r.uncommitted > 0 ? `${r.uncommitted} uncommitted` : "clean";
  const remote = r.unpushed === null ? "no upstream" : r.unpushed === 0 ? "in sync" : `${r.unpushed} unpushed`;
  return [r.repo + (r.native ? " (git worktree)" : ""), r.branch, local, remote, vsMain(r)];
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const fmt = (cells) => "│ " + cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join(" │ ") + " │";
  return [line("┌", "┬", "┐"), fmt(headers), line("├", "┼", "┤"), ...rows.map(fmt), line("└", "┴", "┘")].join("\n");
}

export function renderList(worktrees) {
  if (!worktrees.length) return "No worktrees found.";
  const out = [];
  for (const wt of worktrees) {
    out.push("", `Worktree: ${wt.name}`, `  Path:    ${wt.path}`);
    const m = wt.metadata;
    if (!wt.hasMetadata) out.push("  (no .worktree.json)");
    if (m) {
      if (m.created) out.push(`  Created: ${m.created}`);
      if (m.ticketId) out.push(`  Ticket:  ${m.ticketId}${m.tracker ? ` (${m.tracker})` : ""}`);
      if (m.branch) out.push(`  Branch:  ${m.branch}`);
    }
    if (!wt.repos.length) { out.push("  (no repos)"); continue; }
    out.push(renderTable(["Repo", "Branch", "Local", "vs Remote", "vs main"], wt.repos.map(repoRow)).split("\n").map((l) => "  " + l).join("\n"));
  }
  return out.join("\n").replace(/^\n/, "");
}

// ------------------------------------------------------------------ remove

/** Main workspace for list/remove: root itself, or the sourceWorkspace when root is a worktree. */
function mainRoot(root) {
  const meta = normalizeMeta(readWorktreeMeta(root));
  return meta && meta.sourceWorkspace && fs.existsSync(meta.sourceWorkspace) ? path.resolve(meta.sourceWorkspace) : root;
}

/**
 * Git checkouts in a folder without .worktree.json: the given relativePaths (the
 * source workspace's repos.json), plus a scan up to `maxDepth` levels down for
 * folders with a .git entry (skipping node_modules and dot-folders). A folder whose
 * .git git can't read (a broken gitdir link, a corrupt or dubiously owned repo) is
 * included too, so remove inspects it and refuses. Each: { rel, path, native, mainRepo: null }.
 */
export function findCheckouts(dir, relativePaths = [], maxDepth = 3) {
  const out = [];
  const add = (p) => {
    if (out.some((x) => samePath(x.path, p)) || !fs.existsSync(path.join(p, ".git"))) return;
    out.push({ rel: slash(path.relative(dir, p)) || ".", path: p, native: fs.statSync(path.join(p, ".git")).isFile(), mainRepo: null });
  };
  for (const rel of relativePaths) {
    if (rel === "." || rel === "") add(dir);
    else if (normalizeRel(rel)) add(relPath(dir, normalizeRel(rel)));
  }
  const walk = (d, depth) => {
    add(d);
    if (depth >= maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * Uncommitted, unpushed and stashed work per repo ([] = safe). No upstream: commits
 * on no remote count. A checkout git can't read (not the top of its own repo, or a
 * git command fails: broken gitdir, corrupt, dubious ownership) is "uninspectable":
 * nothing proves it's safe.
 */
export function unsavedWork(repos) {
  const out = [];
  for (const r of repos) {
    if (!fs.existsSync(path.join(r.path, ".git"))) continue;
    const fail = (what, res) => out.push({ repo: r.rel, type: "uninspectable", details: `${what}: ${firstLine(res?.err) || "not the top of a git checkout"}` });
    const top = gitRun(r.path, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || !samePath(top.out, r.path)) { fail("git rev-parse", top.ok ? null : top); continue; }
    const status = gitRun(r.path, ["status", "--porcelain"]);
    if (!status.ok) { fail("git status", status); continue; }
    if (status.out) out.push({ repo: r.rel, type: "uncommitted", details: status.out });
    if (gitRun(r.path, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) {
      const up = gitRun(r.path, ["log", "--oneline", "@{u}..HEAD"]);
      const logs = up.ok ? up : gitRun(r.path, ["log", "--oneline", "HEAD", "--not", "--remotes"]);
      if (!logs.ok) fail("git log", logs);
      else if (logs.out) out.push({ repo: r.rel, type: up.ok ? "unpushed" : "unpushed (no upstream)", details: logs.out });
    }
    const stash = gitRun(r.path, ["stash", "list"]);
    if (!stash.ok) fail("git stash list", stash);
    else if (stash.out) out.push({ repo: r.rel, type: "stashed", details: stash.out });
  }
  return out;
}

/**
 * Removes a worktree: refuses on unsaved work unless force; optionally deletes the
 * remote branches; `git worktree remove` + prune for native repos; frees the port
 * slot; deletes the folder (with retries for Windows file locks).
 */
export function removeWorktree(opts, log = () => {}) {
  const root = mainRoot(path.resolve(opts.root || findRoot(process.cwd())));
  const name = opts.name;
  if (!name || name === true) throw new Error("--name is required");
  if (!NAME_RE.test(name) || /^\.+$/.test(name)) throw new Error(`Invalid name '${name}'`);
  const settings = worktreeSettings(root);
  const wtPath = path.join(settings.dir, name);
  const entry = discoverWorktrees(root, settings).find((e) => samePath(e.path, wtPath));
  if (!entry && !fs.existsSync(wtPath)) throw new Error(`Worktree '${name}' not found at ${slash(wtPath)}`);
  const force = opts.force === true;
  const repos = entry ? [...entry.repos] : [];
  if (!entry || !entry.hasMetadata) {
    // No .worktree.json: find the checkouts in the folder ourselves before trusting it's safe.
    for (const found of findCheckouts(wtPath, readReposJson(root).map((r) => r.relativePath))) {
      if (!repos.some((x) => samePath(x.path, found.path))) repos.push(found);
    }
    const inspectable = repos.filter((r) => isRepoTop(r.path));
    let nonEmpty = false;
    try { nonEmpty = fs.readdirSync(wtPath).length > 0; } catch { /* gone */ }
    if (!inspectable.length && nonEmpty && !force) {
      throw new Error(`Worktree '${name}' has no .worktree.json and no git checkout could be inspected in ${slash(wtPath)}: use --force to delete it anyway`);
    }
  }

  const unsaved = unsavedWork(repos);
  if (unsaved.length && !force) {
    const err = new Error(`Worktree '${name}' has unsaved work`);
    err.unsaved = unsaved;
    throw err;
  }

  const remote = [];
  if (opts.deleteRemoteBranches) {
    for (const r of repos) {
      if (!fs.existsSync(path.join(r.path, ".git"))) continue;
      const branch = git(r.path, ["branch", "--show-current"]) || entry?.metadata?.branch;
      const base = defaultBranch(r.path, readReposJson(root).find((x) => x.relativePath === r.rel)?.defaultBranch);
      if (!branch || branch === base || ["main", "master"].includes(branch)) continue;
      if (!refExists(r.path, `refs/remotes/origin/${branch}`)) { remote.push({ repo: r.rel, branch, status: "no remote branch" }); continue; }
      const res = gitRun(r.path, ["push", "origin", "--delete", branch], { timeout: 60000 });
      remote.push({ repo: r.rel, branch, status: res.ok ? "deleted" : `failed: ${firstLine(res.err)}` });
    }
  }

  // Our own cwd inside the folder would lock it on Windows.
  const cwdInside = isInside(process.cwd(), wtPath);
  if (cwdInside) process.chdir(root);

  const nativeResults = [];
  for (const r of repos.filter((x) => x.native)) {
    const common = git(r.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const owner = r.mainRepo || (common && path.basename(common) === ".git" ? path.dirname(common) : null);
    if (!owner) continue;
    const res = gitRun(owner, ["worktree", "remove", ...(force ? ["--force", "--force"] : []), r.path], { timeout: 120000 });
    gitRun(owner, ["worktree", "prune"]);
    r.mainRepo = owner;
    nativeResults.push({ repo: r.rel, ok: res.ok, error: res.ok ? null : firstLine(res.err) });
    if (!res.ok) log(`git worktree remove ${r.rel}: ${firstLine(res.err)}`);
  }
  if (nativeResults.some((n) => !n.ok) && !force) {
    throw new Error(`git worktree remove failed: ${nativeResults.filter((n) => !n.ok).map((n) => `${n.repo}: ${n.error}`).join("; ")}`);
  }

  let portsFreed = [];
  try { portsFreed = releasePorts({ portsFile: settings.portsFile, wtPath, name, wtDir: settings.dir }); } catch (e) { log(`ports: ${e.message}`); }

  let removed = true;
  let error = null;
  try {
    fs.rmSync(wtPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (e) {
    removed = false;
    error = e.message;
  }
  // Prune again: a native worktree whose folder only went away with rmSync.
  for (const r of repos.filter((x) => x.native && x.mainRepo)) gitRun(r.mainRepo, ["worktree", "prune"]);
  return { name, path: slash(wtPath), removed, error, cwdInside, remoteBranches: remote, native: nativeResults, portsFreed };
}

// ------------------------------------------------------------------ sync

/** Recopies the config list from the worktree's sourceWorkspace; deletes stale skills/agents copies. */
export function syncWorktree(opts = {}) {
  const target = path.resolve(opts.path || findRoot(process.cwd()));
  const meta = normalizeMeta(readWorktreeMeta(target));
  if (!meta) throw new Error(`Not a worktree (no .worktree.json in ${slash(target)})`);
  const source = meta.sourceWorkspace ? path.resolve(meta.sourceWorkspace) : path.resolve(target, "..", "..");
  if (!fs.existsSync(source) || samePath(source, target)) throw new Error(`Source workspace not found (${slash(source)})`);
  const settings = worktreeSettings(source);
  const { copied, removed, skipped, kept } = copyConfig(source, target, settings.copy);
  const copySkipped = [...settings.copyRejected, ...skipped];
  return { source: slash(source), target: slash(target), copied, removed, copySkipped, kept };
}

// ------------------------------------------------------------------ CLI

const USAGE = `Usage: node worktree.mjs <create|list|remove|sync> [options]
  create --name <name> --repos <a,b> [--branch <b>] [--ticket <id>] [--tracker <kind>] [--native] [--root <ws>] [--no-install] [--json]
  list   [--root <ws>] [--json] [--no-fetch] [--no-pr]
  remove --name <name> [--force] [--delete-remote-branches] [--root <ws>] [--json]
  sync   [--path <worktree>] [--json]`;

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest, { booleans: ["json", "native", "no-install", "no-fetch", "no-pr", "force", "delete-remote-branches"] });
  const json = args.json === true;
  const log = (s) => process.stderr.write(s + "\n");
  const print = (s) => process.stdout.write(s + "\n");
  const root = typeof args.root === "string" ? path.resolve(args.root) : undefined;

  if (command === "create") {
    const r = createWorktree({ ...args, root, install: args["no-install"] !== true }, log);
    if (json) return print(JSON.stringify(r, null, 2));
    print(`\nWorktree '${r.name}' created at ${r.path}`);
    if (r.ticketId) print(`Ticket:  ${r.ticketId}${r.tracker ? ` (${r.tracker})` : ""}`);
    if (r.branch) print(`Branch:  ${r.branch}`);
    print(`Repos:   ${r.repos.map((d) => d.relativePath).join(", ")}${r.native ? " (git worktrees)" : ""}`);
    print(`Config:  ${r.copied.join(", ") || "(none)"}`);
    if (r.ports) {
      print(`Ports (slot ${r.ports.slot}, ${r.ports.file}):`);
      for (const [app, port] of Object.entries(r.ports.ports)) print(`  ${app.padEnd(16)} ${port}`);
      for (const c of r.ports.collisions) print(`  WARNING: shares ports ${c.overlap.join(",")} with ${c.worktree} (slot ${c.slot})`);
    } else if (!r.portsConfigured) {
      print("Ports:   none allocated (workspace.json has no worktrees.ports)");
    }
    if (r.failures.length) {
      print(`Failures (${r.failures.length}):`);
      for (const f of r.failures) print(`  - ${f.repo ? `${f.repo} ` : ""}${f.step}: ${f.error}`);
    }
    print(`\nOpen a new session there: cd "${r.path}"`);
    return;
  }
  if (command === "list") {
    const wts = await gatherWorktrees(mainRoot(root || findRoot(process.cwd())), { fetch: args["no-fetch"] !== true, pr: args["no-pr"] !== true });
    return print(json ? JSON.stringify(wts, null, 2) : renderList(wts));
  }
  if (command === "remove") {
    try {
      const r = removeWorktree({ ...args, root, deleteRemoteBranches: args["delete-remote-branches"] === true }, log);
      if (json) print(JSON.stringify(r, null, 2));
      else {
        print(r.removed ? `Worktree '${r.name}' removed.` : `Worktree '${r.name}' could not be fully deleted: ${r.error}`);
        if (r.portsFreed.length) print(`Port slot freed (${r.portsFreed.join(", ")}).`);
        for (const b of r.remoteBranches) print(`  remote ${b.repo} ${b.branch}: ${b.status}`);
      }
      if (r.cwdInside) log(`Your shell is inside ${r.path}: cd out of it${r.removed ? "" : ", then delete the folder"}.`);
      else if (!r.removed) log("Something still holds files there (an editor, a dev server, a build server): close it and delete the folder.");
      if (!r.removed) process.exitCode = 1;
    } catch (e) {
      if (!e.unsaved) throw e;
      if (json) print(JSON.stringify({ name: args.name, removed: false, unsaved: e.unsaved }, null, 2));
      log(`Error: ${e.message}:`);
      for (const u of e.unsaved) {
        log(`  ${u.repo} (${u.type}):`);
        for (const l of u.details.split("\n").slice(0, 5)) log(`    ${l}`);
      }
      log("Use --force to remove anyway, or commit/push first.");
      process.exitCode = 1;
    }
    return;
  }
  if (command === "sync") {
    const r = syncWorktree({ path: typeof args.path === "string" ? args.path : undefined });
    if (json) return print(JSON.stringify(r, null, 2));
    print(`Synced ${r.source} → ${r.target}`);
    for (const c of r.copied) print(`  copied ${c}`);
    for (const d of r.removed) print(`  removed stale ${d}/ (inherited from the parent workspace)`);
    for (const d of r.kept) print(`  kept ${d}/ (it holds git-tracked files)`);
    for (const s of r.copySkipped) print(`  warning: worktrees.copy entry '${s.path}' skipped (${s.reason})`);
    print("Restart the Claude Code session to load the new settings/CLAUDE.md.");
    return;
  }
  process.stderr.write(USAGE + "\n");
  process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = 1;
  });
}

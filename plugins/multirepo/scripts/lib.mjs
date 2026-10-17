/**
 * Shared helpers for the multirepo scripts: the workspace's config, its repos,
 * default branches, ticket ids and dependency order.
 *
 * Config is optional. When a Natterjack workspace is present these read
 *   repos.json                         { repos: [{ name, relativePath, defaultBranch, dependencies, layer, remote }] }
 *   .claude/dashboard/workspace.json   { issues: { kind, ticketPattern, ... }, worktrees: { dir, portsFile, ports } }
 *   .worktree.json                     { name, ticketId, tracker, branch, repos, created }
 * and otherwise fall back to discovery (a single repo, or the git repos one level down).
 *
 * git runs through execFileSync with argument arrays (no shell), so everything
 * behaves the same on Windows, macOS and Linux.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** JSON from a file (a leading BOM is fine), or null when missing or invalid. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/**
 * Runs git in cwd: { ok, out, err }. Never throws. Pass `trim: false` for -z
 * (NUL-separated) output, where trimming would eat a path's leading space.
 */
export function gitRun(cwd, args, { timeout = 30000, trim = true } = {}) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: trim ? out.trim() : out, err: "" };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? "").trim(), err: String(e.stderr ?? e.message ?? "").trim() };
  }
}

/** git's trimmed stdout, or "" on any failure. */
export function git(cwd, args, opts) {
  const r = gitRun(cwd, args, opts);
  return r.ok ? r.out : "";
}

export function isGitRepo(dir) {
  return fs.existsSync(dir) && git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/**
 * A path in a form that's equal for equal folders: the real path (git reports
 * the resolved one, which differs behind a symlink such as macOS's /var →
 * /private/var, a junction, or a Windows 8.3 short name like RUNNER~1), without
 * a trailing separator, lower-cased on case-insensitive platforms.
 */
export function pathKey(p) {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    /* doesn't exist: compare as given */
  }
  r = r.replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
}

export const samePath = (a, b) => pathKey(a) === pathKey(b);

/** dir is the top of its own git checkout (not just a folder inside one). */
export function isRepoTop(dir) {
  if (!isGitRepo(dir)) return false;
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return !!top && samePath(top, dir);
}

/** Forward slashes, for output that's the same on every OS. */
export const slash = (p) => String(p).replace(/\\/g, "/");

/** ~ at the start of a path → the home folder. */
export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The workspace root for a starting folder: the nearest ancestor (or itself)
 * holding .worktree.json, repos.json or .claude/dashboard/workspace.json; else the
 * enclosing git repo's top level; else the folder itself.
 */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, ".worktree.json")) ||
      fs.existsSync(path.join(dir, "repos.json")) ||
      fs.existsSync(path.join(dir, ".claude", "dashboard", "workspace.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const top = git(start, ["rev-parse", "--show-toplevel"]);
  return top ? path.resolve(top) : path.resolve(start);
}

/**
 * .claude/dashboard/workspace.json, or {}. A worktree has no copy of its own, so
 * when root has none and its .worktree.json names a sourceWorkspace, that
 * workspace's file is read instead.
 */
export function readWorkspaceConfig(root) {
  const own = readJson(path.join(root, ".claude", "dashboard", "workspace.json"));
  if (own) return own;
  const src = readWorktreeMeta(root)?.sourceWorkspace;
  if (typeof src === "string" && src && !samePath(src, root)) {
    return readJson(path.join(path.resolve(src), ".claude", "dashboard", "workspace.json")) ?? {};
  }
  return {};
}

/** .worktree.json at root, or null. */
export function readWorktreeMeta(root) {
  return readJson(path.join(root, ".worktree.json"));
}

/** One repos.json entry → { name, relativePath, defaultBranch, dependencies, layer, remote }. */
export function normalizeRepo(r) {
  if (typeof r === "string") return { name: r, relativePath: r, defaultBranch: null, dependencies: [], layer: null, remote: null };
  const relativePath = r.relativePath || r.directory || r.path || r.name;
  return {
    name: r.name || relativePath,
    relativePath: slash(relativePath),
    defaultBranch: r.defaultBranch || null,
    dependencies: Array.isArray(r.dependencies) ? r.dependencies : [],
    layer: r.layer || null,
    remote: r.remote || r.url || null,
  };
}

/** repos.json's repos (normalized), or [] when there's no repos.json. */
export function readReposJson(root) {
  const rj = readJson(path.join(root, "repos.json"));
  return rj && Array.isArray(rj.repos) ? rj.repos.map(normalizeRepo) : [];
}

/**
 * The repos of the workspace (or worktree) at root, each with an absolute `path`:
 *   1. .worktree.json `repos`, matched to repos.json entries (here, or in the
 *      main workspace it was made from) for their branch and dependency info;
 *   2. repos.json;
 *   3. root itself when it's a git repo;
 *   4. the git repos one level down.
 * Entries are listed whether or not they're cloned; check `exists` (true only
 * when the folder is the top of its own checkout, not a plain folder inside a
 * git-backed workspace).
 */
export function listRepos(root) {
  const withPath = (r) => {
    const p = path.join(root, r.relativePath.replace(/[\\/]+/g, path.sep));
    return { ...r, path: p, exists: isRepoTop(p) };
  };

  const meta = readWorktreeMeta(root);
  if (meta && Array.isArray(meta.repos) && meta.repos.length) {
    const known = readReposJson(root);
    const source = meta.sourceWorkspace ? readReposJson(meta.sourceWorkspace) : [];
    const lookup = [...known, ...source];
    return meta.repos.map((entry) => {
      const n = normalizeRepo(entry);
      const match = lookup.find((k) => k.name === n.name || k.relativePath === n.relativePath);
      return withPath(match ? { ...match, relativePath: n.relativePath } : n);
    });
  }

  const repos = readReposJson(root);
  if (repos.length) return repos.map(withPath);

  if (isRepoTop(root)) {
    return [withPath(normalizeRepo({ name: path.basename(root), relativePath: "." }))];
  }

  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && d.name !== "worktrees")
      .map((d) => withPath(normalizeRepo(d.name)))
      .filter((r) => r.exists);
  } catch {
    return [];
  }
}

/** A repo's default branch: the configured one, else origin/HEAD, else main/master/develop. */
export function defaultBranch(repoPath, configured = null) {
  if (configured) return configured;
  const head = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const cand of ["main", "master", "develop"]) {
    if (git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${cand}`]) ||
        git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${cand}`])) {
      return cand;
    }
  }
  return "main";
}

/** The ticket pattern (unanchored, case-insensitive) from workspace.json, else a typical KEY-123. */
export function ticketRegex(config = {}) {
  const pattern = config?.issues?.ticketPattern;
  if (typeof pattern === "string" && pattern) {
    try {
      return new RegExp(`(${pattern.replace(/^\^/, "").replace(/\$$/, "")})`, "i");
    } catch {
      /* fall through */
    }
  }
  return /([A-Z][A-Z0-9]+-\d+)/i;
}

/** The first ticket id in any of the strings (branch names, folder names), upper-cased; or null. */
export function findTicket(strings, config = {}) {
  const re = ticketRegex(config);
  for (const s of strings) {
    const m = String(s ?? "").match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/**
 * Repos in dependency order: a repo comes after the repos it lists in
 * `dependencies` (the ones it consumes). Ties keep their listed order; a cycle
 * or an unknown dependency doesn't drop anything.
 */
export function dependencyOrder(repos) {
  const byName = new Map(repos.map((r) => [r.name, r]));
  const out = [];
  const state = new Map(); // name → "visiting" | "done"
  const visit = (r) => {
    const s = state.get(r.name);
    if (s === "done" || s === "visiting") return;
    state.set(r.name, "visiting");
    for (const dep of r.dependencies ?? []) {
      const d = byName.get(dep);
      if (d) visit(d);
    }
    state.set(r.name, "done");
    out.push(r);
  };
  for (const r of repos) visit(r);
  return out;
}

/** True when this script file is the one node was asked to run. */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(new URL(importMetaUrl));
  } catch {
    return false;
  }
}

/** --flag value / --flag / positional parsing; repeated flags keep the last value. */
export function parseArgs(argv, { booleans = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (booleans.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) out[key] = true;
      else out[key] = argv[++i];
    } else {
      out._.push(a);
    }
  }
  return out;
}

#!/usr/bin/env node
/**
 * repo-status.mjs: what's uncommitted in each repo of the workspace, for /commit.
 *
 * For every repo (repos.json / .worktree.json via lib's listRepos, plus the
 * workspace root itself when it's a git repo of its own) reports the branch,
 * its default branch, the ticket in the branch name, ahead/behind against
 * origin/<default>, and the staged, unstaged and untracked files, each from its
 * own unambiguous git command (`diff --cached --name-status`, `diff
 * --name-status`, `ls-files --others`) rather than porcelain XY columns.
 *
 * Usage:
 *   node repo-status.mjs [--root <dir>] [--ticket <ID>] [--all] [--json]
 *
 *   --root    Workspace/worktree root (or a single repo). Default: cwd's root.
 *   --ticket  The ticket this commit is for; marks which repos `--auto` may
 *             commit in. Default: .worktree.json's ticket, else the one ticket
 *             the changed repos' branches share.
 *   --all     Include clean repos too.
 *   --json    JSON to stdout instead of the text summary.
 *
 * Each repo's `eligible` is true when it's on a branch for the ticket (never
 * its default branch, never another ticket's branch): the only repos an
 * unattended commit may stage everything in.
 */
import fs from "node:fs";
import path from "node:path";
import {
  defaultBranch,
  findRoot,
  findTicket,
  sameTicket,
  ticketCase,
  git,
  gitRun,
  isMain,
  listRepos,
  parseArgs,
  readWorkspaceConfig,
  readWorktreeMeta,
  slash,
  isRepoTop,
  pathKey,
} from "./lib.mjs";

/**
 * `git diff --name-status -z` output → [{ status, path, oldPath? }].
 * Renames and copies (R100, C75) carry two paths: old then new.
 */
export function parseNameStatus(raw) {
  const tok = String(raw ?? "").split("\0").filter((t) => t !== "");
  const out = [];
  for (let i = 0; i < tok.length; ) {
    const status = tok[i++].trim();
    if (/^[RC]/.test(status)) {
      const oldPath = tok[i++];
      const p = tok[i++];
      if (p !== undefined) out.push({ status, path: slash(p), oldPath: slash(oldPath) });
    } else {
      const p = tok[i++];
      if (p !== undefined) out.push({ status, path: slash(p) });
    }
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", "worktrees", "bin", "obj", "dist", "build", "target", "vendor", "packages"]);

/** Fallback discovery: folders holding a .git entry under root, depth ≤ 4, not descending into repos. */
export function walkRepos(root, maxDepth = 4) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== root && entries.some((e) => e.name === ".git")) {
      const rel = slash(path.relative(root, dir));
      found.push({ name: path.basename(dir), relativePath: rel, path: dir, exists: true, dependencies: [], defaultBranch: null });
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}


/**
 * The repos to inspect: the root (when it's its own repo) then lib's listRepos,
 * de-duplicated by path; the directory walk only when listRepos finds nothing cloned.
 */
export function discoverRepos(root) {
  let repos = listRepos(root).filter((r) => r.exists);
  if (!repos.length) repos = walkRepos(root);
  const key = pathKey;
  const out = [];
  if (isRepoTop(root) && !repos.some((r) => key(r.path) === key(root))) {
    out.push({ name: path.basename(root), relativePath: ".", path: root, exists: true, dependencies: [], defaultBranch: null, isRoot: true });
  }
  for (const r of repos) {
    if (!out.some((o) => key(o.path) === key(r.path))) out.push({ ...r, isRoot: key(r.path) === key(root) });
  }
  return out;
}

/** ahead/behind of HEAD against origin/<base>, or nulls when that ref isn't there. */
function aheadBehind(repoPath, base) {
  const r = gitRun(repoPath, ["rev-list", "--left-right", "--count", `HEAD...origin/${base}`]);
  if (!r.ok) return { ahead: null, behind: null };
  const [ahead, behind] = r.out.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ahead, behind };
}

/** One repo's state. `otherRepoPaths` (relative to this repo) are hidden from its untracked list. */
export function inspectRepo(repo, { config = {}, otherRepoPaths = [] } = {}) {
  const p = repo.path;
  const branch = git(p, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const base = defaultBranch(p, repo.defaultBranch);
  const staged = parseNameStatus(git(p, ["diff", "--cached", "--name-status", "-M", "-z"], { trim: false }));
  const unstaged = parseNameStatus(git(p, ["diff", "--name-status", "-z"], { trim: false }));
  const hidden = otherRepoPaths.map((r) => r.replace(/\/?$/, "/"));
  const untracked = git(p, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false })
    .split("\0")
    .filter(Boolean)
    .map(slash)
    .filter((f) => !hidden.some((h) => f === h || f.startsWith(h)))
    .map((f) => ({ status: "?", path: f }));
  const diffStat = staged.length ? git(p, ["diff", "--cached", "--stat"]) || null : null;
  const ticket = branch === "HEAD" ? null : findTicket([branch], config);
  return {
    name: repo.name,
    relativePath: repo.relativePath,
    path: slash(p),
    isRoot: !!repo.isRoot,
    dependencies: repo.dependencies ?? [],
    branch,
    detached: branch === "HEAD",
    defaultBranch: base,
    onDefault: branch === base,
    ticket,
    ...aheadBehind(p, base),
    staged,
    unstaged,
    untracked,
    diffStat,
    hasChanges: staged.length + unstaged.length + untracked.length > 0,
  };
}

/** The ticket being committed for: explicit, the worktree's, else the single one the changed branches share. */
export function resolveTicket(root, repos, explicit = null, config = {}) {
  if (explicit) return ticketCase(explicit, config);
  const meta = readWorktreeMeta(root);
  const fromMeta = meta && (meta.ticketId || findTicket([meta.branch, meta.name, path.basename(root)], config));
  if (fromMeta) return ticketCase(fromMeta, config);
  // One ticket, however its branches spell it (trackers compare ids case-insensitively).
  const tickets = repos.filter((r) => r.hasChanges && r.ticket && !r.onDefault).map((r) => r.ticket);
  const distinct = tickets.filter((t, i) => tickets.findIndex((u) => sameTicket(u, t)) === i);
  return distinct.length === 1 ? distinct[0] : null;
}

export function collectStatus({ root = process.cwd(), all = false, ticket = null } = {}) {
  const wsRoot = findRoot(root);
  const config = readWorkspaceConfig(wsRoot);
  const repos = discoverRepos(wsRoot);
  const inspected = repos.map((r) => {
    // Sub-repos nested in this one (the workspace root holding its repos) aren't its untracked files.
    const nested = repos
      .filter((o) => o !== r)
      .map((o) => slash(path.relative(r.path, o.path)))
      .filter((rel) => rel && !rel.startsWith(".."));
    return inspectRepo(r, { config, otherRepoPaths: nested });
  });
  const forTicket = resolveTicket(wsRoot, inspected, ticket, config);
  for (const r of inspected) r.eligible = !!forTicket && !r.onDefault && !r.detached && sameTicket(r.ticket, forTicket);
  return {
    root: slash(wsRoot),
    ticket: forTicket,
    repos: inspected.filter((r) => all || r.hasChanges),
    clean: inspected.filter((r) => !r.hasChanges).map((r) => r.name),
  };
}

/** A compact per-repo summary. */
export function formatText(result) {
  const lines = [];
  const changed = result.repos.filter((r) => r.hasChanges);
  if (!changed.length) lines.push("All repos are clean: nothing to commit.");
  for (const r of result.repos) {
    const sync = r.ahead === null ? `no origin/${r.defaultBranch}` : `${r.ahead} ahead, ${r.behind} behind origin/${r.defaultBranch}`;
    const tags = [r.ticket && `ticket ${r.ticket}`, r.onDefault && "on default branch", r.eligible && "eligible for --auto"].filter(Boolean);
    lines.push(`\n${r.name}${r.isRoot ? " (root)" : ""}  [${r.branch}]  ${sync}${tags.length ? `  (${tags.join(", ")})` : ""}`);
    if (!r.hasChanges) lines.push("  clean");
    const list = (label, files) => {
      if (!files.length) return;
      lines.push(`  ${label}:`);
      for (const f of files) lines.push(`    ${f.status.padEnd(4)} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}`);
    };
    list("Staged", r.staged);
    list("Unstaged", r.unstaged);
    list("Untracked", r.untracked);
    if (r.diffStat) lines.push(`  Staged stat: ${r.diffStat.split("\n").pop().trim()}`);
  }
  if (result.clean.length && !result.repos.some((r) => !r.hasChanges)) lines.push(`\nClean: ${result.clean.join(", ")}`);
  if (result.ticket) lines.push(`\nTicket: ${result.ticket}`);
  return lines.join("\n").replace(/^\n/, "") + "\n";
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["all", "json"] });
  const result = collectStatus({
    root: typeof args.root === "string" ? path.resolve(args.root) : process.cwd(),
    all: !!args.all,
    ticket: typeof args.ticket === "string" ? args.ticket : null,
  });
  process.stdout.write(args.json ? JSON.stringify(result, null, 2) + "\n" : formatText(result));
}

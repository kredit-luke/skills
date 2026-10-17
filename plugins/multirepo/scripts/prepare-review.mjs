#!/usr/bin/env node
/**
 * prepare-review.mjs: scaffold a second-opinion review and discover what changed.
 *
 * A review covers one unit of work, which may span several repos (a multi-repo
 * workspace) or live in a single repo. This finds every repo under the root with
 * work to review (commits ahead of its base branch and/or a dirty working tree),
 * creates the inbox/outbox state folders, writes a manifest the reviewer prompt
 * reads, and keeps the review state itself out of every diff.
 *
 * Project-agnostic: the repo layout is discovered, the base branch is detected
 * per repo, and the ticket id is inferred from the branch or folder name.
 *
 * Usage:
 *   node prepare-review.mjs [--root <dir>] [--id <reviewId>] [--base <branch>]
 *
 *   --root  Workspace/worktree root (or a single repo). Default: cwd.
 *   --id    Review id, the state folder's name. Default: the ticket id in a
 *           branch or the folder name (e.g. ENG-196), else "adhoc-<timestamp>".
 *   --base  Base branch to diff against. Default: per repo, repos.json's
 *           defaultBranch, else origin's default branch, else main/master/develop.
 *
 * Output: JSON to stdout ({ reviewId, reviewDir, inbox, outbox, repos[] }, each
 * repo with its diff commands and its untracked `newFiles`); a
 * human-readable summary to stderr. Exits 1 when a repo's base branch can't be
 * resolved, rather than reporting its committed work as "no changes".
 *
 * git runs through execFileSync with argument arrays (no shell), so it behaves
 * the same on Windows, macOS and Linux.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  // base: null means "detect per repo".
  const out = { root: process.cwd(), id: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--base") out.base = argv[++i];
  }
  out.root = path.resolve(out.root);
  return out;
}

/** Runs git in repoPath; untrimmed stdout, or "" on any failure. */
function gitRaw(repoPath, args) {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

/** Runs git in repoPath; trimmed stdout, "" on any failure, so callers can branch on emptiness. */
function git(repoPath, args) {
  return gitRaw(repoPath, args).trim();
}

/**
 * Two paths name the same folder. Compares real paths: git reports the resolved
 * one, which differs from what we were given behind a symlink (macOS's /var →
 * /private/var), a junction, or a Windows 8.3 short name (RUNNER~1).
 */
const samePath = (a, b) => {
  const norm = (p) => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync.native(r);
    } catch {
      /* doesn't exist: compare as given */
    }
    r = r.replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};

/** dir is the top of its own git checkout (not just somewhere inside one). */
function isRepoTop(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return !!top && samePath(top, dir);
}

function isGitRepo(dir) {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

function readJson(file) {
  try {
    // Strip a leading BOM (common in JSON written on Windows).
    return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** repos.json entries as { name, rel, defaultBranch }, or []. */
function manifestRepos(dir) {
  const rj = dir ? readJson(path.join(dir, "repos.json")) : null;
  if (!rj || !Array.isArray(rj.repos)) return [];
  return rj.repos.map((r) => {
    if (typeof r === "string") return { name: r, rel: r, defaultBranch: null };
    const rel = r.relativePath || r.directory || r.path || r.name;
    return { name: r.name || rel, rel, defaultBranch: r.defaultBranch || null };
  });
}

/**
 * Candidate repos under root:
 *   1. .worktree.json `repos` (a worktree: only the repos cloned into it), each
 *      inheriting its defaultBranch from repos.json (here, or in the workspace
 *      the worktree was made from);
 *   2. else repos.json `repos` (strings, or objects with relativePath, or the
 *      older directory / path, and name);
 *   3. else the git repos one level down.
 * Root itself is a candidate too when it's the top of a git checkout (a single
 * repo, or a workspace that is its own repo holding scripts and config); its
 * nested repos are left out of its changes. inspectRepo() drops candidates that
 * don't exist or have no changes, so listing too many here is harmless.
 */
export function candidateRepos(root) {
  const norm = (rel) => path.join(root, String(rel).replace(/[\\/]+/g, path.sep));
  const known = (dir) => manifestRepos(dir);
  let list = [];

  const wt = readJson(path.join(root, ".worktree.json"));
  const declared = known(root);
  if (wt && Array.isArray(wt.repos) && wt.repos.length) {
    const lookup = [...declared, ...known(wt.sourceWorkspace)];
    list = wt.repos.map((r) => {
      const name = typeof r === "string" ? r : r.name || r.relativePath || r.directory;
      const rel = typeof r === "string" ? r : r.relativePath || r.directory || r.path || r.name;
      const match = lookup.find((k) => k.name === name || slashed(k.rel) === slashed(rel));
      const defaultBranch = (typeof r === "object" && r.defaultBranch) || match?.defaultBranch || null;
      return { name, path: norm(rel), defaultBranch };
    });
  } else if (declared.length) {
    list = declared.map((r) => ({ name: r.name, path: norm(r.rel), defaultBranch: r.defaultBranch }));
  } else {
    try {
      list = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
        .map((d) => ({ name: d.name, path: path.join(root, d.name), defaultBranch: null }))
        .filter((r) => isGitRepo(r.path) && isRepoTop(r.path));
    } catch {
      /* none */
    }
  }

  if (isRepoTop(root) && !list.some((r) => samePath(r.path, root))) {
    const nested = list.map((r) => slashed(path.relative(root, r.path))).filter((rel) => rel && !rel.startsWith(".."));
    list.unshift({ name: path.basename(root), path: root, defaultBranch: null, nested });
  }
  return list;
}

const slashed = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** A path (from git, relative to the repo) is one of the nested repos, or inside one. */
const inNested = (file, nested) => nested.some((rel) => file === rel || file.startsWith(rel + "/"));

/** A repo's default branch: origin/HEAD, then common names. */
function detectDefaultBase(repoPath) {
  const head = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const cand of ["main", "master", "develop"]) {
    if (
      git(repoPath, ["rev-parse", "--verify", "--quiet", cand]) ||
      git(repoPath, ["rev-parse", "--verify", "--quiet", `origin/${cand}`])
    ) {
      return cand;
    }
  }
  return "main";
}

/** `base` as a ref this repo has: local first, then origin/. */
function resolveBase(repoPath, base) {
  if (git(repoPath, ["rev-parse", "--verify", "--quiet", base])) return base;
  const remote = `origin/${base}`;
  if (git(repoPath, ["rev-parse", "--verify", "--quiet", remote])) return remote;
  return null;
}

/**
 * The commands the reviewer runs itself to see the change: the committed range
 * plus uncommitted changes is everything this work touched.
 */
export function buildDiffCommands(resolvedBase, ahead, dirty) {
  const cmds = [];
  if (ahead > 0 && resolvedBase) cmds.push(`git diff ${resolvedBase}...HEAD`);
  if (dirty) cmds.push("git diff HEAD"); // staged + unstaged vs HEAD
  if (cmds.length === 0 && resolvedBase) cmds.push(`git diff ${resolvedBase}...HEAD`);
  return cmds;
}

/**
 * What changed in one repo, or null when nothing did. Throws when the base can't
 * be resolved: guessing "no commits ahead" would silently skip committed work.
 */
export function inspectRepo(candidate, requestedBase) {
  const { name, path: repoPath } = candidate;
  const nested = candidate.nested ?? [];
  if (!fs.existsSync(repoPath) || !isGitRepo(repoPath)) return null;

  const branch = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const base = requestedBase || candidate.defaultBranch || detectDefaultBase(repoPath);
  const resolvedBase = resolveBase(repoPath, base);
  if (!resolvedBase) {
    throw new Error(
      `${name}: can't resolve the base branch "${base}" (tried ${base} and origin/${base}). ` +
        `Pass --base <branch>, or fetch it (git -C "${slashed(repoPath)}" fetch origin ${base}).`
    );
  }

  let ahead = 0;
  let mergeBase = null;
  if (branch !== base) {
    mergeBase = git(repoPath, ["merge-base", resolvedBase, "HEAD"]) || null;
    ahead = parseInt(git(repoPath, ["rev-list", "--count", `${resolvedBase}..HEAD`]), 10) || 0;
  }

  // Changed paths, NUL-separated so names with spaces or non-ASCII characters
  // come back as real paths (git C-quotes them otherwise). A rename entry is
  // followed by its old path, which is skipped. Nested repos aren't this repo's changes.
  const fields = gitRaw(repoPath, ["status", "--porcelain", "-z"]).split("\0");
  const changed = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    if (/^[RC]/.test(entry)) i++;
    const file = entry.slice(3).replace(/\/$/, "");
    if (!inNested(file, nested)) changed.push(file);
  }
  const dirty = changed.length > 0;
  const changedFiles = changed.length;

  if (ahead === 0 && !dirty) return null; // nothing to review here

  // Untracked files. `git diff HEAD` doesn't show them, so without a list the
  // reviewer never sees new files, and work left uncommitted until the PR makes
  // brand-new modules, migrations and components the normal case.
  const newFiles = gitRaw(repoPath, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((f) => f && !inNested(f.replace(/\/$/, ""), nested));

  // Diff stat for the summary: the committed range when there is one, else the working tree.
  const diffStat =
    ahead > 0 && resolvedBase
      ? git(repoPath, ["diff", "--stat", `${resolvedBase}...HEAD`])
      : git(repoPath, ["diff", "--stat"]);

  return {
    name,
    path: repoPath.replace(/\\/g, "/"),
    branch,
    base: resolvedBase,
    mergeBase,
    commitsAhead: ahead,
    dirty,
    changedFiles,
    diffCommands: buildDiffCommands(resolvedBase, ahead, dirty),
    diffStat: diffStat || null,
    newFiles, // no diff command surfaces these: read them directly
  };
}

/** The ticket pattern from Natterjack's workspace.json (unanchored), else a typical key. */
export function ticketRegex(root) {
  const ws = readJson(path.join(root, ".claude", "dashboard", "workspace.json"));
  const pattern = ws?.issues?.ticketPattern;
  if (typeof pattern === "string" && pattern) {
    try {
      return new RegExp(`(${pattern.replace(/^\^/, "").replace(/\$$/, "")})`, "i");
    } catch {
      /* fall through */
    }
  }
  return /([A-Z][A-Z0-9]+-\d+)/i; // ABC-123, ENG-196, PROJ-7833...
}

export function deriveReviewId(root, repos, now = new Date()) {
  const re = ticketRegex(root);
  for (const r of repos) {
    const m = (r.branch || "").match(re);
    if (m) return m[1].toUpperCase();
  }
  const m = path.basename(root).match(re);
  if (m) return m[1].toUpperCase();
  return `adhoc-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

/** Adds .copilot/ to the repo's info/exclude, so reviewing never sees review state. */
function excludeFromGit(repoPath) {
  // Ask git for the file it actually reads: in a linked worktree that's the shared
  // repo's info/exclude, not one under the worktree's own admin folder.
  const rel = git(repoPath, ["rev-parse", "--git-path", "info/exclude"]);
  if (!rel) return;
  const exclude = path.resolve(repoPath, rel);
  try {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    let body = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf-8") : "";
    if (!body.split(/\r?\n/).some((l) => l.trim() === ".copilot/")) {
      if (body.length && !body.endsWith("\n")) body += "\n";
      fs.writeFileSync(exclude, body + ".copilot/\n");
    }
  } catch {
    /* best effort */
  }
}

export function prepareReview({ root, id = null, base = null }) {
  const repos = candidateRepos(root)
    .map((c) => inspectRepo(c, base))
    .filter(Boolean);
  if (repos.length === 0) return { reviewId: null, repos: [] };

  const reviewId = id || deriveReviewId(root, repos);
  const reviewDir = path.join(root, ".copilot", "reviews", reviewId);
  const inbox = path.join(reviewDir, "inbox");
  const outbox = path.join(reviewDir, "outbox");
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(outbox, { recursive: true });

  excludeFromGit(root);
  for (const r of repos) excludeFromGit(r.path);

  const slash = (p) => p.replace(/\\/g, "/");
  const manifest = {
    reviewId,
    root: slash(root),
    base: base || "auto",
    reviewDir: slash(reviewDir),
    inbox: slash(inbox),
    outbox: slash(outbox),
    repos,
  };
  fs.writeFileSync(path.join(inbox, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  let manifest;
  try {
    manifest = prepareReview(opts);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  if (!manifest.reviewId) {
    process.stderr.write(`No changes to review under ${opts.root} (no commits ahead of base, no working-tree changes).\n`);
  } else {
    process.stderr.write(`Review ${manifest.reviewId}: ${manifest.repos.length} repo(s) with changes:\n`);
    for (const r of manifest.repos) {
      process.stderr.write(
        `  ${r.name} (${r.branch}): ${r.commitsAhead} commit(s) ahead of ${r.base || "?"}` +
          `${r.dirty ? `, ${r.changedFiles} working-tree change(s)` : ""}` +
          `${r.newFiles.length ? `, ${r.newFiles.length} new file(s)` : ""}\n`
      );
    }
    process.stderr.write(`State: ${manifest.reviewDir}\n`);
  }
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}

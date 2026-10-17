#!/usr/bin/env node
/**
 * pull.mjs: bring the workspace's repos up to date with origin/<default branch>,
 * moving only what's safe to move.
 *
 * Every target repo is fetched (in parallel). A repo is fast-forwarded
 * (`git merge --ff-only origin/<default>`) ONLY when it's on its default branch,
 * has no tracked changes, and is strictly behind. Nothing else is touched: no
 * checkout, no branch switch, no stash, no rebase, no merge commit. Every other
 * repo is reported with the reason.
 *
 * Usage:
 *   node pull.mjs [target...] [--layer <layer>] [--root <dir>] [--dry-run] [--json]
 *
 * Targets:
 *   (none) / all   the workspace root (when it's a git repo) + every repo
 *   root           just the workspace root
 *   <name...>      repos by name or relativePath; a layer name (repos.json
 *                  `layer`) means that layer's repos
 *   --layer <l>    that layer's repos
 *
 *   --dry-run  No fetch, no changes: what would happen, judged from the refs as
 *              of the last fetch.
 *   --json     JSON to stdout instead of the table.
 *
 * Refuses inside a worktree (.worktree.json at the root): those are
 * feature-branch checkouts; pull the main workspace.
 *
 * Exit: 0 when nothing failed (skipped and diverged repos aren't failures);
 * 1 when a fetch or fast-forward failed; 2 on bad arguments or a worktree root.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  defaultBranch,
  findRoot,
  git,
  gitRun,
  isMain,
  listRepos,
  parseArgs,
  readJson,
  readWorktreeMeta,
  slash,
  isRepoTop,
  pathKey,
} from "./lib.mjs";

/** git, async (for parallel fetches): { ok, out, err }. Never rejects. */
function gitAsync(cwd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? "").trim(), err: String(stderr || err?.message || "").trim() });
    });
  });
}

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const key = pathKey;

/**
 * The root repo (when the workspace root is its own git repo) + listRepos,
 * de-duplicated by path. A repos.json entry for the root (relativePath ".")
 * keeps its own metadata (name, defaultBranch, layer...) and is marked isRoot.
 */
export function allRepos(root) {
  const out = [];
  if (isRepoTop(root)) {
    out.push({ name: path.basename(root), relativePath: ".", path: root, exists: true, layer: null, defaultBranch: null, isRoot: true });
  }
  for (const r of listRepos(root)) {
    const isRoot = key(r.path) === key(root);
    const i = out.findIndex((o) => key(o.path) === key(r.path));
    if (i === -1) out.push({ ...r, isRoot });
    else if (out[i].isRoot && isRoot) out[i] = { ...r, relativePath: ".", exists: true, isRoot: true };
  }
  return out;
}

/**
 * Target words → repos. Throws an Error (with `.valid`) on an unknown name.
 * Matching is case-insensitive on name, relativePath and layer.
 */
export function resolveTargets(root, targets = [], { layer = null } = {}) {
  const repos = allRepos(root);
  const lc = (s) => String(s ?? "").toLowerCase();
  const layers = [...new Set(repos.map((r) => r.layer).filter(Boolean))];
  const words = targets.map(String).filter(Boolean);
  if (layer) words.push(`layer:${layer}`);
  if (!words.length || (words.length === 1 && lc(words[0]) === "all")) return repos;

  const picked = [];
  const add = (r) => {
    if (!picked.includes(r)) picked.push(r);
  };
  const unknown = [];
  for (const w of words) {
    const lw = lc(w);
    if (lw.startsWith("layer:")) {
      const l = lw.slice(6);
      const inLayer = repos.filter((r) => lc(r.layer) === l);
      if (!inLayer.length) unknown.push(`layer ${w.slice(6)}`);
      inLayer.forEach(add);
      continue;
    }
    if (lw === "root" || lw === ".") {
      const r = repos.find((x) => x.isRoot);
      if (r) add(r);
      else unknown.push(w);
      continue;
    }
    if (lw === "all") {
      repos.forEach(add);
      continue;
    }
    const byName = repos.filter((r) => lc(r.name) === lw || lc(r.relativePath) === lw.replace(/\\/g, "/"));
    if (byName.length) {
      byName.forEach(add);
      continue;
    }
    const inLayer = repos.filter((r) => lc(r.layer) === lw);
    if (inLayer.length) {
      inLayer.forEach(add);
      continue;
    }
    unknown.push(w);
  }
  if (unknown.length) {
    const err = new Error(`Unknown target(s): ${unknown.join(", ")}`);
    err.valid = { repos: repos.map((r) => (r.isRoot ? "root" : r.name)), layers };
    throw err;
  }
  return picked;
}

/** Fetches every repo that has an origin, in parallel: Map(path → { ok, err } | null when no origin). */
async function fetchAll(repos) {
  const results = await Promise.all(
    repos.map(async (r) => {
      if (!r.exists || !git(r.path, ["remote", "get-url", "origin"])) return [r.path, null];
      const f = await gitAsync(r.path, ["fetch", "origin", "--quiet", "--prune"]);
      return [r.path, f];
    })
  );
  return new Map(results);
}

/** Decide and (unless dryRun) act on one repo. `fetch` is this repo's fetch result, or undefined in a dry run. */
export function syncRepo(repo, { dryRun = false, fetch } = {}) {
  const base = { name: repo.isRoot ? `${repo.name} (root)` : repo.name, relativePath: repo.relativePath, path: slash(repo.path), isRoot: !!repo.isRoot };
  const done = (state, detail, extra = {}) => ({ ...base, ...extra, state, detail, error: ["fetch-failed", "ff-failed", "no-upstream"].includes(state) });

  if (!repo.exists) return done("missing", "not cloned: skipped");
  const p = repo.path;
  if (!git(p, ["remote", "get-url", "origin"])) return done("no-origin", "no origin remote: skipped");

  const branch = git(p, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const def = defaultBranch(p, repo.defaultBranch);
  const dirty = git(p, ["status", "--porcelain", "--untracked-files=no"]).length > 0;
  const info = { branch, defaultBranch: def, dirty };

  if (fetch && !fetch.ok) return done("fetch-failed", `fetch failed: ${firstLine(fetch.err)}`, info);
  if (!git(p, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${def}`])) {
    return done("no-upstream", `origin/${def} not found`, info);
  }
  const counts = gitRun(p, ["rev-list", "--left-right", "--count", `HEAD...origin/${def}`]);
  const [ahead, behind] = counts.ok ? counts.out.split(/\s+/).map((n) => parseInt(n, 10) || 0) : [0, 0];
  Object.assign(info, { ahead, behind });

  if (branch !== def) {
    return done("other-branch", `on ${branch === "HEAD" ? "a detached HEAD" : branch}, not ${def}: skipped`, info);
  }
  if (behind === 0) {
    return ahead > 0 ? done("ahead", `${ahead} ahead of origin/${def}: nothing to pull`, info) : done("up-to-date", "up to date", info);
  }
  if (ahead > 0) {
    return done("diverged", `diverged (${ahead} ahead, ${behind} behind origin/${def}): needs a decision`, info);
  }
  if (dirty) return done("dirty", `uncommitted changes, ${behind} behind: skipped`, info);
  if (dryRun) return done("would-ff", `would fast-forward ${behind} commit(s)`, info);

  const from = git(p, ["rev-parse", "HEAD"]);
  const ff = gitRun(p, ["merge", "--ff-only", "--quiet", `origin/${def}`], { timeout: 120000 });
  if (!ff.ok) return done("ff-failed", `fast-forward refused: ${firstLine(ff.err || ff.out)}`, info);
  const to = git(p, ["rev-parse", "HEAD"]);
  return done("fast-forwarded", `fast-forwarded ${behind} commit(s) to ${to.slice(0, 7)}`, { ...info, from, to });
}

/** The dashboard engine folder, when .claude/dashboard/engine.json exists: its `dir`, else "natterjack". */
export function engineDir(root) {
  const file = path.join(root, ".claude", "dashboard", "engine.json");
  if (!fs.existsSync(file)) return null;
  const dir = readJson(file)?.dir;
  return typeof dir === "string" && dir ? slash(dir).replace(/\/+$/, "") : "natterjack";
}

export async function runPull({ root = process.cwd(), targets = [], layer = null, dryRun = false } = {}) {
  const wsRoot = findRoot(root);
  if (readWorktreeMeta(wsRoot)) {
    const err = new Error(`${slash(wsRoot)} is a worktree: worktrees are feature-branch checkouts; pull the main workspace instead.`);
    err.worktree = true;
    throw err;
  }
  const repos = resolveTargets(wsRoot, targets, { layer });
  const fetched = dryRun ? new Map() : await fetchAll(repos);
  const results = repos.map((r) => syncRepo(r, { dryRun, fetch: dryRun ? undefined : fetched.get(r.path) ?? undefined }));

  let engineChanged = null;
  const rootResult = results.find((r) => r.isRoot && r.state === "fast-forwarded");
  const eng = rootResult && engineDir(wsRoot);
  if (eng) {
    const changed = git(wsRoot, ["diff", "--name-only", rootResult.from, rootResult.to, "--", eng]);
    if (changed) engineChanged = eng;
  }
  return { root: slash(wsRoot), dryRun, repos: results, engineChanged, errors: results.filter((r) => r.error).length };
}

export function formatTable(summary) {
  const rows = summary.repos.map((r) => [r.name, r.branch ?? "", r.detail]);
  const w0 = Math.max(4, ...rows.map((r) => r[0].length));
  const w1 = Math.max(6, ...rows.map((r) => r[1].length));
  const lines = [
    `Pull at ${summary.root}${summary.dryRun ? " (dry run: not fetched, judged from the last fetch)" : ""}`,
    "",
    `${"Repo".padEnd(w0)}  ${"Branch".padEnd(w1)}  Result`,
    `${"-".repeat(w0)}  ${"-".repeat(w1)}  ------`,
    ...rows.map((r) => `${r[0].padEnd(w0)}  ${r[1].padEnd(w1)}  ${r[2]}`),
  ];
  if (summary.engineChanged) lines.push("", `The dashboard engine (${summary.engineChanged}/) changed: restart the dashboard to pick it up.`);
  if (summary.errors) lines.push("", `${summary.errors} repo(s) failed (see above).`);
  return lines.join("\n") + "\n";
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["dry-run", "json"] });
  try {
    const summary = await runPull({
      root: typeof args.root === "string" ? path.resolve(args.root) : process.cwd(),
      targets: args._,
      layer: typeof args.layer === "string" ? args.layer : null,
      dryRun: !!args["dry-run"],
    });
    process.stdout.write(args.json ? JSON.stringify(summary, null, 2) + "\n" : formatTable(summary));
    process.exitCode = summary.errors ? 1 : 0;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    if (e.valid) {
      process.stderr.write(`Repos: ${e.valid.repos.join(", ") || "(none)"}\n`);
      if (e.valid.layers.length) process.stderr.write(`Layers: ${e.valid.layers.join(", ")}\n`);
    }
    process.exitCode = 2;
  }
}

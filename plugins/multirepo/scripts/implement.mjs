#!/usr/bin/env node
/**
 * implement.mjs: the deterministic parts of the implement skill.
 *
 *   --ticket <ID> --resolve [--root <dir>] [--branch <b>] [--type <issue type>] [--here] [--json]
 *       Where does this ticket's work live? Makes no changes. Prints
 *       { placement, ticket, mainRoot, baseDir, worktree, branch, branchSource, ports, stages, repos }.
 *         placement   in-worktree        the session is inside this ticket's worktree
 *                     in-other-worktree  inside a different ticket's worktree (stop and ask)
 *                     worktree-exists    this ticket's worktree exists elsewhere (check worktree.state)
 *                     worktree-missing   worktrees are in use here; this ticket has none yet
 *                     flat               no worktrees here (cloud session, bare checkout): work in place
 *                     here               --here: the current checkout, no worktree lookup
 *         ticket      --ticket normalized: a pasted tracker URL becomes its id
 *         worktree    { name, path, state: absent|complete|incomplete, hasMetadata, missingRepos[], problems[],
 *                       matchedBy: metadata|name|null, duplicates[] (other folders for this ticket: ask) }
 *                     found by .worktree.json ticketId first, else by folder name, case-insensitively
 *         branch      --branch > the worktree's .worktree.json branch > <prefix>/<name>
 *                     (prefix from --type: bug → fix/, chore → chore/, else feature/)
 *         stages      [[names]] from repos.json dependencies: a repo after the ones it consumes;
 *                     repos in one stage are independent of each other
 *         repos       [{ name, relativePath, path, exists, branch, defaultBranch, onDefault, onBranch, dirty, ahead, behind }]
 *
 *   --freshness [--pull] [--root <dir>] [--repos a,b] [--layer x] [--json]
 *       Fetch every repo (in parallel), then per repo { name, state, detail }:
 *         up-to-date | fast-forwarded | behind | dirty | other-branch | diverged | ahead | fetch-failed | no-origin | missing
 *       --pull fast-forwards ONLY a repo on its default branch, clean and strictly behind.
 *       Nothing else is ever moved (no checkout, stash, rebase or merge commit).
 *       needsDecision lists the repos a person should decide about.
 *
 *   --branches --branch <b> --repos a,b [--ticket <ID>] [--root <dir>] [--json]
 *       Create or switch to <b> in each repo under --root (default: the current
 *       folder's workspace or worktree). Refuses in a main workspace when the
 *       ticket's worktree exists, and in another ticket's worktree. Skips (with a reason) a repo on an unrelated
 *       branch, on another branch for this ticket, or with uncommitted changes.
 *       Never stashes. New branches start from origin/<default>, with no upstream.
 *
 * Exit: 0 ok; 1 a refusal or a failed repo; 2 bad arguments.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  defaultBranch, dependencyOrder, findRoot, findTicket, git, gitRun, isMain, listRepos, parseArgs,
  readJson, readWorkspaceConfig, readWorktreeMeta, samePath, slash,
} from "./lib.mjs";
import { syncRepo } from "./pull.mjs";
import { NAME_RE, normalizeMeta, worktreeSettings } from "./worktree.mjs";

const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const refExists = (repo, ref) => gitRun(repo, ["rev-parse", "--verify", "--quiet", ref]).ok;
const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

// ------------------------------------------------------------------ names and branches

/** The worktree folder for a ticket id, as the worktree skill derives it: chars outside [A-Za-z0-9_.-] → "-". */
export function worktreeName(ticket) {
  const id = String(ticket ?? "").trim();
  if (NAME_RE.test(id) && !/^\.+$/.test(id)) return id;
  const derived = id.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return derived && !/^\.+$/.test(derived) ? derived : null;
}

/**
 * A --ticket value as an id. A pasted tracker URL becomes its id: a GitHub
 * issue/pull URL → "<owner>/<repo>#<n>"; any other URL → the ticket key in it
 * (Jira ?selectedIssue= first, then the segment after /issue/ or /browse/, then
 * any segment). Not a URL → trimmed as given. A URL with no id → null.
 */
export function normalizeTicket(ticket, config = {}) {
  const raw = String(ticket ?? "").trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const segs = url.pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (/^(www\.)?github\.com$/i.test(url.hostname)) {
    const [owner, repo, kind, num] = segs;
    return owner && repo && /^(issues|pull)$/.test(kind ?? "") && /^\d+$/.test(num ?? "") ? `${owner}/${repo}#${num}` : null;
  }
  const after = (key) => { const i = segs.findIndex((s) => s.toLowerCase() === key); return i >= 0 ? segs[i + 1] : null; };
  const candidates = [url.searchParams.get("selectedIssue"), after("issue"), after("browse"), ...segs].filter(Boolean);
  return findTicket(candidates, config);
}

function ticketOrThrow(ticket, config) {
  const id = normalizeTicket(ticket, config);
  if (!id) throw Object.assign(new Error(`Can't find a ticket id in '${String(ticket).trim()}': pass the id (e.g. ENG-123 or owner/repo#12)`), { usage: true });
  return id;
}

/**
 * The ticket's worktree under worktreesDir, whatever its folder is called:
 * a subfolder whose .worktree.json ticketId (legacy linearId too) equals the
 * ticket case-insensitively wins; else one whose name equals worktreeName(ticket)
 * case-insensitively (unless its metadata names another ticket). Returns
 * { path, matchedBy: "metadata"|"name", duplicates: [paths] } or null.
 */
export function findTicketWorktree(worktreesDir, ticket) {
  const id = String(ticket ?? "").toLowerCase();
  const name = worktreeName(ticket)?.toLowerCase();
  let entries = [];
  try { entries = fs.readdirSync(worktreesDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return null; }
  const byMeta = [];
  const byName = [];
  for (const e of entries) {
    const dir = path.join(worktreesDir, e.name);
    const meta = normalizeMeta(readWorktreeMeta(dir));
    const metaId = meta?.ticketId ? String(meta.ticketId).toLowerCase() : null;
    const nameHit = !!name && e.name.toLowerCase() === name;
    if (id && metaId === id) byMeta.push({ dir, nameHit });
    else if (nameHit && !metaId) byName.push({ dir, nameHit });
  }
  byMeta.sort((a, b) => Number(b.nameHit) - Number(a.nameHit));
  const all = [...byMeta, ...byName];
  if (!all.length) return null;
  return { path: all[0].dir, matchedBy: byMeta.length ? "metadata" : "name", duplicates: all.slice(1).map((x) => slash(x.dir)) };
}

/** Branch prefix for an issue type or label: bug/fix/defect → fix/, chore/maintenance → chore/, else feature/. */
export function branchPrefix(type) {
  const t = String(type ?? "").toLowerCase();
  if (/\b(bug|fix|defect|hotfix|bugfix)\b/.test(t)) return "fix/";
  if (/\b(chore|maintenance|housekeeping)\b/.test(t)) return "chore/";
  return "feature/";
}

/** Whether a branch name carries the ticket (by id or its folder-safe form), case-insensitively. */
export function branchHasTicket(branch, ticket) {
  if (!branch || !ticket) return false;
  const b = branch.toLowerCase();
  const name = worktreeName(ticket);
  return b.includes(String(ticket).toLowerCase()) || (!!name && b.includes(name.toLowerCase()));
}

// ------------------------------------------------------------------ worktree classification

/**
 * absent: no folder. complete: .worktree.json lists repos and every one is a
 * checkout. incomplete: anything else (a failed clone, no metadata, a listed repo
 * missing). An incomplete worktree is never to be reused silently.
 */
export function classifyWorktree(wtPath) {
  const out = { path: slash(wtPath), state: "absent", hasMetadata: false, missingRepos: [], problems: [] };
  if (!fs.existsSync(wtPath)) return out;
  const meta = normalizeMeta(readWorktreeMeta(wtPath));
  out.hasMetadata = !!meta;
  if (!meta) {
    out.state = "incomplete";
    out.problems.push("no .worktree.json (an earlier setup probably failed)");
    return out;
  }
  const repos = listRepos(wtPath);
  if (!repos.length) out.problems.push(".worktree.json lists no repos");
  for (const r of repos) if (!r.exists) out.missingRepos.push(r.name);
  if (out.missingRepos.length) out.problems.push(`not cloned: ${out.missingRepos.join(", ")}`);
  out.state = out.problems.length ? "incomplete" : "complete";
  return out;
}

// ------------------------------------------------------------------ repo status

function counts(repoPath, ref) {
  if (!refExists(repoPath, ref)) return { ahead: null, behind: null };
  const r = gitRun(repoPath, ["rev-list", "--left-right", "--count", `HEAD...${ref}`]);
  if (!r.ok) return { ahead: null, behind: null };
  const [ahead, behind] = r.out.split(/\s+/).map((n) => parseInt(n, 10));
  return { ahead: Number.isNaN(ahead) ? null : ahead, behind: Number.isNaN(behind) ? null : behind };
}

/** One repo's state, read only (no fetch): ahead/behind are against origin/<default> as last fetched. */
export function repoState(repo, targetBranch) {
  const base = { name: repo.name, relativePath: repo.relativePath, path: slash(repo.path), exists: !!repo.exists };
  if (!repo.exists) return { ...base, branch: null, defaultBranch: repo.defaultBranch || null, onDefault: false, onBranch: false, dirty: false, ahead: null, behind: null };
  const branch = git(repo.path, ["branch", "--show-current"]) || "(detached)";
  const def = defaultBranch(repo.path, repo.defaultBranch);
  return {
    ...base,
    branch,
    defaultBranch: def,
    onDefault: branch === def,
    onBranch: !!targetBranch && branch === targetBranch,
    dirty: git(repo.path, ["status", "--porcelain"]).length > 0,
    ...counts(repo.path, `origin/${def}`),
  };
}

// ------------------------------------------------------------------ stages

/**
 * repos.json dependencies → pipeline stages: [[names]], each repo one stage after
 * the latest of the repos it consumes. Repos in one stage don't depend on each
 * other. Unknown dependencies are ignored; a cycle doesn't drop anything.
 */
export function stagesOf(repos) {
  const names = new Set(repos.map((r) => r.name));
  const level = new Map();
  for (const r of dependencyOrder(repos)) {
    const deps = (r.dependencies || []).filter((d) => names.has(d) && level.has(d));
    level.set(r.name, deps.length ? Math.max(...deps.map((d) => level.get(d))) + 1 : 0);
  }
  const out = [];
  for (const r of repos) (out[level.get(r.name)] ||= []).push(r.name);
  return out.filter(Boolean);
}

// ------------------------------------------------------------------ resolve

/** The ports-file entry for a worktree (by path, else by name): { slot, ports } or null. */
export function worktreePorts(settings, wtPath, name) {
  const data = readJson(settings.portsFile);
  const all = { ...(data?.allocations || {}), ...(data?.worktrees || {}) };
  for (const [key, e] of Object.entries(all)) {
    if (!e || typeof e !== "object") continue;
    const hit = e.workspace ? samePath(e.workspace, wtPath) : key === name;
    if (hit) return { slot: e.slot ?? null, ports: e.ports || {}, file: slash(settings.portsFile) };
  }
  return null;
}

/**
 * Where the ticket's work lives. opts: { ticket, root (start folder), branch, type, here }.
 * Makes no changes.
 */
export function resolvePlacement(opts = {}) {
  if (typeof opts.ticket !== "string" || !opts.ticket.trim()) throw new Error("--ticket is required");
  const start = path.resolve(opts.root || process.cwd());
  const here = findRoot(start);
  const hereMeta = normalizeMeta(readWorktreeMeta(here));
  const src = hereMeta?.sourceWorkspace;
  const mainRoot = hereMeta && src && fs.existsSync(src) ? path.resolve(src) : here;
  const config = readWorkspaceConfig(mainRoot);
  const settings = worktreeSettings(mainRoot, config);
  const ticket = ticketOrThrow(opts.ticket, config);
  const name = worktreeName(ticket);
  if (!name) throw new Error(`Can't derive a folder name from '${ticket}'`);

  const isThisTicket = (meta, dir) =>
    (meta?.ticketId && meta.ticketId.toLowerCase() === ticket.toLowerCase()) || path.basename(dir).toLowerCase() === name.toLowerCase();

  let placement;
  let wtPath = path.join(settings.dir, name);
  let meta = null;
  let found = null;
  if (opts.here) {
    placement = "here";
    if (hereMeta) { wtPath = here; meta = hereMeta; }
  } else if (hereMeta) {
    if (isThisTicket(hereMeta, here)) { placement = "in-worktree"; wtPath = here; meta = hereMeta; }
    else { placement = "in-other-worktree"; wtPath = here; meta = hereMeta; }
  } else {
    found = findTicketWorktree(settings.dir, ticket);
    if (found) { placement = "worktree-exists"; wtPath = found.path; meta = normalizeMeta(readWorktreeMeta(wtPath)); }
    else if (fs.existsSync(settings.dir) || (config.worktrees && typeof config.worktrees === "object")) placement = "worktree-missing";
    else placement = "flat";
  }

  const worktree = {
    name: placement === "worktree-missing" || placement === "flat" ? name : path.basename(wtPath),
    ticketId: meta?.ticketId ?? null,
    ...classifyWorktree(wtPath),
    matchedBy: found?.matchedBy ?? null,
    duplicates: found?.duplicates ?? [],
  };
  if (placement === "here" && !hereMeta) Object.assign(worktree, { name: null, path: null, state: "absent" });

  let branch;
  let branchSource;
  if (typeof opts.branch === "string" && opts.branch) { branch = opts.branch; branchSource = "flag"; }
  else if (meta?.branch && placement !== "in-other-worktree") { branch = meta.branch; branchSource = "worktree"; }
  else { branch = `${branchPrefix(opts.type)}${name}`; branchSource = "convention"; }

  const inWorktree = ["in-worktree", "worktree-exists"].includes(placement) || (placement === "here" && hereMeta);
  const baseDir = placement === "here" || placement === "in-worktree" || placement === "in-other-worktree"
    ? here
    : placement === "worktree-exists" ? wtPath : mainRoot;
  const ports = inWorktree && worktree.state !== "absent" ? worktreePorts(settings, baseDir, worktree.name) : null;
  const listed = fs.existsSync(baseDir) ? listRepos(baseDir) : [];
  // A worktree lists only its own repos: take their dependencies from the main workspace too.
  const known = listRepos(mainRoot);
  const withDeps = listed.map((r) => (r.dependencies?.length ? r : { ...r, dependencies: known.find((k) => k.name === r.name)?.dependencies || [] }));

  return {
    placement,
    ticket,
    mainRoot: slash(mainRoot),
    baseDir: slash(baseDir),
    worktree,
    branch,
    branchSource,
    ports,
    stages: stagesOf(withDeps),
    repos: listed.map((r) => repoState(r, branch)),
  };
}

// ------------------------------------------------------------------ freshness

function gitAsync(cwd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? "").trim(), err: String(stderr || err?.message || "").trim() });
    });
  });
}

/** Repos under root picked by name/relativePath and/or layer; throws naming the valid ones. */
export function pickRepos(root, names = [], layer = null) {
  const all = listRepos(root);
  const lc = (s) => String(s ?? "").toLowerCase();
  let picked = all;
  if (names.length) {
    const unknown = names.filter((n) => !all.some((r) => lc(r.name) === lc(n) || lc(r.relativePath) === lc(slash(n))));
    if (unknown.length) {
      const err = new Error(`Unknown repo(s): ${unknown.join(", ")}. Valid: ${all.map((r) => r.name).join(", ") || "(none found)"}`);
      err.usage = true;
      throw err;
    }
    picked = all.filter((r) => names.some((n) => lc(r.name) === lc(n) || lc(r.relativePath) === lc(slash(n))));
  }
  if (layer) {
    picked = picked.filter((r) => lc(r.layer) === lc(layer));
    if (!picked.length) {
      const err = new Error(`No repos in layer '${layer}'. Layers: ${[...new Set(all.map((r) => r.layer).filter(Boolean))].join(", ") || "(none)"}`);
      err.usage = true;
      throw err;
    }
  }
  return picked;
}

const STATE_MAP = { "would-ff": "behind", "ff-failed": "behind", "no-upstream": "fetch-failed" };

/**
 * Fetch, then classify (and with pull, fast-forward the safe ones). The rule is
 * pull.mjs's: only on the default branch, clean (tracked files) and strictly behind.
 */
export async function checkFreshness({ root = process.cwd(), pull = false, repos = [], layer = null } = {}) {
  const base = findRoot(root);
  const targets = pickRepos(base, repos, layer);
  const fetched = await Promise.all(targets.map(async (r) => {
    if (!r.exists || !git(r.path, ["remote", "get-url", "origin"])) return null;
    return gitAsync(r.path, ["fetch", "--quiet", "origin"]);
  }));
  const results = targets.map((r, i) => {
    const s = syncRepo(r, { dryRun: !pull, fetch: fetched[i] ?? undefined });
    const state = STATE_MAP[s.state] || s.state;
    let detail = s.detail;
    if (s.state === "would-ff") detail = `${s.behind} behind origin/${s.defaultBranch}: safe to fast-forward (--pull)`;
    if (state === "other-branch" && s.behind > 0) detail = `${detail}; ${s.behind} behind origin/${s.defaultBranch}`;
    return {
      name: r.name, relativePath: r.relativePath, path: slash(r.path), state, detail,
      branch: s.branch ?? null, defaultBranch: s.defaultBranch ?? null, dirty: s.dirty ?? null,
      ahead: s.ahead ?? null, behind: s.behind ?? null, ffRefused: s.state === "ff-failed",
    };
  });
  const decide = (r) => ["dirty", "diverged", "fetch-failed"].includes(r.state) || r.ffRefused || (r.state === "other-branch" && r.behind > 0);
  return {
    root: slash(base),
    pulled: pull,
    fastForwarded: results.filter((r) => r.state === "fast-forwarded").map((r) => r.name),
    needsDecision: results.filter(decide).map((r) => r.name),
    repos: results,
  };
}

// ------------------------------------------------------------------ branches

/**
 * Creates or switches to `branch` in each named repo under root. Returns
 * { root, branch, ticket, repos: [{ name, path, state, reason }] } where state is
 * created | switched | already-on | skipped | missing | failed. Throws (with
 * .refused) when root is a main workspace and the ticket's worktree exists.
 */
export function createBranches({ root = process.cwd(), branch, repos = [], ticket = null } = {}) {
  if (typeof branch !== "string" || !branch) throw Object.assign(new Error("--branch is required"), { usage: true });
  if (branch.startsWith("-") || !gitRun(process.cwd(), ["check-ref-format", `refs/heads/${branch}`]).ok) throw Object.assign(new Error(`Invalid branch name '${branch}'`), { usage: true });
  if (!repos.length) throw Object.assign(new Error("--repos is required (comma-separated names or relativePaths)"), { usage: true });
  const base = findRoot(root);
  const config = readWorkspaceConfig(base);
  const id = ticket ? ticketOrThrow(ticket, config) : findTicket([branch], config);
  const meta = normalizeMeta(readWorktreeMeta(base));
  const refuse = (reason, message) => { throw Object.assign(new Error(message), { refused: true, reason }); };

  if (!meta && id) {
    const found = findTicketWorktree(worktreeSettings(base, config).dir, id);
    if (found) refuse("in the main workspace", `${id}'s worktree exists at ${slash(found.path)}, but --root is the main workspace (${slash(base)}). Re-run with --root "${slash(found.path)}".`);
  }
  if (meta?.ticketId && id && String(meta.ticketId).toLowerCase() !== id.toLowerCase()) {
    refuse("in another ticket's worktree", `--root (${slash(base)}) is ${meta.ticketId}'s worktree, not ${id}'s. Use ${id}'s own worktree (or create one).`);
  }

  const results = [];
  for (const r of pickRepos(base, repos)) {
    const out = { name: r.name, path: slash(r.path) };
    const done = (state, reason = null, extra = {}) => results.push({ ...out, state, reason, ...extra });
    if (!r.exists) { done("missing", "not cloned here"); continue; }
    const current = git(r.path, ["branch", "--show-current"]);
    if (current === branch) { done("already-on"); continue; }
    const def = defaultBranch(r.path, r.defaultBranch);
    if (!current) { done("skipped", "detached HEAD: left alone"); continue; }
    if (current !== def) {
      done("skipped", branchHasTicket(current, id)
        ? `already on ${current} for this ticket: pass --branch ${current} to keep one branch per ticket`
        : `on ${current}, an unrelated branch: left alone`);
      continue;
    }
    if (git(r.path, ["status", "--porcelain", "--untracked-files=no"])) {
      done("skipped", `uncommitted changes on ${def}: commit or move them first (never stashed)`);
      continue;
    }
    gitRun(r.path, ["fetch", "--quiet", "origin"], { timeout: 120000 }); // offline is fine
    let res;
    let state;
    let from = null;
    if (refExists(r.path, `refs/heads/${branch}`)) {
      res = gitRun(r.path, ["switch", "--quiet", branch]);
      state = "switched";
    } else if (refExists(r.path, `refs/remotes/origin/${branch}`)) {
      res = gitRun(r.path, ["switch", "--quiet", "--track", "-c", branch, `origin/${branch}`]);
      state = "switched";
      from = `origin/${branch}`;
    } else {
      from = refExists(r.path, `refs/remotes/origin/${def}`) ? `origin/${def}` : def;
      res = gitRun(r.path, ["switch", "--quiet", "--no-track", "-c", branch, from]);
      state = "created";
    }
    if (res.ok) done(state, null, { from });
    else done("failed", firstLine(res.err) || "git switch failed");
  }
  return { root: slash(base), branch, ticket: id, repos: results };
}

// ------------------------------------------------------------------ CLI

const USAGE = `Usage:
  node implement.mjs --ticket <ID> --resolve [--root <dir>] [--branch <b>] [--type <issue type>] [--here] [--json]
  node implement.mjs --freshness [--pull] [--root <dir>] [--repos a,b] [--layer <layer>] [--json]
  node implement.mjs --branches --branch <b> --repos a,b [--ticket <ID>] [--root <dir>] [--json]`;

function printResolve(r) {
  const lines = [
    `Placement: ${r.placement}`,
    `Base dir:  ${r.baseDir}`,
    `Worktree:  ${r.worktree.path ? `${r.worktree.name} (${r.worktree.state})${r.worktree.problems.length ? `: ${r.worktree.problems.join("; ")}` : ""}` : "(none)"}`,
    `Branch:    ${r.branch} (from ${r.branchSource})`,
  ];
  if (r.ports) lines.push(`Ports:     ${Object.entries(r.ports.ports).map(([k, v]) => `${k} ${v}`).join(", ") || "(none)"}`);
  lines.push("", "Repos:");
  for (const x of r.repos) {
    if (!x.exists) { lines.push(`  ${x.name}: not cloned`); continue; }
    const vs = x.behind === null ? "" : `, +${x.ahead}/-${x.behind} vs origin/${x.defaultBranch}`;
    lines.push(`  ${x.name}: ${x.branch}${x.onBranch ? " (target)" : ""}${x.dirty ? ", dirty" : ""}${vs}`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const args = parseArgs(argv, { booleans: ["resolve", "freshness", "branches", "pull", "here", "json"] });
  const json = args.json === true;
  const print = (s) => process.stdout.write(s + "\n");
  const root = typeof args.root === "string" ? path.resolve(args.root) : process.cwd();
  const str = (k) => (typeof args[k] === "string" ? args[k] : null);

  if (args.resolve) {
    const r = resolvePlacement({ ticket: str("ticket"), root, branch: str("branch"), type: str("type"), here: args.here === true });
    print(json ? JSON.stringify(r, null, 2) : printResolve(r));
    return;
  }
  if (args.freshness) {
    const r = await checkFreshness({ root, pull: args.pull === true, repos: list(args.repos), layer: str("layer") });
    if (json) return print(JSON.stringify(r, null, 2));
    print(`Freshness at ${r.root}${r.pulled ? " (--pull)" : ""}`);
    for (const x of r.repos) print(`  ${x.name}: ${x.state}: ${x.detail}`);
    if (r.needsDecision.length) print(`Needs a decision: ${r.needsDecision.join(", ")}`);
    return;
  }
  if (args.branches) {
    try {
      const r = createBranches({ root, branch: str("branch"), repos: list(args.repos), ticket: str("ticket") });
      if (json) print(JSON.stringify(r, null, 2));
      else {
        print(`Branch ${r.branch} under ${r.root}`);
        for (const x of r.repos) print(`  ${x.name}: ${x.state}${x.from ? ` from ${x.from}` : ""}${x.reason ? `: ${x.reason}` : ""}`);
      }
      if (r.repos.some((x) => x.state === "failed")) process.exitCode = 1;
    } catch (e) {
      if (!e.refused) throw e;
      if (json) print(JSON.stringify({ refused: true, reason: e.reason ?? null, error: e.message }, null, 2));
      process.stderr.write(`Refused: ${e.message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  process.stderr.write(USAGE + "\n");
  process.exitCode = 2;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = e.usage || /required|Can't derive/.test(e.message) ? 2 : 1;
  });
}

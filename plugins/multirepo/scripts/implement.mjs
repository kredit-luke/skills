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
 *   --recent --since <ISO date> [--root <dir>] [--repos a,b] [--paths p1,p2] [--json]
 *       What landed on each repo's origin/<default> since the date (the ticket's creation), as last
 *       fetched: no fetch of its own (--freshness just fetched). --since is ISO 8601: YYYY-MM-DD,
 *       optionally with a time (no offset = UTC; ±hh:mm or ±hhmm); anything else exits 2. Per repo
 *         { name, state: ok|shallow|error|no-origin|missing, detail, ref, base, paths, missingPaths,
 *           notInRepo, removedPaths, files: [{ path, status, from? }], commits: [{ sha, date, subject }],
 *           docs: [{ path, kind: readme|contributing|decision, status }] }
 *       base is the newest first-parent commit at or before the date, so a branch merged after it counts.
 *       shallow: the history doesn't reach the date; the lists start at the oldest commit it has.
 *       error: a git read (rev-list, diff or log) failed or timed out (detail says which and why,
 *       then any notes gathered before it); the CLI exits 1. Other states exit 0.
 *       --paths (relative to each repo; absolute or with a '..' segment exits 2) narrows files and commits, but the root docs (the root README,
 *       CONTRIBUTING, decision records at the root level or under docs/) and files renamed out of a
 *       watched folder are kept; a --paths the tip doesn't have is in removedPaths when the base had
 *       it, else in missingPaths (a typo, named in detail) when no picked repo has it, or notInRepo
 *       when another one does. No net change still lists the commits.
 *       A partial clone diffs with --no-renames (no blob fetches; detail says so); past the rename
 *       limit (-l20000) renames show as a delete and an add (detail says so).
 *       changed[] names the repos with files.
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
  defaultBranch, dependencyOrder, findRoot, findTicket, git, gitRun, isMain, isoUtc, listRepos, parseArgs,
  readJson, readWorkspaceConfig, readWorktreeMeta, samePath, slash,
} from "./lib.mjs";
import { syncRepo } from "./pull.mjs";
import { parseNameStatus } from "./repo-status.mjs";
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

// ------------------------------------------------------------------ recent changes

const DOC_EXT = "(md|mdx|markdown|rst|txt|adoc)";
const README_RE = new RegExp(`^readme(\\.${DOC_EXT})?$`, "i");
const CONTRIBUTING_RE = new RegExp(`^contributing(\\.${DOC_EXT})?$`, "i");
const DOC_FILE_RE = new RegExp(`\\.${DOC_EXT}$`, "i");
const DECISION_DIRS = "adrs?|decisions|decision-records|architecture-decisions";
const DECISION_DIR_RE = new RegExp(`(^|/)(${DECISION_DIRS})/`, "i");
const REPO_WIDE_DECISION_DIR_RE = new RegExp(`^(docs|${DECISION_DIRS})$`, "i");
const DECISION_NAME_RE = /^adr[-_ ]?\d+|\.adr\.[a-z]+$/i;

/**
 * What kind of guiding doc a repo path is: "readme" (README, README.<doc ext>),
 * "contributing" (CONTRIBUTING likewise), "decision" (a doc file under an
 * adr/, adrs/, decisions/, decision-records/ or architecture-decisions/ folder,
 * or named ADR-<n>…, ADR_<n>… or *.adr.<doc ext>), else null.
 */
export function docKind(file) {
  const p = slash(String(file ?? ""));
  const base = p.split("/").pop();
  if (README_RE.test(base)) return "readme";
  if (CONTRIBUTING_RE.test(base)) return "contributing";
  if (!DOC_FILE_RE.test(base)) return null;
  if (DECISION_DIR_RE.test(p) || DECISION_NAME_RE.test(base)) return "decision";
  return null;
}

/**
 * Docs that bind every folder of a repo, kept when --paths narrows the rest: the
 * root ones only. The README at the root; CONTRIBUTING where GitHub looks for it
 * (the root, docs/, .github/); decision records at the root level: in a root
 * decision folder (adr/…, decisions/…), anywhere under the root docs/, or an ADR
 * file at the root. Another top-level folder's (web/docs/adr/x.md,
 * web/CONTRIBUTING.md) count only when that folder is watched.
 */
const repoWide = (file, kind = docKind(file)) => {
  const parts = file.split("/");
  if (kind === "readme") return parts.length === 1;
  if (kind === "contributing") return parts.length === 1 || (parts.length === 2 && /^(docs|\.github)$/i.test(parts[0]));
  if (kind === "decision") return parts.length === 1 || REPO_WIDE_DECISION_DIR_RE.test(parts[0]);
  return false;
};

const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "modified" };

/** `git diff --name-status -z` → [{ path, status, from? }], via repo-status's parser. */
const nameStatus = (out) => parseNameStatus(out).map(({ status, path: p, oldPath }) => {
  const s = STATUS[status[0]] || "modified";
  return oldPath === undefined ? { path: p, status: s } : { path: p, status: s, from: oldPath };
});

/** Large: a monorepo's diff or log since an old date passes Node's 1 MB default; past it is an error, never a short list. */
const RECENT_MAX_BUFFER = 64 * 1024 * 1024;
/** Per git read: a monorepo's diff or log over months can outlast gitRun's 30 s default. */
const RECENT_TIMEOUT = 120000;
/** Pathspec characters per git log call: far under Windows' ~32K command line, however many files a folder move adds. */
const PATHSPEC_LIMIT = 8000;
/** The diff's rename limit (-l): far over git's default (1000), so a big change still pairs its renames. */
const RENAME_LIMIT = 20000;

/**
 * A clone that fetches objects on demand (git clone --filter=…): a promisor remote
 * or extensions.partialClone set. Rename detection there would fetch file contents.
 */
export function isPartialClone(repo) {
  if (git(repo, ["config", "--get", "extensions.partialClone"])) return true;
  const promisors = gitRun(repo, ["config", "--type=bool", "--get-regexp", "^remote\\..*\\.promisor$"]);
  return promisors.ok && promisors.out.split("\n").some((l) => / true$/.test(l.trim()));
}

/**
 * The repo-wide docs (see repoWide) at any of these commits, read from trees only (never a blob a partial clone
 * would fetch): the root's files, and the files under the root folders that can hold them (docs/, .github/, a root
 * decision folder). → { ok, paths } or the failed gitRun.
 */
function repoWideDocs(repo, commits, opts) {
  const paths = new Set();
  for (const c of commits) {
    const top = gitRun(repo, ["ls-tree", "-z", c], { ...opts, trim: false });
    if (!top.ok) return top;
    const dirs = [];
    for (const entry of top.out.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const type = entry.slice(0, tab).split(" ")[1];
      const name = entry.slice(tab + 1);
      if (type === "blob" && repoWide(name)) paths.add(name);
      else if (type === "tree" && (REPO_WIDE_DECISION_DIR_RE.test(name) || /^\.github$/i.test(name))) dirs.push(name);
    }
    if (!dirs.length) continue;
    const below = gitRun(repo, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", c, "--", ...dirs], { ...opts, trim: false });
    if (!below.ok) return below;
    for (const p of below.out.split("\0").filter(Boolean)) if (repoWide(p)) paths.add(p);
  }
  return { ok: true, paths: [...paths] };
}

/** Where a repo's typo note goes in its notes, filled in once every repo is read. */
const MISSING = Symbol("missing paths");

/** Pathspec entries in groups whose joined length stays under limit (an entry longer than it gets a group of its own). */
function chunkPaths(entries, limit) {
  const groups = [];
  let group = [];
  let len = 0;
  for (const e of entries) {
    if (group.length && len + e.length + 1 > limit) { groups.push(group); group = []; len = 0; }
    group.push(e);
    len += e.length + 1;
  }
  if (group.length) groups.push(group);
  return groups;
}

/**
 * What landed on each repo's origin/<default> since a date, as last fetched (no
 * fetch: implement's freshness check fetched every repo just before). Per repo
 * { name, state, detail, ref, base, paths, missingPaths, notInRepo, removedPaths, files: [{ path, status, from? (renamed/copied) }],
 * commits: [{ sha, date, subject }] (newest first), docs: [{ path, kind, status }] }.
 * since must be an ISO 8601 date, YYYY-MM-DD optionally with a time (a time
 * without an offset is UTC; an offset is ±hh:mm or ±hhmm, so a tracker's raw
 * created timestamp works, Jira's included: lib's isoUtc); anything else is a
 * usage error. git gets it as UTC.
 * state: ok; shallow (the clone's history doesn't reach the date: the lists hold
 * only what changed after its oldest commit, which is base); error (a git read
 * failed: rev-list for the baseline, the diff, ls-tree or the log, including output past
 * maxBuffer (64 MB) or a read past timeout (120 s each); detail says which and
 * why, then the notes gathered before it; files, commits and docs are empty, the
 * path lists are kept); no-origin or missing (empty lists).
 * missingPaths: the --paths neither the tip nor base has (exact case) in this
 * repo nor in any other picked repo that got that far, so "nothing changed" there
 * may be a typo (detail names them); notInRepo: the ones this repo lacks but
 * another picked repo has (another repo's folder; no note). removedPaths: the ones
 * base has and the tip doesn't (removed or moved since the date; detail names them).
 * The diff's rename limit is renameLimit (20000, far over git's 1000); past it git
 * skips inexact renames with only a warning, so they show as a delete and an add
 * and detail says so.
 * An empty net diff (a change merged, then reverted) still lists its commits.
 * In a partial clone (git clone --filter=…) the diff skips rename detection, which
 * would fetch file contents: a rename shows as a delete and an add (detail says so).
 *
 * The baseline is the newest first-parent commit on origin/<default> at or before
 * the date (the branch as it stood then), so a branch committed earlier and merged
 * later counts. A branch committed before the date and fast-forwarded onto the
 * default branch after it is missed (its commits become first-parent history
 * dated before the date); GitHub's merge, squash and rebase merges all write new
 * commits, so only local --ff-only pushes do this. A date before a full clone's
 * first commit diffs from the empty tree (every file added; detail says so).
 * paths (relative to each repo; absolute or with a '..' segment is a usage error) narrow files and
 * commits, except the root docs that bind the whole repo (see repoWide: the root
 * README, CONTRIBUTING at the root, docs/ or .github/, decision records at the root
 * level or under the root docs/) and files renamed out of a watched folder or out of
 * a repo-wide doc's place (kind by the new path); the log also covers every repo-wide
 * doc base or the tip has (ls-tree, trees only), so a root doc changed and then reverted
 * still lists its commits; another top-level folder's decision records count only
 * when it's watched. docs never
 * lists a deleted file. Past pathspecLimit characters (a big folder move) the log's
 * pathspec is split over several calls and their commits merged.
 */
export function recentChanges({
  root = process.cwd(), since, repos = [], paths = [], maxBuffer = RECENT_MAX_BUFFER, timeout = RECENT_TIMEOUT, pathspecLimit = PATHSPEC_LIMIT,
  renameLimit = RENAME_LIMIT,
} = {}) {
  if (typeof since !== "string" || !since.trim()) throw Object.assign(new Error("--since is required (an ISO 8601 date, e.g. the ticket's creation date)"), { usage: true });
  const iso = isoUtc(since);
  if (!iso) throw Object.assign(new Error(`--since '${since}' isn't an ISO 8601 date: pass YYYY-MM-DD, optionally with a time (2026-02-01T09:30:00Z; a time without an offset is UTC)`), { usage: true });
  const absolute = paths.find((p) => path.isAbsolute(p) || /^[a-z]:/i.test(p) || /^[\\/]/.test(p));
  if (absolute) throw Object.assign(new Error(`--paths takes folders relative to each repo; '${absolute}' is absolute`), { usage: true });
  const upward = paths.find((p) => slash(p).split("/").includes(".."));
  if (upward) throw Object.assign(new Error(`--paths takes folders inside each repo; '${upward}' has a '..' segment`), { usage: true });
  const wanted = [...new Set(paths.map((p) => slash(p).replace(/^(\.\/)+/, "").replace(/\/+$/, "")).filter((p) => p && p !== "."))];
  const under = (f) => !wanted.length || (f != null && wanted.some((p) => f === p || f.startsWith(`${p}/`)));
  const base = findRoot(root);
  const day = iso.slice(0, 10);
  const opts = { maxBuffer, timeout };
  const quoted = (ps) => ps.map((p) => `'${p}'`).join(", ");

  const results = pickRepos(base, repos).map((r) => {
    const def = r.exists ? defaultBranch(r.path, r.defaultBranch) : r.defaultBranch || null;
    const ref = def ? `origin/${def}` : null;
    const out = { name: r.name, relativePath: r.relativePath, path: slash(r.path), state: "ok", detail: null, defaultBranch: def, ref, base: null, paths: wanted, missingPaths: [], notInRepo: [], removedPaths: [], files: [], commits: [], docs: [] };
    if (!r.exists) return { ...out, state: "missing", detail: "not cloned here" };
    if (!refExists(r.path, `refs/remotes/${ref}`)) return { ...out, state: "no-origin", detail: `no ${ref} to compare (a local-only repo, or never fetched)` };
    // notes become detail after every repo is read (the typo note needs them all); MISSING marks where it goes.
    const notes = [];
    let removedPaths = [];
    let absent = null; // null until the paths are checked: a repo that failed before then can't say a path is a typo
    const failed = (what, res, fromSha = null) => ({
      ...out, base: fromSha, state: "error", removedPaths, absent, notes: [`git ${what} failed: ${firstLine(res.err) || "unknown error"}`, ...notes],
    });

    // A failed read (timeout, corrupt object) is an error; only an empty successful one means "nothing before the date".
    const baseRun = gitRun(r.path, ["rev-list", "-1", "--first-parent", `--before=${iso}`, ref], { timeout });
    if (!baseRun.ok) return failed("rev-list", baseRun);
    let from = baseRun.out || null;
    let state = "ok";
    if (!from && git(r.path, ["rev-parse", "--is-shallow-repository"]) === "true") {
      // The history stops after the date: diff from the oldest commit it has, never from the empty tree.
      const oldestRun = gitRun(r.path, ["rev-list", "--first-parent", "--max-parents=0", ref], opts);
      if (!oldestRun.ok) return failed("rev-list", oldestRun);
      from = oldestRun.out.split("\n").filter(Boolean).pop() || null;
      const oldest = from ? (isoUtc(git(r.path, ["log", "-1", "--format=%cI", from])) || "").slice(0, 10) : "";
      state = "shallow";
      notes.push(`a shallow clone whose history doesn't reach ${day}: lists only what changed after its oldest commit${oldest ? ` (${oldest})` : ""}; run git fetch --unshallow for the full list`);
    } else if (!from) {
      notes.push(`${day} is before the first commit on ${ref}: every file counts as added`);
    }
    // A watched folder the tip doesn't have would read as "nothing changed": removed since the date when base has it, else
    // a typo or the wrong case (git paths are exact). rev-parse reads trees only, never a blob a partial clone would fetch.
    const has = (commit, p) => gitRun(r.path, ["rev-parse", "--verify", "--quiet", `${commit}:${p}`], { timeout }).ok;
    const gone = wanted.filter((p) => !has(ref, p));
    removedPaths = from ? gone.filter((p) => has(from, p)) : [];
    absent = gone.filter((p) => !removedPaths.includes(p));
    if (removedPaths.length) notes.push(`${quoted(removedPaths)} ${removedPaths.length === 1 ? "was" : "were"} removed or moved on ${ref} since ${day}`);
    notes.push(MISSING);
    const partial = isPartialClone(r.path);
    if (partial) notes.push("a partial clone: renames show as a delete and an add (detecting them would fetch file contents)");
    const emptyTree = from ? null : git(r.path, ["hash-object", "-t", "tree", "--stdin"]);
    const diff = gitRun(r.path, ["diff", "--no-ext-diff", "--name-status", "-z", ...(partial ? ["--no-renames"] : ["-M", `-l${renameLimit}`]), from || emptyTree, ref], { ...opts, trim: false });
    if (!diff.ok) return failed("diff", diff, from);
    // Past the limit git skips inexact renames with only a warning on stderr (exit 0).
    if (!partial && /rename detection was skipped/i.test(diff.err)) notes.push("too many files for rename detection: renames show as a delete and an add");
    const kept = nameStatus(diff.out).map((f) => ({ f, kind: docKind(f.path) }))
      .filter(({ f, kind }) => under(f.path) || under(f.from) || repoWide(f.path, kind) || (f.from != null && repoWide(f.from)));
    const files = kept.map(({ f }) => f);

    // The log runs even with no net change (merged, then reverted), so its commits show. Its pathspec: the watched
    // folders, the files kept outside them (repo-wide docs, renames in or out) and their old names, and every
    // repo-wide doc on base or the tip whatever the net diff (a root README changed, then reverted), chunked.
    let rootDocs = [];
    if (wanted.length) {
      const listed = repoWideDocs(r.path, [from, ref].filter(Boolean), opts);
      if (!listed.ok) return failed("ls-tree", listed, from);
      rootDocs = listed.paths;
    }
    const spec = wanted.length ? [...new Set([...wanted, ...[...files.flatMap((f) => [f.path, f.from]), ...rootDocs].filter((p) => p && !under(p))])] : [];
    const groups = spec.length ? chunkPaths(spec, pathspecLimit) : [[]];
    const seen = new Map();
    for (const group of groups) {
      const log = gitRun(r.path, ["--literal-pathspecs", "log", "--format=%h%x1f%cI%x1f%s", from ? `${from}..${ref}` : ref, "--", ...group], opts);
      if (!log.ok) return failed("log", log, from);
      for (const l of log.out.split("\n").filter(Boolean)) {
        const [sha, date, subject] = l.split("\x1f");
        if (!seen.has(sha)) seen.set(sha, { sha, date, subject });
      }
    }
    const commits = [...seen.values()];
    if (groups.length > 1) commits.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)); // newest first; ties keep their order
    const docs = kept.filter(({ f, kind }) => kind && f.status !== "deleted").map(({ f, kind }) => ({ path: f.path, kind, status: f.status }));
    return { ...out, base: from, state, removedPaths, absent, notes, files, commits, docs };
  });

  // A path absent (tip and base) from every repo that was read is a typo; absent from only some, it's another repo's folder.
  const read = results.filter((x) => x.absent);
  const typo = (p) => read.every((x) => x.absent.includes(p));
  const repoResults = results.map(({ absent, notes, ...x }) => {
    if (!notes) return x;
    const missingPaths = (absent || []).filter(typo);
    const notInRepo = (absent || []).filter((p) => !typo(p));
    const missingNote = missingPaths.length
      ? `${quoted(missingPaths)} ${missingPaths.length === 1 ? "isn't a path" : "aren't paths"} on ${x.ref} (check the spelling and case)` : null;
    const detail = notes.map((n) => (n === MISSING ? missingNote : n)).filter(Boolean).join("; ") || null;
    return { ...x, detail, missingPaths, notInRepo };
  });
  return { root: slash(base), since: iso, paths: wanted, changed: repoResults.filter((r) => r.files.length).map((r) => r.name), repos: repoResults };
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
  node implement.mjs --recent --since <ISO date> [--root <dir>] [--repos a,b] [--paths p1,p2] [--json]
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
  const args = parseArgs(argv, { booleans: ["resolve", "freshness", "recent", "branches", "pull", "here", "json"] });
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
  if (args.recent) {
    const r = recentChanges({ root, since: str("since"), repos: list(args.repos), paths: list(args.paths) });
    if (r.repos.some((x) => x.state === "error")) process.exitCode = 1; // no-origin, missing and shallow are informational
    if (json) return print(JSON.stringify(r, null, 2));
    const day = r.since.slice(0, 10);
    print(`Changes on the default branch since ${r.since}${r.paths.length ? ` under ${r.paths.join(", ")}` : ""} (as last fetched)`);
    for (const x of r.repos) {
      if (!["ok", "shallow"].includes(x.state)) { print(`  ${x.name}: ${x.state}: ${x.detail}`); continue; }
      const note = x.detail ? ` (${x.detail})` : "";
      const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
      if (!x.files.length) {
        print(`  ${x.name}: ${x.commits.length ? `no net change on ${x.ref} since ${day} (${n(x.commits.length, "commit")})` : `nothing on ${x.ref} since ${day}`}${note}`);
        continue;
      }
      print(`  ${x.name}: ${n(x.files.length, "file")}, ${n(x.commits.length, "commit")} on ${x.ref} since ${day}${note}`);
      for (const d of x.docs) print(`    doc (${d.kind}): ${d.path}`);
      for (const f of x.files) print(`    ${f.status}: ${f.from ? `${f.from} -> ` : ""}${f.path}`);
    }
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

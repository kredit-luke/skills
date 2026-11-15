/**
 * What a run changed in the code: the data behind the run page's Changes tab.
 *
 * Baselines: at the start of every turn, each git repo in the run's workspace is
 * snapshotted without being touched: HEAD, `git stash create` (a commit object
 * of the working tree, including uncommitted edits, that is NOT added to the
 * stash list), and the untracked files. Stored in runs/<id>.baselines.json.
 *
 * Changes are then "working tree now vs the first turn's snapshot", so edits
 * that were already there when the run started don't show. Repos the run
 * touched that had no baseline (a worktree it created, or a run from before
 * baselines existed) are compared against where their branch left main.
 *
 * Which repos: every baselined repo that has changed, plus every repo holding a
 * file the run's Edit/Write/NotebookEdit calls touched (nearest .git upwards),
 * which is how a run started in main finds the worktree it created. A run that
 * worked in a worktree (see shared/run-workspace.ts) shows only that worktree's
 * repos: main's repos change under it for reasons that aren't the run's.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { RunMeta, RunEvent } from "../../shared/api.ts";
import { within } from "../../shared/run-workspace.ts";

const SKIP_DIRS = new Set(["node_modules", "worktrees", ".git", ".claude", "dist", "bin", "obj"]);
const MAX_UNTRACKED = 5000;
/** How long a result is served again: a working run's repos keep changing, a finished run's rarely do (Refresh asks anew). */
const CACHE_RUNNING_MS = 4000;
const CACHE_IDLE_MS = 30_000;
/** Git processes at a time, across every run. See git(). */
const GIT_CONCURRENCY = 3;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface RepoBaseline { head: string; snap: string; untracked: string[] }
/** The worktree a run worked in and its repos (absolute paths). */
export interface RunWorktree { path: string; repos: string[] }
interface TurnBaseline { turn: number; at: string; repos: Record<string, RepoBaseline> }

export interface ChangedFile { file: string; status: string; adds: number | null; dels: number | null }
export interface ChangeScope {
  repo: string;          // display name, relative to the run's workspace when inside it
  path: string;          // absolute repo path (the id for /diff)
  branch: string;
  baseKind: "run-start" | "branch";
  baseLabel: string;
  commits: { hash: string; message: string }[];
  files: ChangedFile[];
}

type Changes = { scopes: ChangeScope[]; hasBaseline: boolean; computedAt: string };

/**
 * Starting a process blocks the event loop until it has started (tens of milliseconds
 * each on Windows), and a workspace of many repos needs dozens of them: started all at
 * once, the server answers nothing else for seconds. So a few run at a time, and each
 * starts on a turn of its own, with other requests answered in between.
 */
const gitQueue: (() => void)[] = [];
let gitRunning = 0;
function nextGit(): void {
  if (gitRunning >= GIT_CONCURRENCY) return;
  const start = gitQueue.shift();
  if (!start) return;
  gitRunning++;
  setImmediate(start);
}

function git(args: string[], cwd: string, timeout = 20000): Promise<string> {
  return new Promise((resolve) => {
    gitQueue.push(() => {
      const done = (out: string) => { gitRunning--; resolve(out); nextGit(); };
      try {
        execFile("git", args, { cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => done(err && !stdout ? "" : String(stdout || "")));
      } catch { done(""); }
    });
    nextGit();
  });
}

/**
 * The checked-out branch ("HEAD" when detached), as `git rev-parse --abbrev-ref HEAD` says it,
 * read from the checkout's HEAD file (a worktree's .git is a file naming its git dir): no process.
 */
async function branchOf(repo: string): Promise<string> {
  try {
    let dir = path.join(repo, ".git");
    if (fs.statSync(dir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dir, "utf-8"));
      if (!m) throw new Error("no gitdir");
      dir = path.resolve(repo, m[1].trim());
    }
    const head = fs.readFileSync(path.join(dir, "HEAD"), "utf-8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    if (/^[0-9a-f]{40,64}$/.test(head)) return "HEAD";
  } catch { /* ask git */ }
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).trim();
}

export class RunChanges {
  private runsDir: string;
  private cache = new Map<string, { at: number; scopes: ChangeScope[] }>();
  /** Each run's last cache key (which worktree it was computed for), so cached() needs no events. */
  private lastKey = new Map<string, string>();
  /** Computations under way, by cache key: requests that arrive meanwhile share the one. */
  private inFlight = new Map<string, Promise<Changes>>();
  private roots = new Map<string, string | null>();

  constructor(runsDir: string) {
    this.runsDir = runsDir;
  }

  private file(id: string) { return path.join(this.runsDir, `${id}.baselines.json`); }

  private read(id: string): TurnBaseline[] {
    try { return JSON.parse(fs.readFileSync(this.file(id), "utf-8")).turns || []; } catch { return []; }
  }

  /** Snapshot every repo in the run's workspace for this turn (never modifies them). */
  async snapshot(meta: RunMeta): Promise<void> {
    const repos = listRepos(meta.cwd);
    const out: Record<string, RepoBaseline> = {};
    await Promise.all(repos.map(async (repo) => {
      const head = (await git(["rev-parse", "HEAD"], repo)).trim();
      if (!head) return;
      const snap = (await git(["stash", "create"], repo)).trim() || head;
      const untracked = (await git(["ls-files", "--others", "--exclude-standard"], repo)).split(/\r?\n/).filter(Boolean).slice(0, MAX_UNTRACKED);
      out[repo] = { head, snap, untracked };
    }));
    const turns = this.read(meta.id).filter((t) => t.turn !== meta.turns);
    turns.push({ turn: meta.turns, at: new Date().toISOString(), repos: out });
    try { fs.writeFileSync(this.file(meta.id), JSON.stringify({ turns })); } catch {}
    for (const k of this.cache.keys()) if (k.startsWith(meta.id + "|")) this.cache.delete(k);
  }

  private fresh(meta: RunMeta, key: string): { at: number; scopes: ChangeScope[] } | null {
    const hit = this.cache.get(key);
    return hit && Date.now() - hit.at < (meta.status === "running" ? CACHE_RUNNING_MS : CACHE_IDLE_MS) ? hit : null;
  }

  /** The run's last result while it's still fresh, else null. Needs no events: reading a big run's is the slow part of asking. */
  cached(meta: RunMeta): Changes | null {
    const hit = this.fresh(meta, this.lastKey.get(meta.id) || "");
    return hit ? { scopes: hit.scopes, hasBaseline: this.read(meta.id).length > 0, computedAt: new Date(hit.at).toISOString() } : null;
  }

  /**
   * Repos the run changed, with files and commits, since its first turn.
   * `worktree`: the worktree the run worked in, if any, and its repos (absolute paths).
   * Only repos inside it are listed, and all of its repos are checked, since a
   * subagent's or git's changes don't show up as the run's own edits.
   */
  async changes(meta: RunMeta, events: RunEvent[], force = false, worktree: RunWorktree | null = null): Promise<Changes> {
    const key = meta.id + "|" + (worktree?.path || "");
    this.lastKey.set(meta.id, key);
    const hit = force ? null : this.fresh(meta, key);
    if (hit) return { scopes: hit.scopes, hasBaseline: this.read(meta.id).length > 0, computedAt: new Date(hit.at).toISOString() };
    const going = this.inFlight.get(key);
    if (going) return going;
    const p = this.compute(meta, events, key, worktree).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async compute(meta: RunMeta, events: RunEvent[], key: string, worktree: RunWorktree | null): Promise<Changes> {
    const first = this.read(meta.id).sort((a, b) => a.turn - b.turn)[0] || null;

    const touched = new Set<string>();
    for (const p of editedPaths(events)) {
      const root = this.gitRoot(p);
      if (root) touched.add(root);
    }
    let candidates = [...new Set<string>([...touched, ...Object.keys(first?.repos || {}), ...(worktree?.repos || []).map((r) => path.resolve(r))])];
    if (worktree) candidates = candidates.filter((repo) => within(repo, worktree.path));
    const scopes: ChangeScope[] = [];
    await Promise.all(candidates.map(async (repo) => {
      if (!fs.existsSync(path.join(repo, ".git"))) return;
      const s = await this.scope(meta, repo, worktree?.path || meta.cwd);
      if (s && (s.files.length || s.commits.length || touched.has(repo))) scopes.push(s);
    }));
    scopes.sort((a, b) => a.repo.localeCompare(b.repo));
    this.cache.set(key, { at: Date.now(), scopes });
    return { scopes, hasBaseline: !!first, computedAt: new Date().toISOString() };
  }

  /** Unified diff of one file in one of the run's changed repos. */
  async fileDiff(meta: RunMeta, events: RunEvent[], repo: string, file: string, worktree: RunWorktree | null = null): Promise<string> {
    const { scopes } = await this.changes(meta, events, false, worktree);
    const scope = scopes.find((s) => s.path === repo);
    const f = scope && scope.files.find((x) => x.file === file);
    if (!scope || !f) throw Object.assign(new Error("Not one of this run's changed files"), { status: 404 });
    const base = await this.baseOf(meta, repo);
    if (f.status === "??") return git(["diff", "--no-index", "--", nullDevice(), file], repo);
    return git(["diff", base.ref, "--", file], repo);
  }

  // ------------------------------------------------------------ internals

  private async baseOf(meta: RunMeta, repo: string): Promise<{ ref: string; head: string; kind: "run-start" | "branch"; untracked: Set<string> }> {
    const first = this.read(meta.id).sort((a, b) => a.turn - b.turn)[0];
    const b = first?.repos[repo];
    if (b) return { ref: b.snap, head: b.head, kind: "run-start", untracked: new Set(b.untracked) };
    // No snapshot: the branch's divergence from the default branch is the run's work. origin/HEAD
    // first, so a repo based on develop isn't measured against a main that lags it.
    let mb = "";
    for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
      mb = (await git(["merge-base", "HEAD", ref], repo)).trim();
      if (mb) break;
    }
    const at = mb || (await git(["rev-parse", "HEAD"], repo)).trim();
    return { ref: at, head: at, kind: "branch", untracked: new Set() };
  }

  /** `home`: the folder repo names are shown relative to (the run's worktree, else where it started). */
  private async scope(meta: RunMeta, repo: string, home: string): Promise<ChangeScope | null> {
    const base = await this.baseOf(meta, repo);
    if (!base.ref) return null;
    // One diff for both the statuses (--raw) and the line counts (--numstat): a process each is what costs.
    const [branch, diff, log, untrackedNow] = await Promise.all([
      branchOf(repo),
      git(["diff", "--raw", "--numstat", base.ref], repo),
      base.head ? git(["log", "--oneline", "--no-decorate", "-20", `${base.head}..HEAD`], repo) : Promise.resolve(""),
      git(["ls-files", "--others", "--exclude-standard"], repo),
    ]);
    const stats = new Map<string, { adds: number | null; dels: number | null }>();
    const lines = diff.split(/\r?\n/);
    for (const line of lines) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (m) stats.set(renamed(m[3]), { adds: m[1] === "-" ? null : +m[1], dels: m[2] === "-" ? null : +m[2] });
    }
    const files: ChangedFile[] = [];
    for (const line of lines) {
      // --raw: ":<mode> <mode> <sha> <sha> <status>\t<file>" (a rename: "\t<old>\t<new>").
      const raw = /^:\S+ \S+ \S+ \S+ (\S+)\t(.+)$/.exec(line);
      if (!raw) continue;
      const parts = [raw[1], ...raw[2].split("\t")];
      const file = parts[parts.length - 1];
      const st = stats.get(file) || { adds: null, dels: null };
      files.push({ file, status: parts[0].charAt(0), adds: st.adds, dels: st.dels });
    }
    for (const f of untrackedNow.split(/\r?\n/).filter(Boolean)) {
      if (base.untracked.has(f) || files.some((x) => x.file === f)) continue;
      files.push({ file: f, status: "??", adds: lineCount(path.join(repo, f)), dels: 0 });
    }
    files.sort((a, b) => a.file.localeCompare(b.file));
    const commits = log.split(/\r?\n/).filter(Boolean).map((l) => ({ hash: l.slice(0, l.indexOf(" ")), message: l.slice(l.indexOf(" ") + 1) }));
    const rel = path.relative(home, repo);
    return {
      repo: !rel ? path.basename(repo) : rel.startsWith("..") ? repo.split(/[\\/]/).slice(-3).join("/") : rel.split(path.sep).join("/"),
      path: repo,
      branch: branch.trim() || "unknown",
      baseKind: base.kind,
      baseLabel: base.kind === "run-start" ? "since the run started" : "vs the default branch (whole branch)",
      commits,
      files,
    };
  }

  /** Nearest ancestor directory containing .git (cached). */
  private gitRoot(p: string): string | null {
    let dir = path.dirname(path.resolve(p));
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      if (this.roots.has(dir)) { const r = this.roots.get(dir)!; seen.forEach((s) => this.roots.set(s, r)); return r; }
      seen.push(dir);
      if (fs.existsSync(path.join(dir, ".git"))) { seen.forEach((s) => this.roots.set(s, dir)); return dir; }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    seen.forEach((s) => this.roots.set(s, null));
    return null;
  }
}

/** Absolute paths the run's edit tools wrote to (main session and subagents). */
export function editedPaths(events: readonly RunEvent[]): string[] {
  const out = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "assistant" || !Array.isArray(ev.message?.content)) continue;
    for (const b of ev.message.content) {
      if (b.type !== "tool_use" || !EDIT_TOOLS.has(b.name)) continue;
      const p = b.input?.file_path || b.input?.notebook_path;
      if (typeof p === "string" && path.isAbsolute(p)) out.add(p);
    }
  }
  return [...out];
}

/** The workspace's repos: the folder itself if it's a repo, plus any direct child that is. */
export function listRepos(cwd: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(cwd, ".git"))) out.push(cwd);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(cwd, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(cwd, e.name);
    if (fs.existsSync(path.join(p, ".git"))) out.push(p);
  }
  return out;
}

function renamed(s: string): string {
  // numstat shows renames as "old => new" or "dir/{a => b}/f"
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(s);
  if (brace) return (brace[1] + brace[3] + brace[4]).replace(/\/\//g, "/");
  const arrow = s.split(" => ");
  return arrow[arrow.length - 1];
}

function lineCount(file: string): number | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const text = fs.readFileSync(file, "utf-8");
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch { return null; }
}

/** git recognises /dev/null itself, on Windows too (the Workspaces diff relies on the same). */
function nullDevice() { return "/dev/null"; }

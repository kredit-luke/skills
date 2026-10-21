/**
 * Send to hosted: move a run from the dashboard on someone's computer to their hosted
 * dashboard (hosted.ts), so the conversation carries on there after the laptop closes.
 *
 * Each turn is a fresh `claude -p --resume <sessionId>` (agents/claude.ts), so a session
 * moves with its transcript. The bundle carries:
 *   - the transcript (~/.claude/projects/<folder>/<sessionId>.jsonl, and its <sessionId>/
 *     folder of subagents and tool results);
 *   - the run's ledger files (runs/<id>.json, .events.jsonl) and attached files;
 *   - the worktree the run worked in, if any: per repo, the commits that aren't on any
 *     remote (a git bundle), uncommitted changes (a binary diff) and untracked files,
 *     plus the worktree's own files outside its repos (a copied .claude/, CLAUDE.md...).
 * It's gzipped JSON, each file base64. The hosted page fetches it from this computer with
 * a single-use token (HandoffTokens) and posts it to its own /api/runs/import, which
 * recreates the worktree with `git worktree add` from the hosted clone of each repo.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import type { RunMeta } from "../../shared/api.ts";
import { REPLYABLE } from "./runs.ts";
import { safeMemberPath } from "./tar.ts";

export const HANDOFF_FORMAT = 1;
/** The bundle as sent (gzipped). The hosted ingress must allow at least this much (e.g. proxy-body-size 25m). */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
/** The bundle unpacked: well above anything that fits in MAX_BUNDLE_BYTES gzipped, short of filling memory. */
const MAX_EXPANDED_BYTES = 400 * 1024 * 1024;
const MAX_EXTRA_FILE = 2 * 1024 * 1024;
const MAX_EXTRA_FILES = 2000;
const MAX_UNTRACKED_FILE = 10 * 1024 * 1024;
/** Folders never carried as a worktree's own files (build output, the dashboard's per-person state). */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "bin", "obj", ".angular", ".next", "coverage"]);
const RUN_ID_RE = /^[a-z0-9-]+$/i;
const SESSION_RE = /^[a-z0-9-]+$/i;
const WORKTREE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface HandoffRepo {
  /** Inside the worktree, with `/`; "" when the worktree folder is the repo itself. */
  path: string;
  /** origin's URL without any credentials, or null. */
  remote: string | null;
  branch: string | null;
  head: string;
  /** The remote branch it tracks ("origin/feature/x"), if any. */
  upstream: string | null;
  commits: boolean;
  patch: boolean;
  untracked: string[];
}

export interface HandoffManifest {
  format: number;
  createdAt: string;
  engineVersion: string;
  run: { id: string; sessionId: string; label: string };
  source: { workspaceRoot: string; cwd: string; platform: string };
  transcript: boolean;
  /** `sourcePath`: the worktree's folder on the computer it came from (it may be outside the workspace: worktrees.dir). */
  worktree: { name: string; sourcePath: string; repos: HandoffRepo[]; extras: string[] } | null;
}

interface BundleDoc { manifest: HandoffManifest; files: Record<string, string> }

export interface BuildInput {
  meta: RunMeta;
  metaFile: string;
  eventsFile: string;
  /** The session's transcript, or null when it can't be found. */
  transcript: string | null;
  /** The run's attachments folder (<ledger>/attachments/<id>), if it has one. */
  attachmentsDir: string | null;
  workspaceRoot: string;
  /** The worktree the run worked in (main.ts runWorktree), or null for a run that stayed in the main workspace. */
  worktree: { path: string; repos: string[] } | null;
  engineVersion: string;
}

export interface BuildResult { bundle: Buffer; manifest: HandoffManifest; warnings: string[] }

// ------------------------------------------------------------------ git

interface GitResult { code: number; stdout: Buffer; stderr: string }

function gitRaw(cwd: string, args: string[], timeout = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout, windowsHide: true, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: stdout as Buffer, stderr: String(stderr || (err && err.message) || "") });
    });
  });
}

async function git(cwd: string, args: string[], timeout?: number): Promise<string> {
  const r = await gitRaw(cwd, args, timeout);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").slice(-2).join(" ") || `git ${args[0]} failed`);
  return r.stdout.toString("utf-8").trim();
}

async function gitOr(cwd: string, args: string[], fallback = ""): Promise<string> {
  try { return await git(cwd, args); } catch { return fallback; }
}

/** A remote URL with any user, password or token taken out (it's written into the bundle). */
export function publicRemote(url: string): string {
  const s = url.trim();
  try {
    const u = new URL(s);
    if (u.username || u.password) { u.username = ""; u.password = ""; }
    return u.toString();
  } catch {
    return s; // scp-style git@host:owner/repo: no credentials in it
  }
}

/** One repo's identity across URL spellings: "github.com/owner/repo" for https, ssh and scp forms. */
export function remoteKey(url: string | null): string | null {
  if (!url) return null;
  let s = url.trim().toLowerCase();
  const scp = s.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else {
    try { const u = new URL(s); s = `${u.hostname}${u.pathname}`; } catch {}
  }
  return s.replace(/\.git$/, "").replace(/\/+$/, "") || null;
}

/** Claude Code's folder name under ~/.claude/projects for a session started in `cwd`. */
export function projectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// ------------------------------------------------------------------ build (on the person's computer)

const toPosix = (p: string) => p.split(path.sep).join("/");

/** What's read in before packing: past this the run can't fit in MAX_BUNDLE_BYTES gzipped, so stop early (memory, not a 500). */
const MAX_RAW_BYTES = 120 * 1024 * 1024;

function addFile(files: Record<string, string>, key: string, data: Buffer, sizes: { n: number }) {
  sizes.n += data.length;
  if (sizes.n > MAX_RAW_BYTES) throw tooBig(`over ${MAX_RAW_BYTES / 1048576} MB before packing`);
  files[key] = data.toString("base64");
}

function tooBig(size: string) {
  return Object.assign(new Error(`This run is ${size}, over the ${MAX_BUNDLE_BYTES / 1048576} MB the hosted dashboard takes. Commit and push large files (or add them to .gitignore), or continue in a terminal instead.`), { status: 413 });
}

/** Every file under `dir`, relative with `/`, skipping `skip(relDir)` folders. */
function walk(dir: string, skip: (rel: string, name: string) => boolean, limit = Infinity): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip(r, e.name)) visit(r); }
      else if (e.isFile()) out.push(r);
    }
  };
  visit("");
  return out;
}

async function packRepo(repoDir: string, rel: string, key: string, files: Record<string, string>, sizes: { n: number }, warnings: string[]): Promise<HandoffRepo | null> {
  const name = rel || path.basename(repoDir);
  // Drop remote branches deleted on the server: a merged-and-deleted branch still listed
  // here would hide its commits from "not on any remote" below.
  const fetched = await gitRaw(repoDir, ["fetch", "--prune", "--quiet", "origin"], 60_000);
  if (fetched.code !== 0) warnings.push(`Couldn't reach ${name}'s remote, so its list of pushed commits may be out of date.`);
  const head = await gitOr(repoDir, ["rev-parse", "HEAD"]);
  if (!head) { warnings.push(`${name} has no commits yet, so it was left out.`); return null; }
  const remoteUrl = await gitOr(repoDir, ["config", "--get", "remote.origin.url"]);
  const repo: HandoffRepo = {
    path: rel,
    remote: remoteUrl ? publicRemote(remoteUrl) : null,
    branch: (await gitOr(repoDir, ["branch", "--show-current"])) || null,
    head,
    upstream: (await gitOr(repoDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) || null,
    commits: false,
    patch: false,
    untracked: [],
  };
  // Commits that aren't on any remote branch travel as a git bundle.
  const ahead = parseInt(await gitOr(repoDir, ["rev-list", "--count", "HEAD", "--not", "--remotes"], "0"), 10) || 0;
  if (ahead > 0) {
    const tmp = path.join(os.tmpdir(), `natterjack-handoff-${crypto.randomBytes(6).toString("hex")}.bundle`);
    try {
      await git(repoDir, ["bundle", "create", tmp, "HEAD", "--not", "--remotes"], 120_000);
      addFile(files, `${key}/commits.bundle`, fs.readFileSync(tmp), sizes);
      repo.commits = true;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  // Uncommitted changes to tracked files, staged or not, in the form `git apply` takes whatever the
  // person's git config says (diff.noprefix, color.ui=always, external diff and textconv drivers).
  const diff = await gitRaw(repoDir, ["-c", "core.quotePath=false", "diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"], 120_000);
  if (diff.code !== 0) throw new Error(`Couldn't read ${name}'s uncommitted changes: ${diff.stderr.trim()}`);
  if (diff.stdout.length) { addFile(files, `${key}/changes.patch`, diff.stdout, sizes); repo.patch = true; }
  // New files git doesn't ignore.
  const listed = await gitRaw(repoDir, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const f of listed.stdout.toString("utf-8").split("\0").filter(Boolean)) {
    const safe = safeMemberPath(f);
    if (!safe) continue;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(repoDir, safe)); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_UNTRACKED_FILE) { warnings.push(`${name}/${safe} is over 10 MB, so it stayed on this computer.`); continue; }
    addFile(files, `${key}/files/${safe}`, fs.readFileSync(path.join(repoDir, safe)), sizes);
    repo.untracked.push(safe);
  }
  return repo;
}

/** The bundle for one run. Throws (with a message for the person) if it can't be built. */
export async function buildBundle(input: BuildInput): Promise<BuildResult> {
  const { meta } = input;
  const files: Record<string, string> = {};
  const sizes = { n: 0 };
  const warnings: string[] = [];

  addFile(files, "run/meta.json", fs.readFileSync(input.metaFile), sizes);
  if (fs.existsSync(input.eventsFile)) addFile(files, "run/events.jsonl", fs.readFileSync(input.eventsFile), sizes);

  // The transcript, and the folder beside it (subagents/, tool-results/).
  let transcript = false;
  if (input.transcript && fs.existsSync(input.transcript)) {
    addFile(files, `transcript/${meta.sessionId}.jsonl`, fs.readFileSync(input.transcript), sizes);
    transcript = true;
    const side = path.join(path.dirname(input.transcript), meta.sessionId);
    if (fs.existsSync(side)) for (const f of walk(side, () => false)) addFile(files, `transcript/${meta.sessionId}/${f}`, fs.readFileSync(path.join(side, f)), sizes);
  } else {
    warnings.push("Claude's transcript of this run wasn't found, so the hosted dashboard can show the run but not continue it.");
  }

  if (input.attachmentsDir && fs.existsSync(input.attachmentsDir)) {
    for (const f of walk(input.attachmentsDir, () => false)) addFile(files, `attachments/${f}`, fs.readFileSync(path.join(input.attachmentsDir, f)), sizes);
  }

  let worktree: HandoffManifest["worktree"] = null;
  if (input.worktree) {
    const wt = input.worktree;
    const name = path.basename(wt.path);
    if (!WORKTREE_NAME_RE.test(name)) throw new Error(`The worktree's folder name (${name}) can't be recreated on the hosted dashboard.`);
    const repos: HandoffRepo[] = [];
    const repoRels = wt.repos.map((r) => toPosix(path.relative(wt.path, r))).map((r) => (r === "." ? "" : r));
    for (let i = 0; i < wt.repos.length; i++) {
      const packed = await packRepo(wt.repos[i], repoRels[i], `worktree/repos/${i}`, files, sizes, warnings);
      if (packed) repos.push(packed);
    }
    // The worktree's own files outside its repos: what a worktree tool copied in from the main workspace.
    const extras: string[] = [];
    if (!repoRels.includes("")) {
      const isRepo = (rel: string) => repoRels.includes(rel);
      const found = walk(wt.path, (rel, n) => SKIP_DIRS.has(n) || isRepo(rel) || rel === ".claude/ledger" || fs.existsSync(path.join(wt.path, rel, ".git")), MAX_EXTRA_FILES + 1);
      if (found.length > MAX_EXTRA_FILES) warnings.push(`The worktree has over ${MAX_EXTRA_FILES} files outside its repos; only the first ${MAX_EXTRA_FILES} were sent.`);
      for (const f of found.slice(0, MAX_EXTRA_FILES)) {
        const full = path.join(wt.path, f);
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size > MAX_EXTRA_FILE) { warnings.push(`${name}/${f} is over 2 MB, so it stayed on this computer.`); continue; }
        addFile(files, `worktree/extras/${f}`, fs.readFileSync(full), sizes);
        extras.push(f);
      }
    }
    worktree = { name, sourcePath: wt.path, repos, extras };
  }

  const manifest: HandoffManifest = {
    format: HANDOFF_FORMAT,
    createdAt: new Date().toISOString(),
    engineVersion: input.engineVersion,
    run: { id: meta.id, sessionId: meta.sessionId, label: meta.label },
    source: { workspaceRoot: input.workspaceRoot, cwd: meta.cwd, platform: process.platform },
    transcript,
    worktree,
  };
  const bundle = zlib.gzipSync(Buffer.from(JSON.stringify({ manifest, files } satisfies BundleDoc)));
  if (bundle.length > MAX_BUNDLE_BYTES) throw tooBig(`${(bundle.length / 1048576).toFixed(1)} MB packed`);
  return { bundle, manifest, warnings };
}

// ------------------------------------------------------------------ import (on the hosted dashboard)

export interface ImportContext {
  workspaceRoot: string;
  worktreeRoot: string;
  runsDir: string;
  attachmentsRoot: string;
  /** CLAUDE_CONFIG_DIR, or ~/.claude. */
  claudeDir: string;
  /** This workspace's repos (absolute): where each worktree is added from. */
  mainRepos: string[];
}

export interface ImportResult { meta: RunMeta; warnings: string[] }

/** A folder on the computer the run came from, and where it is here. */
export interface FolderMap { from: string; to: string }

/** `cwd` (a path on the source computer) under `base` there, as the same place under `to` here; null when it isn't under it. */
function under(platform: string, base: string, cwd: string, to: string): string | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const rel = p.relative(base, cwd);
  if (rel.startsWith("..") || p.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((s) => s === ".." || s.includes("\0"))) return null;
  return path.join(to, ...parts);
}

/**
 * The run's folder here: in its worktree, the same place in the recreated worktree (wherever
 * worktrees.dir puts them on either side); else the same place relative to the workspace.
 */
export function mapCwd(source: HandoffManifest["source"], workspaceRoot: string, worktree: FolderMap | null = null): string | null {
  return (worktree && under(source.platform, worktree.from, source.cwd, worktree.to)) || under(source.platform, source.workspaceRoot, source.cwd, workspaceRoot);
}

/** What the run is told on every turn from now on, so the old paths in its history don't mislead it. */
export function movedNote(source: HandoffManifest["source"], workspaceRoot: string, worktree: FolderMap | null = null): string {
  const wt = worktree ? ` Its worktree ${worktree.from} is now ${worktree.to}.` : "";
  return `This conversation was moved here from another computer, where the workspace was ${source.workspaceRoot}. Paths earlier in the conversation under that folder are now under ${workspaceRoot} (use / as the separator).${wt} Apps, services and terminals started there aren't running here.`;
}

function parseBundle(buf: Buffer): BundleDoc {
  let doc: any;
  try {
    doc = JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: MAX_EXPANDED_BYTES }).toString("utf-8"));
  } catch {
    throw Object.assign(new Error("That isn't a run from Send to hosted, or it was cut off on the way."), { status: 400 });
  }
  const m = doc && doc.manifest;
  if (!m || m.format !== HANDOFF_FORMAT || !doc.files || typeof doc.files !== "object") {
    throw Object.assign(new Error("This run was sent by a different version of the dashboard. Update both to the same version and send it again."), { status: 400 });
  }
  if (!RUN_ID_RE.test(String(m.run?.id || "")) || !SESSION_RE.test(String(m.run?.sessionId || ""))) throw Object.assign(new Error("The run's id isn't valid."), { status: 400 });
  for (const k of Object.keys(doc.files)) {
    if (safeMemberPath(k) !== k) throw Object.assign(new Error(`The bundle has an unsafe path (${k}).`), { status: 400 });
  }
  if (m.worktree) {
    if (!WORKTREE_NAME_RE.test(String(m.worktree.name || ""))) throw Object.assign(new Error("The worktree's name isn't valid."), { status: 400 });
    if (typeof m.worktree.sourcePath !== "string" || !m.worktree.sourcePath) throw Object.assign(new Error("The bundle doesn't say where its worktree was."), { status: 400 });
    for (const r of m.worktree.repos || []) {
      if (r.path && safeMemberPath(r.path) !== r.path) throw Object.assign(new Error(`The bundle has an unsafe repo path (${r.path}).`), { status: 400 });
      if (!/^[0-9a-f]{40,64}$/.test(String(r.head))) throw Object.assign(new Error("A repo's commit id isn't valid."), { status: 400 });
    }
  }
  return doc as BundleDoc;
}

/**
 * Write `rel` (a bundle path, with `/`) under `root`, through real folders only: a symlink on
 * the way (one the bundle's own commits checked out, say `link -> ~/.ssh`) or in its place is
 * refused, so nothing in a bundle can write outside where it belongs.
 */
export function writeInside(root: string, rel: string, data: Buffer) {
  if (safeMemberPath(rel) !== rel) throw Object.assign(new Error(`The bundle has an unsafe path (${rel}).`), { status: 400 });
  const parts = rel.split("/");
  let cur = root;
  fs.mkdirSync(root, { recursive: true });
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(cur); } catch {}
    if (!st) fs.mkdirSync(cur);
    else if (st.isSymbolicLink() || !st.isDirectory()) throw Object.assign(new Error(`${rel} goes through a link or a file, so it wasn't written.`), { status: 409 });
  }
  const dest = path.join(cur, parts[parts.length - 1]);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(dest); } catch {}
  if (st && (st.isSymbolicLink() || !st.isFile())) throw Object.assign(new Error(`${rel} is a link or a folder here, so it wasn't written.`), { status: 409 });
  fs.writeFileSync(dest, data);
}

/** The hosted clone a worktree repo is added from: same remote, else the same place in the workspace. */
async function mainRepoFor(repo: HandoffRepo, ctx: ImportContext): Promise<string | null> {
  const want = remoteKey(repo.remote);
  if (want) {
    for (const r of ctx.mainRepos) if (remoteKey(await gitOr(r, ["config", "--get", "remote.origin.url"])) === want) return r;
  }
  const same = path.join(ctx.workspaceRoot, ...repo.path.split("/").filter(Boolean));
  return ctx.mainRepos.find((r) => path.resolve(r) === path.resolve(same)) || null;
}

/**
 * Recreate a sent run here. Refuses one that's already here or whose worktree folder
 * exists; on any failure, undoes what it did (worktrees added, files written).
 */
export async function importBundle(buf: Buffer, ctx: ImportContext, isRoutedModel: (m: string | null) => boolean = () => false): Promise<ImportResult> {
  const doc = parseBundle(buf);
  const m = doc.manifest;
  const file = (k: string) => (doc.files[k] !== undefined ? Buffer.from(doc.files[k], "base64") : null);
  const warnings: string[] = [];
  const id = m.run.id;

  const metaPath = path.join(ctx.runsDir, `${id}.json`);
  if (fs.existsSync(metaPath)) throw Object.assign(new Error("This run is already on the hosted dashboard."), { status: 409 });
  const wtMap: FolderMap | null = m.worktree ? { from: String(m.worktree.sourcePath || ""), to: path.join(ctx.worktreeRoot, m.worktree.name) } : null;
  const cwd = mapCwd(m.source, ctx.workspaceRoot, wtMap);
  if (!cwd) throw Object.assign(new Error("The run's folder is outside its workspace and its worktree, so it can't be placed here."), { status: 400 });
  const metaBuf = file("run/meta.json");
  if (!metaBuf) throw Object.assign(new Error("The bundle has no run in it."), { status: 400 });
  const meta = JSON.parse(metaBuf.toString("utf-8")) as RunMeta;
  if (meta.id !== id || meta.sessionId !== m.run.sessionId) throw Object.assign(new Error("The bundle's run doesn't match its manifest."), { status: 400 });

  const undo: (() => Promise<void> | void)[] = [];
  try {
    // The worktree first: it's the part most likely to fail (a repo not cloned here, a patch that doesn't apply).
    if (m.worktree) {
      const target = path.join(ctx.worktreeRoot, m.worktree.name);
      if (fs.existsSync(target)) throw Object.assign(new Error(`A worktree named ${m.worktree.name} is already on the hosted dashboard. Remove it there first.`), { status: 409 });
      fs.mkdirSync(target, { recursive: true });
      undo.push(() => fs.rmSync(target, { recursive: true, force: true }));
      for (let i = 0; i < m.worktree.repos.length; i++) {
        const repo = m.worktree.repos[i];
        const label = repo.path || m.worktree.name;
        const main = await mainRepoFor(repo, ctx);
        if (!main) throw Object.assign(new Error(`${label} isn't cloned on the hosted dashboard, so its worktree can't be made.`), { status: 409 });
        await gitRaw(main, ["fetch", "--quiet", "origin"], 180_000);
        const key = `worktree/repos/${i}`;
        const bundle = file(`${key}/commits.bundle`);
        if (bundle) {
          const tmp = path.join(os.tmpdir(), `natterjack-import-${crypto.randomBytes(6).toString("hex")}.bundle`);
          fs.writeFileSync(tmp, bundle);
          try { await git(main, ["fetch", "--quiet", tmp, `+HEAD:refs/natterjack/moved/${id}-${i}`], 180_000); }
          catch (e) { throw Object.assign(new Error(`${label}'s unpushed commits couldn't be read: ${(e as Error).message}`), { status: 409 }); }
          finally { fs.rmSync(tmp, { force: true }); }
          undo.push(() => gitRaw(main, ["update-ref", "-d", `refs/natterjack/moved/${id}-${i}`]).then(() => {}));
        }
        if ((await gitRaw(main, ["cat-file", "-e", `${repo.head}^{commit}`])).code !== 0) {
          throw Object.assign(new Error(`${label}'s commit ${repo.head.slice(0, 9)} isn't on its remote. Push it, or send the run again.`), { status: 409 });
        }
        const dest = repo.path ? path.join(target, ...repo.path.split("/")) : target;
        if (repo.path) fs.mkdirSync(path.dirname(dest), { recursive: true });
        else fs.rmSync(target, { recursive: true, force: true }); // git worktree add makes the folder itself
        const addArgs = await worktreeAddArgs(main, repo, dest, warnings, label);
        await git(main, ["worktree", "add", "--quiet", ...addArgs], 180_000);
        undo.push(() => gitRaw(main, ["worktree", "remove", "--force", dest]).then(() => {}));
        if (repo.upstream && repo.branch) await gitRaw(dest, ["branch", "--set-upstream-to", repo.upstream]);
        const patch = file(`${key}/changes.patch`);
        if (patch) {
          const tmp = path.join(os.tmpdir(), `natterjack-import-${crypto.randomBytes(6).toString("hex")}.patch`);
          fs.writeFileSync(tmp, patch);
          try {
            const r = await gitRaw(dest, ["apply", "--binary", "--whitespace=nowarn", tmp]);
            if (r.code !== 0) throw Object.assign(new Error(`${label}'s uncommitted changes didn't apply: ${r.stderr.trim().split("\n")[0]}`), { status: 409 });
          } finally {
            fs.rmSync(tmp, { force: true });
          }
        }
        for (const f of repo.untracked || []) {
          const data = file(`${key}/files/${f}`);
          if (data) writeInside(dest, f, data);
        }
      }
      for (const f of m.worktree.extras || []) {
        const data = file(`worktree/extras/${f}`);
        if (!data) continue;
        if (!fs.existsSync(path.join(target, ...String(f).split("/")))) writeInside(target, f, data); // never over a repo's own file
      }
    }

    // The transcript, where `claude --resume` looks for it from the new folder.
    if (m.transcript) {
      const dir = path.join(ctx.claudeDir, "projects", projectFolder(cwd));
      const prefix = `transcript/${m.run.sessionId}`;
      for (const k of Object.keys(doc.files)) {
        if (k !== `${prefix}.jsonl` && !k.startsWith(`${prefix}/`)) continue;
        const rel = k.slice("transcript/".length);
        const dest = path.join(dir, ...rel.split("/"));
        // One left from an earlier import of this session (its run since deleted) is older: replace it, and put it back on failure.
        let before: Buffer | null = null;
        try { before = fs.readFileSync(dest); } catch {}
        writeInside(dir, rel, file(k)!);
        undo.push(() => (before ? fs.writeFileSync(dest, before) : fs.rmSync(dest, { force: true })));
      }
    } else {
      warnings.push("The transcript didn't come along, so replying starts a fresh conversation.");
    }

    // Attached files and outputs.
    const attDir = path.join(ctx.attachmentsRoot, id);
    if (Object.keys(doc.files).some((k) => k.startsWith("attachments/"))) {
      undo.push(() => fs.rmSync(attDir, { recursive: true, force: true }));
      for (const k of Object.keys(doc.files)) if (k.startsWith("attachments/")) writeInside(attDir, k.slice("attachments/".length), file(k)!);
    }

    // The run itself, pointed at its new folder and ready for a reply.
    meta.cwd = cwd;
    if (!REPLYABLE.has(meta.status)) { meta.status = "interrupted"; meta.question = null; }
    if (!m.transcript) meta.turns = 0; // the next reply starts a new session rather than resuming one that isn't here
    meta.handedOffAt = null;
    meta.handedOffTo = null;
    meta.hostedRunUrl = null;
    meta.handoffPendingAt = null;
    meta.continuedAt = null;
    meta.queued = [];
    meta.queueBlocked = null;
    meta.addDirs = undefined;
    if (isRoutedModel(meta.model)) { meta.model = null; meta.effort = null; meta.resolvedModel = null; }
    meta.movedFrom = { at: new Date().toISOString(), cwd: m.source.cwd };
    meta.extraPrompt = [meta.extraPrompt, movedNote(m.source, ctx.workspaceRoot, wtMap)].filter(Boolean).join("\n\n");
    if (Array.isArray(meta.attachments)) meta.attachments = meta.attachments.map((a) => ({ ...a, path: path.join(attDir, path.basename(a.file || a.name)) }));
    const events = file("run/events.jsonl");
    if (events) {
      writeInside(ctx.runsDir, `${id}.events.jsonl`, events);
      undo.push(() => fs.rmSync(path.join(ctx.runsDir, `${id}.events.jsonl`), { force: true }));
    }
    writeInside(ctx.runsDir, `${id}.json`, Buffer.from(JSON.stringify(meta, null, 2)));
    return { meta, warnings };
  } catch (e) {
    for (const fn of undo.reverse()) { try { await fn(); } catch {} }
    throw e;
  }
}

/** `git worktree add` arguments: on the run's branch where that's safe here, else at the commit, detached. */
async function worktreeAddArgs(main: string, repo: HandoffRepo, dest: string, warnings: string[], label: string): Promise<string[]> {
  if (!repo.branch) return ["--detach", dest, repo.head];
  const tip = await gitOr(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${repo.branch}`]);
  if (!tip) return ["-b", repo.branch, dest, repo.head];
  const checkedOut = (await gitOr(main, ["worktree", "list", "--porcelain"])).split("\n").some((l) => l === `branch refs/heads/${repo.branch}`);
  const behind = tip === repo.head || (await gitRaw(main, ["merge-base", "--is-ancestor", tip, repo.head])).code === 0;
  if (!checkedOut && behind) return ["-B", repo.branch, dest, repo.head];
  warnings.push(`${label}: the branch ${repo.branch} already exists on the hosted dashboard${checkedOut ? " and is checked out" : " with other commits"}, so the worktree is at ${repo.head.slice(0, 9)} without a branch. Create one before committing.`);
  return ["--detach", dest, repo.head];
}

// ------------------------------------------------------------------ tokens (on the person's computer)

/** How long the hosted page has to fetch a bundle once it's built. */
export const FETCH_TTL_MS = 5 * 60_000;
/** After the fetch, how long the import may take before the run is unlocked again. */
export const CONFIRM_TTL_MS = 30 * 60_000;

interface Pending { runId: string; bundle: Buffer | null; createdAt: number; fetchedAt: number | null }

/**
 * Single-use tokens for a bundle: the hosted page can fetch it once, then confirm once.
 * `expired()` lists the runs whose send ran out of time, so their lock can be lifted.
 */
export class HandoffTokens {
  private pending = new Map<string, Pending>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  create(runId: string, bundle: Buffer): string {
    for (const [t, p] of this.pending) if (p.runId === runId) this.pending.delete(t); // a new send replaces an old one
    const token = crypto.randomBytes(24).toString("hex");
    this.pending.set(token, { runId, bundle, createdAt: this.now(), fetchedAt: null });
    return token;
  }

  private find(token: string | null): [string, Pending] | null {
    if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
    const p = this.pending.get(token);
    return p ? [token, p] : null;
  }

  /** The bundle, once: null for an unknown, used or expired token. */
  take(token: string | null): { runId: string; bundle: Buffer } | null {
    const hit = this.find(token);
    if (!hit) return null;
    const [, p] = hit;
    if (!p.bundle || p.fetchedAt !== null || this.now() - p.createdAt > FETCH_TTL_MS) return null;
    const bundle = p.bundle;
    p.bundle = null;
    p.fetchedAt = this.now();
    return { runId: p.runId, bundle };
  }

  /** The import finished: the run id, once (only after the bundle was fetched). */
  confirm(token: string | null): string | null {
    const hit = this.find(token);
    if (!hit) return null;
    const [t, p] = hit;
    if (p.fetchedAt === null || this.now() - p.fetchedAt > CONFIRM_TTL_MS) return null;
    this.pending.delete(t);
    return p.runId;
  }

  /** Forget a run's send (cancelled from its page). */
  drop(runId: string) {
    for (const [t, p] of this.pending) if (p.runId === runId) this.pending.delete(t);
  }

  /** Runs whose send timed out (never fetched, or never confirmed); forgotten as they're returned. */
  expired(): string[] {
    const out: string[] = [];
    const now = this.now();
    for (const [t, p] of this.pending) {
      const late = p.fetchedAt === null ? now - p.createdAt > FETCH_TTL_MS : now - p.fetchedAt > CONFIRM_TTL_MS;
      if (late) { out.push(p.runId); this.pending.delete(t); }
    }
    return out;
  }

  isPending(runId: string): boolean {
    for (const p of this.pending.values()) if (p.runId === runId) return true;
    return false;
  }
}

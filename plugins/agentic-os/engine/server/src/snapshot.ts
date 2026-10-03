/**
 * Read-only snapshots of the workspace's repos, for people who can't clone them.
 *
 * Publish (CI, or anyone with git access): `git archive` each repos.json repo into
 * <name>.tar.gz (no history), the workspace root into workspace.zip (for the first
 * download by hand), and snapshot-manifest.json naming each file's commit; upload
 * them through the repos.json `snapshot` source (snapshot-sources/), manifest last.
 *
 * Download (the Repos page): fetch the manifest, and for each repo that's missing or
 * older than it, download its archive, extract it next to the target, stamp it
 * (.snapshot.json), and swap it in. A folder with .git, or with files but no stamp,
 * is never replaced: it isn't ours.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { SnapshotRepo, SnapshotStatus } from "../../shared/api.ts";
import { readRepos, repoState, STAMP_FILE } from "./repos.ts";
import type { RepoDef } from "./repos.ts";
import type { SnapshotFile, SnapshotSource } from "./snapshot-sources/index.ts";
import { MANIFEST, parseManifest } from "./snapshot-sources/manifest.ts";
import type { Manifest, ManifestEntry } from "./snapshot-sources/manifest.ts";
import { extractTarGz } from "./tar.ts";
import { extractZip } from "./zip.ts";
import { canInstallFrom, installerName, renderInstaller, type InstallerRole } from "./installer.ts";

const run = promisify(execFile);
const MANIFEST_TTL_MS = 60_000;
export interface Stamp { name: string; sha: string; builtAt: string; source: string; downloadedAt?: string }

/**
 * Published file names carry the commit, so a new publish never overwrites a file the
 * current manifest names: until the new manifest is up, the old snapshot stays whole.
 * A repo name that had to be made file-safe also gets a short hash of the original,
 * so "api/core" and "api-core" can't land on the same file.
 */
export function archiveName(repoName: string, sha: string): string {
  const safe = repoName.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const tag = safe === repoName && safe ? "" : `-${crypto.createHash("sha1").update(repoName).digest("hex").slice(0, 6)}`;
  return `${safe || "repo"}${tag}-${sha.slice(0, 12)}.tar.gz`;
}
export const workspaceFile = (sha: string) => `workspace-${sha.slice(0, 12)}.zip`;
export const uiFile = (sha: string) => `dashboard-ui-${sha.slice(0, 12)}.tar.gz`;

/** Every file a manifest names (the manifest itself not included). */
export function manifestFiles(m: Manifest | null): string[] {
  if (!m) return [];
  return [...Object.values(m.repos), m.workspace, m.ui, m.installer].filter((e): e is ManifestEntry => !!e).map((e) => e.file);
}

export function readStamp(dir: string): Stamp | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, STAMP_FILE), "utf-8"));
    return s && typeof s.sha === "string" ? s : null;
  } catch { return null; }
}

const tmpDir = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `aos-snapshot-${tag}-`));
const rmrf = (p: string) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

// ------------------------------------------------------------------ reading

let manifestCache: { key: string; at: number; manifest: Manifest; files: SnapshotFile[] } | null = null;

/** The published manifest and file list (cached a minute; force skips the cache). */
export async function fetchManifest(source: SnapshotSource, key: string, force = false): Promise<{ manifest: Manifest; files: SnapshotFile[] }> {
  if (!force && manifestCache && manifestCache.key === key && Date.now() - manifestCache.at < MANIFEST_TTL_MS) return manifestCache;
  const files = await source.list();
  const mf = files.find((f) => f.name === MANIFEST);
  if (!mf) throw new Error(`Nothing has been published yet: there's no ${MANIFEST} at the ${source.label} source.`);
  const dir = tmpDir("manifest");
  try {
    const file = path.join(dir, MANIFEST);
    await source.download(mf, file);
    let data: any;
    try { data = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { throw new Error(`${MANIFEST} isn't valid JSON.`); }
    const manifest = parseManifest(data);
    if (!manifest) throw new Error(`${MANIFEST} isn't a snapshot manifest (version 1).`);
    manifestCache = { key, at: Date.now(), manifest, files };
    return manifestCache;
  } finally { rmrf(dir); }
}

export function dropManifestCache() { manifestCache = null; }

/** Every repos.json repo against the published manifest: what's here, what's published, whether it needs a download. */
export async function snapshotStatus(root: string, source: SnapshotSource | null, force = false): Promise<SnapshotStatus> {
  const cfg = readRepos(root);
  const base: SnapshotStatus = {
    configured: !!cfg.snapshot, sourceKind: cfg.snapshot ? cfg.snapshot.source : null, label: source ? source.label : null,
    connection: source ? source.status() : null, connect: null, builtAt: null, workspace: null, repos: [], error: cfg.error,
    canPublish: !!source && !!source.upload && source.status().connected,
  };
  if (!cfg.snapshot || !source) return base;
  const rows = (manifest: Manifest | null): SnapshotRepo[] => cfg.repos.map((r) => {
    const state = repoState(root, r.relativePath);
    const local = state === "snapshot" ? readStamp(path.join(root, r.relativePath)) : null;
    const latest = manifest ? manifest.repos[r.name] || null : null;
    return {
      name: r.name, relativePath: r.relativePath, layer: r.layer, included: r.snapshot, state,
      local: local ? { sha: local.sha, builtAt: local.builtAt } : null,
      latest: latest ? { sha: latest.sha, builtAt: latest.builtAt, size: latest.size } : null,
      needsDownload: canDownload(state) && !!latest && (!local || local.sha !== latest.sha),
    };
  });
  if (!base.connection!.connected) return { ...base, connect: source.connectHelp(), repos: rows(null) };
  try {
    const { manifest } = await fetchManifest(source, JSON.stringify(cfg.snapshot), force);
    const rootStamp = readStamp(root);
    return {
      ...base, builtAt: manifest.builtAt, repos: rows(manifest),
      workspace: manifest.workspace ? {
        latest: { sha: manifest.workspace.sha, builtAt: manifest.workspace.builtAt, size: manifest.workspace.size },
        local: rootStamp ? { sha: rootStamp.sha, builtAt: rootStamp.builtAt } : null,
        installer: manifest.installer ? manifest.installer.file : null,
      } : null,
    };
  } catch (e) {
    return { ...base, repos: rows(null), error: (e as Error).message };
  }
}

/** Only an absent/empty folder or one we extracted is ever written. */
const canDownload = (state: string) => state === "missing" || state === "snapshot";

/** Repos a download would fetch: allowed, published, and missing or older; `names` narrows it. */
export async function downloadTargets(root: string, source: SnapshotSource, names: string[] | null): Promise<{ repo: RepoDef; entry: ManifestEntry; file: SnapshotFile }[]> {
  const cfg = readRepos(root);
  const { manifest, files } = await fetchManifest(source, JSON.stringify(cfg.snapshot), true);
  const out: { repo: RepoDef; entry: ManifestEntry; file: SnapshotFile }[] = [];
  for (const repo of cfg.repos) {
    if (!repo.snapshot || (names && !names.includes(repo.name))) continue;
    const entry = manifest.repos[repo.name];
    const file = entry && files.find((f) => f.name === entry.file);
    if (!entry || !file) continue;
    const state = repoState(root, repo.relativePath);
    if (!canDownload(state)) continue;
    const local = state === "snapshot" ? readStamp(path.join(root, repo.relativePath)) : null;
    if (local && local.sha === entry.sha) continue;
    out.push({ repo, entry, file });
  }
  return out;
}

// ------------------------------------------------------------------ downloading

/**
 * A job step: download one repo's archive, extract it beside the target, stamp it and
 * swap it in. The old copy is only removed once the new one is in place.
 */
export function downloadStep(root: string, source: SnapshotSource, t: { repo: RepoDef; entry: ManifestEntry; file: SnapshotFile }) {
  return async (log: (text: string) => void) => {
    const target = path.join(root, t.repo.relativePath);
    const parent = path.dirname(target);
    const base = path.basename(target);
    const staging = path.join(parent, `.${base}.snapshot-new`);
    const old = path.join(parent, `.${base}.snapshot-old`);
    const dl = tmpDir("dl");
    try {
      const archive = path.join(dl, t.entry.file);
      log(`Downloading ${t.entry.file} (${t.entry.sha.slice(0, 10)}, built ${t.entry.builtAt}) from ${source.label}`);
      await source.download(t.file, archive);
      const size = fs.statSync(archive).size;
      if (t.entry.size && size !== t.entry.size) throw new Error(`Downloaded ${size} bytes; the manifest says ${t.entry.size}. Try again.`);
      fs.mkdirSync(parent, { recursive: true });
      rmrf(staging);
      const r = await extractTarGz(archive, staging);
      log(`Extracted ${r.files} files (${Math.round(r.bytes / 1024 / 1024)} MB)${r.skipped ? `, skipped ${r.skipped} links` : ""}`);
      const stamp: Stamp = { name: t.repo.name, sha: t.entry.sha, builtAt: t.entry.builtAt, source: source.kind, downloadedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(staging, STAMP_FILE), JSON.stringify(stamp, null, 2) + "\n");
      // Checked again: something may have been cloned or written there meanwhile.
      const state = repoState(root, t.repo.relativePath);
      if (!canDownload(state)) throw new Error(`${t.repo.relativePath} is now a ${state === "cloned" ? "git clone" : "folder with other files"}; not replacing it.`);
      rmrf(old);
      if (fs.existsSync(target)) fs.renameSync(target, old);
      try { fs.renameSync(staging, target); }
      catch (e) {
        if (fs.existsSync(old)) fs.renameSync(old, target);
        throw new Error(`Couldn't put the new copy in place (${(e as Error).message}). Close anything that has files open in ${t.repo.relativePath} and try again.`);
      }
      rmrf(old);
      log(`${t.repo.relativePath} is now at ${t.entry.sha.slice(0, 10)}`);
    } finally {
      rmrf(dl);
      rmrf(staging);
    }
  };
}

// ------------------------------------------------------------------ installing a workspace

/** The workspace stamp's sha while an install is copying files: never a commit, so the next install redoes it. */
export const INSTALLING = "installing";

/** A workspace folder whose last install didn't finish (its files are a mix): don't run it. */
export function isInstalling(dir: string): boolean {
  return readStamp(dir)?.sha === INSTALLING;
}

export interface InstallResult { workspace: "installed" | "updated" | "current"; sha: string; ui: boolean; repos: number }

/**
 * Install or update a whole workspace from its published snapshot, with no git: what a
 * hosted container runs on boot (`snapshot.mjs install`). workspace.zip goes over
 * `dir` (only an absent or empty folder, or one installed this way: never a git clone),
 * then the prebuilt UI, then, with `repos`, every repo that's missing or older.
 * Everything else in `dir` is left alone: the ledger, downloaded repos. Files deleted
 * from the workspace since the last install stay until the folder is installed fresh.
 */
export async function installWorkspace(source: SnapshotSource, dir: string, opts: { repos?: boolean; log?: (t: string) => void } = {}): Promise<InstallResult> {
  const log = opts.log || (() => {});
  const state = repoState(path.dirname(path.resolve(dir)), path.basename(path.resolve(dir)));
  if (!canDownload(state)) throw new Error(`${dir} is ${state === "cloned" ? "a git clone" : "a folder with other files"}; not installing over it.`);
  const { manifest, files } = await fetchManifest(source, `install:${dir}`, true);
  const ws = manifest.workspace;
  const wsFile = ws && files.find((f) => f.name === ws.file);
  if (!ws || !wsFile) throw new Error("Nothing has been published for the workspace itself yet (no workspace zip in the manifest).");
  const fetchTo = async (entry: ManifestEntry, file: SnapshotFile, into: string) => {
    const archive = path.join(into, entry.file);
    log(`Downloading ${entry.file} (${entry.sha.slice(0, 10)}, built ${entry.builtAt}) from ${source.label}`);
    await source.download(file, archive);
    if (entry.size && fs.statSync(archive).size !== entry.size) throw new Error(`Downloaded ${fs.statSync(archive).size} bytes of ${entry.file}; the manifest says ${entry.size}. Try again.`);
    return archive;
  };

  const local = readStamp(dir);
  const stampFile = path.join(dir, STAMP_FILE);
  const dist = path.join(dir, "dashboard", "dist");
  const uiFileAt = manifest.ui && files.find((f) => f.name === manifest.ui!.file);
  const prebuilt = (() => { try { return JSON.parse(fs.readFileSync(path.join(dist, ".prebuilt.json"), "utf-8")).sha; } catch { return null; } })();
  const needWorkspace = !local || local.sha !== ws.sha;
  const needUi = !!(manifest.ui && uiFileAt) && (needWorkspace || prebuilt !== manifest.ui!.sha);
  if (!manifest.ui) log("No prebuilt UI was published: the dashboard builds it on first start.");

  // Copying over the live folder isn't atomic. Mark it first, so an interruption leaves a
  // folder that's still ours to retry (not "other files") and isn't taken as current
  // (`isInstalling`: the hosted entrypoint won't start it). The real stamp goes back in
  // only once the workspace files and the UI are both in place.
  let finalStamp: string | Buffer | null = null;
  if (needWorkspace || needUi) {
    fs.mkdirSync(dir, { recursive: true });
    finalStamp = needWorkspace ? null : fs.readFileSync(stampFile);
    const marker: Stamp = { name: "workspace", sha: INSTALLING, builtAt: ws.builtAt, source: source.kind };
    fs.writeFileSync(stampFile, JSON.stringify(marker, null, 2) + "\n");
  }

  let workspace: InstallResult["workspace"] = "current";
  if (needWorkspace) {
    const tmp = tmpDir("ws");
    try {
      const staged = path.join(tmp, "workspace");
      const r = await extractZip(await fetchTo(ws, wsFile, tmp), staged);
      log(`Extracted ${r.files} workspace files`);
      const stamp = path.join(staged, STAMP_FILE);
      finalStamp = fs.existsSync(stamp) ? fs.readFileSync(stamp) : JSON.stringify({ name: "workspace", sha: ws.sha, builtAt: ws.builtAt, source: source.kind }, null, 2) + "\n";
      fs.rmSync(stamp, { force: true });
      fs.cpSync(staged, dir, { recursive: true, force: true });
    } finally { rmrf(tmp); }
    workspace = local && local.sha !== INSTALLING ? "updated" : "installed";
  }

  // After the workspace files, so the built UI is newer than its sources and isn't rebuilt.
  // Staged beside dist/ and swapped in by rename: there's never a half-copied dist/ that
  // has a .prebuilt.json, which would pass for complete.
  let ui = false;
  if (needUi) {
    const tmp = tmpDir("ui");
    const next = path.join(dir, "dashboard", ".dist-new"), old = path.join(dir, "dashboard", ".dist-old");
    try {
      const staged = path.join(tmp, "ui");
      await extractTarGz(await fetchTo(manifest.ui!, uiFileAt!, tmp), staged);
      rmrf(next); rmrf(old);
      fs.cpSync(path.join(staged, "dist"), next, { recursive: true });
      if (fs.existsSync(dist)) fs.renameSync(dist, old);
      fs.renameSync(next, dist);
      rmrf(old);
      ui = true;
      log("Installed the prebuilt dashboard UI");
    } finally { rmrf(tmp); rmrf(next); }
  }

  if (finalStamp !== null) {
    fs.writeFileSync(stampFile, finalStamp);
    if (needWorkspace) log(`${dir} is now at ${ws.sha.slice(0, 10)}`);
  }

  let repos = 0;
  if (opts.repos) {
    for (const t of await downloadTargets(dir, source, null)) { await downloadStep(dir, source, t)(log); repos++; }
    log(repos ? `Downloaded ${repos} repo${repos === 1 ? "" : "s"}` : "Every repo is current");
  }
  return { workspace, sha: ws.sha, ui, repos };
}

// ------------------------------------------------------------------ publishing

/** Archives hold files as committed: the publishing machine's core.autocrlf (CRLF on many Windows setups) doesn't apply. */
const AS_COMMITTED = ["-c", "core.autocrlf=false"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
  return String(stdout).trim();
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).catch(() => null);

/**
 * The default branch of a clone's origin: repos.json defaultBranch, else origin/HEAD
 * (asking the remote if the clone never recorded it), else main / master.
 */
async function defaultBranch(dir: string, configured: string | null): Promise<string> {
  if (configured) return configured;
  const head = async () => (await tryGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.replace(/^origin\//, "") || null;
  let b = await head();
  if (!b && (await tryGit(dir, ["remote", "set-head", "origin", "--auto"])) !== null) b = await head();
  for (const guess of ["main", "master"]) if (!b && (await tryGit(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${guess}`])) !== null) b = guess;
  if (!b) throw new Error("its origin has no default branch this clone knows of; set defaultBranch in repos.json");
  return b;
}

/** One repo (or the workspace root) as it will be published: the default branch's latest commit on origin. */
export interface PublishTarget { name: string; relativePath: string; branch: string; sha: string; subject: string; committedAt: string }
export interface PublishPlan { repos: PublishTarget[]; workspace: PublishTarget | null; skipped: { name: string; reason: string }[] }

/**
 * What a publish would upload: for each included repo, `git fetch` its default branch
 * from origin and take that commit, whatever the clone has checked out, so a work
 * branch or uncommitted changes never get published. A repo that isn't cloned here
 * or has no origin is skipped (`allowMissing`) or fails the plan.
 */
export async function planSnapshot(root: string, opts: { fetch?: boolean; workspace?: boolean; allowMissing?: boolean; log?: (t: string) => void } = {}): Promise<PublishPlan> {
  const log = opts.log || (() => {});
  const cfg = readRepos(root);
  if (cfg.error) throw new Error(cfg.error);
  if (!cfg.configured) throw new Error("There's no repos.json at the workspace root.");
  const plan: PublishPlan = { repos: [], workspace: null, skipped: [] };
  const target = async (name: string, rel: string, dir: string, configured: string | null): Promise<PublishTarget> => {
    if ((await tryGit(dir, ["remote", "get-url", "origin"])) === null) throw new Error("it has no origin remote");
    const branch = await defaultBranch(dir, configured);
    if (opts.fetch !== false) {
      log(`fetch ${name} (${branch})`);
      await git(dir, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    }
    const ref = `refs/remotes/origin/${branch}`;
    const [sha, subject, committedAt] = (await git(dir, ["log", "-1", "--format=%H%x00%s%x00%cI", ref])).split("\0");
    return { name, relativePath: rel, branch, sha, subject, committedAt };
  };
  for (const r of cfg.repos) {
    if (!r.snapshot) continue;
    const skip = (reason: string) => {
      if (!opts.allowMissing) throw new Error(`${r.name} (${r.relativePath}): ${reason}. Clone it first (publish --clone), or set "snapshot": false on it in repos.json.`);
      plan.skipped.push({ name: r.name, reason });
      log(`skip ${r.name}: ${reason}`);
    };
    if (repoState(root, r.relativePath) !== "cloned") { skip("not cloned here"); continue; }
    try { plan.repos.push(await target(r.name, r.relativePath, path.join(root, r.relativePath), r.defaultBranch)); }
    catch (e) { skip((e as Error).message.split("\n")[0]); }
  }
  if (opts.workspace !== false && fs.existsSync(path.join(root, ".git"))) {
    try { plan.workspace = await target("workspace", ".", root, null); }
    catch (e) { log(`skip workspace.zip: ${(e as Error).message.split("\n")[0]}`); }
  }
  return plan;
}

/**
 * Build the files to publish into outDir: one <name>.tar.gz per planned repo (at the
 * planned commit), workspace.zip, and the manifest. Plans first unless given a plan.
 */
export async function buildSnapshot(root: string, outDir: string, opts: { workspace?: boolean; fetch?: boolean; plan?: PublishPlan; log?: (t: string) => void; installer?: { name: string; sourceLabel: string; roles?: InstallerRole[] } } = {}): Promise<Manifest> {
  const log = opts.log || (() => {});
  const plan = opts.plan || await planSnapshot(root, { fetch: opts.fetch, workspace: opts.workspace, log });
  fs.mkdirSync(outDir, { recursive: true });
  const builtAt = new Date().toISOString();
  const entry = (file: string, sha: string): ManifestEntry => ({ file, sha, size: fs.statSync(path.join(outDir, file)).size, builtAt });
  const repos: Record<string, ManifestEntry> = {};
  for (const t of plan.repos) {
    const file = archiveName(t.name, t.sha);
    if (Object.values(repos).some((e) => e.file === file)) throw new Error(`Two repos would publish as ${file}; rename one in repos.json.`);
    await git(path.join(root, t.relativePath), [...AS_COMMITTED, "archive", "--format=tar.gz", "-o", path.join(outDir, file), t.sha]);
    repos[t.name] = entry(file, t.sha);
    log(`${t.name}: ${file} ${Math.round(repos[t.name].size / 1024)} KB, ${t.branch} at ${t.sha.slice(0, 10)}`);
  }
  let workspace: ManifestEntry | null = null;
  if (plan.workspace) {
    const t = plan.workspace;
    const stamp = JSON.stringify({ name: "workspace", sha: t.sha, builtAt, source: "publish" });
    // The stamp rides inside the zip, so the Repos page can tell how old the workspace files are.
    await git(root, [...AS_COMMITTED, "archive", "--format=zip", `--add-virtual-file=${STAMP_FILE}:${stamp}`, "-o", path.join(outDir, workspaceFile(t.sha)), t.sha]);
    workspace = entry(workspaceFile(t.sha), t.sha);
    log(`workspace: ${workspace.file} ${Math.round(workspace.size / 1024)} KB, ${t.branch} at ${t.sha.slice(0, 10)}`);
  }
  let ui: ManifestEntry | null = null, installer: ManifestEntry | null = null;
  if (plan.workspace) {
    if (await buildUi(root, outDir, plan.workspace.sha, log)) ui = entry(uiFile(plan.workspace.sha), plan.workspace.sha);
    const snap = readRepos(root).snapshot;
    if (snap && canInstallFrom(snap) && opts.installer) {
      const file = installerName(opts.installer.name);
      fs.writeFileSync(path.join(outDir, file), renderInstaller({
        name: opts.installer.name, folder: path.basename(path.resolve(root)), source: snap, sourceLabel: opts.installer.sourceLabel, nodeMin: nodeFloor(), roles: opts.installer.roles,
      }));
      installer = entry(file, plan.workspace.sha);
      log(`installer: ${file}`);
    }
  }
  const manifest: Manifest = { version: 1, builtAt, repos, workspace, ui, installer };
  fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}


/** The dashboard's Node floor, from its package.json engines. */
function nodeFloor(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8"));
    return (/(\d+\.\d+\.\d+)/.exec(String(pkg.engines && pkg.engines.node)) || [])[1] || "24.0.0";
  } catch { return "24.0.0"; }
}

/** Newest mtime under p, skipping installs and build output (as dashboard.mjs does). */
function newest(p: string): number {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    max = Math.max(max, newest(path.join(p, e.name)));
  }
  return max;
}

/**
 * dashboard-ui.tar.gz: this machine's built dashboard UI (dashboard/dist), marked
 * prebuilt, so the downloaded workspace starts without npm or a build. Only when the
 * dashboard here is exactly the published commit's (no edits, nothing untracked) and
 * the build is newer than its sources; otherwise it's left out and a download builds
 * it on first start. Returns whether it was made.
 */
async function buildUi(root: string, outDir: string, sha: string, log: (t: string) => void): Promise<boolean> {
  const dash = path.join(root, "dashboard");
  const index = path.join(dash, "dist", "browser", "index.html");
  const skip = (why: string) => { log(`dashboard UI not included: ${why}`); return false; };
  if (!fs.existsSync(index)) return skip("dashboard/dist isn't built here");
  if ((await tryGit(root, ["diff", "--quiet", sha, "--", "dashboard"])) === null) return skip("dashboard/ here differs from the published commit");
  const untracked = await tryGit(root, ["status", "--porcelain", "--untracked-files=all", "--", "dashboard"]);
  if (untracked === null || untracked.trim()) return skip("dashboard/ here has untracked or changed files");
  const sources = Math.max(...["web", "shared", "angular.json", "package.json", "tsconfig.json"].map((s) => newest(path.join(dash, s))));
  if (sources > fs.statSync(index).mtimeMs) return skip("dashboard/dist is older than its sources (run npm run build in dashboard/)");
  const stage = tmpDir("ui");
  try {
    fs.cpSync(path.join(dash, "dist"), path.join(stage, "dist"), { recursive: true });
    fs.writeFileSync(path.join(stage, "dist", ".prebuilt.json"), JSON.stringify({ sha, builtAt: new Date().toISOString() }) + "\n");
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    await run(tar, ["-czf", path.join(outDir, uiFile(sha)), "-C", stage, "dist"], { windowsHide: true, timeout: 5 * 60_000 });
    log(`dashboard UI: ${uiFile(sha)} ${Math.round(fs.statSync(path.join(outDir, uiFile(sha))).size / 1024)} KB`);
    return true;
  } finally { rmrf(stage); }
}

/**
 * Repos a publish skipped keep what was published before, when that file is still at
 * the source: a partial publish (someone without every repo cloned) doesn't drop them.
 */
export function carryOver(manifest: Manifest, previous: Manifest | null, files: SnapshotFile[], skipped: string[]): string[] {
  if (!previous) return [];
  const kept: string[] = [];
  for (const name of skipped) {
    const e = previous.repos[name];
    if (e && !manifest.repos[name] && files.some((f) => f.name === e.file)) { manifest.repos[name] = e; kept.push(name); }
  }
  // Not rebuilt this time: the workspace files, their UI and the installer stay as they were.
  const keep = (e: ManifestEntry | null | undefined) => (e && files.some((f) => f.name === e.file) ? e : null);
  if (!manifest.workspace && keep(previous.workspace)) { manifest.workspace = previous.workspace; manifest.ui = keep(previous.ui); manifest.installer = keep(previous.installer); }
  return kept;
}

/** Rewrite the manifest file after carryOver changed it. */
export function writeManifest(outDir: string, manifest: Manifest) {
  fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Upload what buildSnapshot made, then the manifest, and only then remove what the
 * previous manifest named and the new one doesn't (file names carry the commit, so
 * until the new manifest is up the old snapshot is untouched). Pruning old versions
 * only touches the snapshot's own files, never other attachments at the source.
 */
export async function publishSnapshot(source: SnapshotSource, outDir: string, manifest: Manifest, log: (t: string) => void = () => {}): Promise<void> {
  if (!source.upload) throw new Error(`The ${source.label} source can't be published to from here; copy the files in ${outDir} to it yourself.`);
  let previous: Manifest | null = null;
  try { previous = (await fetchManifest(source, `publish:${manifest.builtAt}`, true)).manifest; } catch { /* first publish */ }
  // Only what this run built: entries carried over from the last publish are already at the source.
  const files = [...Object.values(manifest.repos), ...[manifest.workspace, manifest.ui, manifest.installer].filter((e): e is ManifestEntry => !!e)]
    .filter((f) => f.builtAt === manifest.builtAt && fs.existsSync(path.join(outDir, f.file)));
  const tooBig = source.maxFileBytes ? files.filter((f) => f.size > source.maxFileBytes!) : [];
  if (tooBig.length) {
    const mb = (n: number) => `${Math.ceil(n / 1024 / 1024)} MB`;
    throw new Error(`Over the ${source.label} limit of ${mb(source.maxFileBytes!)}: ${tooBig.map((f) => `${f.file} (${mb(f.size)})`).join(", ")}. Leave those repos out ("snapshot": false) or raise the limit.`);
  }
  for (const f of files) { log(`upload ${f.file}`); await source.upload(f.file, path.join(outDir, f.file)); }
  log(`upload ${MANIFEST}`);
  await source.upload(MANIFEST, path.join(outDir, MANIFEST));
  dropManifestCache();
  const keep = new Set([...manifestFiles(manifest), MANIFEST]);
  const stale = new Set(manifestFiles(previous).filter((f) => !keep.has(f)));
  if (stale.size && source.remove) {
    for (const f of await source.list()) if (stale.has(f.name)) { log(`remove ${f.name} (no longer published)`); await source.remove(f); }
  }
  if (source.prune) log(`pruned ${await source.prune([...keep])} old versions`);
}

/** Shallow-clone repos.json repos that aren't here yet (publish --clone, for CI). */
export async function cloneForPublish(root: string, log: (t: string) => void = () => {}): Promise<void> {
  for (const r of readRepos(root).repos) {
    if (!r.snapshot || repoState(root, r.relativePath) !== "missing") continue;
    if (!r.remote) throw new Error(`${r.name} isn't here and has no remote to clone it from.`);
    log(`clone ${r.name}`);
    fs.mkdirSync(path.dirname(path.join(root, r.relativePath)), { recursive: true });
    await git(root, ["clone", "--depth", "1", ...(r.defaultBranch ? ["--branch", r.defaultBranch] : []), "--", r.remote, r.relativePath]);
  }
}

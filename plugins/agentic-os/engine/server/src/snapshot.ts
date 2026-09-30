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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SnapshotRepo, SnapshotStatus } from "../../shared/api.ts";
import { readRepos, repoState, STAMP_FILE } from "./repos.ts";
import type { RepoDef } from "./repos.ts";
import type { SnapshotFile, SnapshotSource } from "./snapshot-sources/index.ts";
import { MANIFEST, parseManifest } from "./snapshot-sources/manifest.ts";
import type { Manifest, ManifestEntry } from "./snapshot-sources/manifest.ts";
import { extractTarGz } from "./tar.ts";

const run = promisify(execFile);
const MANIFEST_TTL_MS = 60_000;
export const WORKSPACE_FILE = "workspace.zip";

export interface Stamp { name: string; sha: string; builtAt: string; source: string; downloadedAt?: string }

/** A repo's archive name: its repos.json name, made file-safe. */
export const archiveName = (repoName: string) => `${repoName.replace(/[^\w.-]+/g, "-")}.tar.gz`;

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

// ------------------------------------------------------------------ publishing

/** Archives hold files as committed: the publishing machine's core.autocrlf (CRLF on many Windows setups) doesn't apply. */
const AS_COMMITTED = ["-c", "core.autocrlf=false"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
  return String(stdout).trim();
}

/**
 * Build the files to publish into outDir: one <name>.tar.gz per included repo (its
 * checked-out commit), workspace.zip, and the manifest. Fails if an included repo
 * isn't a git clone here (`clone` first, e.g. in CI).
 */
export async function buildSnapshot(root: string, outDir: string, opts: { workspace?: boolean; log?: (t: string) => void } = {}): Promise<Manifest> {
  const log = opts.log || (() => {});
  const cfg = readRepos(root);
  if (cfg.error) throw new Error(cfg.error);
  if (!cfg.configured) throw new Error("There's no repos.json at the workspace root.");
  fs.mkdirSync(outDir, { recursive: true });
  const builtAt = new Date().toISOString();
  const missing = cfg.repos.filter((r) => r.snapshot && repoState(root, r.relativePath) !== "cloned");
  if (missing.length) throw new Error(`Not cloned here: ${missing.map((r) => r.relativePath).join(", ")}. Clone them first (publish --clone), or set "snapshot": false on them in repos.json.`);
  const entry = (file: string, sha: string): ManifestEntry => ({ file, sha, size: fs.statSync(path.join(outDir, file)).size, builtAt });
  const repos: Record<string, ManifestEntry> = {};
  for (const r of cfg.repos) {
    if (!r.snapshot) { log(`skip ${r.name} ("snapshot": false)`); continue; }
    const dir = path.join(root, r.relativePath);
    const sha = await git(dir, ["rev-parse", "HEAD"]);
    const file = archiveName(r.name);
    await git(dir, [...AS_COMMITTED, "archive", "--format=tar.gz", "-o", path.join(outDir, file), "HEAD"]);
    repos[r.name] = entry(file, sha);
    log(`${r.name}: ${file} ${Math.round(repos[r.name].size / 1024)} KB at ${sha.slice(0, 10)}`);
  }
  let workspace: ManifestEntry | null = null;
  if (opts.workspace !== false && fs.existsSync(path.join(root, ".git"))) {
    const sha = await git(root, ["rev-parse", "HEAD"]);
    const stamp = JSON.stringify({ name: "workspace", sha, builtAt, source: "publish" });
    // The stamp rides inside the zip, so the Repos page can tell how old the workspace files are.
    await git(root, [...AS_COMMITTED, "archive", "--format=zip", `--add-virtual-file=${STAMP_FILE}:${stamp}`, "-o", path.join(outDir, WORKSPACE_FILE), "HEAD"]);
    workspace = entry(WORKSPACE_FILE, sha);
    log(`workspace: ${WORKSPACE_FILE} ${Math.round(workspace.size / 1024)} KB at ${sha.slice(0, 10)}`);
  }
  const manifest: Manifest = { version: 1, builtAt, repos, workspace };
  fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** Upload what buildSnapshot made: every archive, then the manifest, then prune old versions. */
export async function publishSnapshot(source: SnapshotSource, outDir: string, manifest: Manifest, log: (t: string) => void = () => {}): Promise<void> {
  if (!source.upload) throw new Error(`The ${source.label} source can't be published to from here; copy the files in ${outDir} to it yourself.`);
  const files = [...Object.values(manifest.repos), ...(manifest.workspace ? [manifest.workspace] : [])];
  const tooBig = source.maxFileBytes ? files.filter((f) => f.size > source.maxFileBytes!) : [];
  if (tooBig.length) {
    const mb = (n: number) => `${Math.ceil(n / 1024 / 1024)} MB`;
    throw new Error(`Over the ${source.label} limit of ${mb(source.maxFileBytes!)}: ${tooBig.map((f) => `${f.file} (${mb(f.size)})`).join(", ")}. Leave those repos out ("snapshot": false) or raise the limit.`);
  }
  for (const f of files) { log(`upload ${f.file}`); await source.upload(f.file, path.join(outDir, f.file)); }
  log(`upload ${MANIFEST}`);
  await source.upload(MANIFEST, path.join(outDir, MANIFEST));
  if (source.prune) log(`pruned ${await source.prune()} old versions`);
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

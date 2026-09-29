/**
 * Shared helpers for the agentic-os scripts. Zero dependencies.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE_DIR = path.join(PLUGIN_DIR, "engine");
export const TEMPLATES_DIR = path.join(PLUGIN_DIR, "templates");
export const SOURCE_REPO = "https://github.com/lhoezee/skills";
export const TAG_PREFIX = "agentic-os-v";
export const PLUGIN_NAME = "agentic-os";
// Installed plugins live at <plugins>/cache/<marketplace>/agentic-os/<version>; a checkout of the repo doesn't.
const INSTALLED = path.basename(path.dirname(PLUGIN_DIR)) === PLUGIN_NAME;
export const MARKETPLACE = INSTALLED ? path.basename(path.dirname(path.dirname(PLUGIN_DIR))) : "lhoezee-skills";

/** Folders never copied, compared or merged: installs, builds, caches. */
export const IGNORE = new Set(["node_modules", "dist", ".angular", "out-tsc", ".git"]);

export const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf-8").replace(/^﻿/, "")); } catch { return null; } };
export const writeJson = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n"); };

/** repos.json's schema, as a workspace refers to it (the engine ships a copy under dashboard/). */
export const REPOS_SCHEMA = "./dashboard/shared/repos.schema.json";

/**
 * A relative folder inside the workspace ("api", "services/billing"), forward
 * slashes, or null: absolute paths, drive letters and ".." segments are refused.
 */
export function safeRelativePath(p) {
  if (typeof p !== "string") return null;
  const s = p.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!s || s === "." || s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.split("/").includes("..")) return null;
  return s;
}

/**
 * One repos.json entry → { name, relativePath, remote, layer, defaultBranch, dependencies },
 * or null when it has no usable name or path. `relativePath` / `remote` are the
 * standard names; the older `directory` / `dir` / `path` and `url` are still read.
 * The path defaults to the name. The engine's server/src/repos.ts does the same.
 */
export function normalizeRepo(r) {
  if (!r || typeof r !== "object") return null;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const relativePath = safeRelativePath(r.relativePath ?? r.directory ?? r.dir ?? r.path ?? name);
  if (!name || !relativePath) return null;
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    name,
    relativePath,
    remote: str(r.remote ?? r.url),
    layer: str(r.layer),
    defaultBranch: str(r.defaultBranch),
    dependencies: Array.isArray(r.dependencies) ? r.dependencies.filter((d) => typeof d === "string") : [],
  };
}

/** The workspace's repos.json, normalized (entries without a usable name/path dropped); [] when there's none. */
export function readRepos(root) {
  const manifest = readJson(path.join(root, "repos.json"));
  const list = manifest && Array.isArray(manifest.repos) ? manifest.repos : [];
  return list.map(normalizeRepo).filter(Boolean);
}

export function engineVersion(dir = ENGINE_DIR) {
  return (readJson(path.join(dir, "ENGINE.json")) || readJson(path.join(dir, "package.json")) || {}).version || null;
}

export const pluginVersion = () => (readJson(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json")) || {}).version || null;

const semver = (v) => (/(\d+)\.(\d+)\.(\d+)/.exec(String(v || "")) || []).slice(1).map(Number);
/** Sort-style comparison of x.y.z versions (a leading "v" is fine): <0, 0 or >0. */
export function compareVersions(a, b) {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** The newest agentic-os-v<x.y.z> tag on the source repo, or null (offline, or no tags). */
export function latestRelease(repo = SOURCE_REPO) {
  try {
    const out = execFileSync("git", ["ls-remote", "--tags", "--refs", repo, `${TAG_PREFIX}*`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 });
    const tag = new RegExp(`refs/tags/${TAG_PREFIX}(\\d+\\.\\d+\\.\\d+)$`);
    return out.split("\n").map((l) => (tag.exec(l.trim()) || [])[1]).filter(Boolean).sort(compareVersions).pop() || null;
  } catch {
    return null;
  }
}

/**
 * Is this copy of the plugin the newest release? Claude Code caches plugins and
 * doesn't refresh them by itself, so an old copy would "upgrade" to an old engine.
 * `latest` is null when the check couldn't run (offline). `update` is what to run;
 * `newRoot` is where the updated plugin lands, since a running skill keeps its
 * old folder.
 */
export function releaseCheck(latest) {
  const current = pluginVersion();
  const stale = !!(latest && current && compareVersions(latest, current) > 0);
  return {
    current,
    latest,
    stale,
    update: [`claude plugin marketplace update ${MARKETPLACE}`, `claude plugin update ${PLUGIN_NAME}@${MARKETPLACE}`],
    newRoot: stale && INSTALLED ? path.join(path.dirname(PLUGIN_DIR), latest) : null,
  };
}

/** Relative paths of every file under dir (forward slashes), skipping IGNORE folders. */
export function listFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

/** A text file (no NUL bytes up front) with CRLF, as LF; null for binary files and LF files. */
export function lfText(buf) {
  if (buf.subarray(0, 8000).includes(0)) return null;
  const s = buf.toString("utf-8");
  return s.includes("\r\n") ? s.replace(/\r\n/g, "\n") : null;
}

/**
 * Copy a folder. Text files are written with LF: a plugin cache checked out on
 * Windows with autocrlf has CRLF, and the engine (and its release tags) is LF, so
 * copying CRLF would make every file look edited to upgrade and contribute.
 */
export function copyTree(from, to) {
  for (const rel of listFiles(from)) {
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const src = path.join(from, rel);
    const lf = lfText(fs.readFileSync(src));
    if (lf !== null) fs.writeFileSync(dest, lf);
    else fs.copyFileSync(src, dest);
  }
}

/**
 * A file's content hash, ignoring line endings for text files: a Windows checkout
 * (git autocrlf) has CRLF where the plugin's copy has LF, and that isn't an edit.
 */
export const hashFile = (f) => {
  let buf;
  try { buf = fs.readFileSync(f); } catch { return null; }
  const text = !buf.subarray(0, 8000).includes(0);
  return crypto.createHash("sha1").update(text ? buf.toString("utf-8").replace(/\r\n/g, "\n") : buf).digest("hex");
};

/**
 * An earlier engine version, as the merge base for upgrades: the plugin's own
 * copy if it's that version, else a shallow clone of the release tag. Returns the
 * engine folder, or null (offline, or the tag doesn't exist).
 */
export function fetchEngine(version, repo = SOURCE_REPO) {
  if (!version) return null;
  if (engineVersion() === version) return ENGINE_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-base-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", `${TAG_PREFIX}${version}`, repo, tmp], { stdio: "ignore", timeout: 120000 });
    const dir = path.join(tmp, "plugins", "agentic-os", "engine");
    return fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

export function gitMergeFile(local, base, theirs) {
  // `git merge-file -p` prints the merge; exit code = number of conflicts (0 = clean).
  try {
    return { text: execFileSync("git", ["merge-file", "-p", "-L", "yours", "-L", "previous engine", "-L", "new engine", local, base, theirs], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }), conflicts: 0 };
  } catch (e) {
    if (typeof e.status === "number" && e.status > 0 && e.stdout) return { text: e.stdout, conflicts: e.status };
    throw e;
  }
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const k = a.slice(2);
    out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

// realpath both sides: a symlinked path (macOS /tmp -> /private/tmp) would otherwise never match.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
export const isMain = (meta) => !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(meta.url));

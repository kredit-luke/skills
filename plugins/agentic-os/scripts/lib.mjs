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

/** Folders never copied, compared or merged: installs, builds, caches. */
export const IGNORE = new Set(["node_modules", "dist", ".angular", "out-tsc", ".git"]);

export const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf-8").replace(/^﻿/, "")); } catch { return null; } };
export const writeJson = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n"); };

export function engineVersion(dir = ENGINE_DIR) {
  return (readJson(path.join(dir, "ENGINE.json")) || readJson(path.join(dir, "package.json")) || {}).version || null;
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

export function copyTree(from, to) {
  for (const rel of listFiles(from)) {
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
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

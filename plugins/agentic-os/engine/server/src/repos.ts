/**
 * repos.json: the repos that make up the workspace, each at <root>/<relativePath>
 * (schema: shared/repos.schema.json). Optional: without one the Repos page says how
 * to add it. `relativePath` / `remote` are the standard field names; the older
 * `directory` / `dir` / `path` and `url` are still read. The plugin's
 * scripts/lib.mjs normalizes entries the same way, for discover and doctor.
 *
 * Clone runs `git clone -- <remote> <relativePath>` for repos that aren't here yet,
 * as an app-launcher job (steps and a log, shown in the Logs dialog). It never
 * touches a folder that already has files in it.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { RepoInfo, ReposResponse } from "../../shared/api.ts";

export interface RepoDef {
  name: string;
  relativePath: string;
  remote: string | null;
  layer: string | null;
  defaultBranch: string | null;
  dependencies: string[];
}

const CLONE_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 8000;

/**
 * A relative folder inside the workspace ("api", "services/billing"), forward
 * slashes, or null: absolute paths, drive letters and ".." segments are refused.
 */
export function safeRelativePath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!s || s === "." || s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.split("/").includes("..")) return null;
  return s;
}

/** One repos.json entry, normalized; null when it has no usable name or path (the path defaults to the name). */
export function normalizeRepo(r: any): RepoDef | null {
  if (!r || typeof r !== "object") return null;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const relativePath = safeRelativePath(r.relativePath ?? r.directory ?? r.dir ?? r.path ?? name);
  if (!name || !relativePath) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    name,
    relativePath,
    remote: str(r.remote ?? r.url),
    layer: str(r.layer),
    defaultBranch: str(r.defaultBranch),
    dependencies: Array.isArray(r.dependencies) ? r.dependencies.filter((d: unknown) => typeof d === "string") : [],
  };
}

/** repos.json at the workspace root: configured = the file exists; entries without a usable name/path are dropped. */
export function readRepos(root: string): { configured: boolean; repos: RepoDef[]; error: string | null } {
  const file = path.join(root, "repos.json");
  let text: string;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return { configured: false, repos: [], error: null }; }
  let data: any;
  try { data = JSON.parse(text.replace(/^﻿/, "")); } catch (e) { return { configured: true, repos: [], error: `repos.json isn't valid JSON: ${(e as Error).message}` }; }
  if (!data || !Array.isArray(data.repos)) return { configured: true, repos: [], error: 'repos.json needs a "repos" array.' };
  const repos: RepoDef[] = [];
  const seen = new Set<string>();
  for (const raw of data.repos) {
    const r = normalizeRepo(raw);
    if (!r || seen.has(r.relativePath)) continue;
    seen.add(r.relativePath);
    repos.push(r);
  }
  return { configured: true, repos, error: null };
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

/** "cloned" (has .git: a folder, or a file for git worktrees), "missing" (absent or empty), or "not-git" (has files, no .git). */
export function repoState(root: string, rel: string): RepoInfo["state"] {
  const dir = path.join(root, rel);
  if (fs.existsSync(path.join(dir, ".git"))) return "cloned";
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return "missing"; }
  return entries.length ? "not-git" : "missing";
}

/** Every repos.json repo with what's on disk: cloned or not, and for clones the branch and uncommitted file count. */
export async function reposStatus(root: string): Promise<ReposResponse> {
  const { configured, repos, error } = readRepos(root);
  const out = await Promise.all(repos.map(async (r): Promise<RepoInfo> => {
    const state = repoState(root, r.relativePath);
    const info: RepoInfo = { ...r, state, branch: null, changes: null };
    if (state === "cloned") {
      const dir = path.join(root, r.relativePath);
      const [branch, status] = await Promise.all([git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), git(dir, ["status", "--porcelain"])]);
      info.branch = branch;
      info.changes = status === null ? null : status ? status.split("\n").length : 0;
    }
    return info;
  }));
  return { configured, repos: out, error };
}

/** The repos Clone would clone: not here yet and with a remote; `names` narrows it (null = all of them). */
export function cloneTargets(root: string, names: string[] | null): RepoDef[] {
  return readRepos(root).repos.filter((r) =>
    !!r.remote && repoState(root, r.relativePath) === "missing" && (!names || names.includes(r.name)));
}

/**
 * A job step that clones one repo. No terminal prompt (it would hang with nobody
 * to answer); a credential helper that opens its own sign-in window still works.
 */
export function cloneStep(root: string, repo: RepoDef) {
  return (log: (text: string) => void) => new Promise<void>((resolve, reject) => {
    const dest = path.join(root, repo.relativePath);
    // Re-checked here: the folder may have appeared since the job was queued.
    if (repoState(root, repo.relativePath) !== "missing") return reject(new Error(`${repo.relativePath} already has files in it; not touching it.`));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const args = ["clone", ...(repo.defaultBranch ? ["--branch", repo.defaultBranch] : []), "--", repo.remote!, dest];
    log(`$ git clone ${repo.defaultBranch ? `--branch ${repo.defaultBranch} ` : ""}${repo.remote} ${repo.relativePath}`);
    execFile("git", args, {
      cwd: root, timeout: CLONE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (err, stdout, stderr) => {
      if (stdout) log(String(stdout).trimEnd());
      if (stderr) log(String(stderr).trimEnd());
      if (!err) return resolve();
      reject(new Error((err as any).killed ? "Timed out" : /Authentication failed|could not read Username|terminal prompts disabled|Repository not found|403/i.test(String(stderr))
        ? "git couldn't sign in to the remote, or you don't have access to it"
        : `git clone failed (exit ${(err as any).code})`));
    });
  });
}

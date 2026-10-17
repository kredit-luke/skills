/**
 * Keep a hosted workspace's repos at their latest default branch with the team's read
 * token: what `snapshot.mjs pull-repos` runs on boot when GIT_TOKEN is set (entrypoint.sh
 * hands the token to git through GIT_ASKPASS). For each repos.json repo with a remote:
 *
 *   missing, or a snapshot copy   cloned (blobs fetched on demand), then swapped in for the copy
 *   a clone on its default branch with nothing uncommitted   fetched and fast-forwarded
 *   anything else (local changes, another branch, commits not on origin, files that
 *   aren't ours)   left alone, saying why
 *
 * The snapshot install never replaces a folder with .git, so once a repo is cloned it
 * stays with git and only this keeps it current. The person's own GitHub sign-in is never
 * used for this (credential.helper is emptied), only the token, as for the workspace.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { readRepos, repoState, type RepoDef } from "./repos.ts";

export interface PullResult { name: string; action: "cloned" | "updated" | "current" | "skipped" | "failed"; detail: string }

const CLONE_TIMEOUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
// No credential helper (only the token), and trust the folders: a hosted /data volume (an Azure
// Files share, an NFS mount) can belong to another user than the container's, and git then
// refuses to work in it ("dubious ownership").
const NO_HELPER = ["-c", "credential.helper=", "-c", "safe.directory=*"];

function git(cwd: string, args: string[], timeout = 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("git", [...NO_HELPER, ...args], { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (e, stdout, stderr) => resolve({ ok: !e, out: String(stdout || "").trim(), err: String(stderr || "").trim() }));
  });
}

const why = (err: string) => /Authentication failed|could not read Username|terminal prompts disabled|Repository not found|403/i.test(err)
  ? "the token can't read it (check GIT_TOKEN's access to this repo)"
  : err.split("\n").filter(Boolean).pop() || "git failed";

/** The branch a clone should follow: repos.json's defaultBranch, else origin's HEAD, else main. */
async function defaultBranch(dir: string, repo: RepoDef): Promise<string> {
  if (repo.defaultBranch) return repo.defaultBranch;
  const head = await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return head.ok && head.out.startsWith("origin/") ? head.out.slice("origin/".length) : "main";
}

/** Folders a person's own tooling fills, left out of the fingerprint (their contents go with the copy anyway). */
const SKIP = new Set([".git", "node_modules", ".angular", "dist", "bin", "obj"]);

/**
 * What's in a folder, as a hash of every file's path, size and modified time (null: it isn't
 * there). The pull runs while the dashboard is already up, so Clone missing or a run can
 * create or edit the folder during a clone that takes minutes: comparing this before the swap
 * keeps that work instead of deleting it.
 */
export function fingerprint(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash("sha1");
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name)) { h.update(`${rel}${e.name}/\n`); continue; }
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else { try { const st = fs.statSync(p); h.update(`${rel}${e.name}\0${st.size}\0${st.mtimeMs}\n`); } catch {} }
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

async function cloneOver(root: string, repo: RepoDef, replacing: boolean): Promise<PullResult> {
  const dest = path.join(root, repo.relativePath);
  const tmp = `${dest}.natterjack-clone`;
  const before = fingerprint(dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await git(root, ["clone", "--quiet", "--filter=blob:none", ...(repo.defaultBranch ? ["--branch", repo.defaultBranch] : []), "--", repo.remote!, tmp], CLONE_TIMEOUT_MS);
  if (!r.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { name: repo.name, action: "failed", detail: `couldn't clone: ${why(r.err)}${replacing ? "; keeping the snapshot copy" : ""}` };
  }
  // Someone cloned it, or changed the copy, while this cloned: theirs wins; the next start tries again.
  if (fingerprint(dest) !== before) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { name: repo.name, action: "skipped", detail: "changed while it was being cloned; left alone (the next start tries again)" };
  }
  // Swap in whole: the old copy goes only once the clone is in place.
  const old = `${dest}.natterjack-old`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dest)) fs.renameSync(dest, old);
  fs.renameSync(tmp, dest);
  fs.rmSync(old, { recursive: true, force: true });
  const sha = await git(dest, ["rev-parse", "--short", "HEAD"]);
  return { name: repo.name, action: "cloned", detail: `cloned at ${sha.out}${replacing ? " (in place of the snapshot copy)" : ""}` };
}

async function fastForward(dir: string, repo: RepoDef): Promise<PullResult> {
  const skip = (detail: string): PullResult => ({ name: repo.name, action: "skipped", detail });
  const status = await git(dir, ["status", "--porcelain"]);
  if (!status.ok) return { name: repo.name, action: "failed", detail: why(status.err) };
  if (status.out) return skip(`${status.out.split("\n").length} uncommitted change(s); not touching it`);
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).out;
  const want = await defaultBranch(dir, repo);
  if (branch !== want) return skip(`on branch ${branch || "(none)"}, not ${want}; not touching it`);
  const fetch = await git(dir, ["fetch", "--quiet", "origin", want], FETCH_TIMEOUT_MS);
  if (!fetch.ok) return { name: repo.name, action: "failed", detail: `couldn't fetch: ${why(fetch.err)}` };
  const before = (await git(dir, ["rev-parse", "--short", "HEAD"])).out;
  const merge = await git(dir, ["merge", "--ff-only", "--quiet", "FETCH_HEAD"]);
  if (!merge.ok) return skip(`has commits that aren't on origin/${want}; not touching it`);
  const after = (await git(dir, ["rev-parse", "--short", "HEAD"])).out;
  return before === after
    ? { name: repo.name, action: "current", detail: `already at ${after}` }
    : { name: repo.name, action: "updated", detail: `${before} → ${after}` };
}

/** Every repos.json repo with a remote, one at a time; never throws for one repo. */
export async function pullRepos(root: string, log: (t: string) => void = () => {}): Promise<PullResult[]> {
  const { repos, error } = readRepos(root);
  if (error) throw new Error(error);
  const out: PullResult[] = [];
  for (const repo of repos) {
    if (!repo.remote) continue;
    const state = repoState(root, repo.relativePath);
    let r: PullResult;
    try {
      r = state === "cloned" ? await fastForward(path.join(root, repo.relativePath), repo)
        : state === "not-git" ? { name: repo.name, action: "skipped", detail: "has files that aren't a clone or a snapshot copy; not touching it" }
        : await cloneOver(root, repo, state === "snapshot");
    } catch (e) {
      r = { name: repo.name, action: "failed", detail: (e as Error).message };
    }
    log(`${repo.name}: ${r.detail}`);
    out.push(r);
  }
  return out;
}

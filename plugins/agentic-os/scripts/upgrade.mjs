#!/usr/bin/env node
/**
 * Bring a workspace's dashboard/ up to the engine version this plugin ships,
 * keeping the team's own changes: a three-way merge per file between the version
 * they installed (the base, from .claude/dashboard/engine.json), their copy, and
 * the new engine.
 *
 *   node upgrade.mjs <workspace> [--base <engine folder>] [--dry]
 *
 * Per file: untouched locally -> take the new one; unchanged upstream -> keep
 * theirs; changed on both sides -> `git merge-file`, and anything that doesn't
 * merge cleanly is left with conflict markers and listed. Deleted upstream and
 * untouched locally -> deleted. Config (.claude/dashboard/) is never touched.
 *
 * The base is fetched from the release tag (agentic-os-v<version>) unless --base
 * points at a copy. Without a base, files the team changed can't be told apart
 * from files that are just old, so it stops and says so instead of guessing.
 */

import fs from "node:fs";
import path from "node:path";
import { ENGINE_DIR, TAG_PREFIX, args, engineVersion, fetchEngine, gitMergeFile, hashFile, isMain, listFiles, readJson, writeJson } from "./lib.mjs";

export function upgrade(root, { base: baseArg, dry = false } = {}) {
  root = path.resolve(root);
  const dash = path.join(root, "dashboard");
  const lockFile = path.join(root, ".claude", "dashboard", "engine.json");
  const lock = readJson(lockFile);
  const to = engineVersion();
  if (!lock || !lock.version) return { ok: false, error: "No .claude/dashboard/engine.json: this workspace wasn't set up by the agentic-os skill (or the file was removed). Reinstall with scaffold.mjs --force, or pass --base with the engine it started from." };
  if (lock.version === to && !baseArg) return { ok: true, upToDate: true, version: to };

  const baseDir = baseArg ? path.resolve(baseArg) : fetchEngine(lock.version, lock.sourceRepo);
  if (!baseDir) return { ok: false, error: `Couldn't get engine ${lock.version} (tag ${TAG_PREFIX}${lock.version}) to merge from. Check the network, or pass --base <folder with that engine>.` };

  const files = new Set([...listFiles(baseDir), ...listFiles(ENGINE_DIR), ...listFiles(dash)]);
  const r = { ok: true, from: lock.version, to, updated: [], added: [], deleted: [], keptLocal: [], merged: [], conflicts: [], localOnly: [] };
  for (const rel of [...files].sort()) {
    if (rel === "ENGINE.json") continue;
    const b = path.join(baseDir, rel), n = path.join(ENGINE_DIR, rel), l = path.join(dash, rel);
    const [hb, hn, hl] = [hashFile(b), hashFile(n), hashFile(l)];
    if (hl === hn) continue; // already the same
    const write = (text) => { if (!dry) { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.writeFileSync(l, text); } };
    if (!hb) {
      if (!hl) { r.added.push(rel); if (!dry) { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.copyFileSync(n, l); } }
      else if (!hn) r.localOnly.push(rel);
      else { // both added the same path differently
        const m = gitMergeFile(l, n, n);
        r.conflicts.push(rel);
        write(m.text);
      }
      continue;
    }
    if (hl === hb) { // untouched locally
      if (hn) { r.updated.push(rel); if (!dry) fs.copyFileSync(n, l); }
      else { r.deleted.push(rel); if (!dry) fs.rmSync(l, { force: true }); }
      continue;
    }
    if (hn === hb) { r.keptLocal.push(rel); continue; } // only they changed it
    if (!hl) { r.keptLocal.push(`${rel} (deleted locally)`); continue; }
    if (!hn) { r.conflicts.push(`${rel} (changed locally, removed in the new engine)`); continue; }
    const m = gitMergeFile(l, b, n);
    write(m.text);
    (m.conflicts ? r.conflicts : r.merged).push(rel);
  }
  if (!dry) writeJson(lockFile, { ...lock, version: to, tag: `${TAG_PREFIX}${to}`, upgradedAt: new Date().toISOString(), previous: lock.version });
  r.next = r.conflicts.length
    ? ["Resolve the conflict markers in the files listed under conflicts (search for <<<<<<<), then build and restart."]
    : [];
  r.next.push("cd dashboard && npm ci && npm test", "node dashboard/bin/dashboard.mjs restart  (ends any run in progress in the dashboard)");
  return r;
}

if (isMain(import.meta)) {
  const a = args();
  if (!a._[0]) { console.error("Usage: node upgrade.mjs <workspace> [--base <engine folder>] [--dry]"); process.exit(2); }
  const r = upgrade(a._[0], { base: a.base, dry: !!a.dry });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? (r.conflicts && r.conflicts.length ? 3 : 0) : 1;
}

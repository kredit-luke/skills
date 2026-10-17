#!/usr/bin/env node
/**
 * Bring a workspace's engine folder (engine.json `dir`, else dashboard/) up to
 * the engine version this plugin ships, keeping the team's own changes: a three-way
 * merge per file between the version they installed (the base, from
 * .claude/dashboard/engine.json), their copy, and the new engine.
 *
 *   node upgrade.mjs <workspace> [--base <engine folder>] [--dry] [--allow-stale]
 *
 * First it checks the source repo for a newer release than this plugin copy and
 * stops if there is one (Claude Code doesn't refresh cached plugins, so an old
 * copy would upgrade to an old engine); --allow-stale goes ahead anyway. It also
 * refuses to downgrade a workspace that runs a newer engine than this plugin's.
 *
 * Per file: untouched locally -> take the new one; unchanged upstream -> keep
 * theirs; changed on both sides -> `git merge-file`, and anything that doesn't
 * merge cleanly is left with conflict markers and listed. Deleted upstream and
 * untouched locally -> deleted. Config (.claude/dashboard/) is never touched.
 *
 * The base is fetched from the release tag (natterjack-v<version>) unless --base
 * points at a copy. Without a base, files the team changed can't be told apart
 * from files that are just old, so it stops and says so instead of guessing.
 */

import fs from "node:fs";
import path from "node:path";
import { ENGINE_DIR, TAG_PREFIX, args, compareVersions, engineDirOf, engineVersion, fetchEngine, gitMergeFile, hashFile, isMain, latestRelease, listFiles, readJson, releaseCheck, writeJson } from "./lib.mjs";

/**
 * What the hosted images bake in (templates/hosted/Dockerfile, router/Dockerfile): the image
 * files themselves and the router's shared request checks, plus everything the boot step runs
 * from the image's own copy of the engine (bootFiles). The rest of the engine reaches hosted
 * dashboards through the published snapshot.
 */
const IMAGE_PATHS = ["templates/hosted/", "router/", "engine/server/src/hosted.ts"];

/**
 * The engine files the image's boot step loads (entrypoint.sh runs /opt/natterjack's
 * bin/snapshot.mjs install and pull-repos): snapshot.mjs, snapshot-cli.ts and every module it
 * imports, followed through relative imports. Republishing the snapshot can't change these.
 */
export function bootFiles(pluginDir) {
  const out = new Set(["engine/bin/snapshot.mjs"]);
  const queue = ["engine/server/src/snapshot-cli.ts"];
  const spec = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  while (queue.length) {
    const rel = queue.pop();
    if (out.has(rel)) continue;
    out.add(rel);
    let text = "";
    try { text = fs.readFileSync(path.join(pluginDir, rel), "utf-8"); } catch { continue; }
    for (const m of text.matchAll(spec)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (/\.(ts|mjs|js)$/.test(target) && !target.startsWith("..")) queue.push(target);
    }
  }
  return out;
}

/**
 * The files in the hosted images, and the per-person templates beside them in templates/hosted/,
 * that differ between two plugin folders, sorted; null when the old one isn't a whole plugin
 * (a --base engine folder), so there's nothing to compare.
 */
export function imageChanges(oldPlugin, newPlugin) {
  if (!fs.existsSync(path.join(oldPlugin, "templates", "hosted"))) return null;
  const boot = new Set([...bootFiles(oldPlugin), ...bootFiles(newPlugin)]);
  const inImage = (rel) => IMAGE_PATHS.some((p) => rel.startsWith(p)) || boot.has(rel);
  const files = new Set([...listFiles(oldPlugin), ...listFiles(newPlugin)].filter(inImage));
  return [...files].filter((rel) => hashFile(path.join(oldPlugin, rel)) !== hashFile(path.join(newPlugin, rel))).sort();
}

/**
 * @param o.latest      newest release version; left out, it's looked up on the source repo
 *                      (tests pass it, or null to skip the check)
 * @param o.allowStale  go ahead even though a newer release than this plugin is out
 */
export function upgrade(root, { base: baseArg, dry = false, latest, allowStale = false } = {}) {
  root = path.resolve(root);
  const dir = engineDirOf(root);
  const dash = path.join(root, dir);
  const lockFile = path.join(root, ".claude", "dashboard", "engine.json");
  const lock = readJson(lockFile);
  const to = engineVersion();
  if (!lock || !lock.version) return { ok: false, error: "No .claude/dashboard/engine.json: this workspace wasn't set up by the natterjack skill (or the file was removed). Reinstall with scaffold.mjs --force, or pass --base with the engine it started from." };

  const release = releaseCheck(latest === undefined ? latestRelease(lock.sourceRepo) : latest);
  const { update, newRoot } = release;
  if (release.stale && !allowStale) {
    return { ok: false, stale: true, error: `This plugin is ${release.current}, but ${TAG_PREFIX}${release.latest} is out. Update the plugin, then run upgrade again from the updated copy.`, update, newRoot };
  }
  if (compareVersions(lock.version, to) > 0 && !baseArg) {
    return { ok: false, downgrade: true, error: `The workspace runs engine ${lock.version}, newer than this plugin's ${to}: upgrading would downgrade it. Update the plugin.`, update, newRoot };
  }
  const releaseNote = release.latest ? { latestRelease: release.latest } : { latestRelease: null, note: "Couldn't reach the source repo to check for a newer release; upgrading to this plugin's engine." };
  if (lock.version === to && !baseArg) return { ok: true, upToDate: true, version: to, ...releaseNote };

  const baseDir = baseArg ? path.resolve(baseArg) : fetchEngine(lock.version, lock.sourceRepo);
  if (!baseDir) return { ok: false, error: `Couldn't get engine ${lock.version} (tag ${TAG_PREFIX}${lock.version}) to merge from. Check the network, or pass --base <folder with that engine>.` };

  const files = new Set([...listFiles(baseDir), ...listFiles(ENGINE_DIR), ...listFiles(dash)]);
  const r = { ok: true, from: lock.version, to, engineDir: dir, ...releaseNote, updated: [], added: [], deleted: [], keptLocal: [], merged: [], conflicts: [], localOnly: [] };
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
  r.next.push(`cd ${dir} && npm ci && npm test`, `node ${dir}/bin/dashboard.mjs restart  (ends any run in progress in the dashboard)`);
  // Teams with hosted dashboards (hosting.json): what this release changes there that the merge above doesn't reach.
  const hosted = imageChanges(path.dirname(baseDir), path.dirname(ENGINE_DIR));
  const hosting = readJson(path.join(root, ".claude", "dashboard", "hosting.json"));
  if (hosted?.length) {
    // The per-person templates aren't in an image: teams deploy their own copy (hosting.json platform.template).
    r.hostedTemplates = hosted.filter((f) => /^templates\/hosted\/.*\.(bicep|ya?ml)$/.test(f));
    r.hostedImages = hosted.filter((f) => !r.hostedTemplates.includes(f));
    const list = (files) => files.slice(0, 4).join(", ") + (files.length > 4 ? `, and ${files.length - 4} more` : "");
    const platform = hosting?.platform?.type;
    if (hosting && r.hostedImages.length) {
      const why = `This release changes the hosted images (${list(r.hostedImages)}): rebuild them`;
      // hosted-images.mjs reads the registry from an App Service hosting.json; on Kubernetes the image is in the template.
      r.next.push(platform === "kubernetes"
        ? `${why} with node ${dir}/bin/hosted-images.mjs --all --registry <your registry> --dry-run, then again with --push; set the new dashboard image in ${hosting.platform?.template || "your copy of kubernetes-person.yaml"}, and move the router deployment to its new tag`
        : `${why} with node ${dir}/bin/hosted-images.mjs --all --dry-run, then --all --push --update-hosting, and move the router to its new tag`);
    }
    // Only the platform's own: an App Service team deploys the .bicep, a Kubernetes one the .yaml files.
    const theirs = r.hostedTemplates.filter((f) => (platform === "azure-app-service" ? f.endsWith(".bicep") : platform === "kubernetes" ? /\.ya?ml$/.test(f) : true));
    if (hosting && theirs.length) r.next.push(`This release changes ${list(theirs)}: bring the same change into your copy${hosting.platform?.template ? `, ${hosting.platform.template}` : ""}, keeping your settings`);
  }
  return r;
}

if (isMain(import.meta)) {
  const a = args();
  if (!a._[0]) { console.error("Usage: node upgrade.mjs <workspace> [--base <engine folder>] [--dry] [--allow-stale]"); process.exit(2); }
  const r = upgrade(a._[0], { base: a.base, dry: !!a.dry, allowStale: !!a["allow-stale"] });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? (r.conflicts && r.conflicts.length ? 3 : 0) : 1;
}

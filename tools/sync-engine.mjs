#!/usr/bin/env node
/**
 * Maintainer tool: copy the dashboard engine from a workspace that runs it into
 * plugins/agentic-os/engine/, the copy the skill installs into other workspaces.
 *
 *   node tools/sync-engine.mjs <path to a workspace's dashboard/ folder> [--version X.Y.Z]
 *
 * Copies only what git tracks there (no node_modules, dist, caches), then refuses
 * to finish if any file names a specific team, product or person on the maintainer's
 * denylist: the engine must stay generic, with everything team-specific in the
 * workspace's .claude/dashboard/ config. The denylist names private teams and
 * products, so it is never committed: AGENTIC_OS_DENYLIST=<file>, else
 * tools/denylist.local.txt (gitignored; format in tools/denylist.example.txt).
 * Without one it refuses, unless --no-denylist says to skip the check. Writes
 * engine/ENGINE.json with the version and the source commit. Tag the release afterwards (see README "Releasing"), so upgrades
 * can find this version as a merge base.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(REPO, "plugins", "agentic-os", "engine");
const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
const vIdx = args.indexOf("--version");
if (!src) {
  console.error("Usage: node tools/sync-engine.mjs <workspace>/dashboard [--version X.Y.Z] [--no-denylist]");
  process.exit(2);
}
const SRC = path.resolve(src);
if (!fs.existsSync(path.join(SRC, "server", "src", "main.ts"))) {
  console.error(`${SRC} doesn't look like a dashboard folder (no server/src/main.ts).`);
  process.exit(1);
}

const files = execFileSync("git", ["ls-files", "-z", "."], { cwd: SRC, encoding: "utf-8" }).split("\0").filter(Boolean);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: SRC, encoding: "utf-8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "."], { cwd: SRC, encoding: "utf-8" }).trim();

// ---- denylist check before touching the destination
const DENYLIST = path.resolve(process.env.AGENTIC_OS_DENYLIST || path.join(REPO, "tools", "denylist.local.txt"));
const skipDenylist = args.includes("--no-denylist");
let deny = [];
if (skipDenylist) {
  console.warn("--no-denylist: syncing without the denylist check.");
} else if (fs.existsSync(DENYLIST)) {
  deny = fs.readFileSync(DENYLIST, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
} else {
  console.error(`No denylist at ${DENYLIST}. Set AGENTIC_OS_DENYLIST or create tools/denylist.local.txt (see tools/denylist.example.txt), or pass --no-denylist to sync without the check.`);
  process.exit(1);
}
const TEXT = /\.(ts|mjs|js|json|html|scss|css|md|svg|txt)$/i;
const hits = [];
for (const rel of files) {
  if (!TEXT.test(rel) || rel === "package-lock.json") continue;
  const text = fs.readFileSync(path.join(SRC, rel), "utf-8");
  for (const word of deny) {
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    text.split(/\r?\n/).forEach((line, i) => { if (re.test(line)) hits.push(`${rel}:${i + 1}: "${word}": ${line.trim().slice(0, 120)}`); });
  }
}
if (hits.length) {
  console.error(`The engine still names something team-specific (${DENYLIST}). Move it into config, then sync again:\n`);
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}

// ---- copy
fs.rmSync(DEST, { recursive: true, force: true });
for (const rel of files) {
  const to = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const buf = fs.readFileSync(path.join(SRC, rel));
  // Text files go in with LF endings, whatever the source checkout uses (a Windows
  // checkout is CRLF), so a sync from any machine produces the same files.
  const isText = !buf.subarray(0, 8000).includes(0);
  fs.writeFileSync(to, isText ? buf.toString("utf-8").replace(/\r\n/g, "\n") : buf);
}

const pkgFile = path.join(DEST, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf-8"));
if (vIdx !== -1 && args[vIdx + 1]) {
  pkg.version = args[vIdx + 1];
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
}
fs.writeFileSync(path.join(DEST, "ENGINE.json"), JSON.stringify({
  version: pkg.version,
  sourceCommit: commit,
  sourceDirty: !!dirty,
  syncedAt: new Date().toISOString(),
}, null, 2) + "\n");

console.log(`Synced ${files.length} files (engine ${pkg.version}) from ${SRC} @ ${commit.slice(0, 7)}${dirty ? " (with uncommitted changes)" : ""}.`);
console.log(`Next: review \`git diff\`, commit, and tag agentic-os-v${pkg.version}.`);

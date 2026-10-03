#!/usr/bin/env node
/**
 * Publish read-only snapshots of the workspace's repos to repos.json's `snapshot`
 * source, for people without git access (they download them on the Repos page):
 *
 *   node <engine>/bin/snapshot.mjs publish [--clone] [--out <dir>] [--dry] [--no-workspace]
 *
 * and to install or update a whole workspace from them, with no git (the hosted image's boot):
 *
 *   node <engine>/bin/snapshot.mjs install [--into <dir>] [--repos]
 *
 * <engine> is the workspace's engine folder (natterjack/, or dashboard/ in older
 * workspaces). Runs server/src/snapshot-cli.ts on this Node (it needs the engine's
 * Node floor, like the server). Usually from CI; see references/config.md "Snapshots".
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Where this was started from, not its real path (the engine folder can be a link), as in dashboard.mjs.
const SELF = process.argv[1] && /snapshot\.mjs$/i.test(process.argv[1]) ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
const DASH_DIR = path.resolve(path.dirname(SELF), "..");

/** The nearest folder above the engine with .claude/dashboard/, else its parent (as server/src/workspace-root.ts). */
function findWorkspaceRoot(engineDir) {
  const parent = path.dirname(path.resolve(engineDir));
  for (let dir = parent; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".claude", "dashboard"))) return dir;
    if (path.dirname(dir) === dir) return parent;
  }
}

const env = { ...process.env, WORKSPACE_ROOT: path.resolve(process.env.WORKSPACE_ROOT || findWorkspaceRoot(DASH_DIR)) };
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "src", "snapshot-cli.ts");
const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(r.status === null ? 1 : r.status);

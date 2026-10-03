#!/usr/bin/env node
/**
 * Publish read-only snapshots of the workspace's repos to repos.json's `snapshot`
 * source, for people without git access (they download them on the Repos page):
 *
 *   node dashboard/bin/snapshot.mjs publish [--clone] [--out <dir>] [--dry] [--no-workspace]
 *
 * and to install or update a whole workspace from them, with no git (the hosted image's boot):
 *
 *   node dashboard/bin/snapshot.mjs install [--into <dir>] [--repos]
 *
 * Runs server/src/snapshot-cli.ts on this Node (it needs the engine's Node floor,
 * like the server). Usually from CI; see references/config.md "Snapshots".
 */

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "src", "snapshot-cli.ts");
const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);

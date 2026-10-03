/**
 * Publish read-only snapshots of the workspace's repos (see snapshot.ts), usually
 * from CI, or install a workspace from them. Run through dashboard/bin/snapshot.mjs:
 *
 *   node dashboard/bin/snapshot.mjs publish [--clone] [--out <dir>] [--dry] [--no-workspace]
 *   node dashboard/bin/snapshot.mjs install [--into <dir>] [--repos]
 *
 *   --clone         shallow-clone repos.json repos that aren't here yet first (CI)
 *   --out <dir>     where the files are built (default: a temp folder)
 *   --dry           build only; don't upload (check sizes, inspect the files)
 *   --no-fetch      use the origin/<default branch> each clone already has (no git fetch)
 *   --no-workspace  leave out workspace.zip
 *
 * The source is repos.json `snapshot`. Credentials come from the environment (e.g.
 * CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN for Confluence); nothing is read from or
 * written to a ledger. Needs git >= 2.40 (git archive --add-virtual-file).
 *
 * install: the workspace from its published workspace zip and prebuilt UI, into
 * --into (default the workspace root), with no git. What the hosted image runs on boot.
 *   --into <dir>  the folder to install into or update (absent, empty, or installed before)
 *   --repos       also download every repo that's missing or older
 * The source is SNAPSHOT_CONFIG (repos.json's `snapshot` block as JSON: before the
 * first install there's no repos.json to read it from), else the folder's repos.json;
 * its credentials come from the environment, else the folder's ledger.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_ROOT, workspaceConfig } from "./config.ts";
import { readRepos, type SnapshotConfig } from "./repos.ts";
import { buildSnapshot, cloneForPublish, installWorkspace, publishSnapshot } from "./snapshot.ts";
import { installerRoles } from "./installer.ts";
import { createSource } from "./snapshot-sources/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined; };
const log = (t: string) => console.log(t);

async function install() {
  const dir = path.resolve(opt("into") || WORKSPACE_ROOT);
  let cfg: SnapshotConfig | null = null;
  if (process.env.SNAPSHOT_CONFIG) {
    let data: any;
    try { data = JSON.parse(process.env.SNAPSHOT_CONFIG); } catch { throw new Error("SNAPSHOT_CONFIG isn't valid JSON."); }
    if (!data || typeof data.source !== "string" || !data.source.trim()) throw new Error('SNAPSHOT_CONFIG needs "source", like repos.json\'s snapshot block.');
    cfg = { ...data, source: data.source.trim() };
  } else cfg = readRepos(dir).snapshot;
  if (!cfg) throw new Error(`Set SNAPSHOT_CONFIG to repos.json's snapshot block (as JSON): ${dir} has no repos.json to read it from yet.`);
  const ledgerDir = process.env.DASHBOARD_LEDGER_DIR || path.join(dir, ".claude", "ledger");
  const source = createSource(cfg, { ledgerDir, issues: workspaceConfig().issues });
  if (!source.status().connected) throw new Error(`No credentials for ${source.label}: set them in the environment (see the source's docs in references/config.md).`);
  const r = await installWorkspace(source, dir, { repos: flag("repos"), log });
  log(`Workspace ${r.workspace} at ${r.sha.slice(0, 10)}.`);
}

async function main() {
  const cmd = argv[0];
  if (cmd === "install") return install();
  if (cmd !== "publish") {
    console.error("Usage: node dashboard/bin/snapshot.mjs publish [--clone] [--out <dir>] [--dry] [--no-fetch] [--no-workspace]\n       node dashboard/bin/snapshot.mjs install [--into <dir>] [--repos]");
    process.exit(2);
  }
  const root = WORKSPACE_ROOT;
  const cfg = readRepos(root);
  if (!cfg.snapshot && !flag("dry")) throw new Error('repos.json has no "snapshot" block saying where to publish (use --dry to only build).');
  // Build and validate the source before cloning and archiving, so a bad config fails fast.
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-snapshot-cli-"));
  const source = cfg.snapshot ? createSource(cfg.snapshot, { ledgerDir, issues: workspaceConfig().issues }) : null;
  if (source && !flag("dry") && !source.status().connected) throw new Error(`No credentials for ${source.label}: set them in the environment (see the source's docs in references/config.md).`);

  if (flag("clone")) await cloneForPublish(root, log);
  const out = path.resolve(opt("out") || fs.mkdtempSync(path.join(os.tmpdir(), "aos-snapshot-out-")));
  // Each repo at its origin default branch, fetched now: never a clone's work branch or local edits.
  const manifest = await buildSnapshot(root, out, { workspace: !flag("no-workspace"), fetch: !flag("no-fetch"), log, installer: source ? { name: workspaceConfig().name, sourceLabel: source.label, roles: installerRoles(workspaceConfig()) } : undefined });
  log(`Built ${Object.keys(manifest.repos).length} repo archives${manifest.workspace ? " + workspace.zip" : ""} in ${out}`);
  if (flag("dry") || !source) return;
  await publishSnapshot(source, out, manifest, log);
  log(`Published to ${source.label}.`);
}

main().catch((e) => { console.error(`snapshot: ${e.message}`); process.exit(1); });

/**
 * Publish read-only snapshots of the workspace's repos (see snapshot.ts), usually
 * from CI. Run through dashboard/bin/snapshot.mjs:
 *
 *   node dashboard/bin/snapshot.mjs publish [--clone] [--out <dir>] [--dry] [--no-workspace]
 *
 *   --clone         shallow-clone repos.json repos that aren't here yet first (CI)
 *   --out <dir>     where the files are built (default: a temp folder)
 *   --dry           build only; don't upload (check sizes, inspect the files)
 *   --no-workspace  leave out workspace.zip
 *
 * The source is repos.json `snapshot`. Credentials come from the environment (e.g.
 * CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN for Confluence); nothing is read from or
 * written to a ledger. Needs git >= 2.40 (git archive --add-virtual-file).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_ROOT, workspaceConfig } from "./config.ts";
import { readRepos } from "./repos.ts";
import { buildSnapshot, cloneForPublish, publishSnapshot } from "./snapshot.ts";
import { createSource } from "./snapshot-sources/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined; };
const log = (t: string) => console.log(t);

async function main() {
  const cmd = argv[0];
  if (cmd !== "publish") {
    console.error("Usage: node dashboard/bin/snapshot.mjs publish [--clone] [--out <dir>] [--dry] [--no-workspace]");
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
  const manifest = await buildSnapshot(root, out, { workspace: !flag("no-workspace"), log });
  log(`Built ${Object.keys(manifest.repos).length} repo archives${manifest.workspace ? " + workspace.zip" : ""} in ${out}`);
  if (flag("dry") || !source) return;
  await publishSnapshot(source, out, manifest, log);
  log(`Published to ${source.label}.`);
}

main().catch((e) => { console.error(`snapshot: ${e.message}`); process.exit(1); });

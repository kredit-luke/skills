#!/usr/bin/env node
/**
 * Install the dashboard engine into a workspace and write its config, from a
 * plan Claude has confirmed with the user.
 *
 *   node scaffold.mjs <workspace> --plan plan.json [--force] [--dry]
 *
 * plan.json (every key optional except workspace):
 *   {
 *     "workspace": { ...workspace.json },            name, dashboard.port, issues, codeHost, brand, copy
 *     "apps":      { ...apps.json },
 *     "machine":   { ...machine.json },
 *     "docs":      { ...docs.json },
 *     "reference": { ...reference.json },
 *     "links":     { ...links.json },
 *     "deck":      { ...deck.json },
 *     "repos":     [{ "name", "relativePath", "remote", "layer"?, "dependencies"? }],   written as repos.json
 *                  (the older "directory" / "url" are accepted and written under the new names)
 *     "skills":    ["dashboard"],                    template skills to add to .claude/skills/
 *     "claudeMd":  true                              add a "Workspace dashboard" section to CLAUDE.md
 *   }
 *
 * What it does, and never does:
 *  - copies the engine to <workspace>/dashboard (refuses if one is there: use upgrade.mjs)
 *  - writes each config file in the plan to .claude/dashboard/ (keeps existing files unless --force)
 *  - records the engine version in .claude/dashboard/engine.json (upgrades merge from it)
 *  - adds the dashboard and its local state to .gitignore (allow-list style or not)
 *  - never installs packages, starts anything, commits, or touches the team's repos
 * Prints a JSON summary of what it wrote and skipped.
 */

import fs from "node:fs";
import path from "node:path";
import { ENGINE_DIR, REPOS_SCHEMA, SOURCE_REPO, TAG_PREFIX, TEMPLATES_DIR, args, copyTree, engineVersion, isMain, normalizeRepo, readJson, writeJson } from "./lib.mjs";

const CONFIG_FILES = { workspace: "workspace.json", apps: "apps.json", machine: "machine.json", docs: "docs.json", reference: "reference.json", links: "links.json", deck: "deck.json" };

// What each file is, for its $comment (kept short; the full schema is references/config.md).
const COMMENTS = {
  workspace: "Who this workspace is, for the dashboard: name, dashboard port (DASHBOARD_PORT overrides it per machine), worktrees, issue tracker, code host, brand, wording. Schema: the agentic-os skill's references/config.md.",
  apps: "Apps and stacks for the Apps / Workspaces pages: folder, port, and how each starts ({ cmd } or your launcher script). Schema: references/config.md.",
  machine: "Machine page checks, from the catalog in dashboard/server/src/machine-catalog.ts. Schema: references/config.md.",
  docs: "Docs page sources: site repos, Markdown folders, or external (Confluence, Notion, ...). Schema: references/config.md.",
  reference: "Reference page: a Markdown doc in the workspace and the quick facts to pull out of it. Schema: references/config.md.",
  links: "Links page tiles for the team (personal ones: .claude/ledger/links.local.json). Edit them from the Links page. Schema: references/config.md.",
  deck: "Skill cards, routines, limits, default model and the Issues view. Schema: references/config.md.",
};

const GITIGNORE_DENY = [".claude/ledger/", "dashboard/node_modules/", "dashboard/dist/", "dashboard/.angular/"];
const GITIGNORE_ALLOW = ["!.claude/", "!.claude/**", "!dashboard/", "!dashboard/**", "!repos.json", "!*.md"];

export function scaffold(root, plan, { force = false, dry = false } = {}) {
  root = path.resolve(root);
  const report = { root, wrote: [], kept: [], notes: [] };
  const write = (file, fn) => {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (fs.existsSync(file) && !force) { report.kept.push(rel); return; }
    if (!dry) fn();
    report.wrote.push(rel);
  };

  // ---- engine
  const dash = path.join(root, "dashboard");
  if (fs.existsSync(path.join(dash, "server", "src", "main.ts")) && !force) {
    report.kept.push("dashboard/ (already installed; use upgrade.mjs to update it)");
  } else {
    if (!dry) copyTree(ENGINE_DIR, dash);
    report.wrote.push(`dashboard/ (engine ${engineVersion()})`);
  }
  const version = engineVersion();
  if (!dry) writeJson(path.join(root, ".claude", "dashboard", "engine.json"), {
    $comment: "The dashboard engine this workspace runs (installed by the agentic-os skill). upgrade merges newer versions into dashboard/ using this as the base; don't edit by hand.",
    version, sourceRepo: SOURCE_REPO, tag: `${TAG_PREFIX}${version}`, installedAt: new Date().toISOString(),
  });
  report.wrote.push(".claude/dashboard/engine.json");

  // ---- config
  for (const [key, name] of Object.entries(CONFIG_FILES)) {
    if (!plan[key]) continue;
    const data = { $comment: COMMENTS[key], ...plan[key] };
    write(path.join(root, ".claude", "dashboard", name), () => writeJson(path.join(root, ".claude", "dashboard", name), data));
  }

  // ---- repos.json
  if (Array.isArray(plan.repos) && plan.repos.length) {
    // Standard field names only, and no empty optional fields.
    const repos = plan.repos.map(normalizeRepo).filter(Boolean).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))));
    write(path.join(root, "repos.json"), () => writeJson(path.join(root, "repos.json"), { $schema: REPOS_SCHEMA, repos }));
  }

  // ---- .gitignore
  const gi = path.join(root, ".gitignore");
  const current = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const allowList = lines.includes("*");
  const want = [...(allowList ? GITIGNORE_ALLOW : []), ...GITIGNORE_DENY].filter((l) => !lines.includes(l));
  if (want.length) {
    if (!dry) fs.writeFileSync(gi, current.replace(/\s*$/, "") + (current ? "\n\n" : "") + "# Workspace dashboard (agentic-os)\n" + want.join("\n") + "\n");
    report.wrote.push(`.gitignore (+${want.length} lines${allowList ? ", allow-list style" : ""})`);
  }

  // ---- template skills
  for (const skill of plan.skills || []) {
    const from = path.join(TEMPLATES_DIR, "skills", skill);
    if (!fs.existsSync(from)) { report.notes.push(`No template skill "${skill}".`); continue; }
    const to = path.join(root, ".claude", "skills", skill);
    write(to, () => copyTree(from, to));
  }

  // ---- CLAUDE.md section
  if (plan.claudeMd) {
    const file = path.join(root, "CLAUDE.md");
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (/^## Workspace dashboard/m.test(text)) report.kept.push("CLAUDE.md (already has a Workspace dashboard section)");
    else {
      const port = (plan.workspace && plan.workspace.dashboard && plan.workspace.dashboard.port) || 3333;
      const section = fs.readFileSync(path.join(TEMPLATES_DIR, "claude-md-section.md"), "utf-8").replace(/\{\{port\}\}/g, String(port));
      if (!dry) fs.writeFileSync(file, (text ? text.replace(/\s*$/, "") + "\n\n" : `# ${plan.workspace && plan.workspace.name ? plan.workspace.name : path.basename(root)} workspace\n\n`) + section);
      report.wrote.push(`CLAUDE.md (${text ? "added" : "new, with"} the Workspace dashboard section)`);
    }
  }

  report.next = [
    "node dashboard/bin/dashboard.mjs start --open    (first start installs packages and builds the UI: a minute or two)",
    "node <plugin>/scripts/validate.mjs <workspace>",
  ];
  return report;
}

if (isMain(import.meta)) {
  const a = args();
  const root = a._[0];
  if (!root || !a.plan) {
    console.error("Usage: node scaffold.mjs <workspace> --plan plan.json [--force] [--dry]");
    process.exit(2);
  }
  const plan = readJson(path.resolve(a.plan));
  if (!plan || !plan.workspace) { console.error(`${a.plan}: needs to be JSON with at least "workspace".`); process.exit(1); }
  console.log(JSON.stringify(scaffold(root, plan, { force: !!a.force, dry: !!a.dry }), null, 2));
}

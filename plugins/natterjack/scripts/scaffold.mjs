#!/usr/bin/env node
/**
 * Install the dashboard engine into a workspace and write its config, from a
 * plan Claude has confirmed with the user.
 *
 *   node scaffold.mjs <workspace> --plan plan.json [--engine-dir <folder>] [--force] [--dry]
 *
 * plan.json (every key optional except workspace):
 *   {
 *     "workspace": { ...workspace.json },            name, dashboard.port, issues, codeHost, brand, copy
 *     "engineDir": "natterjack",                     where the engine goes, relative to the workspace (default natterjack)
 *     "skillName": "natterjack",                     the workspace skill's name (default: engineDir's last folder)
 *     "apps":      { ...apps.json },
 *     "machine":   { ...machine.json },
 *     "docs":      { ...docs.json },
 *     "infrastructure": { ...infrastructure.json },  only when the team has infrastructure info ("reference" is the old key)
 *     "links":     { ...links.json },
 *     "deck":      { ...deck.json },
 *     "repos":     [{ "name", "relativePath", "remote", "layer"?, "dependencies"? }],   written as repos.json
 *                  (the older "directory" / "url" are accepted and written under the new names)
 *     "skills":    ["dashboard"],                    template skills to add to .claude/skills/ ("dashboard" is the
 *                                                    workspace's dashboard skill, installed as skillName)
 *     "claudeMd":  true                              add a "Workspace dashboard" section to CLAUDE.md
 *   }
 *
 * What it does, and never does:
 *  - copies the engine to <workspace>/<engineDir> (refuses if one is there: use upgrade.mjs;
 *    refuses a folder that's already something else, or a repo)
 *  - writes each config file in the plan to .claude/dashboard/ (keeps existing files unless --force)
 *  - records the engine version and folder in .claude/dashboard/engine.json (upgrades merge from it)
 *  - adds the engine folder and the local state to .gitignore (allow-list style or not)
 *  - never installs packages, starts anything, commits, or touches the team's repos
 * Prints a JSON summary of what it wrote and skipped.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ENGINE_DIR, ENGINE_DIR, SOURCE_REPO, TAG_PREFIX, TEMPLATES_DIR, args, copyTree, engineDirOf, engineVersion, isMain, listFiles, normalizeRepo, readJson, readRepos, reposSchema, safeEngineDir, writeJson } from "./lib.mjs";

const CONFIG_FILES = { workspace: "workspace.json", apps: "apps.json", machine: "machine.json", docs: "docs.json", infrastructure: "infrastructure.json", links: "links.json", deck: "deck.json" };

// What each file is, for its $comment (kept short; the full schema is references/config.md).
const comments = (dir) => ({
  workspace: "Who this workspace is, for the dashboard: name, dashboard port (DASHBOARD_PORT overrides it per machine), worktrees, issue tracker, code host, brand, wording. Schema: the natterjack skill's references/config.md.",
  apps: "Apps and stacks for the Apps / Workspaces pages: folder, port, and how each starts ({ cmd } or your launcher script). Schema: references/config.md.",
  machine: `Machine page checks, from the catalog in ${dir}/server/src/machine-catalog.ts. Schema: references/config.md.`,
  docs: "Docs page sources: site repos, Markdown folders, or external (Confluence, Notion, ...). Schema: references/config.md.",
  infrastructure: "Infrastructure page: a Markdown doc in the workspace about the team's infrastructure (accounts, environments, URLs, databases, IPs, firewall rules) and the quick facts to pull out of it. Schema: references/config.md.",
  links: "Links page tiles for the team (personal ones: .claude/ledger/links.local.json). Edit them from the Links page. Schema: references/config.md.",
  deck: "Skill cards, routines, limits, default model and the Issues view. Schema: references/config.md.",
});

/** .gitignore lines for an engine in `dir`: what's never committed, and (allow-list style) what is. */
export function gitignoreLines(dir) {
  const deny = [".claude/ledger/", `${dir}/node_modules/`, `${dir}/dist/`, `${dir}/.angular/`];
  // A nested folder (tools/ops) needs its parents let back in too, or git never looks inside.
  const parts = dir.split("/");
  const parents = parts.slice(0, -1).map((_, i) => `!${parts.slice(0, i + 1).join("/")}/`);
  const allow = ["!.claude/", "!.claude/**", ...parents, `!${dir}/`, `!${dir}/**`, "!repos.json", "!*.md"];
  return { deny, allow };
}

/** A skill name Claude Code takes (lowercase letters, digits, hyphens), from a folder name. */
const skillNameOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "dashboard";

const hasEngine = (dir) => fs.existsSync(path.join(dir, "server", "src", "main.ts"));

/**
 * Where the engine goes: what was asked for, else where it's already installed (engine.json,
 * or an older workspace's dashboard/), else natterjack/. Throws when that folder can't be used.
 */
export function resolveEngineDir(root, requested, repos = []) {
  const installed = fs.existsSync(path.join(root, ".claude", "dashboard", "engine.json")) || hasEngine(path.join(root, "dashboard")) ? engineDirOf(root) : null;
  if (requested !== undefined && requested !== null && !safeEngineDir(requested)) {
    throw new Error(`engineDir "${requested}" must be a folder inside the workspace (relative, no "..", not under .claude/).`);
  }
  const dir = requested ? safeEngineDir(requested) : installed || DEFAULT_ENGINE_DIR;
  if (installed && dir !== installed && hasEngine(path.join(root, installed))) {
    throw new Error(`The engine is already installed in ${installed}/; moving it to ${dir}/ isn't supported by scaffold. Leave engineDir out (or set it to "${installed}").`);
  }
  const abs = path.join(root, dir);
  if (fs.existsSync(abs) && !hasEngine(abs)) {
    if (!fs.statSync(abs).isDirectory() || fs.readdirSync(abs).length) throw new Error(`${dir}/ is already in the workspace and isn't the engine; pick another engineDir (e.g. tools/natterjack).`);
  }
  const clash = repos.find((r) => r.relativePath === dir || dir.startsWith(`${r.relativePath}/`) || r.relativePath.startsWith(`${dir}/`));
  if (clash) throw new Error(`engineDir ${dir}/ overlaps the repo "${clash.name}" (${clash.relativePath}); pick another folder.`);
  return dir;
}

/** Fill a template's {{engineDir}} / {{skill}} / {{port}}, and set a SKILL.md's front-matter name. */
function render(text, vars) {
  let out = text.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  if (vars.skill) out = out.replace(/^(---\r?\n[\s\S]*?^name:)[^\r\n]*/m, `$1 ${vars.skill}`);
  return out;
}

export function scaffold(root, plan, { force = false, dry = false, engineDir } = {}) {
  root = path.resolve(root);
  const repos = [...(Array.isArray(plan.repos) ? plan.repos.map(normalizeRepo).filter(Boolean) : []), ...readRepos(root)];
  const dir = resolveEngineDir(root, engineDir ?? plan.engineDir, repos);
  const skillName = skillNameOf(plan.skillName || dir.split("/").pop());
  const report = { root, engineDir: dir, skill: skillName, wrote: [], kept: [], notes: [] };
  const write = (file, fn) => {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (fs.existsSync(file) && !force) { report.kept.push(rel); return; }
    if (!dry) fn();
    report.wrote.push(rel);
  };

  // ---- engine
  const dash = path.join(root, dir);
  if (hasEngine(dash) && !force) {
    report.kept.push(`${dir}/ (already installed; use upgrade.mjs to update it)`);
  } else {
    if (!dry) copyTree(ENGINE_DIR, dash);
    report.wrote.push(`${dir}/ (engine ${engineVersion()})`);
  }
  const version = engineVersion();
  if (!dry) writeJson(path.join(root, ".claude", "dashboard", "engine.json"), {
    $comment: `The dashboard engine this workspace runs (installed by the natterjack skill) and its folder. upgrade merges newer versions into ${dir}/ using this as the base; don't edit by hand.`,
    version, dir, sourceRepo: SOURCE_REPO, tag: `${TAG_PREFIX}${version}`, installedAt: new Date().toISOString(),
  });
  report.wrote.push(".claude/dashboard/engine.json");

  // ---- config
  if (plan.reference && !plan.infrastructure) plan.infrastructure = plan.reference; // the Infrastructure page's old name
  const COMMENTS = comments(dir);
  for (const [key, name] of Object.entries(CONFIG_FILES)) {
    if (!plan[key]) continue;
    const data = { $comment: COMMENTS[key], ...plan[key] };
    write(path.join(root, ".claude", "dashboard", name), () => writeJson(path.join(root, ".claude", "dashboard", name), data));
  }

  // ---- repos.json
  if (Array.isArray(plan.repos) && plan.repos.length) {
    // Standard field names only, and no empty optional fields (snapshot only when it's false).
    const list = plan.repos.map(normalizeRepo).filter(Boolean).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== null && !(Array.isArray(v) && !v.length) && !(k === "snapshot" && v === true))));
    write(path.join(root, "repos.json"), () => writeJson(path.join(root, "repos.json"), { $schema: reposSchema(dir), repos: list }));
  }

  // ---- .gitignore
  const gi = path.join(root, ".gitignore");
  const current = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const allowList = lines.includes("*");
  const { deny, allow } = gitignoreLines(dir);
  const want = [...(allowList ? allow : []), ...deny].filter((l) => !lines.includes(l));
  if (want.length) {
    if (!dry) fs.writeFileSync(gi, current.replace(/\s*$/, "") + (current ? "\n\n" : "") + "# Workspace dashboard (natterjack)\n" + want.join("\n") + "\n");
    report.wrote.push(`.gitignore (+${want.length} lines${allowList ? ", allow-list style" : ""})`);
  }

  // ---- template skills ("dashboard" is the workspace's own dashboard skill, named after its folder)
  const vars = { engineDir: dir, skill: skillName };
  for (const skill of plan.skills || []) {
    const from = path.join(TEMPLATES_DIR, "skills", skill);
    if (!fs.existsSync(from)) { report.notes.push(`No template skill "${skill}".`); continue; }
    const name = skill === "dashboard" ? skillName : skill;
    const to = path.join(root, ".claude", "skills", name);
    write(to, () => {
      copyTree(from, to);
      for (const rel of listFiles(to).filter((f) => f.endsWith(".md"))) {
        const f = path.join(to, rel);
        fs.writeFileSync(f, render(fs.readFileSync(f, "utf-8"), { ...vars, skill: name }));
      }
    });
  }

  // ---- CLAUDE.md section
  if (plan.claudeMd) {
    const file = path.join(root, "CLAUDE.md");
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (/^## Workspace dashboard/m.test(text)) report.kept.push("CLAUDE.md (already has a Workspace dashboard section)");
    else {
      const port = (plan.workspace && plan.workspace.dashboard && plan.workspace.dashboard.port) || 3333;
      const section = render(fs.readFileSync(path.join(TEMPLATES_DIR, "claude-md-section.md"), "utf-8"), { port, engineDir: dir, skill: skillName });
      if (!dry) fs.writeFileSync(file, (text ? text.replace(/\s*$/, "") + "\n\n" : `# ${plan.workspace && plan.workspace.name ? plan.workspace.name : path.basename(root)} workspace\n\n`) + section);
      report.wrote.push(`CLAUDE.md (${text ? "added" : "new, with"} the Workspace dashboard section)`);
    }
  }

  report.next = [
    `node ${dir}/bin/dashboard.mjs start --open    (first start installs packages and builds the UI: a minute or two)`,
    "node <plugin>/scripts/validate.mjs <workspace>",
  ];
  return report;
}

if (isMain(import.meta)) {
  const a = args();
  const root = a._[0];
  if (!root || !a.plan) {
    console.error("Usage: node scaffold.mjs <workspace> --plan plan.json [--engine-dir <folder>] [--force] [--dry]");
    process.exit(2);
  }
  const plan = readJson(path.resolve(a.plan));
  if (!plan || !plan.workspace) { console.error(`${a.plan}: needs to be JSON with at least "workspace".`); process.exit(1); }
  try {
    const engineDir = typeof a["engine-dir"] === "string" ? a["engine-dir"] : undefined;
    console.log(JSON.stringify(scaffold(root, plan, { force: !!a.force, dry: !!a.dry, engineDir }), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

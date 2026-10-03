#!/usr/bin/env node
/**
 * Check a workspace's dashboard config: each .claude/dashboard/*.json (and repos.json) against what
 * the engine understands, and against the workspace itself (folders exist, ports
 * don't clash, machine checks name real catalog entries, brand files are there).
 *
 *   node validate.mjs <workspace> [--json]
 *
 * Exit code 1 when there are errors (the dashboard would show a broken or empty
 * page), 0 otherwise; warnings are things worth a look. It only reads.
 */

import fs from "node:fs";
import path from "node:path";
import { args, isMain, normalizeRepo, readJson } from "./lib.mjs";

const read = (f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return null; } };

/** Keys of an object literal `NAME = { key: ..., "key-2": ... }` in a TS file (catalog ids, adapters). */
function literalKeys(file, name) {
  const text = read(file) || "";
  const start = text.indexOf(name);
  if (start < 0) return [];
  const body = text.slice(text.indexOf("{", start) + 1);
  const keys = [];
  let depth = 0;
  for (const line of body.split(/\r?\n/)) {
    if (depth === 0) {
      const m = /^\s*"?([\w-]+)"?\s*:/.exec(line);
      if (m) keys.push(m[1]);
      if (/^\s*\};?\s*$/.test(line)) break;
    }
    depth += (line.match(/[{[]/g) || []).length - (line.match(/[}\]]/g) || []).length;
    if (depth < 0) break;
  }
  return keys;
}

export function validate(root) {
  root = path.resolve(root);
  const cfgDir = path.join(root, ".claude", "dashboard");
  const errors = [], warnings = [], ok = [];
  const err = (file, msg) => errors.push(`${file}: ${msg}`);
  const warn = (file, msg) => warnings.push(`${file}: ${msg}`);
  const load = (name) => {
    const file = path.join(cfgDir, name);
    if (!fs.existsSync(file)) return null;
    const data = readJson(file);
    if (!data) { err(name, "isn't valid JSON"); return null; }
    ok.push(name);
    return data;
  };
  const dirExists = (rel) => typeof rel === "string" && fs.existsSync(path.join(root, rel));

  const engine = path.join(root, "dashboard");
  if (!fs.existsSync(path.join(engine, "server", "src", "main.ts"))) err("dashboard/", "the engine isn't installed (run scaffold.mjs)");
  const catalog = literalKeys(path.join(engine, "server", "src", "machine-catalog.ts"), "CATALOG");
  const docProviders = literalKeys(path.join(engine, "server", "src", "docs-providers", "index.ts"), "const PROVIDERS");
  const trackers = literalKeys(path.join(engine, "server", "src", "issues", "index.ts"), "ADAPTERS");

  // ---- workspace.json
  const ws = load("workspace.json");
  if (!ws) warn("workspace.json", "missing: the dashboard uses the folder name, port 3333 and no issue tracker");
  const port = Number((ws && ws.dashboard && ws.dashboard.port) || 3333);
  if (ws) {
    if (!ws.name) warn("workspace.json", "no name (the sidebar shows the folder name)");
    const kind = ws.issues && ws.issues.kind;
    if (kind && kind !== "none" && trackers.length && !trackers.includes(kind)) err("workspace.json", `issues.kind "${kind}" has no adapter (known: ${trackers.join(", ")}); add one or use "none"`);
    if (kind === "linear" && !ws.issues.org) warn("workspace.json", "issues.org (the Linear workspace slug) isn't set: issue links and the connect card can't point at it");
    if (kind === "jira" && !ws.issues.site) err("workspace.json", "issues.site (e.g. acme.atlassian.net) is required for Jira");
    if (kind === "github" && !(ws.issues.repos || ws.issues.repo)) err("workspace.json", "issues.repos (e.g. [\"acme/api\"]) is required for GitHub Issues");
    if (ws.issues && ws.issues.ticketPattern) { try { new RegExp(ws.issues.ticketPattern); } catch { err("workspace.json", "issues.ticketPattern isn't a valid regex"); } }
    const brand = ws.brand || {};
    for (const key of ["logo", "favicon"]) if (brand[key] && !fs.existsSync(path.join(cfgDir, "brand", brand[key]))) err("workspace.json", `brand.${key} "${brand[key]}" isn't in .claude/dashboard/brand/`);
    if (ws.codeHost && ws.codeHost.kind && !["github", "none"].includes(ws.codeHost.kind)) warn("workspace.json", `codeHost.kind "${ws.codeHost.kind}": the Needs-you inbox only reads GitHub so far`);
    if (ws.roles !== undefined) {
      if (!ws.roles || typeof ws.roles !== "object" || Array.isArray(ws.roles)) err("workspace.json", 'roles must be an object: { "<id>": { "label": "…", "profile": "developer" | "reader" } }');
      else {
        // Output styles Claude Code has built in, else a .claude/output-styles/*.md whose name (frontmatter, else file name) matches.
        const styles = new Set(["default", "explanatory", "learning"]);
        const stylesDir = path.join(root, ".claude", "output-styles");
        for (const f of (fs.existsSync(stylesDir) ? fs.readdirSync(stylesDir) : []).filter((f) => f.endsWith(".md"))) {
          // Only the frontmatter block: a "name:" line in the body isn't the style's name.
          const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(read(path.join(stylesDir, f)) || "");
          const m = front && /^name:\s*["']?(.+?)["']?\s*$/m.exec(front[1]);
          styles.add((m ? m[1] : f.slice(0, -3)).toLowerCase());
        }
        for (const [id, r] of Object.entries(ws.roles)) {
          if (!/^[a-z0-9][\w-]*$/i.test(id)) { err("workspace.json", `roles."${id}": an id is letters, digits, - and _ (the dashboard skips it)`); continue; }
          if (!r || typeof r !== "object") { err("workspace.json", `roles.${id} must be an object`); continue; }
          if (r.profile !== undefined && !["developer", "reader"].includes(r.profile)) err("workspace.json", `roles.${id}.profile must be "developer" or "reader" (it's treated as developer)`);
          if (r.outputStyle && !styles.has(String(r.outputStyle).toLowerCase())) warn("workspace.json", `roles.${id}.outputStyle "${r.outputStyle}" isn't built in or in .claude/output-styles/ (Claude falls back to its default)`);
        }
      }
    }
    const rule = ws.worktrees && ws.worktrees.ports;
    if (rule !== undefined && rule !== null) {
      const good = rule && Number.isInteger(rule.base) && rule.base > 0 && Number.isInteger(rule.slotSize) && rule.slotSize > 0 && rule.base + rule.slotSize < 65535;
      if (!good) err("workspace.json", "worktrees.ports needs { base, slotSize } as whole numbers (e.g. { \"base\": 24000, \"slotSize\": 100 }), below port 65535; the dashboard ignores it as written");
    }
  }
  const slotRule = ws && ws.worktrees && ws.worktrees.ports && Number.isInteger(ws.worktrees.ports.base) && Number.isInteger(ws.worktrees.ports.slotSize) && ws.worktrees.ports.slotSize > 0 ? ws.worktrees.ports : null;
  if (fs.existsSync(path.join(cfgDir, "brand")) && !fs.existsSync(path.join(cfgDir, "brand", "theme.css"))) warn("brand/", "no theme.css, so the brand files aren't applied (the neutral theme shows)");
  const theme = read(path.join(cfgDir, "brand", "theme.css"));
  if (theme) {
    for (const m of theme.matchAll(/@import\s+url\(["']?([^"')]+)["']?\)/g)) if (!/^https?:/.test(m[1]) && !fs.existsSync(path.join(cfgDir, "brand", m[1]))) err("brand/theme.css", `imports ${m[1]}, which isn't in brand/`);
    for (const m of theme.matchAll(/--([\w-]+)\s*:\s*var\(--([\w-]+)\)/g)) if (m[1] === m[2]) err("brand/theme.css", `--${m[1]}: var(--${m[1]}) refers to itself (invalid in CSS); delete that line`);
  }

  // ---- apps.json
  const apps = load("apps.json");
  if (apps) {
    const ids = Object.keys(apps.apps || {});
    const ports = new Map();
    for (const [id, a] of Object.entries(apps.apps || {})) {
      if (!a.name) err("apps.json", `apps.${id} has no name`);
      if (!a.dir) err("apps.json", `apps.${id} has no dir`);
      else if (!dirExists(a.dir)) warn("apps.json", `apps.${id}.dir "${a.dir}" isn't in the workspace (not cloned yet?)`);
      if (!a.launch || (!a.launch.cmd && !a.launch.launcher)) err("apps.json", `apps.${id} needs launch.cmd (or launch.launcher)`);
      if (a.launch && a.launch.launcher && !(apps.launcher && apps.launcher.script)) err("apps.json", `apps.${id} uses a launcher but there's no launcher.script`);
      if (a.port) {
        if (ports.has(a.port)) err("apps.json", `apps.${id} and apps.${ports.get(a.port)} both use port ${a.port}`);
        ports.set(a.port, id);
        if (a.port === port) err("apps.json", `apps.${id} uses port ${a.port}, which is the dashboard's`);
      }
      if (a.fallback !== undefined) {
        if (a.fallback !== "main") err("apps.json", `apps.${id}.fallback can only be "main"`);
        else if (a.mainOnly) warn("apps.json", `apps.${id}: fallback has no effect on a mainOnly app (worktrees always use main's)`);
        else if (!a.port) warn("apps.json", `apps.${id}: fallback needs a port, so worktrees know where main's instance is`);
      }
      if (a.slotOffset !== undefined && !(Number.isInteger(a.slotOffset) && a.slotOffset >= 0)) err("apps.json", `apps.${id}.slotOffset must be a whole number (0 or more)`);
    }
    // Worktree port slots (workspace.json worktrees.ports): offsets unique and inside a slot,
    // and the first ten slots clear of main's ports and the dashboard's.
    if (slotRule) {
      const offsets = new Map();
      Object.entries(apps.apps || {}).forEach(([id, a], i) => {
        if (a.mainOnly) return;
        const off = Number.isInteger(a.slotOffset) ? a.slotOffset : i + 1;
        if (off >= slotRule.slotSize) err("apps.json", `apps.${id}: slot offset ${off} is past worktrees.ports.slotSize (${slotRule.slotSize}), so it lands in the next worktree's slot`);
        if (offsets.has(off)) err("apps.json", `apps.${id} and apps.${offsets.get(off)} both get slot offset ${off}; set slotOffset on one of them`);
        else offsets.set(off, id);
      });
      const clashes = new Set();
      for (let slot = 1; slot <= 10; slot++) {
        for (const [off, id] of offsets) {
          const p = slotRule.base + slot * slotRule.slotSize + off;
          if (p > 65535) { err("apps.json", `apps.${id} in worktree slot ${slot} would get port ${p}, past 65535; lower worktrees.ports.base or slotSize`); break; }
          if (p === port) err("apps.json", `apps.${id} in worktree slot ${slot} would get port ${p}, the dashboard's; change worktrees.ports.base`);
          else if (ports.has(p) && !clashes.has(p)) { clashes.add(p); warn("apps.json", `apps.${id} in worktree slot ${slot} would get port ${p}, which apps.${ports.get(p)} uses in main; change worktrees.ports.base`); }
        }
      }
    }
    for (const [sid, s] of Object.entries(apps.stacks || {})) {
      for (const k of s.apps || []) if (!ids.includes(k)) err("apps.json", `stacks.${sid} lists "${k}", which isn't an app`);
      for (const step of s.steps || []) for (const k of [].concat(step.start || [], step.wait || [])) if (!["rest", "all"].includes(k) && !ids.includes(k)) err("apps.json", `stacks.${sid} step names "${k}", which isn't an app`);
    }
    if (apps.launcher && apps.launcher.script && !dirExists(apps.launcher.script)) err("apps.json", `launcher.script "${apps.launcher.script}" doesn't exist`);
    if (apps.defaultStack && !(apps.stacks || {})[apps.defaultStack]) err("apps.json", `defaultStack "${apps.defaultStack}" isn't a stack`);
  } else warn("apps.json", "missing: the Apps page explains how to add apps");

  // ---- machine.json
  const machine = load("machine.json");
  if (machine) {
    for (const [i, c] of (machine.checks || []).entries()) {
      const where = `checks[${i}]${c.id || c.use ? ` (${c.id || c.use})` : ""}`;
      if (c.use && catalog.length && !catalog.includes(c.use)) err("machine.json", `${where}: "${c.use}" isn't in the catalog (${catalog.length} tools; see dashboard/server/src/machine-catalog.ts)`);
      if (!c.use && !c.kind) err("machine.json", `${where}: needs "use" (a catalog id) or "kind"`);
      if (c.required && c.required.file && !dirExists(c.required.file)) warn("machine.json", `${where}: required.file "${c.required.file}" isn't there (the min/default applies)`);
      if (c.apps && apps) for (const k of c.apps) if (!(apps.apps || {})[k]) warn("machine.json", `${where}: apps lists "${k}", which isn't in apps.json`);
    }
  } else warn("machine.json", "missing: the Machine page has nothing to check");

  // ---- docs.json
  const docs = load("docs.json");
  if (docs) {
    const keys = new Set();
    for (const s of docs.sources || []) {
      if (!s.key || !s.name) err("docs.json", `a source needs key and name (${JSON.stringify(s).slice(0, 60)})`);
      if (keys.has(s.key)) err("docs.json", `key "${s.key}" is used twice`);
      keys.add(s.key);
      if (s.kind === "external") {
        if (!/^https?:\/\//.test(s.url || "")) err("docs.json", `${s.key}: external sources need an https url`);
        if (s.provider && docProviders.length && !docProviders.includes(s.provider)) warn("docs.json", `${s.key}: provider "${s.provider}" has no adapter (known: ${docProviders.join(", ")}), so it's a link card only; add one to search it from the Docs page`);
        if (s.provider === "confluence" && s.url && !/^https:\/\/[\w.-]+\/wiki\/?/.test(s.url)) warn("docs.json", `${s.key}: a Confluence url looks like https://<site>.atlassian.net/wiki`);
        if (s.spaces !== undefined && !(Array.isArray(s.spaces) && s.spaces.every((k) => typeof k === "string" && /^[A-Za-z0-9_~-]+$/.test(k)))) err("docs.json", `${s.key}: spaces must be a list of space keys, e.g. ["ENG"]`);
      }
      else if (!s.dir) err("docs.json", `${s.key}: needs dir (or kind "external" with a url)`);
      else if (!dirExists(s.dir)) warn("docs.json", `${s.key}: "${s.dir}" isn't in the workspace`);
      if (s.kind === "site" && !s.port) warn("docs.json", `${s.key}: no preview port, so Page view is off`);
    }
  }

  // ---- infrastructure.json (reference.json before the page was renamed; still read when it's the only one)
  const infraName = fs.existsSync(path.join(cfgDir, "infrastructure.json")) || !fs.existsSync(path.join(cfgDir, "reference.json")) ? "infrastructure.json" : "reference.json";
  const infra = load(infraName);
  if (infraName === "reference.json") warn("reference.json", "rename it to infrastructure.json (the Reference page is now Infrastructure)");
  if (infra && infra.file && !dirExists(infra.file)) warn(infraName, `file "${infra.file}" isn't in the workspace`);

  // ---- links.json
  const links = load("links.json");
  if (links) {
    for (const c of links.categories || []) for (const t of c.tiles || []) {
      const urls = [t.url, ...(t.links || []).map((l) => l.url)].filter(Boolean);
      for (const u of urls) if (!/^https?:\/\/|^\/(?!\/)/.test(u)) err("links.json", `"${t.title}": "${u}" must start with https://, http:// or /`);
      if (!urls.length && !t.repo) warn("links.json", `"${t.title}" has no link and no repo, so it's hidden`);
    }
  }

  // ---- deck.json
  const deck = load("deck.json");
  if (deck) {
    const presetIds = (deck.presets || []).map((p) => p.id);
    for (const r of deck.routines || []) if (!presetIds.includes(r.preset)) err("deck.json", `routine "${r.id}" uses preset "${r.preset}", which doesn't exist`);
    if (deck.issues && deck.issues.implementPreset && !presetIds.includes(deck.issues.implementPreset)) warn("deck.json", `issues.implementPreset "${deck.issues.implementPreset}" isn't a preset, so Implement buttons won't show`);
  }

  // ---- repos.json (workspace root; optional)
  const reposFile = path.join(root, "repos.json");
  if (fs.existsSync(reposFile)) {
    const manifest = readJson(reposFile);
    if (!manifest || !Array.isArray(manifest.repos)) err("repos.json", "needs a \"repos\" array");
    else {
      ok.push("repos.json");
      const paths = new Map(), names = new Set();
      manifest.repos.forEach((raw, i) => {
        const r = normalizeRepo(raw);
        const which = raw && raw.name ? `"${raw.name}"` : `entry ${i + 1}`;
        if (!r) return err("repos.json", `${which} needs a name and a relative path inside the workspace (no absolute paths or "..")`);
        if (names.has(r.name)) err("repos.json", `the name ${which} is used twice`);
        names.add(r.name);
        if (paths.has(r.relativePath)) err("repos.json", `${which} and "${paths.get(r.relativePath)}" both use ${r.relativePath}`);
        paths.set(r.relativePath, r.name);
        const old = ["directory", "dir", "path", "url"].filter((k) => raw[k] !== undefined);
        if (old.length) warn("repos.json", `${which} uses ${old.join(", ")}; the standard names are relativePath and remote (still read)`);
        if (!r.remote && !fs.existsSync(path.join(root, r.relativePath))) warn("repos.json", `${which} isn't here and has no remote to clone it from`);
      });
      // snapshot: where read-only copies are published (engine snapshot-sources/).
      const snap = manifest.snapshot;
      if (snap !== undefined) {
        const kinds = literalKeys(path.join(engine, "server", "src", "snapshot-sources", "index.ts"), "const SOURCES");
        const need = { confluence: ["site", "pageId"], http: ["baseUrl"], "azure-blob": ["container"], s3: ["bucket"] };
        if (!snap || typeof snap !== "object" || typeof snap.source !== "string" || !snap.source) err("repos.json", "snapshot needs a \"source\" (e.g. \"confluence\" or \"http\")");
        else if (kinds.length && !kinds.includes(snap.source)) err("repos.json", `snapshot.source "${snap.source}" has no adapter in this engine (known: ${kinds.join(", ")})`);
        else {
          for (const k of need[snap.source] || []) if (!snap[k]) err("repos.json", `snapshot.source "${snap.source}" needs "${k}"`);
          if (snap.source === "confluence" && snap.pageId && !/^\d+$/.test(String(snap.pageId))) err("repos.json", "snapshot.pageId is the number in the page's URL (…/pages/<pageId>/…)");
          if (snap.source === "http" && snap.auth && !["none", "bearer", "basic"].includes(snap.auth)) err("repos.json", `snapshot.auth must be "none", "bearer" or "basic"`);
          if (snap.source === "azure-blob" && !snap.account && !snap.endpoint) err("repos.json", 'snapshot.source "azure-blob" needs "account" (or "endpoint")');
          if (snap.source === "azure-blob" && snap.account && !/^[a-z0-9]{3,24}$/.test(String(snap.account))) err("repos.json", "snapshot.account is the storage account's name: 3-24 lowercase letters and digits");
        }
      }
    }
  }

  return { root, ok, errors, warnings };
}

if (isMain(import.meta)) {
  const a = args();
  const r = validate(a._[0] || process.cwd());
  if (a.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`Checked: ${r.ok.join(", ") || "(no config files)"}`);
    for (const e of r.errors) console.log(`  ERROR  ${e}`);
    for (const w of r.warnings) console.log(`  warn   ${w}`);
    if (!r.errors.length && !r.warnings.length) console.log("  All good.");
  }
  process.exitCode = r.errors.length ? 1 : 0;
}

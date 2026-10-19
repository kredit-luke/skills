#!/usr/bin/env node
/**
 * Check a workspace's dashboard config: each .claude/dashboard/*.json (and repos.json) against what
 * the engine understands, and against the workspace itself (folders exist, ports
 * don't clash, machine checks name real catalog entries, brand files are there), and
 * that the workspace is a git repo its team can share.
 *
 *   node validate.mjs <workspace> [--json]
 *
 * Exit code 1 when there are errors (the dashboard would show a broken or empty
 * page), 0 otherwise; warnings are things worth a look. It only reads.
 */

import fs from "node:fs";
import path from "node:path";
import { args, engineDirOf, gitOut, gitTopOf, isMain, normalizeRepo, readJson, safeEngineDir } from "./lib.mjs";

const read = (f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return null; } };
/** Does the git repo around `root` ignore this workspace-relative path? (check-ignore exits 0 when it does.) */
const gitIgnores = (root, rel) => gitOut(root, ["check-ignore", "-q", rel]) !== null;

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

/** What's wrong with a meetings.json redirectUri (the engine's rule): http, a loopback host, an explicit port that isn't 0 or 80. */
function redirectProblem(uri) {
  let u;
  try { u = new URL(uri); } catch { return "isn't a URL"; }
  if (u.protocol !== "http:") return "must start with http:// (the dashboard catches the sign-in on this machine)";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return "must be on localhost, 127.0.0.1 or [::1]";
  // URL drops :80 (http's default), so check what was written before calling the port missing.
  if (!u.port && /^http:\/\/[^/?#]*:0*80(?:[/?#]|$)/i.test(uri)) return "can't use port 80 (listening there needs admin rights)";
  if (!u.port) return "needs an explicit port, e.g. http://localhost:31417/roam/callback";
  if (u.port === "0") return "needs a real port, not 0";
  return null;
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

  const lock = readJson(path.join(cfgDir, "engine.json"));
  if (lock && lock.dir !== undefined && !safeEngineDir(lock.dir)) err("engine.json", `dir "${lock.dir}" must be a folder inside the workspace (relative, no "..", not under .claude/); dashboard/ is used instead`);
  const engineDir = engineDirOf(root);
  const engine = path.join(root, engineDir);
  if (!fs.existsSync(path.join(engine, "server", "src", "main.ts"))) err(`${engineDir}/`, "the engine isn't installed (run scaffold.mjs)");
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
      if (c.use && catalog.length && !catalog.includes(c.use)) err("machine.json", `${where}: "${c.use}" isn't in the catalog (${catalog.length} tools; see ${engineDir}/server/src/machine-catalog.ts)`);
      if (!c.use && !c.kind) err("machine.json", `${where}: needs "use" (a catalog id) or "kind"`);
      if (c.required && c.required.file && !dirExists(c.required.file)) warn("machine.json", `${where}: required.file "${c.required.file}" isn't there (the min/default applies)`);
      if (c.apps && apps) for (const k of c.apps) if (!(apps.apps || {})[k]) warn("machine.json", `${where}: apps lists "${k}", which isn't in apps.json`);
    }
  } else warn("machine.json", "missing: the Machine page has nothing to check");

  // ---- docs.json
  const docs = load("docs.json");
  if (docs) {
    const keys = new Set();
    const areaKeys = new Set();
    for (const a of docs.areas || []) {
      if (!a || !/^[\w-]+$/.test(a.key || "")) { err("docs.json", `an area needs a key of letters, digits, _ or - (${JSON.stringify(a).slice(0, 60)})`); continue; }
      if (areaKeys.has(a.key)) err("docs.json", `area "${a.key}" is listed twice`);
      areaKeys.add(a.key);
      if (!a.label) warn("docs.json", `area "${a.key}" has no label`);
      if (a.reviewEvery !== undefined && !(Number(a.reviewEvery) > 0)) err("docs.json", `area "${a.key}": reviewEvery is a number of days, e.g. 90`);
    }
    for (const s of docs.sources || []) {
      if (!s.key || !s.name) err("docs.json", `a source needs key and name (${JSON.stringify(s).slice(0, 60)})`);
      if (keys.has(s.key)) err("docs.json", `key "${s.key}" is used twice`);
      keys.add(s.key);
      if (s.area !== undefined && !areaKeys.has(s.area)) err("docs.json", `${s.key}: area "${s.area}" isn't in areas`);
      const connNames = Array.isArray(s.connection) ? s.connection : [s.connection];
      if (s.connection !== undefined && (!connNames.length || connNames.some((c) => typeof c !== "string" || !c.trim()))) err("docs.json", `${s.key}: connection is the MCP server's name as the Connections page shows it, e.g. "claude.ai Notion" (or a list of names, any one of which works)`);
      if (s.kind === "store") {
        const st = s.store || {};
        const where = `${s.key}: store`;
        if (!["s3", "gcs", "azure-blob"].includes(st.type)) err("docs.json", `${where}.type must be s3, gcs or azure-blob`);
        else if (st.type === "azure-blob") {
          if (!st.container) err("docs.json", `${where} needs container`);
          if (!st.account && !st.endpoint) err("docs.json", `${where} needs account (the storage account name)`);
        } else if (!st.bucket) err("docs.json", `${where} needs bucket`);
        if (st.endpoint && !/^https?:\/\//.test(st.endpoint)) err("docs.json", `${where}.endpoint must be an http(s) address`);
        for (const k of ["key", "secret", "accessKey", "secretAccessKey", "sas", "token"]) if (st[k]) err("docs.json", `${where}.${k}: never put keys in docs.json (it's committed); each person pastes theirs on the Knowledge page, or a hosted dashboard sets KNOWLEDGE_${String(s.key).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`);
        if (!/^[\w-]+$/.test(s.key || "")) err("docs.json", `${s.key}: a store's key is letters, digits, _ or -`);
        continue;
      }
      if (s.kind === "external") {
        if (!/^https?:\/\//.test(s.url || "")) err("docs.json", `${s.key}: external sources need an https url`);
        if (s.provider && docProviders.length && !docProviders.includes(s.provider)) warn("docs.json", `${s.key}: provider "${s.provider}" has no adapter (known: ${docProviders.join(", ")}), so it's a link card only; add one to search it from the Docs page`);
        if (s.provider === "confluence" && s.url && !/^https:\/\/[\w.-]+\/wiki\/?/.test(s.url)) warn("docs.json", `${s.key}: a Confluence url looks like https://<site>.atlassian.net/wiki`);
        if (s.spaces !== undefined && !(Array.isArray(s.spaces) && s.spaces.every((k) => typeof k === "string" && /^[A-Za-z0-9_~-]+$/.test(k)))) err("docs.json", `${s.key}: spaces must be a list of space keys, e.g. ["ENG"]`);
      }
      else if (!s.dir) err("docs.json", `${s.key}: needs dir (or kind "external" with a url, or "store" with a store)`);
      else if (!dirExists(s.dir)) warn("docs.json", `${s.key}: "${s.dir}" isn't in the workspace`);
      if (s.kind === "site" && !s.port) warn("docs.json", `${s.key}: no preview port, so Page view is off`);
    }
  }

  // ---- infrastructure.json (reference.json before the page was renamed; still read when it's the only one)
  const infraName = fs.existsSync(path.join(cfgDir, "infrastructure.json")) || !fs.existsSync(path.join(cfgDir, "reference.json")) ? "infrastructure.json" : "reference.json";
  const infra = load(infraName);
  if (infraName === "reference.json") warn("reference.json", "rename it to infrastructure.json (the Reference page is now Infrastructure)");
  if (infra && infra.file && !dirExists(infra.file)) warn(infraName, `file "${infra.file}" isn't in the workspace`);

  // ---- meetings.json (the Meetings page; without the file the page isn't in the nav)
  const mtg = load("meetings.json");
  if (mtg) {
    const sources = literalKeys(path.join(engine, "server", "src", "meetings", "index.ts"), "const SOURCES");
    const source = typeof mtg.source === "string" ? mtg.source.trim().toLowerCase() : "";
    if (!source) err("meetings.json", '"source" names the meeting tool, e.g. "roam"');
    else if (!sources.length) warn("meetings.json", "this engine has no Meetings page yet: upgrade it");
    else if (!sources.includes(source)) err("meetings.json", `source "${mtg.source}" has no adapter (known: ${sources.join(", ")})`);
    // The engine's rule (server/src/meetings/index.ts): blank or null means left out. The engine turns
    // sign-in off for a bad one (pasting a token still works); here it's an error to fix.
    if (mtg.clientId != null && typeof mtg.clientId !== "string") err("meetings.json", '"clientId" must be the OAuth app\'s client ID (a string), or left out');
    if (mtg.redirectUri != null && typeof mtg.redirectUri !== "string") err("meetings.json", '"redirectUri" must be a string, e.g. http://localhost:31417/roam/callback');
    else if (typeof mtg.redirectUri === "string" && mtg.redirectUri.trim()) {
      const problem = redirectProblem(mtg.redirectUri.trim());
      if (problem) err("meetings.json", `"redirectUri" ${problem}: ${mtg.redirectUri.trim()}`);
    }
    // Only when it's left out (null, absent or blank): a non-string is already an error above.
    const noClientId = mtg.clientId == null || (typeof mtg.clientId === "string" && !mtg.clientId.trim());
    if (source === "roam" && noClientId) warn("meetings.json", 'no "clientId" (the team\'s Roam OAuth app), so there\'s no Sign in with Roam: people can only paste a personal access token');
  }

  // ---- hosting.json (the People page: who has a hosted dashboard; engine people/config.ts has the full checks)
  const hosting = load("hosting.json");
  if (hosting) {
    const H = "hosting.json";
    const d = hosting.directory || {};
    if (!["google", "entra", "manual"].includes(d.type)) err(H, '"directory.type" must be google, entra or manual');
    else if (d.type !== "manual" && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(d.domain || ""))) err(H, `"directory.domain" is the company's email domain, e.g. "acme.com"`);
    const pl = hosting.platform || {};
    const appService = pl.type === "azure-app-service";
    if (pl.type !== "kubernetes" && !appService) err(H, '"platform.type" must be "kubernetes" or "azure-app-service"');
    if (pl.type === "kubernetes" && !pl.namespace) err(H, '"platform.namespace" is the namespace the dashboards run in');
    if (appService && !pl.resourceGroup) err(H, '"platform.resourceGroup" is the resource group the Web Apps go in');
    if (appService && pl.appName !== undefined && !String(pl.appName).includes("{person}")) err(H, '"platform.appName" needs {person} in it, e.g. "dash-{person}"');
    if (!pl.template) err(H, `"platform.template" is a workspace path to your copy of templates/hosted/${appService ? "app-service-person.bicep" : "kubernetes-person.yaml"}`);
    else if (!fs.existsSync(path.join(root, pl.template))) err(H, `"platform.template" ${pl.template} isn't in the workspace`);
    const areas = hosting.areas || {};
    for (const [k, a] of Object.entries(areas)) {
      if (!a || !a.secret) err(H, `area "${k}" needs "secret": ${appService ? "the Key Vault secret holding its key" : "the Kubernetes Secret holding its keys"}`);
      else if (appService && !a.env) err(H, `area "${k}" needs "env": the setting it becomes, e.g. "KNOWLEDGE_${k.toUpperCase()}_KEY"`);
    }
    const profiles = hosting.profiles || {};
    if (!Object.keys(profiles).length) err(H, '"profiles" needs at least one profile');
    for (const [id, pr] of Object.entries(profiles)) for (const a of (pr && pr.areas) || []) if (!areas[a]) err(H, `profile "${id}" uses area "${a}", which isn't in "areas"`);
    if (hosting.defaultProfile && !profiles[hosting.defaultProfile]) err(H, `"defaultProfile" "${hosting.defaultProfile}" isn't one of the profiles`);
  }

  // ---- links.json
  const links = load("links.json");
  if (links) {
    for (const c of links.categories || []) for (const t of c.tiles || []) {
      const urls = [t.url, ...(t.links || []).map((l) => l.url)].filter(Boolean);
      for (const u of urls) if (!/^https?:\/\/|^\/(?!\/)/.test(u)) err("links.json", `"${t.title}": "${u}" must start with https://, http:// or /`);
      if (!urls.length && !t.repo) warn("links.json", `"${t.title}" has no link and no repo, so it's hidden`);
    }
  }

  // ---- connections.json
  const conns = load("connections.json");
  if (conns) {
    if (!Array.isArray(conns.required)) err("connections.json", "needs a \"required\" list");
    const seen = new Set();
    for (const r of Array.isArray(conns.required) ? conns.required : []) {
      if (!r || typeof r.name !== "string" || !r.name.trim()) { err("connections.json", "every required server needs a \"name\" (as `claude mcp list` shows it, e.g. \"claude.ai Linear\")"); continue; }
      if (seen.has(r.name.toLowerCase())) err("connections.json", `"${r.name}" is listed twice`);
      seen.add(r.name.toLowerCase());
      if (!r.why) warn("connections.json", `"${r.name}" has no "why": say what needs it, so people know why to connect it`);
      if (r.alternatives !== undefined && !(Array.isArray(r.alternatives) && r.alternatives.every((a) => typeof a === "string" && a.trim()))) err("connections.json", `"${r.name}": alternatives is a list of other server names that meet it, e.g. ["notion"]`);
      const a = r.add;
      if (a === undefined) continue;
      if (/^claude\.ai |^plugin:/i.test(r.name)) err("connections.json", `"${r.name}": claude.ai connectors and plugin servers can't be added from here; drop "add"`);
      else if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(r.name)) err("connections.json", `"${r.name}": a server with "add" needs a plain name (letters, digits, . _ -)`);
      const type = a && (a.type || (a.url ? "http" : "stdio"));
      if (!a || typeof a !== "object") err("connections.json", `"${r.name}": "add" must be an object`);
      else if (type === "http" || type === "sse") { if (!/^https?:\/\//.test(a.url || "")) err("connections.json", `"${r.name}": add.url must start with https://`); }
      else if (type === "stdio") { if (!a.command) err("connections.json", `"${r.name}": add.command is missing`); }
      else err("connections.json", `"${r.name}": add.type must be http, sse or stdio`);
      const secret = (v) => typeof v === "string" && v.trim() && !/\$\{[A-Z_][A-Z0-9_]*\}/.test(v);
      for (const [k, v] of Object.entries({ ...(a && a.headers), ...(a && a.env) })) {
        if (/key|token|secret|password|authorization/i.test(k) && secret(v)) err("connections.json", `"${r.name}": ${k} looks like a secret; use a placeholder such as "\${${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}}" (each person types theirs in when adding it)`);
      }
    }
  }

  // ---- models.json (local and team open models: the Models page)
  const mdl = load("models.json");
  if (mdl) {
    const local = mdl.local;
    if (local !== undefined && (typeof local !== "object" || Array.isArray(local))) err("models.json", "\"local\" must be an object");
    else if (local) {
      const ctx = local.contextLength;
      if (ctx !== undefined && !(Number.isInteger(ctx) && ctx >= 8192 && ctx <= 1048576)) err("models.json", "local.contextLength must be a whole number of tokens from 8192 to 1048576 (65536 is the default)");
      for (const m of Array.isArray(local.recommended) ? local.recommended : []) {
        if (!m || !/^[a-z0-9][a-z0-9._\-/]{0,100}(:[A-Za-z0-9._\-]{1,60})?$/.test(m.tag || "")) err("models.json", `local.recommended: "${m && m.tag}" isn't an Ollama model name (like qwen3.8:27b)`);
        else if (!(Number(m.diskGb) > 0)) warn("models.json", `local.recommended "${m.tag}" has no diskGb, so the page can't say whether it fits`);
      }
      if (local.hide !== undefined && !(Array.isArray(local.hide) && local.hide.every((x) => typeof x === "string"))) err("models.json", "local.hide is a list of Ollama model names");
    }
    const ids = new Set();
    for (const e of Array.isArray(mdl.endpoints) ? mdl.endpoints : mdl.endpoints === undefined ? [] : (err("models.json", "\"endpoints\" must be a list"), [])) {
      const id = e && e.id;
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id || "")) { err("models.json", `endpoint "${id}": the id must be lowercase letters, digits and dashes (it's part of the model's name in runs)`); continue; }
      if (ids.has(id)) err("models.json", `endpoint "${id}" is listed twice`);
      ids.add(id);
      if (!/^https?:\/\/\S+$/i.test(e.baseUrl || "")) err("models.json", `endpoint "${id}": baseUrl must be the server's address, e.g. https://llm.example.com (an Anthropic-compatible server: Ollama, vLLM, LiteLLM)`);
      else if (/\/v1\/?$/.test(e.baseUrl)) warn("models.json", `endpoint "${id}": baseUrl shouldn't end in /v1 (Claude Code adds /v1/messages itself)`);
      if (typeof e.token === "string" && e.token && !/^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(e.token)) err("models.json", `endpoint "${id}": token looks like a secret; use a placeholder such as "\${${id.toUpperCase().replace(/-/g, "_")}_TOKEN}" (or leave it out and each person saves theirs on the Models page)`);
      if (e.models !== undefined) {
        if (!Array.isArray(e.models)) err("models.json", `endpoint "${id}": models must be a list of { id, label?, tools?, context? }`);
        else for (const m of e.models) if (!m || !/^[A-Za-z0-9._:\-/]{1,120}$/.test(m.id || "")) err("models.json", `endpoint "${id}": model "${m && m.id}" needs an id as the server names it`);
      }
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
  const clones = []; // repos.json repos cloned here, for the .gitignore check below
  if (fs.existsSync(reposFile)) {
    const manifest = readJson(reposFile);
    if (!manifest || !Array.isArray(manifest.repos)) err("repos.json", "needs a \"repos\" array");
    else {
      ok.push("repos.json");
      const paths = new Map(), names = new Set();
      clones.push(...manifest.repos.map(normalizeRepo).filter((r) => r && r.relativePath !== "." && fs.existsSync(path.join(root, r.relativePath, ".git"))));
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

  // ---- the workspace itself: shared through git, unless it was installed from a snapshot (no git by design)
  // (A repo at the home folder, i.e. dotfiles, doesn't count: gitTopOf skips it.)
  if (fs.existsSync(cfgDir) && !fs.existsSync(path.join(root, ".snapshot.json"))) {
    const top = gitTopOf(root);
    if (!top) warn("workspace", "the workspace folder isn't a git repo, so its dashboard, config, skills and CLAUDE.md can't be shared with the team. Run git init here and commit them (the product repos stay their own clones, gitignored and listed in repos.json)");
    else if (gitIgnores(root, ".claude/dashboard/")) warn("workspace", `the git repo at ${top} ignores .claude/dashboard/, so the dashboard config isn't shared with the team. Make the workspace its own git repo (git init here), or stop ignoring it there`);
    else {
      // Clones inside the workspace repo must be ignored, or git add records them as embedded repos.
      const wt = (ws && ws.worktrees && ws.worktrees.dir) || "worktrees";
      const nested = [...clones.map((r) => r.relativePath), ...(fs.existsSync(path.join(root, wt)) ? [wt] : [])];
      const unignored = nested.filter((p) => !gitIgnores(root, `${p}/`));
      if (unignored.length) warn("workspace", `${unignored.map((p) => `${p}/`).join(", ")} ${unignored.length === 1 ? "isn't" : "aren't"} gitignored: the folders hold their own clones, so git add in the workspace repo would record them as embedded repos. Add ${unignored.map((p) => `/${p}/`).join(" ")} to .gitignore`);
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

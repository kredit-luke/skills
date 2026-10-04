/**
 * The Connections page: the MCP servers Claude Code can reach from this workspace,
 * whether each one works, and the fixes the page can make.
 *
 * Two sources, merged by name:
 *  - config, read from the files Claude Code keeps it in (fast): ~/.claude.json
 *    `mcpServers` (user scope) and `projects[<workspace>].mcpServers` (local scope),
 *    and the workspace's .mcp.json (project scope). Plugins' servers and claude.ai
 *    connectors only show up in the CLI's list.
 *  - health, from `claude mcp list` (slow: it connects to every server), cached and
 *    shared with the Machine page's claude-connector check.
 *
 * Changes go through the CLI (`claude mcp add-json / remove / logout`; `login` is
 * mcp-login.ts) or the person's own .claude/settings.local.json
 * (`enabledMcpjsonServers` to approve a project server, `permissions.allow` to let
 * dashboard runs use a server's tools: they run with permission prompts off, so
 * an MCP tool without an allow rule is denied). Never ~/.claude.json by hand:
 * Claude Code rewrites it all the time.
 *
 * Header and env values (where tokens live) never leave the server.
 *
 * connections.json (optional, .claude/dashboard/) names the servers the team relies on:
 *   { "required": [ { "name": "claude.ai Linear", "why": "Issues page" },
 *                   { "name": "notion", "why": "Specs", "add": { "type": "http", "url": "https://mcp.notion.com/mcp" } } ] }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connection, ConnectionAddRequest, ConnectionRequired, ConnectionsResponse, McpScope, McpServerConfig } from "../../shared/api.ts";
import { claudeEnv, claudeIsShim, parseMcpList, spawnClaude, type McpListEntry } from "./claude.ts";
import { readConfigFile } from "./config.ts";
import { editSettings } from "./profile.ts";

// ------------------------------------------------------------------ `claude mcp list`

/** An Error with an HTTP status (main.ts sends it as { error }). */
function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/** Run `claude <args>`: { ok, out } (stdout and stderr together), never rejects. */
export function runClaude(args: string[], cwd: string, timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnClaude(args, { cwd, env: claudeEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { return resolve({ ok: false, out: e.message }); }
    let out = "";
    const timer = setTimeout(() => { out += "\nTimed out."; child.kill(); }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, out }); });
  });
}

// One cached health check per workspace folder, shared by this page and the Machine page.
const HEALTH_TTL_MS = 60_000;
interface Health { at: number | null; out: string; ok: boolean; entries: McpListEntry[] }
const health = new Map<string, { last: Health | null; inflight: Promise<Health> | null; rerun: Promise<Health> | null }>();

export type ClaudeRunner = typeof runClaude;

/** `claude mcp list` for `cwd`, cached for a minute (force: check again). */
export function mcpHealth(cwd: string, force = false, run: ClaudeRunner = runClaude): Promise<Health> {
  const slot = health.get(cwd) || { last: null, inflight: null, rerun: null };
  health.set(cwd, slot);
  if (slot.last && !force && slot.last.at && Date.now() - slot.last.at < HEALTH_TTL_MS) return Promise.resolve(slot.last);
  if (slot.inflight) {
    if (!force) return slot.inflight;
    // A forced check while one runs (e.g. right after an add or remove): that one may predate the change, so check again after it.
    if (!slot.rerun) slot.rerun = slot.inflight.catch(() => {}).then(() => { slot.rerun = null; return mcpHealth(cwd, true, run); });
    return slot.rerun;
  }
  slot.inflight = run(["mcp", "list"], cwd, 120_000)
    .then((r) => (slot.last = { at: Date.now(), out: r.out, ok: r.ok, entries: parseMcpList(r.out) }))
    .finally(() => { slot.inflight = null; });
  return slot.inflight;
}

function healthNow(cwd: string): { last: Health | null; checking: boolean } {
  const slot = health.get(cwd);
  return { last: slot?.last || null, checking: !!slot?.inflight };
}

/** Forget the cached check, so the next read asks the CLI again. */
export function invalidateMcpHealth(cwd: string) {
  const slot = health.get(cwd);
  if (slot) slot.last = null;
}

// ------------------------------------------------------------------ config files

/** ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json. */
export function claudeJsonFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, "")); } catch { return null; }
}

const samePath = (a: string, b: string) => {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

const obj = (v: any): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const names = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** The allow rule that covers every tool of a server: names become tool prefixes with anything but [A-Za-z0-9_-] as "_". */
export function mcpRule(name: string): string {
  return `mcp__${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

const SECRET_ARG = /^(--?[\w-]*(key|token|secret|password|auth)[\w-]*=).+$/i;

const SECRET_FLAG = /^--?[\w-]*(key|token|secret|password|auth)[\w-]*$/i;

/** URL or command line to show: the URL without its query or credentials, a command with secret-looking flags masked. */
export function targetOf(c: any): string | null {
  if (typeof c.url === "string") return c.url.replace(/[?#].*$/, "").replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, "$1");
  if (typeof c.command === "string") {
    const args = names(c.args);
    // --token=abc, and the value after a bare --token.
    return [c.command, ...args.map((a, i) => (i > 0 && SECRET_FLAG.test(args[i - 1]) && !a.startsWith("-") ? "•••" : a.replace(SECRET_ARG, "$1•••")))].join(" ");
  }
  return null;
}

interface Configured { name: string; scope: McpScope; transport: string | null; target: string | null; envKeys: string[]; headerKeys: string[] }

function configured(name: string, c: any, scope: McpScope): Configured {
  const cfg = obj(c);
  const type = typeof cfg.type === "string" ? cfg.type : typeof cfg.url === "string" ? "http" : "stdio";
  return { name, scope, transport: type.toLowerCase(), target: targetOf(cfg), envKeys: Object.keys(obj(cfg.env)), headerKeys: Object.keys(obj(cfg.headers)) };
}

/** The servers configured in files, plus the person's project-server choices and allow rules. */
export function readMcpConfig(root: string) {
  const claudeJson = obj(readJson(claudeJsonFile()));
  const projects = obj(claudeJson.projects);
  const projKey = Object.keys(projects).find((k) => samePath(k, root));
  const proj = obj(projKey ? projects[projKey] : null);
  const mcpJson = obj(readJson(path.join(root, ".mcp.json")));
  const local = obj(readJson(path.join(root, ".claude", "settings.local.json")));
  const shared = obj(readJson(path.join(root, ".claude", "settings.json")));
  const userSettings = obj(readJson(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json")));

  const servers: Configured[] = [];
  for (const [n, c] of Object.entries(obj(claudeJson.mcpServers))) servers.push(configured(n, c, "user"));
  for (const [n, c] of Object.entries(obj(proj.mcpServers))) servers.push(configured(n, c, "local"));
  for (const [n, c] of Object.entries(obj(mcpJson.mcpServers))) servers.push(configured(n, c, "project"));

  const enabledAll = [local, shared, userSettings].some((s) => s.enableAllProjectMcpServers === true);
  const enabled = new Set([...names(local.enabledMcpjsonServers), ...names(shared.enabledMcpjsonServers), ...names(proj.enabledMcpjsonServers)]);
  const disabled = new Set([...names(local.disabledMcpjsonServers), ...names(shared.disabledMcpjsonServers), ...names(proj.disabledMcpjsonServers)]);
  const allowLocal = new Set(names(obj(local.permissions).allow));
  const allowOther = new Set([...names(obj(shared.permissions).allow), ...names(obj(userSettings.permissions).allow)]);
  return { servers, enabledAll, enabled, disabled, allowLocal, allowOther };
}

// ------------------------------------------------------------------ connections.json

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** The ${VAR} names in a server config. */
export function configVars(c: McpServerConfig | null): string[] {
  if (!c) return [];
  const found = new Set<string>();
  const scan = (s: unknown) => { if (typeof s === "string") for (const m of s.matchAll(VAR_RE)) found.add(m[1]); };
  scan(c.url); scan(c.command);
  (c.args || []).forEach(scan);
  Object.values(c.headers || {}).forEach(scan);
  Object.values(c.env || {}).forEach(scan);
  return [...found];
}

/** connections.json `required`, keyed by lowercased name. */
export function readRequired(): { required: Map<string, { name: string } & ConnectionRequired>; error: string | null; configured: boolean } {
  const { data, error } = readConfigFile("connections.json");
  const required = new Map<string, { name: string } & ConnectionRequired>();
  const errors = error ? [error] : [];
  for (const r of Array.isArray(data?.required) ? data.required : []) {
    if (!r || typeof r.name !== "string" || !r.name.trim()) continue;
    let add: McpServerConfig | null = null;
    try { add = r.add ? checkConfig(r.add) : null; } catch (e) { errors.push(`connections.json: "${r.name.trim()}" add: ${(e as Error).message}`); }
    const alternatives = Array.isArray(r.alternatives) ? r.alternatives.filter((a: unknown) => typeof a === "string" && a.trim()).map((a: string) => a.trim()) : [];
    required.set(r.name.trim().toLowerCase(), { name: r.name.trim(), why: typeof r.why === "string" ? r.why : "", add, vars: configVars(add), alternatives });
  }
  return { required, error: errors.join(" ") || null, configured: !!data };
}

// ------------------------------------------------------------------ validation

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Names the CLI shows (claude.ai connectors and plugin servers have spaces and colons). */
const LISTED_NAME_RE = /^[\w .:@/()-]{1,120}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;

function strMap(v: any, what: string, keyRe: RegExp): Record<string, string> | undefined {
  if (v == null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw httpError(400, `${what} must be an object.`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!keyRe.test(k)) throw httpError(400, `Invalid ${what} name: ${k}`);
    if (typeof val !== "string" || /[\r\n]/.test(val)) throw httpError(400, `${what} ${k} must be one line of text.`);
    out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A server config from the browser or connections.json, checked and reduced to the fields add-json takes. */
export function checkConfig(c: any): McpServerConfig {
  if (!c || typeof c !== "object") throw httpError(400, "Missing server config.");
  const type = String(c.type || (c.url ? "http" : "stdio")).toLowerCase();
  if (type === "http" || type === "sse") {
    let u: URL;
    try { u = new URL(String(c.url || "")); } catch { throw httpError(400, "Enter the server's URL (https://…)."); }
    if (!/^https?:$/.test(u.protocol)) throw httpError(400, "The URL must start with https:// (or http:// for a local server).");
    const headers = strMap(c.headers, "Header", /^[A-Za-z0-9-]{1,128}$/);
    return { type, url: u.toString(), ...(headers ? { headers } : {}) };
  }
  if (type !== "stdio") throw httpError(400, `Unknown transport: ${type}`);
  const command = String(c.command || "").trim();
  if (!command || /[\r\n]/.test(command)) throw httpError(400, "Enter the command that starts the server.");
  const args = c.args == null ? [] : Array.isArray(c.args) ? c.args.map(String) : null;
  if (!args || args.some((a) => /[\r\n]/.test(a))) throw httpError(400, "Arguments must be a list of single-line strings.");
  const env = strMap(c.env, "Environment variable", KEY_RE);
  return { type: "stdio", command, ...(args.length ? { args } : {}), ...(env ? { env } : {}) };
}

/** A server name as `claude mcp list` shows it, checked (it goes to the CLI). */
export function listedName(v: unknown): string {
  const name = String(v || "").trim();
  if (!LISTED_NAME_RE.test(name)) throw httpError(400, "Invalid server name.");
  return name;
}

// ------------------------------------------------------------------ the page

export class Connections {
  root: string;
  /** Runs `claude`; tests pass a fake. */
  run: ClaudeRunner;

  constructor(workspaceRoot: string, opts: { run?: ClaudeRunner } = {}) {
    this.root = workspaceRoot;
    this.run = opts.run || runClaude;
  }

  /** Config now; health from the cache, or (wait) from a check. A stale cache starts a check in the background. */
  async list(opts: { wait?: boolean; force?: boolean } = {}): Promise<ConnectionsResponse> {
    if (opts.wait || opts.force) {
      await mcpHealth(this.root, !!opts.force, this.run);
    } else {
      const { last } = healthNow(this.root);
      if (!last?.at || Date.now() - last.at >= HEALTH_TTL_MS) mcpHealth(this.root, false, this.run).catch(() => {});
    }
    return this.build();
  }

  build(): ConnectionsResponse {
    const cfg = readMcpConfig(this.root);
    const { last, checking } = healthNow(this.root);
    const req = readRequired();
    const listed = new Map((last?.entries || []).map((e) => [e.name.toLowerCase(), e]));
    const rows = new Map<string, Connection>();

    const row = (name: string, base: Partial<Connection>): Connection => {
      const key = name.toLowerCase();
      const e = listed.get(key);
      const rule = mcpRule(name);
      return {
        name, scope: "unknown", transport: e?.transport || null, target: e?.target || null, envKeys: [], headerKeys: [],
        state: e ? e.state : null, status: e ? e.text : null, approval: null,
        allowed: cfg.allowLocal.has(rule) || cfg.allowOther.has(rule),
        rule, required: null, missing: false, actions: [], hint: null,
        ...base,
      };
    };

    // Files first (they know the scope); a name in two scopes shows as the one Claude uses (local > project > user).
    const rank: Record<string, number> = { local: 3, project: 2, user: 1 };
    for (const s of cfg.servers) {
      const prev = rows.get(s.name.toLowerCase());
      if (prev && (rank[prev.scope] || 0) >= (rank[s.scope] || 0)) continue;
      rows.set(s.name.toLowerCase(), row(s.name, { scope: s.scope, transport: s.transport, target: s.target, envKeys: s.envKeys, headerKeys: s.headerKeys }));
    }
    for (const e of last?.entries || []) {
      if (rows.has(e.name.toLowerCase())) continue;
      const scope: McpScope = /^claude\.ai /i.test(e.name) ? "claude.ai" : /^plugin:/i.test(e.name) ? "plugin" : "unknown";
      rows.set(e.name.toLowerCase(), row(e.name, { scope }));
    }
    // Each requirement lands on the server that meets it: its name or an alternative (the same tool reached
    // another way, e.g. a claude.ai connector or a server added by hand), the connected one first.
    // None configured: a "missing" row, known only once a check has run (claude.ai connectors and plugins aren't in files).
    for (const [key, r] of req.required) {
      const required = { why: r.why, add: r.add, vars: r.vars, alternatives: r.alternatives };
      const found = [r.name, ...r.alternatives].map((n) => rows.get(n.toLowerCase())).filter((c): c is Connection => !!c && !c.required);
      const best = found.find((c) => c.state === "connected") || found[0];
      if (best) { best.required = required; continue; }
      if (!last?.at && !r.add) continue;
      rows.set(key, row(r.name, { scope: /^claude\.ai /i.test(r.name) ? "claude.ai" : /^plugin:/i.test(r.name) ? "plugin" : "unknown", missing: true, required }));
    }

    for (const c of rows.values()) this.decorate(c, cfg);

    const list = [...rows.values()].sort((a, b) =>
      Number(!!b.required) - Number(!!a.required) || SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.name.localeCompare(b.name));
    return {
      connections: list,
      checkedAt: last?.at || null,
      checking,
      checkError: last && !last.ok && !last.entries.length ? (last.out.trim().split(/\r?\n/).pop() || "claude mcp list failed.") : null,
      configError: req.error,
      configured: req.configured,
      problems: list.filter(needsAttention).length,
    };
  }

  /** Approval, buttons and a hint for one row. */
  private decorate(c: Connection, cfg: ReturnType<typeof readMcpConfig>) {
    if (c.scope === "project") {
      c.approval = cfg.disabled.has(c.name) ? "rejected" : cfg.enabledAll || cfg.enabled.has(c.name) ? "approved" : "pending";
      if (c.approval === "pending") c.state = c.state === "connected" ? c.state : "pending";
    }
    const actions = new Set<Connection["actions"][number]>();
    if (!c.missing) actions.add("allow");
    if (c.missing) {
      c.hint = c.required?.add ? "Not set up for you yet: Add it." :
        c.scope === "claude.ai" ? `Your claude.ai account doesn't have the ${c.name.replace(/^claude\.ai /i, "")} connector. An org admin adds it in claude.ai's admin settings; then connect it at claude.ai → Settings → Connectors.` :
        c.scope === "plugin" ? "Comes with a Claude Code plugin that isn't installed for you." :
        "Not set up for you yet. Ask whoever added it to connections.json how to add it.";
    } else if (c.approval === "pending") {
      actions.add("approve");
      c.hint = "In the workspace's .mcp.json, but you haven't approved it, so Claude doesn't connect to it (and dashboard runs can't ask).";
    } else if (c.approval === "rejected") {
      c.hint = "You turned this project server down. Run `claude mcp reset-project-choices` in the workspace to be asked again.";
    } else if (c.state === "needs-auth") {
      actions.add("login");
    } else if (c.state === "disabled") {
      c.hint = `Turned off for this workspace. In a Claude session, run /mcp and enable "${c.name}".`;
    } else if (c.state === "failed" && /dynamic client registration/i.test(c.status || "")) {
      c.hint = "This server's sign-in doesn't work with Claude Code's automatic setup. Use its claude.ai connector instead, if there is one.";
    } else if (c.state === "failed" && c.headerKeys.length && /\b401\b|unauthori[sz]ed|expired|forbidden|\b403\b/i.test(c.status || "")) {
      c.hint = `The server turned down its ${c.headerKeys.join(", ")} header: the token has probably expired. Remove it and add it again with a new one.`;
    } else if (c.state === "not-configured") {
      c.hint = "The plugin that brings it has no address set for it.";
    }
    // An OAuth sign-in to clear: an HTTP/SSE server without a fixed header token (claude.ai keeps its connectors' own).
    if (c.state === "connected" && (c.transport === "http" || c.transport === "sse") && !c.headerKeys.length && c.scope !== "claude.ai") actions.add("logout");
    if (c.scope === "user" || c.scope === "local") actions.add("remove");
    if (c.scope === "claude.ai" && c.state !== "connected" && !actions.has("login") && !c.hint) c.hint = "Connect it at claude.ai → Settings → Connectors.";
    c.actions = [...actions];
  }

  // ---------------------------------------------------------------- actions

  async logout(name: string): Promise<ConnectionsResponse> {
    const r = await this.run(["mcp", "logout", listedName(name)], this.root);
    if (!r.ok) throw httpError(400, lastLine(r.out) || "Couldn't sign out.");
    return this.refresh();
  }

  async remove(name: string): Promise<ConnectionsResponse> {
    const n = listedName(name);
    const s = readMcpConfig(this.root).servers.filter((x) => x.name === n);
    const scope = s.find((x) => x.scope === "local") ? "local" : s.find((x) => x.scope === "user") ? "user" : null;
    if (!scope) throw httpError(400, s.length ? "That server is in the workspace's .mcp.json, which everyone shares: remove it there." : "No server by that name in your config.");
    this.checkSettings("removing a server");
    const r = await this.run(["mcp", "remove", n, "-s", scope], this.root);
    if (!r.ok) throw httpError(400, lastLine(r.out) || "Couldn't remove it.");
    this.afterCli(() => this.setAllowed(n, false), "Removed, but its allow rule couldn't be taken out of .claude/settings.local.json");
    return this.refresh();
  }

  async add(body: ConnectionAddRequest): Promise<ConnectionsResponse> {
    const name = String(body?.name || "").trim();
    if (!NAME_RE.test(name)) throw httpError(400, "Name: letters, digits, '.', '_' or '-' (up to 64), starting with a letter or digit.");
    const scope = body?.scope === "user" ? "user" : "local";
    const config = checkConfig(body?.config);
    if (configVars(config).length) throw httpError(400, `Fill in ${configVars(config).map((v) => "${" + v + "}").join(", ")} first.`);
    const json = JSON.stringify(config);
    if (claudeIsShim() && /[&|<>^%!]/.test(json)) throw httpError(400, "Claude Code is installed through npm here, so this server's settings can't be passed safely (they contain & | < > ^ % or !). Install Claude Code natively, or add it in a terminal with `claude mcp add`.");
    if (body.allow) this.checkSettings("adding a server");
    const r = await this.run(["mcp", "add-json", name, json, "-s", scope], this.root);
    if (!r.ok) throw httpError(400, lastLine(r.out) || "Couldn't add it.");
    if (body.allow) this.afterCli(() => this.setAllowed(name, true), "Added, but runs couldn't be allowed to use it in .claude/settings.local.json");
    return this.refresh();
  }

  /** Approve a project (.mcp.json) server for this person. */
  async approve(name: string): Promise<ConnectionsResponse> {
    const n = listedName(name);
    if (!readMcpConfig(this.root).servers.some((s) => s.scope === "project" && s.name === n)) throw httpError(400, "Not a server in the workspace's .mcp.json.");
    editSettings(this.root, (s) => {
      const on = names(s.enabledMcpjsonServers);
      const off = names(s.disabledMcpjsonServers);
      if (on.includes(n) && !off.includes(n)) return { changed: false, result: null };
      s.enabledMcpjsonServers = [...new Set([...on, n])];
      if (off.includes(n)) {
        const rest = off.filter((x) => x !== n);
        if (rest.length) s.disabledMcpjsonServers = rest; else delete s.disabledMcpjsonServers;
      }
      return { changed: true, result: null };
    }, "approving a server");
    return this.refresh();
  }

  /** Let dashboard runs use a server's tools without asking (or stop). */
  allow(name: string, on: boolean): ConnectionsResponse {
    const n = listedName(name);
    if (!on && readMcpConfig(this.root).allowOther.has(mcpRule(n))) throw httpError(400, "It's allowed in shared settings (.claude/settings.json or your user settings), not just yours: change it there.");
    this.setAllowed(n, on);
    return this.build();
  }

  /** Before a CLI change that's followed by a settings edit: fail now if settings.local.json can't be edited. */
  private checkSettings(doing: string) {
    try { editSettings(this.root, () => ({ changed: false, result: null }), doing); } catch (e) { throw httpError(400, (e as Error).message); }
  }

  /** The settings edit after a CLI change that already happened: say what's left over rather than "failed". */
  private afterCli(edit: () => void, done: string) {
    try { edit(); } catch (e) { throw httpError(500, `${done}: ${(e as Error).message}`); }
  }

  private setAllowed(name: string, on: boolean) {
    const rule = mcpRule(name);
    editSettings(this.root, (s) => {
      const perms = obj(s.permissions);
      const allow = names(perms.allow);
      if (on === allow.includes(rule)) return { changed: false, result: null };
      const next = on ? [...allow, rule] : allow.filter((x) => x !== rule);
      s.permissions = { ...perms, allow: next };
      if (!next.length) delete s.permissions.allow;
      if (!Object.keys(s.permissions).length) delete s.permissions;
      return { changed: true, result: null };
    }, "changing what runs may use");
  }

  private async refresh(): Promise<ConnectionsResponse> {
    await mcpHealth(this.root, true, this.run);
    return this.build();
  }
}

const SCOPE_ORDER: McpScope[] = ["claude.ai", "project", "local", "user", "plugin", "unknown"];

/** Required and not working for this person. */
export function needsAttention(c: Connection): boolean {
  if (!c.required) return false;
  return c.missing || c.approval === "pending" || c.approval === "rejected" || (c.state !== null && c.state !== "connected");
}

function lastLine(out: string): string {
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("[")).pop() || "";
}

/**
 * MCP servers for the other agent CLIs (the Connections page's Copilot and Codex tabs):
 * each keeps its own list, read with its own `mcp list --json` and changed with
 * `mcp add` / `mcp remove`. Claude's is connections.ts.
 *
 *   Copilot: ~/.copilot/mcp-config.json (user), plus the workspace's .mcp.json and
 *            .github/mcp.json (shared with Claude), plugins and its built-in GitHub server.
 *   Codex:   ~/.codex/config.toml (user only). Adding a remote server starts its OAuth
 *            sign-in, and `codex mcp login` signs in again, so both open a terminal.
 *
 * Env and header values (where tokens live) never leave the server: rows carry names only.
 * "Copy from Claude" adds one of Claude's servers to the other agent, with its real config
 * read on the server (claude.ai connectors by their URL: the other agent signs in itself).
 */

import fs from "node:fs";
import type { McpServerConfig } from "../../../shared/api.ts";
import { claudeJsonFile, mcpHealth } from "../connections.ts";
import { probeCli } from "./util.ts";
import path from "node:path";

export type OtherAgent = "copilot" | "codex";

export interface AgentServer {
  name: string;
  /** Where it's configured: user (yours), workspace (.mcp.json, shared), plugin, builtin. */
  source: "user" | "workspace" | "plugin" | "builtin";
  transport: string;
  target: string | null;
  enabled: boolean;
  envKeys: string[];
  headerKeys: string[];
  /** Codex's sign-in state for remote servers (e.g. "o_auth", "not_logged_in"), else null. */
  auth: string | null;
  actions: Array<"remove" | "login">;
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const keys = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []);
const SECRET_ARG = /^(--?[\w-]*(key|token|secret|password|auth)[\w-]*=).+$/i;
const shown = (command: string, args: string[]) => [command, ...args].map((a) => String(a).replace(SECRET_ARG, "$1•••")).join(" ");

/** `copilot mcp list --json` → rows. */
export function parseCopilotServers(json: any): AgentServer[] {
  const servers = json && typeof json.mcpServers === "object" ? json.mcpServers : {};
  return Object.entries<any>(servers).map(([name, s]) => {
    const remote = s.type === "http" || s.type === "sse";
    const source = (["user", "workspace", "plugin", "builtin"].includes(s.source) ? s.source : "user") as AgentServer["source"];
    return {
      name, source, transport: remote ? s.type : "stdio",
      target: remote ? String(s.url || "").replace(/[?#].*$/, "") : s.command ? shown(s.command, Array.isArray(s.args) ? s.args : []) : null,
      enabled: s.enabled !== false, envKeys: keys(s.env), headerKeys: keys(s.headers), auth: null,
      actions: source === "user" ? ["remove"] : [],
    };
  });
}

/** `codex mcp list --json` → rows. */
export function parseCodexServers(json: any): AgentServer[] {
  return (Array.isArray(json) ? json : []).filter((s) => s && typeof s.name === "string").map((s) => {
    const t = s.transport || {};
    const remote = !!t.url;
    const auth = typeof s.auth_status === "string" && s.auth_status !== "unsupported" ? s.auth_status : null;
    return {
      name: s.name, source: "user" as const, transport: remote ? "http" : "stdio",
      target: remote ? String(t.url).replace(/[?#].*$/, "") : t.command ? shown(t.command, Array.isArray(t.args) ? t.args : []) : null,
      enabled: s.enabled !== false, envKeys: [...keys(t.env), ...(Array.isArray(t.env_vars) ? t.env_vars : [])],
      headerKeys: keys(t.http_headers || t.headers), auth,
      actions: ["remove", ...(remote && auth && /not.?logged|logged.?out|expired|unauth/i.test(auth) ? ["login" as const] : [])],
    };
  });
}

/** The JSON a CLI printed, past any warnings before it. */
function jsonOf(out: string): any {
  const at = out.search(/^[[{]/m);
  if (at < 0) throw new Error("No JSON in the output.");
  return JSON.parse(out.slice(at));
}

/** One agent's servers, from its CLI (run in the workspace, so Copilot sees .mcp.json). */
export async function listAgentServers(agent: OtherAgent, cwd: string): Promise<AgentServer[]> {
  const r = await probeCli(agent, ["mcp", "list", "--json"], 60_000, cwd);
  if (r.missing) throw httpError(409, `${agent === "copilot" ? "Copilot" : "Codex"} isn't installed.`);
  try { return agent === "copilot" ? parseCopilotServers(jsonOf(r.out)) : parseCodexServers(jsonOf(r.out)); }
  catch { throw httpError(502, `Couldn't read ${agent}'s MCP servers: ${r.out.trim().split(/\r?\n/).pop() || "no output"}`); }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A Claude name ("claude.ai Notion", "plugin:engineering:linear") as another agent's ("notion", "linear"). */
export function agentServerName(claudeName: string): string {
  const base = claudeName.replace(/^claude\.ai\s+/i, "").replace(/^plugin:[^:]+:/i, "");
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "server";
}

/**
 * The CLI arguments that add a server. Codex takes no headers on a remote server (it signs
 * in with OAuth, or reads a bearer token from an env var): a header config is refused.
 */
export function addArgs(agent: OtherAgent, name: string, c: McpServerConfig): string[] {
  if (!NAME.test(name)) throw httpError(400, "Name: letters, digits, _ or - (up to 64), starting with a letter or digit.");
  const env = Object.entries(c.env || {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  if (c.type === "stdio") {
    if (!c.command) throw httpError(400, "Enter the command that starts the server.");
    return ["mcp", "add", name, ...env, "--", c.command, ...(c.args || [])];
  }
  if (!c.url) throw httpError(400, "Enter the server's URL.");
  if (agent === "copilot") return ["mcp", "add", "--transport", c.type, name, c.url, ...Object.entries(c.headers || {}).flatMap(([k, v]) => ["--header", `${k}: ${v}`])];
  if (keys(c.headers).length) throw httpError(400, "Codex doesn't take headers for a remote server: it signs in with OAuth. Add it without headers.");
  return ["mcp", "add", name, "--url", c.url];
}

export async function removeAgentServer(agent: OtherAgent, name: string, cwd: string): Promise<void> {
  if (!/^[\w .:@/-]{1,120}$/.test(name)) throw httpError(400, "Invalid server name.");
  const r = await probeCli(agent, ["mcp", "remove", name], 60_000, cwd);
  if (!r.ok) throw httpError(400, r.out.trim().split(/\r?\n/).pop() || "Couldn't remove it.");
}

/** Run `mcp add` (Copilot; Codex for a stdio server). */
export async function addAgentServer(agent: OtherAgent, name: string, c: McpServerConfig, cwd: string): Promise<void> {
  const r = await probeCli(agent, addArgs(agent, name, c), 60_000, cwd);
  if (!r.ok) throw httpError(400, r.out.trim().split(/\r?\n/).pop() || "Couldn't add it.");
}

/** Codex adds a remote server by signing in to it: that needs a browser and may ask, so it's a terminal command. */
export function needsTerminal(agent: OtherAgent, c: McpServerConfig): boolean {
  return agent === "codex" && c.type !== "stdio";
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** A command line for a terminal (PowerShell on Windows, sh elsewhere: single quotes either way). */
export function terminalCommand(agent: OtherAgent, args: string[]): string {
  const q = process.platform === "win32" ? psq : (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [agent, ...args.map((a) => (/^[\w.:/@=-]+$/.test(a) ? a : q(a)))].join(" ");
}

/**
 * Claude's servers another agent could get, with the config to add (server side only):
 * your own (user/local) and the workspace's (.mcp.json) by their full config; claude.ai
 * connectors and plugins' remote servers by URL (the other agent signs in itself).
 */
export async function claudeServersToCopy(root: string): Promise<{ name: string; from: string; config: McpServerConfig }[]> {
  const out: { name: string; from: string; config: McpServerConfig }[] = [];
  const add = (claudeName: string, from: string, raw: any) => {
    const c = raw && typeof raw === "object" ? raw : {};
    const type = String(c.type || (c.url ? "http" : "stdio")).toLowerCase();
    if ((type === "http" || type === "sse") && typeof c.url === "string") out.push({ name: claudeName, from, config: { type, url: c.url, ...(keys(c.headers).length ? { headers: c.headers } : {}) } });
    else if (typeof c.command === "string") out.push({ name: claudeName, from, config: { type: "stdio", command: c.command, args: Array.isArray(c.args) ? c.args.map(String) : [], ...(keys(c.env).length ? { env: c.env } : {}) } });
  };
  let claudeJson: any = {};
  try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonFile(), "utf-8")); } catch {}
  for (const [n, c] of Object.entries<any>(claudeJson.mcpServers || {})) add(n, "user", c);
  const proj = Object.entries<any>(claudeJson.projects || {}).find(([k]) => path.resolve(k).toLowerCase() === path.resolve(root).toLowerCase())?.[1];
  for (const [n, c] of Object.entries<any>(proj?.mcpServers || {})) add(n, "local", c);
  // .mcp.json is the workspace's: Copilot reads it already, Codex doesn't.
  try { for (const [n, c] of Object.entries<any>(JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf-8")).mcpServers || {})) add(n, "workspace", c); } catch {}
  const seen = new Set(out.map((s) => s.name));
  const health = await mcpHealth(root).catch(() => null);
  for (const e of health?.entries || []) {
    if (seen.has(e.name) || !/^https?:\/\//.test(e.target)) continue;
    out.push({ name: e.name, from: /^claude\.ai /i.test(e.name) ? "claude.ai" : "plugin", config: { type: "http", url: e.target } });
  }
  return out;
}

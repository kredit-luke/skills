/**
 * How the dashboard starts `claude`: resolved path, argument quoting and a clean
 * environment. Shared by runs, usage and session listing.
 */

import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * Env vars Claude Code sets on processes it launches, describing *that* session
 * (its id, pid, a messaging socket + token back to it, a child-session marker).
 * A long-lived service started from a Claude session (this dashboard) must not
 * pass them on: a `claude` started with CLAUDE_CODE_CHILD_SESSION set treats itself
 * as a sub-session and turns transcript saving off. User-level config vars
 * (CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK, ...) are deliberately not listed.
 */
export const CLAUDE_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_EFFORT", // the launching session's effort level; would silently become every child's default
];

/**
 * The environment for every `claude` we start:
 *  - no markers of a Claude Code session the dashboard may have been launched
 *    from (CLAUDE_CODE_CHILD_SESSION alone turns transcript saving off, which
 *    breaks resume);
 *  - no ANTHROPIC_API_KEY when this machine is signed in to a Claude subscription,
 *    so a stray key in the shell can't silently switch runs to per-token billing.
 *    When there's no subscription sign-in (the team uses an API key, Bedrock or
 *    Vertex), the key stays: it's how Claude authenticates.
 * User-level config such as CLAUDE_CONFIG_DIR is kept.
 */
export function claudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of CLAUDE_SESSION_ENV) delete env[key];
  if (!authCache || authCache.subscription) delete env.ANTHROPIC_API_KEY;
  return env;
}

// ------------------------------------------------------------------ sign-in state

export interface ClaudeAuth {
  /** `claude` runs on this machine. */
  installed: boolean;
  /** Signed in some way (subscription, API key, cloud provider). */
  loggedIn: boolean;
  /** Signed in to a Claude subscription (claude.ai), not counting an API key in the env. */
  subscription: boolean;
  /** e.g. "claude.ai", "api_key": what `claude auth status` reports. */
  authMethod: string | null;
  apiProvider: string | null;
  checkedAt: number;
}

let authCache: ClaudeAuth | null = null;
let authInflight: Promise<ClaudeAuth> | null = null;
const AUTH_TTL_MS = 60 * 1000;

function authStatus(env: NodeJS.ProcessEnv): Promise<{ installed: boolean; data: any }> {
  return new Promise((resolve) => {
    const child = spawnClaude(["auth", "status"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(timer); resolve({ installed: false, data: null }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let data = null;
      try { data = JSON.parse(out.slice(out.indexOf("{"))); } catch {}
      // A shim that can't find claude exits non-zero with no JSON: not installed.
      resolve({ installed: data !== null || code === 0, data });
    });
  });
}

/**
 * Is Claude Code installed and signed in? `claude auth status` (no model call),
 * cached for a minute. `subscription` is checked with ANTHROPIC_API_KEY removed,
 * so a key in the environment doesn't hide (or fake) a subscription sign-in.
 */
export function claudeAuth(force = false): Promise<ClaudeAuth> {
  if (authCache && !force && Date.now() - authCache.checkedAt < AUTH_TTL_MS) return Promise.resolve(authCache);
  if (!authInflight) {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const key of CLAUDE_SESSION_ENV) delete base[key];
    const withoutKey = { ...base };
    delete withoutKey.ANTHROPIC_API_KEY;
    const asRunP = authStatus(base);
    authInflight = Promise.all([asRunP, base.ANTHROPIC_API_KEY ? authStatus(withoutKey) : asRunP])
      .then(([asRun, noKey]) => {
        const d = asRun.data || {};
        const nk = noKey.data || {};
        authCache = {
          installed: asRun.installed,
          loggedIn: !!d.loggedIn,
          subscription: !!nk.loggedIn && nk.authMethod === "claude.ai",
          authMethod: d.authMethod || null,
          apiProvider: d.apiProvider || null,
          checkedAt: Date.now(),
        };
        return authCache;
      })
      .finally(() => { authInflight = null; });
  }
  return authInflight;
}

/** The last known sign-in state (null until the first check finishes). */
export function claudeAuthCached(): ClaudeAuth | null {
  return authCache;
}

let resolved: { file: string; shim: boolean } | null = null;

/**
 * `claude` is a native binary for the standard installer, but an npm install
 * leaves a .cmd shim on Windows, which spawn() can't run without a shell.
 */
function resolveClaude(): { file: string; shim: boolean } {
  if (resolved) return resolved;
  if (process.platform !== "win32") return (resolved = { file: "claude", shim: false });
  try {
    const hits = execFileSync("where", ["claude"], { encoding: "utf-8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const exe = hits.find((h) => /\.exe$/i.test(h));
    if (exe) return (resolved = { file: exe, shim: false });
    const cmd = hits.find((h) => /\.(cmd|bat)$/i.test(h));
    if (cmd) return (resolved = { file: cmd, shim: true });
  } catch {}
  return (resolved = { file: "claude", shim: false });
}

/** Quote one argument by the MSVCRT rules (what a .cmd shim's node.exe parses). */
function quoteWin(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { slashes++; continue; }
    if (ch === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

/** spawn("claude", args) that works for both the native binary and a Windows .cmd shim. */
export function spawnClaude(args: string[], opts: SpawnOptions): ChildProcess {
  const { file, shim } = resolveClaude();
  if (!shim) return spawn(file, args, opts);
  const line = [file, ...args].map(quoteWin).join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true });
}

/**
 * A claude.ai connector's state from `claude mcp list` output, e.g.
 *   "claude.ai Atlassian: https://mcp.atlassian.com/v1/mcp - ✔ Connected"
 * "absent" means the person's claude.ai account doesn't have that connector at all.
 */
export function connectorState(listOutput: string, name: string): { state: "connected" | "disabled" | "signed-out" | "absent"; text: string } {
  const prefix = `claude.ai ${name}:`.toLowerCase();
  const line = listOutput.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().startsWith(prefix));
  if (!line) return { state: "absent", text: "" };
  const text = line.replace(/^.*? - /, "").replace(/^[^\p{L}]+/u, "").trim();
  if (/\bconnected\b/i.test(text) && !/not connected|failed/i.test(text)) return { state: "connected", text };
  if (/disabled/i.test(text)) return { state: "disabled", text };
  return { state: "signed-out", text };
}

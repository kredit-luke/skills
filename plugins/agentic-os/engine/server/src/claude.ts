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
 *  - no ANTHROPIC_API_KEY, so a stray key in the shell can't silently switch runs
 *    from the subscription to per-token billing.
 * User-level config such as CLAUDE_CONFIG_DIR is kept.
 */
export function claudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of CLAUDE_SESSION_ENV) delete env[key];
  delete env.ANTHROPIC_API_KEY;
  return env;
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

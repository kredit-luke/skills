/**
 * Signing in to an MCP server from the page, with no terminal window: works the same
 * locally and hosted (hosted.ts), where the person's browser isn't on the dashboard's machine.
 *
 * `claude mcp login <name> --no-browser` only signs in on a terminal (with plain pipes it
 * says "stdin isn't a terminal" and never finishes), so it runs under `script`, which gives
 * it a pseudo-terminal (util-linux on Linux, BSD on macOS; no packages to add). It prints
 * an authorization URL, listens on http://localhost:<port>/callback, and also prompts
 * "Or paste the redirect URL here:". The page shows the URL; the person signs in in their
 * own browser. Locally, the browser comes back to that callback and the CLI finishes.
 * Hosted, "localhost" in the browser is the person's own computer, so the last page
 * doesn't load: they paste its address into the page, and it's typed at the CLI's prompt
 * (only an address on the port and path the CLI's own URL named).
 *
 * claude.ai connectors sign in on claude.ai instead: the CLI prints a claude.ai link and
 * exits, so there's nothing to paste; the page re-checks when they come back.
 *
 * Windows has no `script`: there, sign-in opens a terminal window (machine.ts openTerminal),
 * which is fine since a Windows dashboard is always local.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { McpLoginStart, McpLoginStatus } from "../../shared/api.ts";
import { claudeEnv, claudeFile } from "./claude.ts";

const URL_WAIT_MS = 30_000;
const FINISH_WAIT_MS = 30_000;
/** An unfinished sign-in is dropped after this long. */
const PENDING_MS = 10 * 60_000;

type Spawn = (args: string[]) => ChildProcess;

/** Drop terminal escapes (the URL comes wrapped in an OSC 8 hyperlink; a PTY adds colours and \r). */
export function stripEscapes(s: string): string {
  return s.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x07\r]/g, "");
}

/** The authorization URL in the CLI's output, and the loopback callback it sends the browser back to. */
export function findLoginUrl(out: string): McpLoginStart | null {
  const urls = stripEscapes(out).match(/https?:\/\/[^\s"'<>]+/g) || [];
  const url = urls.find((u) => /redirect_uri=/.test(u)) || urls.find((u) => /^https:\/\//.test(u) && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u));
  if (!url) return null;
  let callback: string | null = null;
  try {
    const r = new URL(url).searchParams.get("redirect_uri");
    if (r) {
      const cb = new URL(r);
      if (cb.protocol === "http:" && isLoopback(cb.hostname)) callback = cb.toString();
    }
  } catch {}
  return { url, callback };
}

const isLoopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";

/**
 * The address the person pasted, checked against the callback the CLI is waiting on:
 * same port and path, a loopback host, and a code or an error from the provider.
 */
export function callbackTarget(pasted: string, callback: string): URL {
  let got: URL;
  try { got = new URL(String(pasted || "").trim()); } catch { throw new Error("Paste the whole address from the browser's address bar (it starts with http://localhost)."); }
  const want = new URL(callback);
  if (got.protocol !== "http:" || !isLoopback(got.hostname) || got.port !== want.port || got.pathname !== want.pathname) {
    throw new Error(`That isn't the address sign-in ended on. It should start with ${want.origin}${want.pathname}.`);
  }
  if (!got.searchParams.get("code") && !got.searchParams.get("error")) throw new Error("That address has no sign-in code in it. Copy it from the address bar after signing in.");
  return got;
}

/** POSIX single quotes, for the command line `script -c` hands to sh. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `claude <args>` under a pseudo-terminal: `script` (Linux: -c "cmd"; macOS: the command as arguments). */
export function scriptArgs(platform: string, file: string, args: string[]): [string, string[]] {
  if (platform === "darwin") return ["script", ["-q", "/dev/null", file, ...args]];
  return ["script", ["-qfec", [file, ...args].map(shQuote).join(" "), "/dev/null"]];
}

/** Sign-in from the page needs `script`; Windows doesn't have it (its dashboard is always local: use a terminal). */
export const PTY_SIGN_IN = process.platform !== "win32";

interface Pending {
  child: ChildProcess;
  out: string;
  exit: Promise<number | null>;
  code: number | null | undefined;
  start: McpLoginStart | null;
  expiry: NodeJS.Timeout;
}

export class McpLogin {
  private pending = new Map<string, Pending>();
  private spawn: Spawn;

  constructor(cwd: string, opts: { spawn?: Spawn } = {}) {
    this.spawn = opts.spawn || ((args) => {
      const [cmd, argv] = scriptArgs(process.platform, claudeFile(), args);
      return spawn(cmd, argv, { cwd, env: { ...claudeEnv(), TERM: "dumb", COLUMNS: "1000" }, stdio: ["pipe", "pipe", "pipe"] });
    });
  }

  /** Start signing in to `name` (dropping an unfinished one) and return the page to open. */
  async start(name: string): Promise<McpLoginStart> {
    this.cancel(name);
    const child = this.spawn(["mcp", "login", name, "--no-browser"]);
    const p: Pending = {
      child, out: "", code: undefined, start: null,
      exit: new Promise((resolve) => { child.on("error", () => resolve(null)); child.on("close", (c) => resolve(c)); }),
      expiry: setTimeout(() => this.cancel(name), PENDING_MS),
    };
    p.exit.then((c) => { p.code = c; });
    const onData = (d: Buffer) => { p.out += d.toString(); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => {}); // the CLI may exit before a write lands
    this.pending.set(name, p);

    const deadline = Date.now() + URL_WAIT_MS;
    while (Date.now() < deadline) {
      const found = findLoginUrl(p.out);
      if (found) { p.start = found; return found; }
      if (p.code !== undefined) break; // exited without a URL
      await new Promise((r) => setTimeout(r, 100));
    }
    const said = lastLines(p.out);
    this.cancel(name);
    throw Object.assign(new Error(`Claude didn't give a sign-in address${said ? `: ${said}` : "."}`), { status: 400 });
  }

  /** Where a sign-in stands: still waiting, or finished (ok or not). */
  status(name: string): McpLoginStatus {
    const p = this.pending.get(name);
    if (!p) return { pending: false, done: false, ok: false, message: "No sign-in is waiting." };
    if (p.code === undefined) return { pending: true, done: false, ok: false, message: "Waiting for you to finish in the browser." };
    return this.result(name, p);
  }

  /** Type the address the browser ended on at the CLI's "paste the redirect URL" prompt, and wait for it to finish. */
  async finish(name: string, pasted: string): Promise<McpLoginStatus> {
    const p = this.pending.get(name);
    if (!p) return { pending: false, done: false, ok: false, message: "No sign-in is waiting. Start again." };
    if (p.code !== undefined) return this.result(name, p);
    if (!p.start?.callback) return { pending: true, done: false, ok: false, message: "This one finishes in the browser; there's no address to paste." };
    const target = callbackTarget(pasted, p.start.callback);
    if (!p.child.stdin || p.child.stdin.destroyed) return { pending: true, done: false, ok: false, message: "The sign-in isn't waiting for an address any more. Start again." };
    p.child.stdin.write(target.toString() + "\r");
    const code = await Promise.race([p.exit, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), FINISH_WAIT_MS))]);
    if (code === "timeout") { this.cancel(name); return { pending: false, done: true, ok: false, message: "Claude didn't finish the sign-in. Start again." }; }
    return this.result(name, p);
  }

  cancel(name: string) {
    const p = this.pending.get(name);
    if (!p) return;
    this.pending.delete(name);
    clearTimeout(p.expiry);
    if (p.child.exitCode === null) p.child.kill();
  }

  cancelAll() {
    for (const name of [...this.pending.keys()]) this.cancel(name);
  }

  private result(name: string, p: Pending): McpLoginStatus {
    this.pending.delete(name);
    clearTimeout(p.expiry);
    const said = lastLines(p.out, 1);
    // claude.ai connectors: the CLI only hands out the link; the sign-in happens on claude.ai.
    if (p.code === 0 && p.start && !p.start.callback) return { pending: false, done: true, ok: true, message: "Finish connecting it on claude.ai, then come back here." };
    if (p.code === 0) return { pending: false, done: true, ok: true, message: `Signed in to ${name}.` };
    return { pending: false, done: true, ok: false, message: said ? `Sign-in failed: ${said}` : "Sign-in failed. Start again." };
  }
}

function lastLines(out: string, n = 2): string {
  return stripEscapes(out).split(/\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[") && !/https?:\/\//.test(l) && !/^(Visit this URL|If the browser|Waiting for|Or paste|Starting authentication)/i.test(l))
    .slice(-n).join(" ").slice(0, 300);
}

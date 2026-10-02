/**
 * Claude sign-in from the page, for a dashboard with no terminal or browser of its own
 * (hosted mode). Runs `claude auth login --claudeai` with plain pipes: with no browser to
 * open and no local callback a browser could reach, the CLI prints a sign-in URL and
 * waits at "Paste code here if prompted". The person opens the URL in their own
 * browser, signs in, and pastes the code the page shows them back into the dashboard,
 * which types it into the waiting CLI.
 *
 * The login lands in the CLI's own credentials file (under CLAUDE_CONFIG_DIR), so it
 * gives everything a `claude /login` does, claude.ai connectors included. (A
 * `claude setup-token` token can only make model requests, so it's not used.)
 */

import type { ChildProcess } from "node:child_process";
import { claudeAuth, claudeEnv, spawnClaude } from "./claude.ts";

const URL_RE = /https:\/\/\S+\/oauth\/authorize\?\S+/;
const URL_WAIT_MS = 30_000;
const CODE_WAIT_MS = 45_000;
/** An unfinished sign-in is dropped after this long (the CLI's own state would be stale anyway). */
const PENDING_MS = 15 * 60_000;

export interface LoginStart { url: string }
export interface LoginResult { ok: boolean; message: string }

export class ClaudeLogin {
  private child: ChildProcess | null = null;
  private out = "";
  private exit: Promise<number | null> | null = null;
  private expiry: NodeJS.Timeout | null = null;

  /** Start a sign-in (dropping any unfinished one) and return the URL to open. */
  async start(email?: string | null): Promise<LoginStart> {
    this.cancel();
    const args = ["auth", "login", "--claudeai", ...(email ? ["--email", email] : [])];
    const child = spawnClaude(args, { env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.out = "";
    const onData = (d: Buffer) => { this.out += d.toString(); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    this.exit = new Promise((resolve) => {
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
    this.exit.then(() => { if (this.child === child) this.clear(); });
    this.expiry = setTimeout(() => this.cancel(), PENDING_MS);

    const deadline = Date.now() + URL_WAIT_MS;
    while (Date.now() < deadline) {
      const m = this.out.replace(/\s+/g, " ").match(URL_RE);
      if (m) return { url: m[0] };
      if (this.child !== child) break; // exited (or replaced) before printing a URL
      await new Promise((r) => setTimeout(r, 100));
    }
    const said = this.out.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
    this.cancel();
    throw new Error(`Claude didn't give a sign-in address${said ? `: ${said}` : ". Is Claude Code installed?"}`);
  }

  /** Type the code from the sign-in page into the waiting CLI and report how it went. */
  async finish(code: string): Promise<LoginResult> {
    const child = this.child, exit = this.exit;
    if (!child || !exit || !child.stdin) return { ok: false, message: "No sign-in is waiting. Start again." };
    const clean = String(code || "").trim();
    if (!clean || clean.length > 1000 || /\s/.test(clean)) return { ok: false, message: "That doesn't look like a sign-in code. Copy the whole code from the sign-in page." };
    const before = this.out.length;
    child.stdin.write(clean + "\n");
    const code_ = await Promise.race([exit, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), CODE_WAIT_MS))]);
    const said = this.out.slice(before).trim().split(/\r?\n/).filter(Boolean).pop() || "";
    if (code_ === "timeout") { this.cancel(); return { ok: false, message: "Claude didn't finish the sign-in. Start again." }; }
    if (code_ !== 0) return { ok: false, message: said ? `Sign-in failed: ${said.slice(0, 300)}` : "Sign-in failed. Start again and use the newest code." };
    await claudeAuth(true).catch(() => {});
    return { ok: true, message: "Signed in to Claude." };
  }

  cancel() {
    const child = this.child;
    this.clear();
    if (child && child.exitCode === null) child.kill();
  }

  private clear() {
    if (this.expiry) clearTimeout(this.expiry);
    this.child = null;
    this.exit = null;
    this.expiry = null;
  }
}

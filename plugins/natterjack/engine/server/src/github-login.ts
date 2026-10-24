/**
 * GitHub sign-in from the page, for a dashboard with no terminal of its own (hosted mode),
 * so a person's runs can push branches and open pull requests as them.
 *
 * Runs `gh auth login --web` with plain pipes. Without a terminal, gh uses GitHub's device
 * flow and doesn't wait for Enter: it prints a one-time code and https://github.com/login/device,
 * then polls GitHub until the person enters the code there in their own browser. Nothing calls
 * back into the dashboard, so it works behind any proxy, and no OAuth app of the team's own is
 * needed (it's the GitHub CLI's; an organization that restricts OAuth apps approves it once).
 *
 * When gh finishes, `gh auth setup-git` makes git use the token for https remotes, and the
 * commit identity is set: the person's GitHub name, and the dashboard owner's email (the
 * proxy's) or else their GitHub noreply address. All of it lands in gh's config and git's
 * global config, which the hosted image keeps on the volume (GH_CONFIG_DIR, GIT_CONFIG_GLOBAL).
 *
 * Hosted, commits are signed too, so GitHub shows them as Verified like ones made on a laptop
 * with a signing key: the sign-in asks for `admin:ssh_signing_key`, an ed25519 key is made
 * beside gh's config (once; restarts reuse it), added to the person's account as a signing key,
 * and git signs with it (gpg.format ssh). Signing out removes the key from their account. A
 * local dashboard never touches the machine's own signing setup.
 */

import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GithubLoginStatus } from "../../shared/api.ts";

export const GITHUB_HOST = "github.com";
const CODE_WAIT_MS = 30_000;
/** GitHub's device codes last 15 minutes; an unfinished sign-in is dropped then. */
const PENDING_MS = 15 * 60_000;
const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const DEVICE_URL_RE = /https:\/\/\S+\/login\/device\b/;

/** Pinned for an image or a test (a `.mjs` runs with this Node), else the command from PATH. */
function pinnedCommand(envVar: string, name: string, args: string[]): [string, string[]] {
  const pinned = (process.env[envVar] || "").trim();
  if (/\.m?js$/i.test(pinned)) return [process.execPath, [pinned, ...args]];
  return [pinned || name, args];
}
const ghCommand = (args: string[]) => pinnedCommand("DASHBOARD_GH_BIN", "gh", args);

export function spawnGh(args: string[], opts: SpawnOptions): ChildProcess {
  const [file, argv] = ghCommand(args);
  return spawn(file, argv, opts);
}

function ghEnv(): NodeJS.ProcessEnv {
  // No prompts, no colours to strip, and never open a browser on the server.
  return { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_BROWSER: "true", BROWSER: "true" };
}

function exec(file: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: ghEnv(), timeout, windowsHide: true, maxBuffer: 1 << 20 }, (e, out, err) => resolve({ ok: !e, out: String(out || ""), err: String(err || "") }));
  });
}
const gh = (args: string[]) => exec(...ghCommand(args));
const said = (r: { out: string; err: string }) => (r.err || r.out).trim().slice(0, 300);

/** The commit-signing key: beside gh's own config, so it's on the volume with the token. */
export function signingKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.GH_CONFIG_DIR || path.join(os.homedir(), ".config", "gh"), "signing_ed25519");
}

/** The key's title on GitHub, so the person can tell which dashboard it belongs to. */
export function signingKeyTitle(env: NodeJS.ProcessEnv = process.env): string {
  let host = "";
  try { host = new URL(env.DASHBOARD_PUBLIC_URL || "").host; } catch {}
  return `Natterjack dashboard (${host || os.hostname()})`;
}

/** The type and key fields of an OpenSSH public key line, which is how GitHub lists it (no comment). */
export const keyBody = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(" ");

/** The signed-in account in `gh auth status` output ("Logged in to github.com account ana (…)"). */
export function statusAccount(text: string): string | null {
  const m = text.match(/Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}

/** The commit identity for a GitHub user: their name (else login), and the given email or their noreply address. */
export function commitIdentity(user: { login: string; id: number; name?: string | null }, email?: string | null) {
  return { name: (user.name || "").trim() || user.login, email: email || `${user.id}+${user.login}@users.noreply.github.com` };
}

/**
 * Whether a hosted dashboard that no longer offers the GitHub sign-in should sign out at startup.
 * Only when gh and git's global config are this engine's own (GH_CONFIG_DIR, GIT_CONFIG_GLOBAL, as
 * the hosted image sets them): otherwise `gh auth logout` and `git config --global --unset` would
 * sign the developer's own computer out of GitHub and turn off its commit signing. `skipped` says
 * why it didn't, when that's worth a log line (hosted, no sign-in offered, but not its own config).
 */
export function shouldSignOutAtStartup(opts: { hosted: boolean; offersGithubSignIn: boolean; env: NodeJS.ProcessEnv }): { signOut: boolean; skipped?: string } {
  if (!opts.hosted || opts.offersGithubSignIn) return { signOut: false };
  const missing = ["GH_CONFIG_DIR", "GIT_CONFIG_GLOBAL"].filter((k) => !(opts.env[k] || "").trim());
  if (missing.length) return { signOut: false, skipped: `Not signing out of GitHub at startup: this engine has no ${missing.join(" or ")} of its own.` };
  return { signOut: true };
}

export class GithubLogin {
  /** Sign commits with a key of the dashboard's own (hosted only). */
  private readonly signing: boolean;
  private child: ChildProcess | null = null;
  private out = "";
  private expiry: NodeJS.Timeout | null = null;
  private state: GithubLoginStatus = { state: "idle" };
  /** Bumped by every start and cancel: a finish that outlived its sign-in checks it and stops. */
  private gen = 0;
  /**
   * The finish or sign-out in flight. A cancel only stops a finish at its next step, so a new
   * sign-in and a sign-out wait for it: a sign-out's cleanup can't run beside a key upload or a
   * git config write, and can't undo the setup of a sign-in that started after it.
   */
  private busy: Promise<void> = Promise.resolve();

  constructor(opts: { signing?: boolean } = {}) {
    this.signing = !!opts.signing;
  }

  /** Start a sign-in (dropping any unfinished one) and return the code to enter on GitHub. */
  async start(email?: string | null): Promise<GithubLoginStatus> {
    this.cancel();
    await this.busy;
    this.cancel(); // another start may have begun while this one waited: only the newest runs
    const gen = this.gen;
    // `workflow` too: without it GitHub refuses a push that touches .github/workflows. Signing
    // needs `admin:ssh_signing_key` to add the key (and remove it on sign-out).
    const scopes = ["workflow", ...(this.signing ? ["admin:ssh_signing_key"] : [])].join(",");
    const args = ["auth", "login", "--hostname", GITHUB_HOST, "--git-protocol", "https", "--web", "--skip-ssh-key", "--insecure-storage", "--scopes", scopes];
    const child = spawnGh(args, { env: ghEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.out = "";
    const onData = (d: Buffer) => { this.out += d.toString(); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // A gh that asks for Enter before polling (it shouldn't without a terminal) gets one.
    child.stdin?.end("\n");
    child.on("error", (e) => { if (this.child === child) this.fail(`Couldn't run the GitHub CLI: ${e.message}`); });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.busy = this.finished(code, email, gen).catch((e) => {
        if (gen === this.gen) this.fail(`Sign-in failed: ${(e && e.message) || e}`);
      });
    });
    this.expiry = setTimeout(() => { this.cancel(); this.state = { state: "failed", message: "The code expired. Start again." }; }, PENDING_MS);
    this.state = { state: "starting" };

    const deadline = Date.now() + CODE_WAIT_MS;
    while (Date.now() < deadline && this.child === child) {
      const code = this.out.match(CODE_RE);
      if (code) {
        const url = (this.out.match(DEVICE_URL_RE) || [`https://${GITHUB_HOST}/login/device`])[0];
        this.state = { state: "pending", code: code[1].toUpperCase(), url };
        return this.state;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.state.state === "failed") throw new Error(this.state.message);
    const said = this.lastLine();
    this.cancel();
    throw new Error(`GitHub didn't give a sign-in code${said ? `: ${said}` : ". Is the GitHub CLI installed?"}`);
  }

  status(): GithubLoginStatus { return this.state; }

  cancel() {
    const child = this.child;
    this.gen++;
    this.clear();
    this.state = { state: "idle" };
    if (child && child.exitCode === null) child.kill();
  }

  /** Sign out of github.com (the token is deleted; git falls back to whatever else it has). */
  async logout(): Promise<{ ok: boolean; message: string }> {
    this.cancel();
    await this.busy;
    const run = (async () => {
      // While the token still works: take the signing key off their account, and stop signing
      // (a commit signed with a key GitHub doesn't know shows as Unverified, worse than unsigned).
      if (this.signing) await this.removeSigningKey().catch(() => {});
      return gh(["auth", "logout", "--hostname", GITHUB_HOST]);
    })();
    this.busy = run.then(() => {}, () => {});
    const r = await run;
    const last = (r.err || r.out).trim().split(/\r?\n/).pop() || "";
    return r.ok ? { ok: true, message: "Signed out of GitHub." } : { ok: false, message: `Couldn't sign out${last ? `: ${last.slice(0, 300)}` : "."}` };
  }

  private async finished(code: number | null, email: string | null | undefined, gen: number) {
    this.clear();
    if (code !== 0) return this.fail(this.lastLine() ? `Sign-in failed: ${this.lastLine()}` : "Sign-in failed. Start again.");
    this.state = { state: "finishing" };
    // A cancel or a new start while this awaits makes it stale: it must not touch git's config or the state.
    const stale = () => gen !== this.gen;

    const setup = await gh(["auth", "setup-git", "--hostname", GITHUB_HOST]);
    if (stale()) return;
    if (!setup.ok) return this.fail(`Signed in, but git couldn't be set up to use it: ${said(setup)}`);

    const me = await gh(["api", "user"]);
    if (stale()) return;
    let user: { login: string; id: number; name?: string | null } | null = null;
    try { user = JSON.parse(me.out); } catch {}
    if (!me.ok || !user || typeof user.login !== "string" || typeof user.id !== "number") {
      return this.fail(`Signed in, but GitHub didn't say who you are, so the commit name and email aren't set${me.ok ? "" : `: ${said(me)}`}. Sign out and in again.`);
    }
    const who = commitIdentity(user, email);
    for (const [key, value] of [["user.name", who.name], ["user.email", who.email]]) {
      const r = await exec("git", ["config", "--global", key, value]);
      if (stale()) return;
      if (!r.ok) return this.fail(`Signed in as @${user.login}, but git's ${key} couldn't be set: ${said(r)}`);
    }
    if (this.signing) {
      const why = await this.setupSigning(stale);
      if (why === "stale") return;
      if (why) return this.fail(`Signed in as @${user.login}, but commits won't be signed: ${why}. Sign out and in again.`);
    }
    this.state = { state: "done", login: user.login, message: `Signed in to GitHub as @${user.login}.` };
  }

  /** Make the signing key (once), add it to the person's account and sign with it. null = done, else why not. */
  private async setupSigning(stale: () => boolean): Promise<string | null> {
    const key = signingKeyPath(), title = signingKeyTitle();
    if (!fs.existsSync(key) || !fs.existsSync(key + ".pub")) {
      try {
        fs.mkdirSync(path.dirname(key), { recursive: true });
        fs.rmSync(key, { force: true });
        fs.rmSync(key + ".pub", { force: true });
      } catch (e: any) {
        return `the key's folder ${path.dirname(key)} can't be written (${e.code || e.message})`;
      }
      const r = await exec(...pinnedCommand("DASHBOARD_SSH_KEYGEN_BIN", "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", title, "-f", key]));
      if (stale()) return "stale";
      if (!r.ok || !fs.existsSync(key + ".pub")) return `the key couldn't be made${said(r) ? ` (${said(r)})` : ""}`;
    }
    // Already on the account (a sign-in after a restart): gh says so, which is fine.
    const add = await gh(["ssh-key", "add", key + ".pub", "--type", "signing", "--title", title]);
    if (stale()) return "stale";
    if (!add.ok && !/already/i.test(add.err + add.out)) return `GitHub didn't take the signing key (${said(add)})`;
    for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", key], ["commit.gpgsign", "true"], ["tag.gpgsign", "true"]]) {
      const r = await exec("git", ["config", "--global", k, v]);
      if (stale()) return "stale";
      if (!r.ok) return `git's ${k} couldn't be set (${said(r)})`;
    }
    return null;
  }

  /** Take this dashboard's signing key off the account, and stop signing. Best effort: sign-out goes on regardless. */
  private async removeSigningKey() {
    await exec("git", ["config", "--global", "--unset", "commit.gpgsign"]);
    await exec("git", ["config", "--global", "--unset", "tag.gpgsign"]);
    let mine = "";
    try { mine = keyBody(fs.readFileSync(signingKeyPath() + ".pub", "utf8")); } catch { return; }
    // Every page (gh api doesn't paginate by itself): --slurp makes it one array of pages.
    const list = await gh(["api", "--paginate", "--slurp", "user/ssh_signing_keys"]);
    let pages: unknown = [];
    try { pages = JSON.parse(list.out); } catch {}
    const keys = (Array.isArray(pages) ? pages : []).flat() as { id: number; key: string }[];
    for (const k of keys) {
      if (k && typeof k.key === "string" && keyBody(k.key) === mine) await gh(["api", "-X", "DELETE", `user/ssh_signing_keys/${k.id}`]);
    }
  }

  private fail(message: string) {
    this.clear();
    this.state = { state: "failed", message };
  }

  private lastLine(): string {
    return this.out.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) || "";
  }

  private clear() {
    if (this.expiry) clearTimeout(this.expiry);
    this.child = null;
    this.expiry = null;
  }
}

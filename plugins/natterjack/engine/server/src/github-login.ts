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
 */

import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { GithubLoginStatus } from "../../shared/api.ts";

export const GITHUB_HOST = "github.com";
const CODE_WAIT_MS = 30_000;
/** GitHub's device codes last 15 minutes; an unfinished sign-in is dropped then. */
const PENDING_MS = 15 * 60_000;
const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const DEVICE_URL_RE = /https:\/\/\S+\/login\/device\b/;

/** Pinned for an image or a test (a `.mjs` runs with this Node), else gh from PATH. */
function ghCommand(args: string[]): [string, string[]] {
  const pinned = (process.env.DASHBOARD_GH_BIN || "").trim();
  if (/\.m?js$/i.test(pinned)) return [process.execPath, [pinned, ...args]];
  return [pinned || "gh", args];
}

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

/** The signed-in account in `gh auth status` output ("Logged in to github.com account ana (…)"). */
export function statusAccount(text: string): string | null {
  const m = text.match(/Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/);
  return m ? m[1] : null;
}

/** The commit identity for a GitHub user: their name (else login), and the given email or their noreply address. */
export function commitIdentity(user: { login: string; id: number; name?: string | null }, email?: string | null) {
  return { name: (user.name || "").trim() || user.login, email: email || `${user.id}+${user.login}@users.noreply.github.com` };
}

export class GithubLogin {
  private child: ChildProcess | null = null;
  private out = "";
  private expiry: NodeJS.Timeout | null = null;
  private state: GithubLoginStatus = { state: "idle" };

  /** Start a sign-in (dropping any unfinished one) and return the code to enter on GitHub. */
  async start(email?: string | null): Promise<GithubLoginStatus> {
    this.cancel();
    // `workflow` too: without it GitHub refuses a push that touches .github/workflows.
    const args = ["auth", "login", "--hostname", GITHUB_HOST, "--git-protocol", "https", "--web", "--skip-ssh-key", "--insecure-storage", "--scopes", "workflow"];
    const child = spawnGh(args, { env: ghEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.out = "";
    const onData = (d: Buffer) => { this.out += d.toString(); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // A gh that asks for Enter before polling (it shouldn't without a terminal) gets one.
    child.stdin?.end("\n");
    child.on("error", (e) => { if (this.child === child) this.fail(`Couldn't run the GitHub CLI: ${e.message}`); });
    child.on("close", (code) => { if (this.child === child) this.finished(code, email); });
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
    this.clear();
    this.state = { state: "idle" };
    if (child && child.exitCode === null) child.kill();
  }

  /** Sign out of github.com (the token is deleted; git falls back to whatever else it has). */
  async logout(): Promise<{ ok: boolean; message: string }> {
    this.cancel();
    const r = await gh(["auth", "logout", "--hostname", GITHUB_HOST]);
    const said = (r.err || r.out).trim().split(/\r?\n/).pop() || "";
    return r.ok ? { ok: true, message: "Signed out of GitHub." } : { ok: false, message: `Couldn't sign out${said ? `: ${said.slice(0, 300)}` : "."}` };
  }

  private async finished(code: number | null, email?: string | null) {
    this.clear();
    if (code !== 0) return this.fail(this.lastLine() ? `Sign-in failed: ${this.lastLine()}` : "Sign-in failed. Start again.");
    this.state = { state: "finishing" };
    const setup = await gh(["auth", "setup-git", "--hostname", GITHUB_HOST]);
    if (!setup.ok) return this.fail(`Signed in, but git couldn't be set up to use it: ${(setup.err || setup.out).trim().slice(0, 300)}`);
    let login: string | null = null;
    const me = await gh(["api", "user"]);
    try {
      const user = JSON.parse(me.out);
      login = user.login;
      const who = commitIdentity(user, email);
      await exec("git", ["config", "--global", "user.name", who.name]);
      await exec("git", ["config", "--global", "user.email", who.email]);
    } catch {}
    this.state = { state: "done", login, message: login ? `Signed in to GitHub as @${login}.` : "Signed in to GitHub." };
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

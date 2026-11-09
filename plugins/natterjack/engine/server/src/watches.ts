/**
 * Watches (loops): the server half of a run's <<WATCH>> block (parsed in runs.ts).
 *
 * A headless turn can't keep a loop alive, so instead of /loop Claude ends its turn
 * with a watch block and the dashboard does the waiting. Every TICK_MS this looks at
 * the due watches and, when it's time, replies to the run: a new turn on the same
 * session, with what happened and the watch's prompt. By kind:
 *  - github-pr: checks the PRs with gh (no tokens) and wakes only when something worth
 *    acting on changed. Ends when every PR is merged or closed.
 *  - every: wakes on a fixed interval (the dashboard's /loop).
 *  - check: runs a command (bash, in the run's folder; no tokens) and wakes when its output
 *    or exit code changes, or once when it exits 0 (until: "success", which then ends it).
 *    Nothing runs until you approve the command, unless deck.json loops.allowCommands
 *    allows it.
 *
 * A watch only checks while its run is idle and done (status "succeeded"): a running
 * turn, an open question, a failure or a cancel pause it. It ends when it expires,
 * after MAX_WAKES wake-ups, or when you (Stop watching) or Claude (a stop block) end it.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { CheckResult, PrSnapshot, RunWatch, WatchedPr } from "../../shared/api.ts";
import { formatMinutes } from "../../shared/loops.ts";
import { endWatch, watchActive, type RunManager } from "./runs.ts";
import { rollupState } from "./inbox.ts";

const TICK_MS = 30 * 1000;
const MAX_WAKES = 100;
/** After a wake-up couldn't start (run limits), try again this soon. */
const RETRY_MS = 60 * 1000;
const LOGIN_TTL_MS = 60 * 60 * 1000;
/** A check's command gets this long, and this much of its output is kept and compared. */
const CHECK_TIMEOUT_MS = 60 * 1000;
const CHECK_OUTPUT_MAX = 4000;

/** Runs gh and resolves with its stdout. */
export type Gh = (args: string[]) => Promise<string>;

const defaultGh: Gh = (args) => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error((stderr || err.message).trim().split("\n")[0]));
    resolve(String(stdout || ""));
  });
});

/** Runs a check's command in a folder; rejects only when it couldn't run at all. */
export type RunCommand = (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;

/**
 * The bash checks run with: Git Bash on Windows (never the WSL launcher in System32, which
 * would run it in another system), bash elsewhere. Null when there's none.
 */
export function findBash(env: NodeJS.ProcessEnv = process.env, exists = fs.existsSync): string | null {
  if (process.platform !== "win32") return exists("/bin/bash") ? "/bin/bash" : exists("/usr/bin/bash") ? "/usr/bin/bash" : null;
  const candidates: string[] = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of String(env.PATH || env.Path || "").split(";").filter(Boolean)) {
    if (exists(path.join(dir, "git.exe"))) candidates.push(path.join(dir, "..", "bin", "bash.exe"), path.join(dir, "..", "..", "bin", "bash.exe"));
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]) {
    if (root) candidates.push(path.join(root, "Git", "bin", "bash.exe"));
  }
  return candidates.find((c) => exists(c)) || null;
}

/** Stop a check's whole process tree: bash and anything it started (which could hold the output pipes open). */
function killCheckTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  // Its own process group (spawned detached): TERM the group, then KILL whatever ignored it.
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 2000).unref();
}

/**
 * A runner that gives each command `timeoutMs`. On timeout it settles at once (the watch isn't
 * left busy waiting on pipes a leftover process holds), stops the whole tree and drops the pipes.
 */
export function makeRunCommand(timeoutMs = CHECK_TIMEOUT_MS): RunCommand {
  return (command, cwd) => new Promise((resolve, reject) => {
    const bash = findBash();
    if (!bash) return reject(new Error(process.platform === "win32" ? "Git Bash wasn't found (install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH)." : "bash wasn't found."));
    let out = "";
    let settled = false;
    const child = spawn(bash, ["-c", command], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const keep = (d: Buffer) => { out = (out + d.toString("utf-8")).slice(-CHECK_OUTPUT_MAX * 2); };
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killCheckTree(child);
      child.stdout!.destroy();
      child.stderr!.destroy();
      reject(new Error(`The command didn't finish within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? 0, output: out.trim().slice(-CHECK_OUTPUT_MAX) });
    });
  });
}

const defaultRunCommand: RunCommand = makeRunCommand();

/**
 * Whether deck.json `loops.allowCommands` allows a check's command without asking: each
 * entry is a regular expression the whole command must match. A bad pattern allows nothing.
 */
export function commandAllowed(command: string, patterns: unknown): boolean {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => {
    try { return new RegExp(`^(?:${String(p)})$`).test(command); } catch { return false; }
  });
}

export interface WatcherOptions {
  gh?: Gh;
  runCommand?: RunCommand;
  /** A check's command runs without your approval when this says so (deck.json loops.allowCommands). */
  allowCommand?: (command: string) => boolean;
  /** Start a turn on the run with this text. Returns null when it started, else why it couldn't. */
  wake: (runId: string, text: string) => string | null;
}

export class Watcher {
  runs: RunManager;
  gh: Gh;
  runCommand: RunCommand;
  allowCommand: (command: string) => boolean;
  wake: WatcherOptions["wake"];
  timer: ReturnType<typeof setInterval> | null = null;
  private _busy = new Set<string>();
  private _login: { login: string; at: number } | null = null;

  constructor(runs: RunManager, opts: WatcherOptions) {
    this.runs = runs;
    this.gh = opts.gh || defaultGh;
    this.runCommand = opts.runCommand || defaultRunCommand;
    this.allowCommand = opts.allowCommand || (() => false);
    this.wake = opts.wake;
  }

  start() {
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()) {
    const due = this.runs.list().filter((r) => watchActive(r) && !this._busy.has(r.id));
    await Promise.all(due.map((r) => this.check(r.id, now)));
  }

  /** One check of one run's watch, if it's due. */
  async check(id: string, now = new Date()): Promise<void> {
    const meta = this.runs.get(id);
    if (!meta || !watchActive(meta) || this._busy.has(id)) return;
    const w = meta.watch!;
    if (Date.parse(w.expiresAt) <= now.getTime()) {
      const what = w.kind === "github-pr" ? "the PRs still need it" : "it's still needed";
      this.runs.updateWatch(id, w.startedAt, (_, m) => endWatch(m, `The watch expired. Start a new one if ${what}.`, now));
      return;
    }
    if (this.runs.live.has(id) || meta.status !== "succeeded") return;
    // A check waiting for approval: deck.json may allow its command; otherwise nothing runs.
    if (w.kind === "check" && w.approval !== "approved") {
      if (!w.command || !this.allowCommand(w.command)) return;
      this.runs.updateWatch(id, w.startedAt, (x) => { x.approval = "approved"; });
    }
    if (Date.parse(w.nextCheckAt) > now.getTime()) return;

    this._busy.add(id);
    try {
      if (w.kind === "every") this.checkEvery(id, w, now);
      else if (w.kind === "check") await this.checkCommand(id, meta.cwd, w, now);
      else await this.checkPrs(id, w, now);
    } finally {
      this._busy.delete(id);
    }
  }

  /**
   * Wake the run with `text`. When it can't start (run limits), `undo` puts the watch back
   * as it was so the same wake-up happens on the retry. Returns whether it started.
   */
  private _wake(id: string, w: RunWatch, now: Date, text: string, undo: (x: RunWatch) => void): boolean {
    const blocked = this.wake(id, text);
    if (!blocked) return true;
    this.runs.updateWatch(id, w.startedAt, (x) => {
      undo(x);
      x.wakes -= 1;
      x.error = `Couldn't wake the run: ${blocked}`;
      x.nextCheckAt = new Date(now.getTime() + RETRY_MS).toISOString();
    });
    return false;
  }

  /** An interval loop: every check is a wake-up. */
  private checkEvery(id: string, w: RunWatch, now: Date) {
    let text: string | null = null;
    const saved = this.runs.updateWatch(id, w.startedAt, (x, m) => {
      x.lastCheckAt = now.toISOString();
      x.nextCheckAt = new Date(now.getTime() + x.everyMinutes * 60000).toISOString();
      x.error = null;
      if (x.wakes >= MAX_WAKES) { endWatch(m, `Stopped after ${MAX_WAKES} wake-ups.`, now); return; }
      x.wakes += 1;
      x.lastChangeAt = now.toISOString();
      x.lastChange = `Wake-up ${x.wakes}`;
      text = everyText(x);
    });
    if (saved && text) this._wake(id, w, now, text, () => {});
  }

  /** A command check: run it, compare with the last result, wake on a change (or on success). */
  private async checkCommand(id: string, cwd: string, w: RunWatch, now: Date) {
    const nextCheckAt = new Date(now.getTime() + w.everyMinutes * 60000).toISOString();
    let result: CheckResult;
    try {
      const r = await this.runCommand(w.command!, cwd);
      result = { exitCode: r.exitCode, output: r.output, at: now.toISOString() };
    } catch (e) {
      this.runs.updateWatch(id, w.startedAt, (x) => { x.error = `Couldn't run the check: ${(e as Error).message}`; x.lastCheckAt = now.toISOString(); x.nextCheckAt = nextCheckAt; });
      return;
    }
    const prev = w.lastResult ?? null;
    const succeeded = w.until === "success" && result.exitCode === 0;
    // The first run only records, like a PR watch's first look; "until success" is met whenever it exits 0.
    const changed = !!prev && (prev.exitCode !== result.exitCode || prev.output !== result.output);
    let text: string | null = null;
    const saved = this.runs.updateWatch(id, w.startedAt, (x, m) => {
      x.lastCheckAt = now.toISOString();
      x.nextCheckAt = nextCheckAt;
      x.error = null;
      x.lastResult = result;
      if (!(succeeded || (w.until !== "success" && changed))) return;
      if (x.wakes >= MAX_WAKES) { endWatch(m, `Stopped after ${MAX_WAKES} wake-ups.`, now); return; }
      x.wakes += 1;
      x.lastChangeAt = now.toISOString();
      x.lastChange = succeeded ? "The command succeeded" : prev && prev.exitCode !== result.exitCode ? `Exit code ${prev.exitCode} → ${result.exitCode}` : "The output changed";
      text = checkText(x, prev, result, succeeded);
    });
    if (!saved || !text) return;
    const woke = this._wake(id, w, now, text, (x) => { x.lastResult = prev; });
    // Met: the watch is done. stopWatch works mid-turn (the woken turn is running now).
    if (woke && succeeded) { try { this.runs.stopWatch(id, "The check succeeded."); } catch {} }
  }

  /** A PR watch: snapshot each PR with gh and wake on what changed. */
  private async checkPrs(id: string, w: RunWatch, now: Date) {
    const nextCheckAt = new Date(now.getTime() + w.everyMinutes * 60000).toISOString();
    let snaps: PrSnapshot[];
    try {
      const me = await this.login();
      // A merged PR doesn't change any more; don't ask again. A closed one can be reopened.
      snaps = await Promise.all(w.prs.map((p) => (p.seen && p.seen.state === "MERGED" ? p.seen : prSnapshot(this.gh, p.repo, p.number, me))));
    } catch (e) {
      this.runs.updateWatch(id, w.startedAt, (x) => { x.error = `Couldn't check the pull requests: ${(e as Error).message}`; x.lastCheckAt = now.toISOString(); x.nextCheckAt = nextCheckAt; });
      return;
    }

    const changes = w.prs.map((p, i) => ({ pr: p, lines: describeChanges(p.seen, snaps[i]) })).filter((c) => c.lines.length);
    const open = w.prs.filter((_, i) => snaps[i].state === "OPEN");
    const before = w.prs.map((p) => p.seen);
    let text: string | null = null;
    const saved = this.runs.updateWatch(id, w.startedAt, (x, m) => {
      x.lastCheckAt = now.toISOString();
      x.nextCheckAt = nextCheckAt;
      x.error = null;
      x.prs.forEach((p, i) => { p.seen = snaps[i]; });
      if (!open.length) { endWatch(m, "Every pull request is merged or closed.", now); return; }
      if (!changes.length) return;
      if (x.wakes >= MAX_WAKES) { endWatch(m, `Stopped after ${MAX_WAKES} wake-ups.`, now); return; }
      x.wakes += 1;
      x.lastChangeAt = now.toISOString();
      x.lastChange = changes.map((c) => `${prName(c.pr)}: ${c.lines.join("; ")}`).join(" · ");
      text = wakeText(x, changes, open);
    });
    if (!saved || !text) return;
    // Put the old view back so the same changes wake the run on the retry.
    this._wake(id, w, now, text, (x) => { x.prs.forEach((p, i) => { p.seen = before[i]; }); });
  }

  /** Who gh is signed in as: activity by this login (Claude replying for you) never wakes a run. */
  async login(): Promise<string> {
    if (this._login && Date.now() - this._login.at < LOGIN_TTL_MS) return this._login.login;
    const login = (await this.gh(["api", "user", "--jq", ".login"])).trim();
    if (!/^[\w.[\]-]+$/.test(login)) throw new Error("gh isn't signed in (run `gh auth login`).");
    this._login = { login, at: Date.now() };
    return login;
  }
}

/** What one check sees on a PR. */
export async function prSnapshot(gh: Gh, repo: string, number: number, me: string): Promise<PrSnapshot> {
  const [view, inline] = await Promise.all([
    gh(["pr", "view", String(number), "--repo", repo, "--json", "state,reviewDecision,mergeStateStatus,statusCheckRollup,reviews,comments"]),
    // One max per page with --paginate; the highest wins.
    gh(["api", `repos/${repo}/pulls/${number}/comments?per_page=100`, "--paginate", "--jq", `[.[] | select(.user.login != "${me}") | .id] | max // 0`]),
  ]);
  const d = JSON.parse(view || "{}");
  const others = (list: any[]) => (Array.isArray(list) ? list : []).filter((x) => x && x.author && x.author.login !== me);
  const reviews = others(d.reviews).filter((r) => r.state && r.state !== "PENDING" && r.submittedAt);
  const review = reviews.reduce((a: any, r: any) => (!a || r.submittedAt > a.submittedAt ? r : a), null);
  const lastIssueCommentAt = others(d.comments).reduce((a: string, c: any) => (c.createdAt && c.createdAt > a ? c.createdAt : a), "");
  const lastCommentId = inline.split(/\s+/).map(Number).filter(Number.isFinite).reduce((a, n) => Math.max(a, n), 0);
  return {
    state: String(d.state || "OPEN"),
    reviewDecision: String(d.reviewDecision || ""),
    mergeStateStatus: String(d.mergeStateStatus || ""),
    checks: rollupState(d.statusCheckRollup),
    lastReviewAt: review ? review.submittedAt : "",
    lastReviewBy: review ? review.author.login : "",
    lastReviewState: review ? review.state : "",
    lastCommentId,
    lastIssueCommentAt,
  };
}

/**
 * The changes worth a turn, as short phrases. The first look (no `prev`) only
 * records. Checks starting again (pending) never wake: Claude's own push does that.
 * Passing checks wake only an approved PR, since that's when it's ready to merge.
 */
export function describeChanges(prev: PrSnapshot | null, next: PrSnapshot): string[] {
  if (!prev) return [];
  const out: string[] = [];
  if (next.state !== prev.state) out.push(next.state === "MERGED" ? "was merged" : next.state === "CLOSED" ? "was closed" : "was reopened");
  if (next.state !== "OPEN") return out;
  // An empty decision is a change too: a dismissed approval leaves none, often without a new review.
  if (next.reviewDecision !== prev.reviewDecision) {
    out.push(next.reviewDecision === "APPROVED" ? "is approved" : next.reviewDecision === "CHANGES_REQUESTED" ? "has changes requested" : "needs review again");
  }
  if (next.lastReviewAt > prev.lastReviewAt) out.push(`new review from ${next.lastReviewBy} (${next.lastReviewState.toLowerCase().replace(/_/g, " ")})`);
  if (next.lastCommentId > prev.lastCommentId) out.push("new inline review comments");
  if (next.lastIssueCommentAt > prev.lastIssueCommentAt) out.push("new comment");
  if (next.checks !== prev.checks) {
    if (next.checks === "failing") out.push("checks are failing");
    else if (next.checks === "passing" && next.reviewDecision === "APPROVED") out.push("checks passed");
  }
  if (next.mergeStateStatus !== prev.mergeStateStatus) {
    if (next.mergeStateStatus === "BEHIND") out.push("branch is behind its base");
    else if (next.mergeStateStatus === "DIRTY") out.push("has a merge conflict");
  }
  return out;
}

function prName(p: Pick<WatchedPr, "repo" | "number">) { return `${p.repo}#${p.number}`; }

function wakeText(w: RunWatch, changes: { pr: WatchedPr; lines: string[] }[], open: WatchedPr[]): string {
  return [
    "[Dashboard PR watch] Something changed on the pull requests this run is watching:",
    ...changes.map((c) => `- ${prName(c.pr)}: ${c.lines.join("; ")}`),
    `Still open: ${open.map(prName).join(", ")}.`,
    "",
    `The watch stays on: the dashboard checks again every ${w.everyMinutes} minutes and wakes you on the next change, so don't start a loop. End your turn with a new <<WATCH>> block to change it, or <<WATCH>>{"stop":true}<</WATCH>> to end it.`,
    "",
    w.prompt,
  ].join("\n");
}

const KEEP_ON = (w: RunWatch, what: string) =>
  `The watch stays on: the dashboard ${what} every ${formatMinutes(w.everyMinutes)}, so don't start a loop. If nothing needs doing, say so in one line and end with <<WATCH>>{"noop":true}<</WATCH>>. End your turn with a new <<WATCH>> block to change it, or <<WATCH>>{"stop":true}<</WATCH>> to end it.`;

function everyText(w: RunWatch): string {
  return [
    `[Dashboard loop] Wake-up ${w.wakes} of this run's loop (every ${formatMinutes(w.everyMinutes)}, until ${new Date(w.expiresAt).toLocaleString()}).`,
    "",
    KEEP_ON(w, "wakes you again"),
    "",
    w.prompt,
  ].join("\n");
}

function checkText(w: RunWatch, prev: CheckResult | null, now: CheckResult, succeeded: boolean): string {
  const fence = (s: string) => "```\n" + (s || "(no output)").replace(/```/g, "``\u200b`") + "\n```";
  return [
    succeeded
      ? "[Dashboard check] The command this run is waiting on succeeded (exit code 0). The watch has ended."
      : "[Dashboard check] The command this run is watching changed:",
    "",
    "Command: " + w.command,
    prev && prev.exitCode !== now.exitCode ? `Exit code: ${prev.exitCode} → ${now.exitCode}` : `Exit code: ${now.exitCode}`,
    "Output now:",
    fence(now.output),
    ...(prev && !succeeded ? ["Output before:", fence(prev.output)] : []),
    "",
    ...(succeeded ? [] : [KEEP_ON(w, "runs the command again"), ""]),
    w.prompt,
  ].join("\n");
}

/**
 * PR watches: the server half of a run's <<WATCH>> block (parsed in runs.ts).
 *
 * A headless turn can't keep a loop alive, so instead of /loop Claude ends its
 * turn naming the PRs to watch. Every TICK_MS this checks the due watches with
 * gh (no tokens), compares with what the last check saw, and only when something
 * worth acting on changed replies to the run: a new turn on the same session,
 * with the changes and the watch's prompt.
 *
 * A watch only checks while its run is idle and done (status "succeeded"): a
 * running turn, an open question, a failure or a cancel pause it. It ends when
 * every PR is merged or closed, when it expires, after MAX_WAKES wake-ups, or
 * when you (Stop watching) or Claude (a stop block) end it.
 */

import { execFile } from "node:child_process";
import type { PrSnapshot, RunWatch, WatchedPr } from "../../shared/api.ts";
import { endWatch, watchActive, type RunManager } from "./runs.ts";
import { rollupState } from "./inbox.ts";

const TICK_MS = 30 * 1000;
const MAX_WAKES = 100;
/** After a wake-up couldn't start (run limits), try again this soon. */
const RETRY_MS = 60 * 1000;
const LOGIN_TTL_MS = 60 * 60 * 1000;

/** Runs gh and resolves with its stdout. */
export type Gh = (args: string[]) => Promise<string>;

const defaultGh: Gh = (args) => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error((stderr || err.message).trim().split("\n")[0]));
    resolve(String(stdout || ""));
  });
});

export interface WatcherOptions {
  gh?: Gh;
  /** Start a turn on the run with this text. Returns null when it started, else why it couldn't. */
  wake: (runId: string, text: string) => string | null;
}

export class Watcher {
  runs: RunManager;
  gh: Gh;
  wake: WatcherOptions["wake"];
  timer: ReturnType<typeof setInterval> | null = null;
  private _busy = new Set<string>();
  private _login: { login: string; at: number } | null = null;

  constructor(runs: RunManager, opts: WatcherOptions) {
    this.runs = runs;
    this.gh = opts.gh || defaultGh;
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
      this.runs.updateWatch(id, w.startedAt, (_, m) => endWatch(m, "The watch expired. Start a new one if the PRs still need it.", now));
      return;
    }
    if (this.runs.live.has(id) || meta.status !== "succeeded") return;
    if (Date.parse(w.nextCheckAt) > now.getTime()) return;

    this._busy.add(id);
    try {
      const nextCheckAt = new Date(now.getTime() + w.everyMinutes * 60000).toISOString();
      let snaps: PrSnapshot[];
      try {
        const me = await this.login();
        // Merged and closed PRs don't change any more; don't ask again.
        snaps = await Promise.all(w.prs.map((p) => (p.seen && p.seen.state !== "OPEN" ? p.seen : prSnapshot(this.gh, p.repo, p.number, me))));
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

      const blocked = this.wake(id, text);
      if (blocked) {
        // Put the old view back so the same changes wake the run on the retry.
        this.runs.updateWatch(id, w.startedAt, (x) => {
          x.prs.forEach((p, i) => { p.seen = before[i]; });
          x.wakes -= 1;
          x.error = `Couldn't wake the run: ${blocked}`;
          x.nextCheckAt = new Date(now.getTime() + RETRY_MS).toISOString();
        });
      }
    } finally {
      this._busy.delete(id);
    }
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
  if (next.reviewDecision !== prev.reviewDecision && next.reviewDecision) {
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

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrSnapshot, RunMeta } from "../../shared/api.ts";
import { RunManager, applyWatchBlock, parseWatch } from "../src/runs.ts";
import { Watcher, describeChanges, prSnapshot, type Gh } from "../src/watches.ts";

const T0 = new Date("2026-10-02T10:00:00Z");
const later = (min: number) => new Date(T0.getTime() + min * 60000);

const snap = (o: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "OPEN", reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", checks: "pending",
  lastReviewAt: "", lastReviewBy: "", lastReviewState: "", lastCommentId: 0, lastIssueCommentAt: "", ...o,
});

// ------------------------------------------------------------ parsing

test("parseWatch: PRs as owner/name#n, URLs and objects; defaults and clamps", () => {
  const w = parseWatch('done.\n<<WATCH>>\n{"prs":["acme/api#12","https://github.com/acme/web/pull/7",{"repo":"acme/api","number":12}],"everyMinutes":1}\n<</WATCH>>') as any;
  assert.deepEqual(w.prs, [{ repo: "acme/api", number: 12 }, { repo: "acme/web", number: 7 }]); // the duplicate is dropped
  assert.equal(w.everyMinutes, 2);
  assert.equal(w.days, 7);
  assert.match(w.prompt, /review feedback/);
});

test("parseWatch: stop, no marker, and blocks that can't be used", () => {
  assert.deepEqual(parseWatch('<<WATCH>>{"stop":true}<</WATCH>>'), { stop: true });
  assert.equal(parseWatch("All done."), null);
  assert.match((parseWatch("<<WATCH>>not json<</WATCH>>") as any).error, /JSON/);
  assert.match((parseWatch('<<WATCH>>{"prs":[]}<</WATCH>>') as any).error, /no pull requests/);
  assert.match((parseWatch('<<WATCH>>{"prs":["nope"]}<</WATCH>>') as any).error, /Can't read/);
  assert.match((parseWatch('<<WATCH>>{"kind":"jira","prs":["a/b#1"]}<</WATCH>>') as any).error, /Unknown watch kind/);
});

test("applyWatchBlock: a replacement keeps what was already seen; stop ends it; a bad block leaves it running", () => {
  const meta = { watch: null } as unknown as RunMeta;
  applyWatchBlock(meta, '<<WATCH>>{"prs":["a/b#1"],"prompt":"cycle"}<</WATCH>>', T0);
  assert.equal(meta.watch!.prompt, "cycle");
  meta.watch!.prs[0].seen = snap();
  meta.watch!.wakes = 3;

  applyWatchBlock(meta, '<<WATCH>>{"prs":["a/b#1","a/b#2"]}<</WATCH>>', later(5));
  assert.deepEqual(meta.watch!.prs.map((p) => !!p.seen), [true, false]);
  assert.equal(meta.watch!.wakes, 3);

  applyWatchBlock(meta, "<<WATCH>>{oops<</WATCH>>", later(6));
  assert.equal(meta.watch!.endedAt, null);
  assert.match(meta.watch!.error!, /ignored/);

  applyWatchBlock(meta, "No block this time.", later(7));
  assert.equal(meta.watch!.endedAt, null);

  applyWatchBlock(meta, '<<WATCH>>{"stop":true}<</WATCH>>', later(8));
  assert.equal(meta.watch!.endedAt, later(8).toISOString());
});

// ------------------------------------------------------------ what wakes a run

test("describeChanges: the first look only records", () => {
  assert.deepEqual(describeChanges(null, snap({ checks: "failing" })), []);
});

test("describeChanges: reviews, comments, failing checks, behind and conflicts wake", () => {
  const prev = snap();
  assert.deepEqual(describeChanges(prev, snap({ lastReviewAt: "2026-10-02T10:01:00Z", lastReviewBy: "alice", lastReviewState: "CHANGES_REQUESTED", reviewDecision: "CHANGES_REQUESTED" })),
    ["has changes requested", "new review from alice (changes requested)"]);
  assert.deepEqual(describeChanges(prev, snap({ lastCommentId: 99 })), ["new inline review comments"]);
  assert.deepEqual(describeChanges(prev, snap({ lastIssueCommentAt: "2026-10-02T10:01:00Z" })), ["new comment"]);
  assert.deepEqual(describeChanges(prev, snap({ checks: "failing" })), ["checks are failing"]);
  assert.deepEqual(describeChanges(prev, snap({ mergeStateStatus: "BEHIND" })), ["branch is behind its base"]);
  assert.deepEqual(describeChanges(prev, snap({ mergeStateStatus: "DIRTY" })), ["has a merge conflict"]);
  assert.deepEqual(describeChanges(prev, snap({ state: "MERGED" })), ["was merged"]);
  // A dismissed approval leaves no decision at all.
  assert.deepEqual(describeChanges(snap({ reviewDecision: "APPROVED" }), snap({ reviewDecision: "" })), ["needs review again"]);
});

test("describeChanges: checks restarting, passing before approval and other merge states don't wake", () => {
  assert.deepEqual(describeChanges(snap({ checks: "failing" }), snap({ checks: "pending" })), []);
  assert.deepEqual(describeChanges(snap(), snap({ checks: "passing" })), []);
  assert.deepEqual(describeChanges(snap(), snap({ mergeStateStatus: "UNKNOWN" })), []);
  assert.deepEqual(describeChanges(snap({ reviewDecision: "APPROVED" }), snap({ reviewDecision: "APPROVED", checks: "passing" })), ["checks passed"]);
});

test("prSnapshot: activity by the signed-in user is left out", async () => {
  const gh: Gh = async (args) => {
    if (args[0] === "pr") {
      return JSON.stringify({
        state: "OPEN", reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
        reviews: [
          { author: { login: "me" }, state: "COMMENTED", submittedAt: "2026-10-02T11:00:00Z" },
          { author: { login: "alice" }, state: "APPROVED", submittedAt: "2026-10-02T09:00:00Z" },
          { author: { login: "bob" }, state: "PENDING", submittedAt: "2026-10-02T12:00:00Z" },
        ],
        comments: [{ author: { login: "me" }, createdAt: "2026-10-02T11:00:00Z" }, { author: { login: "carol" }, createdAt: "2026-10-02T08:00:00Z" }],
      });
    }
    assert.match(args[args.length - 1], /select\(\.user\.login != "me"\)/);
    return "17\n0\n42\n"; // one max per page
  };
  const s = await prSnapshot(gh, "a/b", 1, "me");
  assert.equal(s.checks, "failing");
  assert.equal(s.lastReviewBy, "alice");
  assert.equal(s.lastIssueCommentAt, "2026-10-02T08:00:00Z");
  assert.equal(s.lastCommentId, 42);
});

// ------------------------------------------------------------ the watcher

/** A RunManager over a temp ledger holding one idle run that watches a/b#1, and a gh the test steers. */
function setup(runOver: Partial<RunMeta> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-watch-"));
  const runs = new RunManager(dir);
  const meta: any = { id: "r1", sessionId: "s1", status: "succeeded", permissionMode: "auto", startedAt: T0.toISOString(), endedAt: T0.toISOString(), watch: null, ...runOver };
  applyWatchBlock(meta, '<<WATCH>>{"prs":["a/b#1"],"everyMinutes":5,"prompt":"Run the cycle."}<</WATCH>>', T0);
  fs.writeFileSync(path.join(dir, "runs", "r1.json"), JSON.stringify(meta));
  const pr = { state: "OPEN", reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", statusCheckRollup: [] as any[], reviews: [] as any[], comments: [] as any[] };
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") return "me\n";
    if (args[0] === "pr") return JSON.stringify(pr);
    return "0\n";
  };
  const wakes: string[] = [];
  let blocker: string | null = null;
  const watcher = new Watcher(runs, { gh, wake: (_id, text) => { if (blocker) return blocker; wakes.push(text); return null; } });
  return { dir, runs, watcher, pr, calls, wakes, block: (b: string | null) => { blocker = b; }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("watcher: first check records, a quiet check doesn't wake, a new review does", async () => {
  const t = setup();
  try {
    await t.watcher.tick(later(0));
    assert.equal(t.wakes.length, 0);
    assert.ok(t.runs.get("r1")!.watch!.prs[0].seen);

    await t.watcher.tick(later(2)); // not due yet
    assert.equal(t.calls.filter((c) => c[0] === "pr").length, 1);

    await t.watcher.tick(later(5));
    assert.equal(t.wakes.length, 0);

    t.pr.reviews.push({ author: { login: "alice" }, state: "CHANGES_REQUESTED", submittedAt: later(6).toISOString() });
    t.pr.reviewDecision = "CHANGES_REQUESTED";
    await t.watcher.tick(later(10));
    assert.equal(t.wakes.length, 1);
    assert.match(t.wakes[0], /a\/b#1: has changes requested; new review from alice/);
    assert.match(t.wakes[0], /Run the cycle\.$/);
    const w = t.runs.get("r1")!.watch!;
    assert.equal(w.wakes, 1);
    assert.match(w.lastChange!, /alice/);
  } finally { t.done(); }
});

test("watcher: your own review never wakes the run", async () => {
  const t = setup();
  try {
    await t.watcher.tick(later(0));
    t.pr.reviews.push({ author: { login: "me" }, state: "COMMENTED", submittedAt: later(1).toISOString() });
    t.pr.comments.push({ author: { login: "me" }, createdAt: later(1).toISOString() });
    await t.watcher.tick(later(5));
    assert.equal(t.wakes.length, 0);
  } finally { t.done(); }
});

test("watcher: a wake-up that can't start keeps the change for the retry", async () => {
  const t = setup();
  try {
    await t.watcher.tick(later(0));
    t.pr.statusCheckRollup = [{ status: "COMPLETED", conclusion: "FAILURE" }];
    t.block("Already 3 runs in flight (limit 3).");
    await t.watcher.tick(later(5));
    assert.equal(t.wakes.length, 0);
    let w = t.runs.get("r1")!.watch!;
    assert.match(w.error!, /3 runs in flight/);
    assert.equal(w.wakes, 0);
    assert.equal(w.nextCheckAt, later(6).toISOString());

    t.block(null);
    await t.watcher.tick(later(6));
    assert.equal(t.wakes.length, 1);
    assert.match(t.wakes[0], /checks are failing/);
    w = t.runs.get("r1")!.watch!;
    assert.equal(w.error, null);
  } finally { t.done(); }
});

test("watcher: paused unless the run is idle and done", async () => {
  for (const status of ["waiting", "failed", "cancelled"] as const) {
    const t = setup({ status });
    try {
      await t.watcher.tick(later(0));
      assert.equal(t.calls.length, 0, status);
    } finally { t.done(); }
  }
});

test("watcher: a closed PR is checked again and its reopening wakes the run; a merged one isn't asked again", async () => {
  const t = setup();
  try {
    // Watch a second PR so closing the first doesn't end the watch.
    const meta = t.runs.get("r1")!;
    applyWatchBlock(meta, '<<WATCH>>{"prs":["a/b#1","a/b#2"],"prompt":"Run the cycle."}<</WATCH>>', T0);
    fs.writeFileSync(path.join(t.dir, "runs", "r1.json"), JSON.stringify(meta));
    // #2 stays open until the end; #1 follows t.pr.
    let second = "OPEN";
    const gh = t.watcher.gh;
    t.watcher.gh = (args) => (args[0] === "pr" && args[2] === "2" ? gh(args).then((v) => JSON.stringify({ ...JSON.parse(v), state: second })) : gh(args));
    await t.watcher.tick(later(0));
    t.pr.state = "CLOSED";
    await t.watcher.tick(later(5));
    assert.equal(t.wakes.length, 1);
    assert.match(t.wakes[0], /a\/b#1: was closed/);

    t.pr.state = "OPEN";
    await t.watcher.tick(later(10));
    assert.equal(t.wakes.length, 2);
    assert.match(t.wakes[1], /was reopened/);

    t.pr.state = "MERGED";
    second = "MERGED";
    await t.watcher.tick(later(15));
    const views = () => t.calls.filter((c) => c[0] === "pr").length;
    const before = views();
    await t.watcher.tick(later(20));
    assert.equal(views(), before); // both merged: the watch ended, nothing is asked
    assert.match(t.runs.get("r1")!.watch!.endReason!, /merged or closed/);
  } finally { t.done(); }
});

test("watcher: ends when every PR is merged or closed, and when it expires", async () => {
  const t = setup();
  try {
    await t.watcher.tick(later(0));
    t.pr.state = "MERGED";
    await t.watcher.tick(later(5));
    assert.equal(t.wakes.length, 0);
    assert.match(t.runs.get("r1")!.watch!.endReason!, /merged or closed/);
  } finally { t.done(); }

  const u = setup();
  try {
    await u.watcher.tick(later(7 * 24 * 60 + 1));
    assert.equal(u.calls.length, 0);
    assert.match(u.runs.get("r1")!.watch!.endReason!, /expired/);
  } finally { u.done(); }
});

test("watcher: a gh failure is recorded, not woken on", async () => {
  const t = setup();
  t.watcher.gh = async () => { throw new Error("gh: command not found"); };
  try {
    await t.watcher.tick(later(0));
    const w = t.runs.get("r1")!.watch!;
    assert.match(w.error!, /command not found/);
    assert.equal(w.endedAt, null);
    assert.equal(w.nextCheckAt, later(5).toISOString());
  } finally { t.done(); }
});

test("stopWatch ends the watch; hand-off ends it too", () => {
  const t = setup();
  try {
    assert.match(t.runs.stopWatch("r1").watch!.endReason!, /dashboard/);
    assert.throws(() => t.runs.stopWatch("r1"), /isn't watching/);
  } finally { t.done(); }
  const u = setup();
  try {
    assert.match(u.runs.handOff("r1").watch!.endReason!, /terminal/);
  } finally { u.done(); }
});

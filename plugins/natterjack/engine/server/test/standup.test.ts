// standup.ts with fake sources (tracker, gh, inbox, ledger, meeting tool) and a fake Claude: which
// sources show, what lands in Since / Today / Blockers, caching, and drafts kept per day. Also each
// tracker adapter's activity() against a stubbed API.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Standup, cleanDraft, dayParam, draftPrompt, ownerIsViewer, prRefs, runsSource, sinceParam } from "../src/standup.ts";
import { byPriority, isBlocked, minutesAgo } from "../src/issues/activity.ts";
import { LinearTracker, activityFilters } from "../src/issues/linear.ts";
import { JiraTracker, activityJql } from "../src/issues/jira.ts";
import { GitHubTracker } from "../src/issues/github.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "standup-"));
let n = 0;
const ledger = () => path.join(TMP, `ledger-${++n}`);

const NOW = Date.parse("2026-10-26T15:00:00Z");
const SINCE = "2026-10-23T00:00:00Z";

function run(over: any = {}): any {
  return { id: "r1", label: "Fix login", trigger: "manual", status: "succeeded", startedAt: "2026-10-24T10:00:00Z", endedAt: "2026-10-24T11:00:00Z", turnStartedAt: null, resultText: null, error: null, verdict: null, flagged: false, question: null, watch: null, ...over };
}

/** A Standup with nothing but the ledger, and whatever `over` adds. */
function standup(over: any = {}) {
  return new Standup({
    ledgerDir: ledger(), now: () => NOW,
    tracker: () => null, codeHost: () => ({ kind: "none" }), inbox: async () => ({ items: [], errors: [] }),
    runs: () => [], meetings: () => null, ask: async () => "x",
    ...over,
  });
}

test("since must be a time within the last month, not ahead; day must be YYYY-MM-DD", () => {
  assert.equal(sinceParam("2026-10-23T00:00:00.000Z", NOW), "2026-10-23T00:00:00Z");
  assert.equal(sinceParam("2026-10-27T00:00:00Z", NOW), null, "in the future");
  assert.equal(sinceParam("2026-08-01T00:00:00Z", NOW), null, "too far back");
  assert.equal(sinceParam("yesterday", NOW), null);
  assert.equal(dayParam("2026-10-26"), "2026-10-26");
  assert.equal(dayParam("26/10/2026"), null);
  assert.equal(dayParam("../x"), null);
});

test("an action item's owner is you by name, by part of it, or by your email's name", () => {
  assert.equal(ownerIsViewer("Sam Lee", "Sam Lee"), true);
  assert.equal(ownerIsViewer("sam", "Sam Lee"), true);
  assert.equal(ownerIsViewer("Sam Lee", "sam.lee@acme.com"), true);
  assert.equal(ownerIsViewer("Kim", "Sam Lee"), false);
  assert.equal(ownerIsViewer(null, "Sam"), false);
  assert.equal(ownerIsViewer("Sam", null), false);
});

test("PR links in a run's text, each once", () => {
  assert.deepEqual(prRefs("Opened https://github.com/acme/api/pull/12 and https://github.com/acme/web/pull/3, see https://github.com/acme/api/pull/12"), ["acme/api#12", "acme/web#3"]);
  assert.deepEqual(prRefs(null), []);
});

test("runs: ended since the window are done (with PRs and verdicts); running and waiting are next; waiting blocks", () => {
  const s = runsSource([
    run({ id: "a", trigger: "issues", resultText: "PR: https://github.com/acme/api/pull/7", verdict: "good" }),
    run({ id: "b", status: "failed", error: "tests failed\nmore", trigger: "explain" }),
    run({ id: "c", endedAt: "2026-10-20T10:00:00Z", startedAt: "2026-10-20T09:00:00Z" }),
    run({ id: "d", status: "running", startedAt: "2026-10-01T00:00:00Z", endedAt: null }),
    run({ id: "e", status: "waiting", question: [{ question: "Which repo?", options: [] }] }),
  ], SINCE);
  assert.deepEqual(s.done.map((i) => i.runId).sort(), ["a", "b"]);
  const a = s.done.find((i) => i.runId === "a")!;
  assert.match(a.detail, /^Implement · succeeded · marked good · PR acme\/api#7$/);
  assert.match(s.done.find((i) => i.runId === "b")!.detail, /Explain · failed · tests failed$/);
  assert.deepEqual(s.next.map((i) => i.runId).sort(), ["d", "e"]);
  assert.deepEqual(s.blockers.map((i) => i.runId), ["e"]);
  assert.match(s.blockers[0].detail, /Which repo\?/);
});

test("a workspace with only the ledger shows only runs", async () => {
  const r = await standup({ runs: () => [run()] }).get(SINCE);
  assert.deepEqual(r.sources.map((s) => s.id), ["runs"]);
  assert.equal(r.since, SINCE);
});

test("tracker: your changes are done, open issues next, blocked ones blockers; not connected says so; no activity() leaves it out", async () => {
  const tracker: any = {
    status: () => ({ connected: true }),
    activity: async (since: string) => {
      assert.equal(since, SINCE);
      return {
        changed: [{ id: "ENG-1", title: "Login", url: "https://t/ENG-1", state: "Done", what: ["moved In Progress → Done", "commented"], at: "2026-10-24T00:00:00.000Z" }],
        assigned: [
          { id: "ENG-2", title: "Retry", url: "https://t/ENG-2", state: "In Progress", priority: 1, priorityLabel: "Urgent", blocked: false, updatedAt: "" },
          { id: "ENG-3", title: "Deploy", url: "https://t/ENG-3", state: "Blocked", priority: 2, priorityLabel: "High", blocked: true, updatedAt: "" },
        ],
      };
    },
  };
  const r = await standup({ tracker: () => ({ tracker, label: "Linear" }) }).get(SINCE);
  const t = r.sources.find((s) => s.id === "tracker")!;
  assert.equal(t.label, "Linear");
  assert.deepEqual(t.done, [{ title: "ENG-1 Login", detail: "moved In Progress → Done, commented", url: "https://t/ENG-1", at: "2026-10-24T00:00:00.000Z" }]);
  assert.deepEqual(t.next.map((i) => [i.title, i.detail]), [["ENG-2 Retry", "In Progress · Urgent"]]);
  assert.deepEqual(t.blockers.map((i) => i.title), ["ENG-3 Deploy"]);

  const off = await standup({ tracker: () => ({ tracker: { ...tracker, status: () => ({ connected: false }) }, label: "Jira" }) }).get(SINCE);
  assert.match(off.sources[0].error!, /Jira isn't connected/);
  const none = await standup({ tracker: () => ({ tracker: { status: () => ({ connected: true }) }, label: "X" }) }).get(SINCE);
  assert.deepEqual(none.sources.map((s) => s.id), ["runs"]);
  const failing = await standup({ tracker: () => ({ tracker: { ...tracker, activity: async () => { throw new Error("HTTP 500"); } }, label: "Linear" }) }).get(SINCE);
  assert.equal(failing.sources[0].error, "Linear: HTTP 500");
});

/** A fake gh for the code host: searches by flag, and each PR's reviews. */
function fakeGh() {
  const calls: string[][] = [];
  const pr = (number: number, over: any = {}) => ({ number, title: `PR ${number}`, repository: { nameWithOwner: "acme/api" }, url: `https://github.com/acme/api/pull/${number}`, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", closedAt: null, author: { login: "me" }, ...over });
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") return { login: "me" };
    if (args[0] === "search" && args.includes("--created")) return [pr(1, { createdAt: "2026-10-24T09:00:00Z" })];
    if (args[0] === "search" && args.includes("--merged-at")) return [pr(1, { createdAt: "2026-10-24T09:00:00Z", closedAt: "2026-10-25T00:00:00Z" })];
    if (args[0] === "search" && args.includes("--author=@me")) return [pr(1, { createdAt: "2026-10-24T09:00:00Z" }), pr(2)];
    if (args[0] === "search" && args.includes("--reviewed-by=@me")) return [pr(5, { author: { login: "kim" } }), pr(6, { author: { login: "kim" } }), pr(2)];
    if (args[0] === "api" && args[1] === "repos/acme/api/pulls/5/reviews?per_page=100") return [{ login: "me", at: "2026-10-24T12:00:00Z" }];
    if (args[0] === "api" && args[1] === "repos/acme/api/pulls/6/reviews?per_page=100") return [{ login: "me", at: "2026-10-01T12:00:00Z" }];
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls };
}

test("code host: PRs you opened, merged, updated or reviewed since, once each; Today and Blockers from the inbox", async () => {
  const f = fakeGh();
  const inbox = async () => ({
    errors: ["acme/web CI: nope", "review requests: rate limited"],
    items: [
      { kind: "review-requested", severity: "action", title: "Bump", detail: "acme/web#9 by kim", url: "https://github.com/acme/web/pull/9", at: "2026-10-26T10:00:00Z" },
      { kind: "pr-failing", severity: "alert", title: "Old", detail: "acme/api#3 · checks failing", url: "https://github.com/acme/api/pull/3", at: "2026-10-24T00:00:00Z" },
      { kind: "pr-failing", severity: "alert", title: "New", detail: "acme/api#4 · checks failing", url: "https://github.com/acme/api/pull/4", at: "2026-10-26T14:00:00Z" },
      { kind: "my-pr", severity: "info", title: "Waiting", detail: "acme/api#8 · waiting on review", url: "u", at: "" },
      { kind: "run-waiting", severity: "action", title: "Claude is asking", detail: "", runId: "r", at: "" },
    ],
  });
  const r = await standup({ codeHost: () => ({ kind: "github" }), gh: f.gh, inbox }).get(SINCE);
  const c = r.sources.find((s) => s.id === "code")!;
  assert.deepEqual(c.done.map((i) => i.detail), ["acme/api#1 · opened, merged", "acme/api#5 · reviewed", "acme/api#2 · updated"], "newest first");
  assert.ok(f.calls.some((a) => a.includes("--created") && a.includes(">=2026-10-23T00:00:00Z")), "searches from since");
  assert.ok(!f.calls.some((a) => a[1]?.includes("pulls/2/reviews")), "your own PRs aren't checked for your reviews");
  assert.deepEqual(c.next.map((i) => i.title), ["Bump", "Old", "New"]);
  assert.deepEqual(c.blockers.map((i) => i.title), ["Old"], "failing for over a day");
  assert.equal(c.error, "review requests: rate limited", "the inbox's CI checks aren't this page's");

  const other = await standup({ codeHost: () => ({ kind: "gitlab" }) }).get(SINCE);
  assert.match(other.sources[0].error!, /gitlab/);
});

test("meetings: pages back to since; your open action items are next; not connected says so", async () => {
  const meeting = (id: string, startedAt: string, items: any[] = []) => ({ id, title: `Meeting ${id}`, startedAt, endedAt: null, participantCount: 3, host: null, summary: null, actionItems: items, tickets: [] });
  const pages: Record<string, any> = {
    "": { meetings: [meeting("m1", "2026-10-26T09:00:00Z", [{ text: "Send the plan", description: null, complete: false, suggestedOwner: "Sam" }, { text: "Book room", description: null, complete: false, suggestedOwner: "Kim" }])], nextCursor: "p2" },
    p2: { meetings: [meeting("m2", "2026-10-23T10:00:00Z", [{ text: "Done thing", description: null, complete: true, suggestedOwner: "Sam Lee" }]), meeting("m3", "2026-10-22T10:00:00Z")], nextCursor: "p3" },
  };
  const asked: string[] = [];
  const source: any = {
    label: "Roam", status: () => ({ connected: true, viewer: "Sam Lee" }),
    listMeetings: async (req: any) => { asked.push(req.cursor || ""); return pages[req.cursor || ""]; },
  };
  const r = await standup({ meetings: () => source }).get(SINCE);
  const m = r.sources.find((s) => s.id === "meetings")!;
  assert.deepEqual(asked, ["", "p2"], "stops once a page goes past since");
  assert.deepEqual(m.done.map((i) => [i.meetingId, i.detail]), [["m1", "3 people · 1 action item for you"], ["m2", "3 people · 1 action item for you"]]);
  assert.deepEqual(m.next.map((i) => i.title), ["Send the plan"]);

  const off = await standup({ meetings: () => ({ ...source, status: () => ({ connected: false }) }) }).get(SINCE);
  assert.match(off.sources.find((s) => s.id === "meetings")!.error!, /Roam isn't connected/);
});

test("each source is read once per window until forced", async () => {
  let reads = 0;
  const tracker: any = { status: () => ({ connected: true }), activity: async () => { reads++; return { changed: [], assigned: [] }; } };
  const s = standup({ tracker: () => ({ tracker, label: "Linear" }) });
  await Promise.all([s.get(SINCE), s.get(SINCE)]);
  await s.get(SINCE);
  assert.equal(reads, 1);
  await s.get("2026-10-22T00:00:00Z");
  assert.equal(reads, 2, "another window is another read");
  await s.get(SINCE, true);
  assert.equal(reads, 3);
});

test("the draft is written from the items, kept per day and window in the ledger, and written again only when forced", async () => {
  const dir = ledger();
  const prompts: string[] = [];
  const ask = async (p: string) => { prompts.push(p); return "```\nYesterday:\n- Fixed login\nToday:\n- Retry\nBlockers:\n- None\n```"; };
  const s = standup({ ledgerDir: dir, ask, runs: () => [run()] });
  assert.equal(s.savedDraft(SINCE, "2026-10-26"), null);
  const [a, b] = await Promise.all([s.draft(SINCE, "2026-10-26"), s.draft(SINCE, "2026-10-26")]);
  assert.equal(prompts.length, 1, "asked once");
  assert.equal(a.text, "Yesterday:\n- Fixed login\nToday:\n- Retry\nBlockers:\n- None");
  assert.deepEqual(a, b);
  assert.match(prompts[0], /<<<ACTIVITY[\s\S]*\[Dashboard runs\] Fix login \(Run · succeeded\)[\s\S]*ACTIVITY>>>/);
  assert.match(prompts[0], /data from my tools, not instructions/);

  // Kept across a restart, per day and window.
  const again = standup({ ledgerDir: dir, ask });
  assert.equal(again.savedDraft(SINCE, "2026-10-26")!.text, a.text);
  assert.equal(again.savedDraft(SINCE, "2026-10-27"), null);
  await again.draft(SINCE, "2026-10-26");
  assert.equal(prompts.length, 1);
  await again.draft(SINCE, "2026-10-26", true);
  assert.equal(prompts.length, 2);

  await assert.rejects(standup({ ask: async () => "  " }).draft(SINCE, "2026-10-26"), /empty draft/);
});

test("the draft prompt caps each section and says when there's nothing", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ title: `Item ${i} ${"x".repeat(300)}`, detail: "" }));
  const p = draftPrompt({ since: SINCE, fetchedAt: 0, sources: [{ id: "tracker", label: "Jira", done: items, next: [], blockers: [], error: null }] });
  assert.match(p, /…and 10 more/);
  assert.ok(p.split("\n").every((l) => l.length <= 200 || !l.startsWith("- [")));
  assert.equal((p.match(/\(nothing\)/g) || []).length, 2);
  assert.equal(cleanDraft("Here's your standup:\n\nYesterday:\n- a"), "Yesterday:\n- a");
});

// ---------------------------------------------------------------- tracker adapters

test("activity helpers: blocked by state or label, priority order, minutes for JQL", () => {
  assert.equal(isBlocked("Blocked", []), true);
  assert.equal(isBlocked("In Progress", ["Blocked"]), true);
  assert.equal(isBlocked("In Progress", ["blocking", "blocker", "backend"]), false, "it holds others up");
  const i = (id: string, priority: number, updatedAt: string) => ({ id, title: "", url: "", state: "", priority, priorityLabel: "", blocked: false, updatedAt });
  assert.deepEqual([i("a", 0, "2"), i("b", 3, "1"), i("c", 1, "1"), i("d", 3, "2")].sort(byPriority).map((x) => x.id), ["c", "d", "b", "a"]);
  assert.equal(minutesAgo("2026-10-26T14:00:00Z", NOW), 60);
  assert.equal(minutesAgo("2026-10-26T15:00:00Z", NOW), 1);
});

test("linear: state moves, comments and created-by-you since; assigned started or up next, by priority", async () => {
  const t = new LinearTracker(TMP, { kind: "linear", org: "acme" } as any);
  t._key = () => "lin_api_x";
  let vars: any = null;
  t.gql = async (_k, _q, v) => {
    vars = v;
    return {
      changed: { nodes: [
        { identifier: "ENG-1", title: "Login", url: "https://linear.app/acme/issue/ENG-1", createdAt: "2026-10-24T00:00:00.000Z", state: { name: "Done" }, creator: { isMe: true },
          history: { nodes: [
            { createdAt: "2026-10-25T00:00:00.000Z", actor: { isMe: true }, fromState: { name: "In Progress" }, toState: { name: "Done" } },
            { createdAt: "2026-10-25T01:00:00.000Z", actor: { isMe: false }, fromState: { name: "Done" }, toState: { name: "QA" } },
            { createdAt: "2026-10-20T00:00:00.000Z", actor: { isMe: true }, fromState: null, toState: { name: "Todo" } },
          ] },
          comments: { nodes: [{ createdAt: "2026-10-24T05:00:00.000Z" }] } },
        { identifier: "ENG-9", title: "Someone else's edit", url: "u", createdAt: "2026-01-01T00:00:00.000Z", state: { name: "Todo" }, creator: { isMe: false }, history: { nodes: [] }, comments: { nodes: [] } },
      ] },
      assigned: { nodes: [
        { identifier: "ENG-3", title: "Low", url: "u3", priority: 4, priorityLabel: "Low", updatedAt: "2026-10-25T00:00:00.000Z", state: { name: "Todo" }, labels: { nodes: [] } },
        { identifier: "ENG-2", title: "Urgent", url: "u2", priority: 1, priorityLabel: "Urgent", updatedAt: "2026-10-25T00:00:00.000Z", state: { name: "In Progress" }, labels: { nodes: [{ name: "Blocked" }] } },
      ] },
    };
  };
  const a = await t.activity(SINCE);
  assert.deepEqual(vars.changed, activityFilters(SINCE).changed);
  assert.deepEqual(vars.assigned.state, { type: { in: ["started", "unstarted"] } });
  assert.deepEqual(a.changed, [{ id: "ENG-1", title: "Login", url: "https://linear.app/acme/issue/ENG-1", state: "Done", what: ["created", "moved In Progress → Done", "commented"], at: "2026-10-25T00:00:00.000Z" }]);
  assert.deepEqual(a.assigned.map((i) => [i.id, i.blocked]), [["ENG-2", true], ["ENG-3", false]]);
});

test("jira: relative JQL in the configured projects; your changelog, comments and created issues; open assigned issues", async () => {
  const q = activityJql(90, ["ENG"]);
  assert.equal(q.changed, 'project in ("ENG") AND (issue in updatedBy(currentUser(), "-90m") OR (reporter = currentUser() AND created >= "-90m")) ORDER BY updated DESC');
  assert.equal(activityJql(5, []).assigned, "assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC");

  const t = new JiraTracker(TMP, { kind: "jira", site: "acme.atlassian.net", projects: ["ENG"] } as any);
  t._auth = () => ({ kind: "token", cred: "a@b:token123456" });
  const bodies: any[] = [];
  t._get = async (_c: any, p: string, body?: any) => {
    if (p === "/rest/api/3/myself") return { accountId: "me1", displayName: "Me" };
    bodies.push(body);
    if (/updatedBy/.test(body.jql)) {
      return { issues: [{ key: "ENG-1", fields: {
        summary: "Login", status: { name: "Done" }, created: "2026-10-01T00:00:00.000+0000", reporter: { accountId: "kim" },
        comment: { comments: [{ author: { accountId: "me1" }, created: "2026-10-24T10:00:00.000+0100" }, { author: { accountId: "kim" }, created: "2026-10-25T10:00:00.000+0000" }] },
      }, changelog: { histories: [
        { author: { accountId: "me1" }, created: "2026-10-24T09:00:00.000+0000", items: [{ field: "status", fromString: "In Progress", toString: "Done" }, { field: "labels" }] },
        { author: { accountId: "kim" }, created: "2026-10-25T09:00:00.000+0000", items: [{ field: "status", fromString: "Done", toString: "Reopened" }] },
      ] } }] };
    }
    return { issues: [{ key: "ENG-5", fields: { summary: "Deploy", status: { name: "Blocked" }, priority: { name: "High" }, labels: [], updated: "2026-10-25T00:00:00.000+0000" } }] };
  };
  const a = await t.activity(SINCE);
  assert.equal(bodies[0].expand, "changelog");
  assert.deepEqual(a.changed.map((c) => [c.id, c.what]), [["ENG-1", ["moved In Progress → Done", "commented"]]]);
  assert.equal(a.changed[0].url, "https://acme.atlassian.net/browse/ENG-1");
  assert.deepEqual(a.assigned.map((i) => [i.id, i.priority, i.blocked]), [["ENG-5", 2, true]]);
});

test("github: opened, closed and moved by you (events), commented (comments), assigned open issues; pull requests left out", async () => {
  const t = new GitHubTracker({ kind: "github", repos: ["acme/api"], states: { "In progress": ["doing"] } } as any);
  const calls: string[][] = [];
  t.gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") return { login: "me" };
    if (args[0] === "search" && args.includes("--author=@me")) return [{ number: 1, title: "New bug", url: "https://github.com/acme/api/issues/1", repository: { nameWithOwner: "acme/api" }, labels: [], state: "open", createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" }];
    if (args[0] === "search" && args.includes("--commenter=@me")) return [{ number: 4, title: "Question", url: "https://github.com/acme/api/issues/4", repository: { nameWithOwner: "acme/api" }, labels: [], state: "open" }];
    if (args[0] === "search" && args.includes("--assignee=@me")) return [{ number: 2, title: "Mine", url: "https://github.com/acme/api/issues/2", repository: { nameWithOwner: "acme/api" }, labels: [{ name: "doing" }], state: "open", updatedAt: "2026-10-25T00:00:00Z" }];
    if (args[1] === "repos/acme/api/issues/events?per_page=100&page=1") {
      return [
        { event: "closed", actor: { login: "me" }, created_at: "2026-10-25T00:00:00Z", issue: { number: 3, title: "Old bug", html_url: "https://github.com/acme/api/issues/3", state: "closed", labels: [] } },
        { event: "labeled", actor: { login: "me" }, label: { name: "Doing" }, created_at: "2026-10-25T01:00:00Z", issue: { number: 2, title: "Mine", html_url: "https://github.com/acme/api/issues/2", state: "open", labels: [{ name: "doing" }] } },
        { event: "closed", actor: { login: "me" }, created_at: "2026-10-25T00:00:00Z", issue: { number: 8, title: "A PR", pull_request: {}, state: "closed", labels: [] } },
        { event: "closed", actor: { login: "kim" }, created_at: "2026-10-25T00:00:00Z", issue: { number: 6, title: "Kim's", state: "closed", labels: [] } },
        { event: "closed", actor: { login: "me" }, created_at: "2026-10-01T00:00:00Z", issue: { number: 7, title: "Long ago", state: "closed", labels: [] } },
      ];
    }
    if (args[1].startsWith("repos/acme/api/issues/comments?since=")) {
      return [
        { user: { login: "me" }, created_at: "2026-10-24T03:00:00Z", issue_url: "https://api.github.com/repos/acme/api/issues/4", html_url: "https://github.com/acme/api/issues/4#issuecomment-1" },
        { user: { login: "me" }, created_at: "2026-10-24T03:00:00Z", issue_url: "https://api.github.com/repos/acme/api/issues/8", html_url: "https://github.com/acme/api/pull/8#issuecomment-2" },
      ];
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const a = await t.activity(SINCE);
  assert.ok(calls.some((c) => c[1] === `repos/acme/api/issues/comments?since=${encodeURIComponent("2026-10-23T00:00:00Z")}&sort=created&direction=desc&per_page=100&page=1`));
  assert.equal(a.errors, undefined);
  assert.deepEqual(a.changed.map((c) => [c.id, c.title, c.what]), [
    ["api#2", "Mine", ["moved to In progress"]],
    ["api#3", "Old bug", ["closed"]],
    ["api#4", "Question", ["commented"]],
    ["api#1", "New bug", ["opened"]],
  ]);
  assert.equal(a.changed.find((c) => c.id === "api#3")!.state, "Closed");
  assert.deepEqual(a.assigned.map((i) => [i.id, i.state]), [["api#2", "In progress"]]);
});

test("github: pages events back to since; one part failing leaves the rest, with the error", async () => {
  const t = new GitHubTracker({ kind: "github", repos: ["acme/api", "acme/gone"] } as any);
  t.viewer = "me";
  const pages: string[] = [];
  const ev = (number: number, at: string) => ({ event: "closed", actor: { login: "me" }, created_at: at, issue: { number, title: `#${number}`, html_url: "u", state: "closed", labels: [] } });
  t.gh = async (args: string[]) => {
    if (args[0] === "search") return [];
    if (args[1].startsWith("repos/acme/gone/")) throw new Error("HTTP 404");
    if (args[1].startsWith("repos/acme/api/issues/events")) {
      pages.push(args[1]);
      // Page 1 is full and still inside the window; page 2 goes past it.
      return args[1].endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => ev(i + 1, "2026-10-25T00:00:00Z")) : [ev(500, "2026-10-24T00:00:00Z"), ev(501, "2026-10-01T00:00:00Z")];
    }
    return [];
  };
  const a = await t.activity(SINCE);
  assert.equal(pages.length, 2);
  assert.ok(a.changed.some((c) => c.id === "api#500"));
  assert.ok(!a.changed.some((c) => c.id === "api#501"));
  assert.deepEqual(a.errors, ["acme/gone issue events: HTTP 404", "acme/gone comments: HTTP 404"]);

  const r = await standup({ tracker: () => ({ tracker: t, label: "GitHub Issues" }) }).get(SINCE);
  assert.match(r.sources[0].error!, /^GitHub Issues: acme\/gone issue events: HTTP 404/);
  assert.ok(r.sources[0].done.length > 100);
});

test("jira: a changelog longer than search returns is read again for its newest page", async () => {
  const t = new JiraTracker(TMP, { kind: "jira", site: "acme.atlassian.net", projects: [] } as any);
  t._auth = () => ({ kind: "token", cred: "a@b:token123456" });
  const paths: string[] = [];
  t._get = async (_c: any, p: string, body?: any) => {
    paths.push(p);
    if (p === "/rest/api/3/myself") return { accountId: "me1" };
    if (p.startsWith("/rest/api/3/issue/ENG-1/changelog")) return { values: [{ author: { accountId: "me1" }, created: "2026-10-25T00:00:00.000+0000", items: [{ field: "status", fromString: "To Do", toString: "In Review" }] }] };
    if (/updatedBy/.test(body.jql)) return { issues: [{ key: "ENG-1", fields: { summary: "Long", status: { name: "In Review" } }, changelog: { total: 250, histories: [{ author: { accountId: "me1" }, created: "2025-01-01T00:00:00.000+0000", items: [] }] } }] };
    return { issues: [] };
  };
  const a = await t.activity(SINCE);
  assert.ok(paths.includes("/rest/api/3/issue/ENG-1/changelog?startAt=150&maxResults=100"));
  assert.deepEqual(a.changed.map((c) => c.what), [["moved To Do → In Review"]]);
});

test("Refresh reads the inbox again too; the answer is as old as its oldest cached part", async () => {
  let now = NOW;
  const forced: boolean[] = [];
  const s = standup({
    now: () => now, codeHost: () => ({ kind: "github" }), gh: async (args: string[]) => (args[1] === "user" ? { login: "me" } : []),
    inbox: async (force: boolean) => { forced.push(force); return { items: [], errors: [] }; },
  });
  const first = await s.get(SINCE);
  now += 60_000;
  const second = await s.get(SINCE);
  assert.equal(second.fetchedAt, first.fetchedAt, "served from the cache");
  await s.get(SINCE, true);
  assert.deepEqual(forced, [false, true]);
});

test("code host: when gh can't say who you are, reviews aren't guessed and the page says why", async () => {
  const s = standup({ codeHost: () => ({ kind: "github" }), gh: async (args: string[]) => {
    if (args[1] === "user") throw new Error("rate limited");
    if (args[0] === "search" && args.includes("--reviewed-by=@me")) return [{ number: 5, title: "x", repository: { nameWithOwner: "acme/api" }, url: "u", author: { login: "kim" } }];
    if (args[0] === "search") return [];
    throw new Error(`unexpected gh ${args.join(" ")}`);
  } });
  const c = (await s.get(SINCE)).sources.find((x) => x.id === "code")!;
  assert.deepEqual(c.done, []);
  assert.match(c.error!, /who you are .*rate limited/);
});

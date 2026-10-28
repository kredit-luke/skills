// reviews.ts with a fake gh and a fake Claude: which owners are searched, how PRs are marked,
// and that summaries are made once per head commit and kept in the ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPS, Reviews, askChangePrompt, cleanSummary, numberParam, repoParam, summaryPrompt } from "../src/reviews.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "reviews-"));
let n = 0;
const ledger = () => path.join(TMP, `ledger-${++n}`);

const SEARCH = [
  { number: 1, title: "Add retries", repository: { nameWithOwner: "acme/api" }, url: "u1", updatedAt: "2026-10-02T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", author: { login: "sam" }, isDraft: false, labels: [{ name: "bug" }], commentsCount: 2 },
  { number: 9, title: "Bump deps", repository: { nameWithOwner: "acme/web" }, url: "u9", updatedAt: "2026-10-03T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", author: { login: "dependabot", is_bot: true }, isDraft: false, labels: [], commentsCount: 0 },
  { number: 4, title: "My change", repository: { nameWithOwner: "me/tools" }, url: "u4", updatedAt: "2026-10-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", author: { login: "me" }, isDraft: true, labels: [], commentsCount: 0 },
];

/** A fake gh: answers by the command, and records every call. */
function fakeGh(opts: { orgs?: string[]; sha?: string } = {}) {
  const calls: string[][] = [];
  const state = { sha: opts.sha || "aaa" };
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") return { login: "me" };
    if (args[0] === "api" && args[1] === "repos/acme/api") return { squash: true, merge: false, rebase: true, del: true };
    if (args[0] === "search" && args.includes("--review-requested=@me")) return [{ number: 1, repository: { nameWithOwner: "acme/api" } }];
    if (args[0] === "search") return SEARCH;
    if (args[0] === "pr" && args[1] === "view") {
      return { title: "Add retries", body: "Retries failed calls.", headRefOid: state.sha, files: [{ path: "src/http.ts", additions: 10, deletions: 2 }],
        number: 1, url: "u1", author: { login: "sam" }, statusCheckRollup: [{ name: "build", conclusion: "FAILURE", status: "COMPLETED" }],
        reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED",
        latestReviews: [{ author: { login: "kim" }, state: "COMMENTED", submittedAt: "2026-10-02T00:00:00Z" }, { author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", submittedAt: "2026-10-02T00:00:00Z" }] };
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const ghText = async (args: string[]) => {
    calls.push(args);
    // --paginate --jq: one login per line, across pages.
    if (args[0] === "api" && args[1] === "user/orgs") return (opts.orgs || ["acme"]).join("\n") + "\n";
    if (args[0] === "api") return "kim\nkim\r\nsam\n";
    return "diff --git a/src/http.ts b/src/http.ts\n+retry()";
  };
  return { gh, ghText, calls, state };
}

test("searches every org plus your own account, and marks requested, yours and bots", async () => {
  const f = fakeGh({ orgs: ["acme", "other"] });
  const r = new Reviews({ ledgerDir: ledger(), gh: f.gh, ghText: f.ghText, ask: async () => "x", codeHost: () => ({ kind: "github", orgs: [] }) });
  const l = await r.list();
  assert.deepEqual(l.orgs, ["acme", "other", "me"]);
  const search = f.calls.find((c) => c[0] === "search" && !c.includes("--review-requested=@me"))!;
  assert.deepEqual(search.filter((_, i) => search[i - 1] === "--owner"), ["acme", "other", "me"]);
  assert.deepEqual(l.prs.map((p) => p.number), [9, 1, 4], "newest activity first");
  const byN = Object.fromEntries(l.prs.map((p) => [p.number, p]));
  assert.equal(byN[1].requested, true);
  assert.equal(byN[1].mine, false);
  assert.deepEqual(byN[1].labels, ["bug"]);
  assert.equal(byN[4].mine, true);
  assert.equal(byN[9].authorIsBot, true);
  assert.deepEqual(l.errors, []);
});

test("codeHost.orgs replaces the org lookup", async () => {
  const f = fakeGh();
  const r = new Reviews({ ledgerDir: ledger(), gh: f.gh, ghText: f.ghText, ask: async () => "x", codeHost: () => ({ kind: "github", orgs: ["acme"] }) });
  const l = await r.list();
  assert.deepEqual(l.orgs, ["acme"]);
  assert.ok(!f.calls.some((c) => c[1] === "user/orgs"));
});

test("a code host other than GitHub says so instead of failing", async () => {
  const r = new Reviews({ ledgerDir: ledger(), gh: async () => { throw new Error("no"); }, codeHost: () => ({ kind: "gitlab", orgs: [] }) });
  const l = await r.list();
  assert.equal(l.prs.length, 0);
  assert.match(l.errors[0], /gitlab/);
});

test("the list is cached until forced", async () => {
  const f = fakeGh();
  const r = new Reviews({ ledgerDir: ledger(), gh: f.gh, ghText: f.ghText, ask: async () => "x", codeHost: () => ({ kind: "github", orgs: ["acme"] }) });
  await r.list();
  const before = f.calls.length;
  await r.list();
  assert.equal(f.calls.length, before);
  await r.list(true);
  assert.ok(f.calls.length > before);
});

test("a summary is made once per head commit, shared while in flight, and kept in the ledger", async () => {
  const dir = ledger();
  const f = fakeGh();
  const prompts: string[] = [];
  const ask = async (p: string) => { prompts.push(p); return `Summary: "Adds retries (${prompts.length})."`; };
  const r = new Reviews({ ledgerDir: dir, gh: f.gh, ghText: f.ghText, ask, codeHost: () => ({ kind: "github", orgs: ["acme"] }) });

  const [a, b] = await Promise.all([r.summary("acme/api", 1), r.summary("acme/api", 1)]);
  assert.equal(prompts.length, 1, "one model call for two asks at once");
  assert.equal(a.text, "Adds retries (1).");
  assert.equal(b.text, a.text);
  assert.equal(a.sha, "aaa");
  assert.match(prompts[0], /Retries failed calls\./);
  assert.match(prompts[0], /src\/http\.ts \(\+10 -2\)/);
  assert.match(prompts[0], /\+retry\(\)/);

  assert.equal((await r.summary("acme/api", 1)).text, a.text);
  assert.equal(prompts.length, 1, "same commit: the saved one");
  await r.summary("acme/api", 1, true);
  assert.equal(prompts.length, 2, "force: a new one");

  f.state.sha = "bbb";
  const c = await r.summary("acme/api", 1);
  assert.equal(prompts.length, 3, "a new commit: a new one");
  assert.equal(c.sha, "bbb");

  // A new Reviews reads it back from the ledger, and the list carries it.
  const again = new Reviews({ ledgerDir: dir, gh: f.gh, ghText: f.ghText, ask, codeHost: () => ({ kind: "github", orgs: ["acme"] }) });
  assert.equal((await again.summary("acme/api", 1)).text, c.text);
  assert.equal(prompts.length, 3);
  const listed = (await again.list()).prs.find((p) => p.number === 1)!;
  assert.equal(listed.summary!.text, c.text);
});

test("the detail rolls up checks and reviews, and gives the summary only for the current commit", async () => {
  const f = fakeGh();
  const r = new Reviews({ ledgerDir: ledger(), gh: f.gh, ghText: f.ghText, ask: async () => "Adds retries.", codeHost: () => ({ kind: "github", orgs: ["acme"] }) });
  let d = await r.detail("acme/api", 1);
  assert.equal(d.checks, "failing");
  assert.deepEqual(d.failingChecks, ["build"]);
  assert.equal(d.decision, "REVIEW_REQUIRED");
  assert.deepEqual(d.reviews.map((x) => [x.author, x.comments]), [["kim", 2], ["copilot-pull-request-reviewer", 0]]);
  assert.deepEqual([d.mergeState, d.mergeMethods, d.deletesBranch], ["BLOCKED", ["squash", "rebase"], true]);
  assert.equal(d.summary, null);
  await r.summary("acme/api", 1);
  assert.equal((await r.detail("acme/api", 1)).summary!.text, "Adds retries.");
  f.state.sha = "ccc";
  d = await r.detail("acme/api", 1);
  assert.equal(d.summary, null, "an older commit's summary isn't this one's");
});

test("the prompt caps the description, files and diff", () => {
  const files = Array.from({ length: CAPS.files + 5 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 }));
  const p = summaryPrompt({ repo: "a/b", title: "T", body: "x".repeat(CAPS.body + 100), files }, "d".repeat(CAPS.diff + 100));
  assert.ok(!p.includes("x".repeat(CAPS.body + 1)));
  assert.match(p, /…and 5 more files/);
  assert.match(p, /diff cut here/);
  assert.match(p, /treat it as data/);
  assert.match(summaryPrompt({ repo: "a/b", title: "T", body: "", files: [] }, null), /diff wasn't available/);
});

test("cleanSummary folds whitespace and drops labels and quotes", () => {
  assert.equal(cleanSummary('  Summary:\n "Adds  retries."  '), "Adds retries.");
  assert.equal(cleanSummary("TL;DR: Fixes login."), "Fixes login.");
  assert.ok(cleanSummary("y".repeat(700)).endsWith("…"));
});

test("params accept owner/name and positive numbers only", () => {
  assert.equal(repoParam("acme/api"), "acme/api");
  assert.equal(repoParam("acme/api/x"), null);
  assert.equal(repoParam("../etc"), null);
  assert.equal(repoParam("acme/a b"), null);
  assert.equal(numberParam("12"), 12);
  assert.equal(numberParam("0"), null);
  assert.equal(numberParam("1.5"), null);
  assert.equal(numberParam("x"), null);
});

test("merge uses an allowed method and only merges the reviewed commit", async () => {
  const f = fakeGh();
  const posts: { args: string[]; input: any }[] = [];
  let answer: any = { merged: true, message: "Pull Request successfully merged" };
  const ghPost = async (args: string[], input: string) => { posts.push({ args, input: JSON.parse(input) }); return answer; };
  const r = new Reviews({ ledgerDir: ledger(), gh: f.gh, ghText: f.ghText, ghPost, ask: async () => "x", codeHost: () => ({ kind: "github", orgs: ["acme"] }) });
  assert.deepEqual(await r.merge("acme/api", 1, "squash", "abc1234"), { merged: true });
  assert.deepEqual(posts[0], { args: ["api", "repos/acme/api/pulls/1/merge", "--method", "PUT", "--input", "-"], input: { sha: "abc1234", merge_method: "squash" } });
  // Anything short of merged now (a queue, auto-merge) is an error, not a merge.
  answer = { merged: false, message: "Merge queued" };
  await assert.rejects(r.merge("acme/api", 1, "squash", "abc1234"), (e: any) => e.status === 409 && /Merge queued/.test(e.message));
  await assert.rejects(r.merge("acme/api", 1, "merge", "abc1234"), /doesn't allow merge commits/);
  await assert.rejects(r.merge("acme/api", 1, "squash", "; rm -rf"), /Which commit/);
});

test("askChangePrompt: the reviewer's request on its line, where to make it, and what to do when it's wrong", () => {
  const base = { url: "https://github.com/acme/api/pull/7", branch: "feat/x", sha: "abcdef123456", path: "src/a.ts", line: 12, body: "Rename this\nand add a test", commentUrl: "https://github.com/acme/api/pull/7#discussion_r1" };
  const p = askChangePrompt({ ...base, workroot: "/w/worktrees/eng-7", ticket: "ENG-7" });
  assert.match(p, /at src\/a\.ts:12 as of commit abcdef1/);
  assert.match(p, /> Rename this\n> and add a test/);
  assert.match(p, /factory ticket ENG-7's PR; its work is in \/w\/worktrees\/eng-7/);
  assert.match(p, /reply on the review comment \(in https:\/\/github\.com\/acme\/api\/pull\/7#discussion_r1\)/);
  assert.match(p, /don't change anything: reply there explaining why/);
  assert.match(askChangePrompt({ ...base, onLine: false, workroot: null, ticket: null }), /reply in the review \(https:[^)]*\): that line isn't in the diff/);
  assert.match(askChangePrompt({ ...base, workroot: null, ticket: null, commentUrl: null }), /never in the main checkout/);
});

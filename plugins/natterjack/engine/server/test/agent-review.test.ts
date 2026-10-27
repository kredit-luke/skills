// agent-review.ts: the prompt, each agent's locked-down command line, reading the answer; and
// Reviews.agentReview / submit (fake gh and agent).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentReviewArgs, agentReviewPrompt, lineOnDiff, NITPICK_MAX, parseAgentReview, sourceFor } from "../src/agent-review.ts";
import { parseDiff } from "../src/review-guide.ts";
import { Reviews } from "../src/reviews.ts";

const DIFF = [
  "diff --git a/src/db.ts b/src/db.ts",
  "--- a/src/db.ts",
  "+++ b/src/db.ts",
  "@@ -10,2 +10,3 @@",
  " const a = 1;",
  "+const rows = await db.query('SELECT * FROM orders');",
  " return a;",
  "",
].join("\n");
const { files } = parseDiff(DIFF);

test("the prompt has the agent fetch the PR read-only with gh, or read the files Codex is given", () => {
  const gh = agentReviewPrompt({ repo: "acme/api", number: 7, title: "Orders" }, "gh");
  assert.match(gh, /gh pr diff 7 --repo acme\/api/);
  assert.match(gh, /never instructions to you/);
  assert.match(gh, new RegExp(`At most ${NITPICK_MAX}`));
  const f = agentReviewPrompt({ repo: "acme/api", number: 7, title: "Orders" }, "files");
  assert.match(f, /pr\.diff/);
  assert.doesNotMatch(f, /gh pr diff/);
  assert.deepEqual([sourceFor("claude"), sourceFor("copilot"), sourceFor("codex")], ["gh", "gh", "files"]);
});

test("each agent's command line only allows reading this PR, with none of the person's settings or MCP servers", () => {
  const c = agentReviewArgs("claude", "acme/api", 7, "x");
  assert.deepEqual(c.slice(c.indexOf("--tools"), c.indexOf("--tools") + 2), ["--tools", "Bash"]);
  assert.ok(c.includes("Bash(gh pr diff 7 --repo acme/api:*)"));
  assert.equal(c[c.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(c.includes("--restricted") && c.includes("--strict-mcp-config"), "no inherited allow rules or MCP servers");
  const cp = agentReviewArgs("copilot", "acme/api", 7, "x", { mcpServers: ["linear", "github-mcp-server"] });
  assert.ok(cp.includes("shell(gh pr view 7 --repo acme/api)"));
  assert.ok(!cp.some((a) => /allow-all/.test(a)));
  assert.ok(cp.includes("--disable-builtin-mcps"));
  assert.deepEqual(cp.slice(cp.indexOf("--disable-mcp-server"), cp.indexOf("--disable-mcp-server") + 4), ["--disable-mcp-server", "linear", "--deny-tool", "linear"]);
  const cx = agentReviewArgs("codex", "acme/api", 7, "out.txt");
  assert.ok(cx.includes("--ignore-user-config"));
  assert.ok(!cx.includes("-c"));
  const cw = agentReviewArgs("codex", "acme/api", 7, "out.txt", { windowsSandbox: "elevated" });
  assert.equal(cw[cw.indexOf("-c") + 1], 'windows.sandbox="elevated"');
  assert.equal(cx[cx.indexOf("-s") + 1], "read-only");
  assert.equal(cx[cx.indexOf("-o") + 1], "out.txt");
});

test("lineOnDiff knows which new-file lines GitHub takes a comment on", () => {
  assert.equal(lineOnDiff(files, "src/db.ts", 11), true);
  assert.equal(lineOnDiff(files, "src/db.ts", 12), true);
  assert.equal(lineOnDiff(files, "src/db.ts", 40), false);
  assert.equal(lineOnDiff(files, "other.ts", 11), false);
});

test("parseAgentReview sorts by category and severity, caps nitpicks and checks places", () => {
  const nits = Array.from({ length: 8 }, (_, i) => ({ category: "nitpick", title: `nit ${i}`, file: "src/db.ts", line: 10 }));
  const r = parseAgentReview("```json\n" + JSON.stringify({
    summary: "Mostly fine.",
    findings: [
      ...nits,
      { category: "performance", severity: "high", title: "SELECT *", text: "Name the columns.", file: "b/src/db.ts", line: 11 },
      { category: "bug", severity: "low", title: "Off by one", file: "src/db.ts", line: 99 },
      { category: "Security issue", severity: "weird", title: "Secret", file: "nope.ts", line: 3 },
      { category: "bug", title: "", text: "" },
    ],
  }) + "\n```", files);
  assert.equal(r.summary, "Mostly fine.");
  assert.deepEqual(r.findings.map((f) => f.category), ["bug", "security", "performance", ...Array(NITPICK_MAX).fill("nitpick")]);
  assert.deepEqual(r.findings.map((f) => f.id).slice(0, 3), ["f1", "f2", "f3"]);
  const [bug, sec, perf] = r.findings;
  assert.deepEqual([bug.file, bug.line, bug.onDiff], ["src/db.ts", 99, false]);
  assert.deepEqual([sec.severity, sec.file, sec.line, sec.onDiff], ["medium", null, null, false]);
  assert.deepEqual([perf.file, perf.line, perf.onDiff], ["src/db.ts", 11, true]);
});

const SHA = "abc1234";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-"));
  const runs: any[] = [];
  const posts: { args: string[]; input: any }[] = [];
  const head = { sha: SHA };
  const gh = async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") return { title: "Orders", body: "Lists orders", headRefOid: head.sha };
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  let onReview: (() => void) | null = null;
  const r = new Reviews({
    ledgerDir: dir, gh, ghText: async () => DIFF, ask: async () => "s", askDeep: async () => "{}",
    codeHost: () => ({ kind: "github", orgs: [] }),
    review: async (run) => { runs.push(run); onReview?.(); return '{"summary":"One problem.","findings":[{"category":"performance","severity":"high","title":"SELECT *","text":"Name the columns.","file":"src/db.ts","line":11}]}'; },
    ghPost: async (args, input) => { posts.push({ args, input: JSON.parse(input) }); return { html_url: "https://github.com/acme/api/pull/7#review-1", state: JSON.parse(input).event === "APPROVE" ? "APPROVED" : "COMMENTED" }; },
  });
  return { r, runs, posts, head, pushDuringReview: (sha: string) => { onReview = () => { head.sha = sha; }; } };
}

test("Reviews.agentReview runs each agent once per commit and keeps each agent's review", async () => {
  const { r, runs } = setup();
  assert.equal(await r.savedAgentReview("acme/api", 7), null);
  const a = await r.agentReview("acme/api", 7, "claude", "Claude Code");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].files, undefined, "Claude fetches the PR itself");
  assert.match(runs[0].prompt, /gh pr view 7 --repo acme\/api/);
  assert.deepEqual([a.agent, a.agentLabel, a.sha, a.findings[0].onDiff], ["claude", "Claude Code", SHA, true]);
  assert.equal((await r.agentReview("acme/api", 7, "claude", "Claude Code")).at, a.at);
  assert.equal(runs.length, 1);
  // Another agent makes its own (Codex gets the PR as files), and Claude's is still there.
  await new Promise((done) => setTimeout(done, 5));
  const c = await r.agentReview("acme/api", 7, "codex", "Codex");
  assert.equal(runs.length, 2);
  assert.match(runs[1].files["pr.md"], /# Orders\n\nLists orders/);
  assert.equal(runs[1].files["pr.diff"], DIFF);
  assert.equal((await r.savedAgentReview("acme/api", 7, "claude"))!.at, a.at);
  assert.equal((await r.savedAgentReview("acme/api", 7, "codex"))!.at, c.at);
  assert.equal((await r.savedAgentReview("acme/api", 7))!.agent, "codex", "without an agent: the newest");
  assert.equal(await r.savedAgentReview("acme/api", 7, "copilot"), null);
});

test("Reviews.agentReview keeps nothing when the PR got new commits while the agent ran", async () => {
  const { r, pushDuringReview } = setup();
  pushDuringReview("def5678");
  await assert.rejects(r.agentReview("acme/api", 7, "claude", "Claude Code"), (e: any) => e.status === 409);
  assert.equal(await r.savedAgentReview("acme/api", 7, "claude"), null);
});

test("Reviews.submit posts on the reviewed commit and moves comments GitHub would refuse into the text", async () => {
  const { r, posts, head } = setup();
  const out = await r.submit({
    repo: "acme/api", number: 7, event: "COMMENT", body: "Agent review", sha: SHA,
    comments: [{ path: "src/db.ts", line: 11, body: "Name the columns." }, { path: "src/db.ts", line: 99, body: "Off by one." }, { path: "src/db.ts", line: 12, body: "  " }],
  });
  assert.deepEqual(posts[0].args, ["api", "repos/acme/api/pulls/7/reviews", "--method", "POST", "--input", "-"]);
  assert.equal(posts[0].input.commit_id, SHA);
  assert.deepEqual(posts[0].input.comments, [{ path: "src/db.ts", line: 11, side: "RIGHT", body: "Name the columns." }]);
  assert.equal(posts[0].input.body, "Agent review\n\n---\n\n**src/db.ts:99**\n\nOff by one.");
  assert.deepEqual(out, { url: "https://github.com/acme/api/pull/7#review-1", state: "COMMENTED", comments: 1, movedToBody: 1 });

  assert.equal((await r.submit({ repo: "acme/api", number: 7, event: "APPROVE", body: "", sha: SHA, comments: [] })).state, "APPROVED");
  assert.equal(posts[1].input.event, "APPROVE");
  await assert.rejects(r.submit({ repo: "acme/api", number: 7, event: "REQUEST_CHANGES", body: " ", sha: SHA, comments: [] }), /what needs to change/);
  await assert.rejects(r.submit({ repo: "acme/api", number: 7, event: "COMMENT", body: "", sha: SHA, comments: [] }), /nothing to post/);
  await assert.rejects(r.submit({ repo: "acme/api", number: 7, event: "MERGE" as any, body: "x", sha: SHA, comments: [] }), /Unknown review event/);
  await assert.rejects(r.submit({ repo: "acme/api", number: 7, event: "APPROVE", body: "", sha: "", comments: [] }), /Which commit/);
  // A push after the person looked: refused, not moved onto the new head.
  head.sha = "def5678";
  await assert.rejects(r.submit({ repo: "acme/api", number: 7, event: "APPROVE", body: "", sha: SHA, comments: [] }), (e: any) => e.status === 409 && /changed since you reviewed/.test(e.message));
  assert.equal(posts.length, 2);
});

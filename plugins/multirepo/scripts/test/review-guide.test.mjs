// review-guide.mjs: numbering a PR's hunks, checking the agent's guide, and the comment it posts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKER, findOwnGuide, fittingComment, guideComment, hunkLine, normalizeGuide, numberedDiff, parseDiff, readGuideComment, renderGuide } from "../review-guide.mjs";

const DIFF = [
  "diff --git a/src/api.ts b/src/api.ts",
  "index 1111111..2222222 100644",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -1,3 +1,4 @@ export function a() {",
  " const x = 1;",
  "+const y = 2;",
  " return x;",
  "@@ -10,2 +11,2 @@",
  "-old();",
  "+fresh();",
  "diff --git a/docs/my file.md b/docs/my file.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/my file.md",
  "@@ -0,0 +1,1 @@",
  "+# Hello",
  "diff --git \"a/caf\\303\\251.ts\" \"b/caf\\303\\251.ts\"",
  "deleted file mode 100644",
  "--- \"a/caf\\303\\251.ts\"",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
].join("\n");

test("hunks are numbered across the whole PR, in diff order, with paths unquoted", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.hunks.map((h) => h.id)]), [
    ["src/api.ts", "modified", ["h1", "h2"]],
    ["docs/my file.md", "added", ["h3"]],
    ["café.ts", "deleted", ["h4"]],
  ]);
  const text = numberedDiff(files);
  assert.match(text, /=== src\/api\.ts \[modified\]\n\[h1\] @@ -1,3 \+1,4 @@/);
  assert.match(text, /\[h4\] @@ -1 \+0,0 @@\n-gone/);
});

test("past the cap, later hunks are listed by id only", () => {
  const text = numberedDiff(parseDiff(DIFF), 60);
  assert.match(text, /\[h2\] @@ -10,2 \+11,2 @@ \(not shown: 2 lines\)/);
  assert.doesNotMatch(text, /fresh\(\)/);
});

const IDS = new Set(["h1", "h2", "h3", "h4"]);

test("a guide is checked: unknown hunks dropped and listed, every hunk tagged, core wins", () => {
  const { guide, dropped } = normalizeGuide({
    intent: " Retry deliveries. ",
    core: [{ title: "Retry", text: "Adds the retry.", hunks: ["h2", "h9", "h2"] }],
    supporting: [{ title: "Docs", text: "", hunks: ["h3"] }, { title: "", text: "" }],
    questions: ["Is 5 retries right?", 7, ""],
    tags: { h1: "formatting", h2: "test", h3: "nonsense" },
    minutes: 12.4,
  }, IDS);
  assert.deepEqual(dropped, ["h9"]);
  assert.equal(guide.intent, "Retry deliveries.");
  assert.deepEqual(guide.core, [{ title: "Retry", text: "Adds the retry.", hunks: ["h2"] }]);
  assert.equal(guide.supporting.length, 1);
  assert.deepEqual(guide.questions, ["Is 5 retries right?"]);
  assert.deepEqual(guide.tags, { h1: "formatting", h2: "core", h3: "supporting", h4: "supporting" });
  assert.equal(guide.minutes, 12);
  assert.deepEqual(guide.consequences, []);
  assert.throws(() => normalizeGuide({ questions: ["?"] }, IDS), /nothing to post/);
  assert.throws(() => normalizeGuide([], IDS), /JSON object/);
});

test("the comment links each hunk to its first changed line and round-trips its data", () => {
  const files = parseDiff(DIFF);
  const { guide } = normalizeGuide({ intent: "Why.", core: [{ title: "Core", text: "Does it.", hunks: ["h1"] }], questions: ["Check it?"] }, IDS);
  const ctx = { repo: "acme/api", number: 7, sha: "abcdef1234567890", files };
  const md = renderGuide(guide, ctx);
  assert.match(md, /1\. \*\*Core\*\*: Does it\. \(\[`src\/api\.ts:2`\]\(https:\/\/github\.com\/acme\/api\/pull\/7\/files#diff-[0-9a-f]{64}R2\)\)/);
  assert.match(md, /for abcdef1/);
  assert.match(md, /- \[ \] Check it\?/);
  const body = guideComment(guide, ctx);
  assert.ok(body.startsWith(`<!-- ${MARKER} sha=abcdef1234567890 -->`));
  assert.deepEqual(readGuideComment(body), { sha: "abcdef1234567890", guide });
  assert.equal(readGuideComment("<!-- natterjack:review-guide sha=abc1234 -->\nno data"), null);
  assert.equal(readGuideComment("hello"), null);
});

test("a hunk links to its first added line, or its first removed line when it only removes", () => {
  const [api, , gone] = parseDiff(DIFF);
  assert.deepEqual(hunkLine(api.hunks[0]), { side: "R", line: 2 });
  assert.deepEqual(hunkLine(api.hunks[1]), { side: "R", line: 11 }, "the removed line comes first, but the added one is linked");
  assert.deepEqual(hunkLine(gone.hunks[0]), { side: "L", line: 1 });
  const { guide } = normalizeGuide({ intent: "x", core: [{ title: "Gone", text: "", hunks: ["h4"] }] }, new Set(["h1", "h2", "h3", "h4"]));
  assert.match(renderGuide(guide, { repo: "acme/api", number: 7, files: parseDiff(DIFF) }), /\[`café\.ts:1 \(removed\)`\]\(https:\/\/github\.com\/acme\/api\/pull\/7\/files#diff-[0-9a-f]{64}L1\)/);
});

test("a guide that's too long is shortened to fit a comment", () => {
  const long = "x".repeat(2000);
  const raw = { intent: "Why.", ...Object.fromEntries(["core", "consequences", "supporting", "risk"].map((k) => [k, Array.from({ length: 12 }, () => ({ title: "t", text: long, hunks: [] }))])) };
  const { body, guide } = fittingComment(raw, IDS, { sha: "abcdef1" });
  assert.ok(body.length <= 65_000);
  assert.ok(guide.core[0].text.length < 2000);
});

test("only my own guide comment is updated, the newest one", () => {
  const head = `<!-- ${MARKER} sha=abc1234 -->`;
  const comments = [
    { id: 1, user: { login: "me" }, body: `${head}\nold` },
    { id: 2, user: { login: "someone" }, body: `${head}\ntheirs` },
    { id: 3, user: { login: "me" }, body: "a normal comment" },
    { id: 4, user: { login: "me" }, body: `${head}\nnewer` },
  ];
  assert.equal(findOwnGuide(comments, "me").id, 4);
  assert.equal(findOwnGuide(comments, "nobody"), null);
});

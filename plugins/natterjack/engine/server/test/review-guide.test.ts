// review-guide.ts: the diff parser, the numbered diff the prompts carry, reading the model's
// answers, and Reviews.guide / security saving one per head commit (fake gh and Claude).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitPath, jsonIn, numberedDiff, parseDiff, parseGuide, parseSecurity } from "../src/review-guide.ts";
import { Reviews } from "../src/reviews.ts";

const DIFF = [
  "diff --git a/src/http.ts b/src/http.ts",
  "index 111..222 100644",
  "--- a/src/http.ts",
  "+++ b/src/http.ts",
  "@@ -10,3 +10,4 @@ export function get() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+retry();",
  " return a;",
  "@@ -40,2 +41,2 @@",
  "-old()",
  "+fresh()",
  "\\ No newline at end of file",
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,2 @@",
  "+-- not a header",
  "+x",
  "diff --git a/old/name.ts b/new/name.ts",
  "similarity index 100%",
  "rename from old/name.ts",
  "rename to new/name.ts",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\r\n");

test("parseDiff reads files, statuses and numbered hunks with line numbers", () => {
  const d = parseDiff(DIFF);
  assert.deepEqual(d.files.map((f) => [f.path, f.status, f.binary]), [
    ["src/http.ts", "modified", false], ["new.ts", "added", false], ["new/name.ts", "renamed", false], ["logo.png", "modified", true],
  ]);
  assert.equal(d.files[2].oldPath, "old/name.ts");
  const [h1, h2] = d.files[0].hunks;
  assert.deepEqual([h1.id, h2.id, d.files[1].hunks[0].id], ["h1", "h2", "h3"]);
  assert.deepEqual(h1.lines.map((l) => [l.t, l.old, l.new]), [[" ", 10, 10], ["-", 11, null], ["+", null, 11], ["+", null, 12], [" ", 12, 13]]);
  assert.equal(h2.lines.length, 2, "the no-newline marker isn't a line");
  assert.equal(d.files[0].additions, 3);
  assert.equal(d.files[0].deletions, 2);
  assert.deepEqual(d.files[1].hunks[0].lines.map((l) => l.text), ["-- not a header", "x"]);
  assert.equal(d.truncated, false);
});

test("parseDiff decodes git's quoted paths (tabs, quotes, octal UTF-8 bytes), renames and paths with spaces", () => {
  const d = parseDiff([
    'diff --git "a/caf\\303\\251\\tmenu.ts" "b/caf\\303\\251\\tmenu.ts"',
    'index 1..2 100644',
    '--- "a/caf\\303\\251\\tmenu.ts"',
    '+++ "b/caf\\303\\251\\tmenu.ts"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
    'diff --git a/old "q".ts b/new "q".ts',
    "similarity index 100%",
    'rename from "old \\"q\\".ts"',
    'rename to "new \\"q\\".ts"',
    "diff --git a/my docs/read me.md b/my docs/read me.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/my docs/read me.md",
    "@@ -0,0 +1 @@",
    "+hi",
    "",
  ].join("\n"));
  assert.deepEqual(d.files.map((f) => [f.path, f.oldPath, f.status]), [
    ["café\tmenu.ts", null, "modified"],
    ['new "q".ts', 'old "q".ts', "renamed"],
    ["my docs/read me.md", null, "added"],
  ]);
  assert.equal(gitPath('"a\\\\b\\"c" rest').path, 'a\\b"c');
  assert.equal(gitPath('"a\\\\b\\"c" rest').rest, "rest");
});

test("parseDiff stops sending lines past the cap but still counts them", () => {
  const d = parseDiff(DIFF, 3);
  assert.equal(d.truncated, true);
  assert.equal(d.files.flatMap((f) => f.hunks.flatMap((h) => h.lines)).length, 3);
  assert.equal(d.files[0].additions, 3);
});

test("numberedDiff labels hunks and lists the ones past the cap by id", () => {
  const { files } = parseDiff(DIFF);
  const all = numberedDiff(files);
  assert.match(all, /\[h1\] @@ -10,3/);
  assert.match(all, /^\+retry\(\);$/m);
  assert.match(all, /=== new\/name\.ts \(renamed from old\/name\.ts\) \[renamed\]/);
  const cut = numberedDiff(files, 120);
  assert.match(cut, /\[h3\] .*\(not shown: 2 lines\)/);
});

test("jsonIn finds the object inside a fence or a sentence", () => {
  assert.deepEqual(jsonIn('Here:\n```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } });
  assert.throws(() => jsonIn("no json"), /no JSON/);
});

test("parseGuide drops unknown hunks, tags every hunk, and makes the core's hunks core", () => {
  const ids = new Set(["h1", "h2", "h3"]);
  const g = parseGuide(JSON.stringify({
    intent: " Adds retries. ",
    core: [{ title: "Retry", text: "Retries GETs", hunks: ["h2", "h9", "h2"] }],
    consequences: [{ title: "", text: "" }, { title: "Callers", text: "slower", hunks: "h1" }],
    risk: "nope",
    questions: ["Is 3 retries right?", 7, ""],
    tags: { h1: "test", h2: "supporting", h3: "weird" },
    minutes: 12.6,
  }), ids);
  assert.equal(g.intent, "Adds retries.");
  assert.deepEqual(g.core[0].hunks, ["h2"]);
  assert.deepEqual(g.consequences, [{ title: "Callers", text: "slower", hunks: [] }]);
  assert.deepEqual(g.risk, []);
  assert.deepEqual(g.supporting, []);
  assert.deepEqual(g.questions, ["Is 3 retries right?"]);
  assert.deepEqual(g.tags, { h1: "test", h2: "core", h3: "supporting" });
  assert.equal(g.minutes, 13);
});

test("parseSecurity keeps known severities and sorts worst first", () => {
  const s = parseSecurity(JSON.stringify({
    summary: "Two issues.",
    findings: [{ severity: "low", title: "Verbose error", hunks: ["h1"] }, { severity: "high", title: "SQL injection", text: "x", hunks: ["h2", "h7"] }, { severity: "bogus", title: "Odd" }],
  }), new Set(["h1", "h2"]));
  assert.deepEqual(s.findings.map((f) => [f.severity, f.title, f.hunks]), [["high", "SQL injection", ["h2"]], ["low", "Verbose error", ["h1"]], ["low", "Odd", []]]);
});

test("Reviews.guide and security are made once per head commit and kept in the ledger", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-guide-"));
  const state = { sha: "aaa" };
  const gh = async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") return { title: "PROJ-7 add retries", body: "b", author: { login: "sam" }, baseRefName: "main", headRefName: "feat/x", headRefOid: state.sha };
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  let diffs = 0;
  const ghText = async () => { diffs++; return DIFF; };
  const prompts: string[] = [];
  const askDeep = async (p: string) => {
    prompts.push(p);
    return p.startsWith("You are a security reviewer")
      ? '{"summary":"Fine.","findings":[]}'
      : '{"intent":"x","core":[{"title":"c","text":"t","hunks":["h1"]}],"questions":["q"],"tags":{},"minutes":5}';
  };
  const tickets: string[] = [];
  const ticket = async (text: string) => { tickets.push(text); return { id: "PROJ-7", title: "Retries", url: "https://t/PROJ-7", description: "Please add retries" }; };
  const make = () => new Reviews({ ledgerDir: dir, gh, ghText, askDeep, ticket, ask: async () => "s", codeHost: () => ({ kind: "github", orgs: [] }) });
  const r = make();

  assert.equal(await r.savedGuide("acme/api", 1), null);
  const [g, again] = await Promise.all([r.guide("acme/api", 1), r.guide("acme/api", 1)]);
  assert.equal(prompts.length, 1, "one model call for two asks at once");
  assert.equal(again, g);
  assert.deepEqual(g.ticket, { id: "PROJ-7", title: "Retries", url: "https://t/PROJ-7" });
  assert.equal(g.tags.h1, "core");
  assert.equal(g.sha, "aaa");
  assert.match(prompts[0], /Linked ticket PROJ-7: Retries\nPlease add retries/);
  assert.match(tickets[0], /PROJ-7 add retries feat\/x/);

  const s = await r.security("acme/api", 1);
  assert.equal(s.summary, "Fine.");
  assert.equal(prompts.length, 2);
  assert.equal(diffs, 1, "the diff is fetched once per commit");

  // Saved: a new Reviews answers from the ledger; force or a new commit makes a new one.
  const r2 = make();
  assert.equal((await r2.savedGuide("acme/api", 1))!.intent, "x");
  assert.equal((await r2.guide("acme/api", 1)).at, g.at);
  assert.equal(prompts.length, 2);
  await r2.guide("acme/api", 1, true);
  assert.equal(prompts.length, 3);
  state.sha = "bbb";
  assert.equal(await r2.savedSecurity("acme/api", 1), null);
  assert.equal((await r2.guide("acme/api", 1)).sha, "bbb");
  assert.equal(prompts.length, 4);
  assert.equal((await r2.diff("acme/api", 1)).sha, "bbb");
});

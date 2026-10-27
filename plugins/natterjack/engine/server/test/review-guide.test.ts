// review-guide.ts: the diff parser, the numbered diff the prompts carry, reading the model's
// answers, and Reviews.guide / security saving one per head commit (fake gh and Claude).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gitPath, jsonIn, numberedDiff, parseDiff, parseGuide, parseSecurity, postedGuides, readGuideComment } from "../src/review-guide.ts";
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
  const ghText = async (args: string[]) => { if (args[0] === "api") return ""; diffs++; return DIFF; };
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

// multirepo's review-guide skill posts a guide on the PR; the Reviews page shows it instead of writing one.
const guideBody = (sha: string, g: object) =>
  `<!-- natterjack:review-guide sha=${sha} -->\n## Review guide\n\n…\n<!-- natterjack:review-guide-data ${Buffer.from(JSON.stringify(g)).toString("base64")} -->`;

test("posted guides for a commit are read newest first, and checked", () => {
  const ids = new Set(["h1", "h2", "h3"]);
  const g = { intent: "Retries.", core: [{ title: "Retry", text: "t", hunks: ["h2", "h9"] }], questions: ["q?"], tags: { h1: "test" }, minutes: 4 };
  assert.deepEqual(readGuideComment(guideBody("abc1234", g))!.sha, "abc1234");
  assert.equal(readGuideComment("<!-- natterjack:review-guide sha=abc1234 -->\nno data"), null);
  const c = (body: string, by = "sam", updatedAt = "2026-10-27T10:00:00Z") => ({ body, url: `https://x/${by}`, by, updatedAt });
  const [found] = postedGuides([c(guideBody("abc1234", g))], "ABC1234ffff", ids);
  assert.equal(found.intent, "Retries.");
  assert.deepEqual(found.core[0].hunks, ["h2"]);
  assert.deepEqual(found.tags, { h1: "test", h2: "core", h3: "supporting" });
  assert.deepEqual(found.posted, { by: "sam", url: "https://x/sam" });
  assert.equal(found.at, "2026-10-27T10:00:00Z");
  // Another commit's, or data that won't read: none.
  assert.deepEqual(postedGuides([c(guideBody("0000000", g))], "abc1234ffff", ids), []);
  assert.deepEqual(postedGuides([c("<!-- natterjack:review-guide sha=abc1234 -->\n<!-- natterjack:review-guide-data bm90IGpzb24= -->")], "abc1234ffff", ids), []);
  // Newest first; an older comment edited since is the newest.
  assert.deepEqual(postedGuides([c(guideBody("abc1234", g), "old"), c(guideBody("abc1234", { ...g, intent: "Newer." }), "new")], "abc1234ffff", ids).map((x) => x.posted!.by), ["new", "old"]);
  assert.deepEqual(postedGuides([c(guideBody("abc1234", g), "edited", "2026-10-27T12:00:00Z"), c(guideBody("abc1234", g), "later", "2026-10-27T11:00:00Z")], "abc1234ffff", ids).map((x) => x.posted!.by), ["edited", "later"]);
});

test("Reviews shows a guide posted by someone with write access, the newer of it and one written here", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-guide-"));
  const state = { sha: "abc1234ffff", comments: 0, failDiff: false, updatedAt: "2000-01-01T00:00:00Z", intent: "Posted." };
  const perms: Record<string, string> = { bot: "write", reader: "read" };
  const gh = async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") return { title: "PROJ-7 t", body: "b", author: { login: "sam" }, baseRefName: "main", headRefName: "feat/x", headRefOid: state.sha };
    const perm = /^repos\/acme\/api\/collaborators\/([^/]+)\/permission$/.exec(args[1] || "");
    if (args[0] === "api" && perm) return { permission: perms[perm[1]] || "none" };
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const comment = (by: string, intent: string) => JSON.stringify({ body: guideBody("abc1234", { intent, core: [{ title: "c", text: "t", hunks: ["h1"] }] }), url: `https://gh/c/${by}`, by, updatedAt: state.updatedAt });
  const ghText = async (args: string[]) => {
    if (args[0] !== "api") { if (state.failDiff) throw new Error("diff too large"); return DIFF; }
    state.comments++;
    // A newer one by someone who can only read is passed over.
    return state.sha.startsWith("abc1234") ? `${comment("bot", state.intent)}\n${comment("reader", "Sneaky.")}\n` : "";
  };
  let asked = 0;
  const askDeep = async () => { asked++; return '{"intent":"Written.","core":[],"questions":[],"tags":{},"minutes":1}'; };
  const ticket = async () => ({ id: "PROJ-7", title: "Retries", url: "https://t/PROJ-7", description: "" });
  const make = () => new Reviews({ ledgerDir: dir, gh, ghText, askDeep, ticket, ask: async () => "s", codeHost: () => ({ kind: "github", orgs: [] }) });
  const r = make();
  const g = (await r.savedGuide("acme/api", 1))!;
  assert.equal(g.intent, "Posted.");
  assert.deepEqual(g.posted, { by: "bot", url: "https://gh/c/bot" });
  assert.deepEqual(g.ticket, { id: "PROJ-7", title: "Retries", url: "https://t/PROJ-7" });
  assert.equal((await r.guide("acme/api", 1)).intent, "Posted.");
  assert.equal(asked, 0);
  assert.equal(state.comments, 1, "kept for a minute");
  // Written again here, even within the same second as the comment's edit (GitHub's times are to the second): it shows.
  state.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  r.postedCache.clear();
  assert.equal((await r.guide("acme/api", 1, true)).intent, "Written.");
  assert.equal((await r.savedGuide("acme/api", 1))!.intent, "Written.");
  // The skill updates its comment later: that's newer, and shows once the minute is up.
  state.updatedAt = "2999-01-01T00:00:00Z";
  state.intent = "Posted again.";
  const r2 = make();
  assert.equal((await r2.savedGuide("acme/api", 1))!.intent, "Posted again.");
  // When reading it fails, there's no posted guide (not an error).
  state.failDiff = true;
  const r3 = make();
  assert.equal((await r3.savedGuide("acme/api", 1))!.intent, "Written.");
  // A new commit with none posted: none.
  state.sha = "def5678";
  assert.equal(await make().savedGuide("acme/api", 1), null);
});

// The skill numbers hunks itself; its ids must mean the same hunks here.
test("multirepo's review-guide script numbers hunks as the dashboard does", async (t) => {
  const script = path.join(import.meta.dirname, "..", "..", "..", "..", "multirepo", "scripts", "review-guide.mjs");
  if (!fs.existsSync(script)) return t.skip("no multirepo plugin next to this engine");
  const cli = await import(pathToFileURL(script).href);
  const mine = parseDiff(DIFF);
  const theirs = cli.parseDiff(DIFF);
  assert.deepEqual(theirs.map((f: any) => [f.path, f.status, f.hunks.map((h: any) => [h.id, h.header, h.newStart])]),
    mine.files.map((f) => [f.path, f.status, f.hunks.map((h) => [h.id, h.header, h.newStart])]));
  // What it posts reads back here.
  const { guide } = cli.normalizeGuide({ intent: "x", core: [{ title: "c", text: "t", hunks: ["h1"] }] }, new Set(["h1", "h2", "h3"]));
  const body = cli.guideComment(guide, { sha: "abc1234" });
  assert.equal(postedGuides([{ body, url: "u", by: "b", updatedAt: "t" }], "abc1234", new Set(["h1", "h2", "h3"]))[0].intent, "x");
});

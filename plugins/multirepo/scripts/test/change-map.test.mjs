// change-map.mjs: gathering a change, checking the agent's map against it, what each line is for, and the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build, bundleFiles, bundleName, classify, hunkIndex, localBundle, normalizeMap, numberedText, outputDir, parsePrRef, renderHtml, renderMarkdown, resolveRef, untestedBranches, untrackedDiff } from "../change-map.mjs";
import { parseDiff } from "../review-guide.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const API = [
  "diff --git a/src/api.ts b/src/api.ts",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -1,3 +1,14 @@ export class Api {",
  " import { a } from './a';",
  "+import { b } from './b';",
  " ",
  "+  /** Sends it, once. */",
  "+  async send(x) {",
  "+    if (!x) return null;",
  "+    try {",
  "+      return await post(x);",
  "+    } catch (e) {",
  "+      log(e);",
  "+    }",
  "+    audit(x);",
  "+  }",
  " }",
].join("\n");
const TEST = [
  "diff --git a/test/api.test.ts b/test/api.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/test/api.test.ts",
  "@@ -0,0 +1,2 @@",
  "+test('send', () => {});",
  "+test('empty', () => {});",
].join("\n");

const bundle = (parts = [{ repo: "api", files: parseDiff(API + "\n" + TEST) }]) => ({ source: "local", repos: parts.map((p) => ({ repo: p.repo, branch: "feat/ENG-7-send", base: "origin/main" })), skipped: [], files: bundleFiles(parts) });

const MAP = {
  title: "Send",
  summary: "Sends things.",
  nodes: [{ id: "send", layer: "server", file: "src/api.ts", symbol: "Api.send()", change: "added", hunks: ["h1"] }, { id: "post", layer: "server", file: "src/http.ts", symbol: "post()", change: "existing", hunks: [] }],
  edges: [{ from: "send", to: "post", kind: "calls" }],
  flows: [{
    id: "send", kind: "happy", title: "Send a thing", trigger: "A caller sends x.",
    steps: [{
      node: "send", title: "Posts it", text: "",
      code: [{ hunk: "h1", from: "async send", to: "return await post" }],
      branches: [
        { kind: "edge", title: "Nothing to send", text: "", code: [{ hunk: "h1", from: "if (!x)", to: "if (!x)" }], tests: [{ hunk: "h2", name: "empty" }] },
        { kind: "error", title: "Post fails", text: "", code: [{ hunk: "h1", from: "catch (e)", to: "log(e)" }], tests: [] },
      ],
    }],
  }],
  tags: { h2: "test" },
};

test("hunks are numbered across repos, and each file names its repo when there are several", () => {
  const files = bundleFiles([{ repo: "api", files: parseDiff(API) }, { repo: "web", files: parseDiff(TEST) }]);
  assert.deepEqual(files.map((f) => [f.repo, f.path, f.hunks.map((h) => h.id)]), [["api", "src/api.ts", ["h1"]], ["web", "test/api.test.ts", ["h2"]]]);
  const text = numberedText(files);
  assert.match(text, /=== api: src\/api\.ts \[modified\]\n\[h1\]/);
  assert.match(text, /=== web: test\/api\.test\.ts \[added\]\n\[h2\]/);
  assert.doesNotMatch(numberedText(bundleFiles([{ repo: "api", files: parseDiff(API) }])), /api: /);
});

test("an untracked file reads as an added file, spaces in its path included", () => {
  const [f] = parseDiff(untrackedDiff("docs/my notes.md", "# Hi\r\nthere\n"));
  assert.equal(f.path, "docs/my notes.md");
  assert.equal(f.status, "added");
  assert.deepEqual(f.hunks[0].lines, ["+# Hi", "+there"]);
});

test("a code reference is text on a line: from, to, after, or the whole hunk", () => {
  const hunks = hunkIndex(bundle());
  assert.deepEqual(resolveRef({ hunk: "h1", from: "async send", to: "return await" }, hunks), { hunk: "h1", a: 4, b: 7 });
  assert.deepEqual(resolveRef({ hunk: "h1", from: "+    if (!x)" }, hunks), { hunk: "h1", a: 5, b: 5 }, "the +/- prefix may be included");
  assert.deepEqual(resolveRef({ hunk: "h1", after: "catch", from: "}", to: "}" }, hunks), { hunk: "h1", a: 10, b: 10 });
  assert.deepEqual(resolveRef({ hunk: "h2" }, hunks), { hunk: "h2", a: 0, b: 1 });
  assert.match(resolveRef({ hunk: "h9" }, hunks).error, /no hunk h9/);
  assert.match(resolveRef({ hunk: "h1", from: "nope" }, hunks).error, /"nope" is on no line of h1/);
  assert.match(resolveRef({ hunk: "h1", from: "audit", to: "async send" }, hunks).error, /at or after "audit"/);
  assert.match(resolveRef({ hunk: "h1", from: "a\nb" }, hunks).error, /one line/);
});

test("a map is checked against the diff, and every problem is listed at once", () => {
  const hunks = hunkIndex(bundle());
  const bad = structuredClone(MAP);
  bad.nodes.push({ id: "ghost", layer: "x", hunks: ["h7"] });
  bad.edges.push({ from: "send", to: "nowhere" });
  bad.flows[0].steps[0].branches.push({ kind: "weird", title: "?" });
  bad.flows[0].steps[0].branches[0].tests.push({ hunk: "h8", name: "lost" });
  bad.flows[0].steps.push({ node: "nobody", title: "?" });
  bad.tags.h1 = "core";
  bad.tags.h5 = "test";
  const { errors } = normalizeMap(bad, hunks);
  for (const want of [/nodes\[ghost\]: no hunk h7/, /edges\[1\]: unknown node nowhere/, /branches\["\?"\]: kind must be/, /test in no hunk h8/, /steps\[2\]: unknown node nobody/, /tags\.h1: must be/, /tags\.h5: no such hunk/]) {
    assert.ok(errors.some((e) => want.test(e)), `${want} in ${JSON.stringify(errors, null, 1)}`);
  }
  const { map, errors: none } = normalizeMap(MAP, hunks);
  assert.deepEqual(none, []);
  assert.deepEqual(map.layers, [{ id: "server", title: "server" }], "layers come from the nodes when the map has none");
  assert.deepEqual(normalizeMap({}, hunks).errors, ["title: missing", "nodes: at least one node", "flows: at least one flow"]);
});

test("each added line's job: branches beat the happy path, comments join their code, the rest is tagged, glue or on no flow", () => {
  const hunks = hunkIndex(bundle());
  const { map } = normalizeMap(MAP, hunks);
  const { stats, unexplained } = classify(map, hunks);
  const cats = Object.fromEntries(hunks.h1.lines.map((l, i) => [l.s.trim(), hunks.h1.cat[i]]).filter(([, c]) => c));
  assert.equal(cats["import { b } from './b';"], "glue");
  assert.equal(cats["/** Sends it, once. */"], "happy", "a doc comment takes the category of the code under it");
  assert.equal(cats["async send(x) {"], "happy");
  assert.equal(cats["if (!x) return null;"], "edge", "a branch's line isn't the happy path's even inside its slice");
  assert.equal(cats["log(e);"], "error");
  assert.equal(cats["audit(x);"], "unexplained");
  assert.deepEqual(hunks.h2.cat, ["test", "test"]);
  assert.deepEqual(stats, { happy: 4, alt: 0, edge: 1, error: 2, test: 2, glue: 1, docs: 0, generated: 0, unexplained: 1 });
  assert.deepEqual(unexplained, [{ hunk: "h1", a: 11, b: 11 }]);
  assert.deepEqual(untestedBranches(map), ["error: Post fails (step 1)"]);
});

test("the page carries its data safely inside a script element", () => {
  const evil = structuredClone(MAP);
  evil.title = "</script><script>alert(1)</script>";
  const r = build(bundle(), evil, { template: "<script id=\"data\" type=\"application/json\">/*__DATA__*/null</script>", format: "both" });
  assert.equal(r.ok, true);
  assert.equal((r.html.match(/<\/script>/g) || []).length, 1, "only the template's own closing tag");
  const json = r.html.match(/>(.*)<\/script>$/s)[1];
  assert.equal(JSON.parse(json).map.title, evil.title);
  assert.doesNotMatch(r.md, /<script>/);
});

test("the shipped template has the data placeholder", () => {
  const html = renderHtml({ x: 1 });
  assert.match(html, /<script id="data" type="application\/json">\{"x":1\}<\/script>/);
});

test("markdown: weight line, a Mermaid diagram with branches counted per step, a list, and what no flow explains", () => {
  const r = build(bundle(), MAP, { format: "md" });
  assert.equal(r.html, null);
  assert.match(r.md, /\*\*Where the added lines go:\*\* happy path 4 · edge cases 1 · error handling 2 · tests 2 · glue 1 · on no flow 1/);
  assert.match(r.md, /```mermaid\nflowchart TD\n {2}s0\["1 · Posts it"\]\n {2}s0 -\.- b0\(\["1 edge case · 1 error · 1 untested"\]\)/);
  assert.match(r.md, /- Error: \*\*Post fails\*\*: {2}_\(no test\)_/);
  assert.match(r.md, /### Changed code on no flow[\s\S]*- `src\/api\.ts:12` `audit\(x\);`/);
});

test("build returns the map's errors instead of a page", () => {
  const r = build(bundle(), { ...MAP, flows: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["flows: at least one flow"]);
});

test("names: the ticket in the branch, else pr-<n>, else the branch; PR refs from short form or URL", () => {
  assert.equal(bundleName(bundle()), "ENG-7");
  assert.equal(bundleName({ source: "pr", repos: [{ number: 186, branch: "natterjack/run-denied" }] }), "pr-186");
  assert.equal(bundleName({ source: "local", repos: [{ branch: "spike/try this" }] }), "spike-try-this");
  assert.equal(bundleName({ source: "local", repos: [{ branch: "x" }] }, {}, { ticketId: "ABC-9" }), "ABC-9");
  assert.deepEqual(parsePrRef("acme/api#42"), { repo: "acme/api", number: 42 });
  assert.deepEqual(parsePrRef("https://github.com/acme/web.app/pull/7/files"), { repo: "acme/web.app", number: 7 });
  assert.equal(parsePrRef("42"), null);
});

test("the local change: committed, uncommitted and untracked work against the merge base, maps folder ignored", () => {
  const dir = tmp("change-map-");
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    git(dir, "checkout", "-qb", "feat/ENG-12-thing");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    git(dir, "commit", "-qam", "two");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(dir, "new file.js"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([1, 0, 2]));
    outputDir(path.join(dir, ".claude", "change-maps"));
    fs.writeFileSync(path.join(dir, ".claude", "change-maps", "x.html"), "<p>");

    const all = localBundle(dir);
    assert.equal(all.repos[0].base, "main");
    assert.equal(all.repos[0].branch, "feat/ENG-12-thing");
    const byPath = Object.fromEntries(all.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ["a.txt", "blob.bin", "new file.js"]);
    assert.deepEqual(byPath["a.txt"].hunks[0].lines.filter((l) => l[0] === "+"), ["+two", "+three"]);
    assert.deepEqual(byPath["new file.js"].hunks[0].lines, ["+export const x = 1;"]);
    assert.equal(byPath["blob.bin"].binary, true);
    assert.equal(bundleName(all), "ENG-12");

    const committed = localBundle(dir, { committed: true });
    assert.deepEqual(committed.files.map((f) => f.path), ["a.txt"]);
    assert.deepEqual(committed.files[0].hunks[0].lines.filter((l) => l[0] === "+"), ["+two"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review fixes: one unexplained block across blank lines, prototype keys, PR names, Mermaid labels, prose files", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts", "--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1,1 +1,5 @@",
    " keep();", "+foo();", "+", "+// why", "+bar();",
    "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1,1 +1,3 @@",
    " intro", "+# New section", "+* an item",
  ].join("\n");
  const b = { source: "local", repos: [{ repo: "x", branch: "main" }], skipped: [], files: bundleFiles([{ repo: "x", files: parseDiff(diff) }]) };
  const map = { title: "T", nodes: [{ id: "n", hunks: ["h1"] }], flows: [{ id: "f", title: "F", steps: [{ node: "n", title: "Line one\nand two", code: [{ hunk: "h1", from: "keep" }] }] }] };
  const r = build(b, map, { format: "md" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.unexplained, [{ hunk: "h1", a: 1, b: 4 }, { hunk: "h2", a: 1, b: 2 }], "foo..bar is one item; markdown headings and bullets aren't comments");
  assert.match(r.md, /s0\["1 · Line one and two"\]/, "one line, and no '1.' for Mermaid to read as a list");

  const hunks = hunkIndex(b);
  for (const key of ["toString", "constructor", "__proto__"]) assert.match(resolveRef({ hunk: key, from: "x" }, hunks).error, /no hunk/);
  const { errors } = normalizeMap({ ...map, tags: { toString: "test" }, nodes: [{ id: "n", hunks: ["constructor"] }] }, hunks);
  assert.ok(errors.includes("nodes[n]: no hunk constructor") && errors.includes("tags.toString: no such hunk"), JSON.stringify(errors));

  assert.equal(bundleName({ source: "pr", repos: [{ number: 42, branch: "fix/thing" }] }, {}, { ticketId: "ENG-1" }), "pr-42", "the worktree's ticket doesn't name another PR");
});

test("an edge kind is escaped on the page", () => {
  const html = fs.readFileSync(new URL("../change-map.html", import.meta.url), "utf-8");
  assert.doesNotMatch(html, /\$\{e\.kind\}/);
});

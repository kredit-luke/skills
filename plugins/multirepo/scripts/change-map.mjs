#!/usr/bin/env node
/**
 * change-map.mjs: the change-map skill's deterministic half. The agent (the change-map skill)
 * reads a change and writes a map of it: the flows it adds (the happy path, step by step), the
 * edge cases, errors and alternate outcomes branching off each step, and the files and symbols
 * they run through. This gathers the change for it, checks the map against the real diff, works
 * out what every added line is for (lines on no flow are found here, not by the model), and
 * renders the map as one self-contained HTML page (no network, opens from disk) or as Markdown
 * with a Mermaid diagram for a PR comment or an editor preview.
 *
 * Usage:
 *   node change-map.mjs diff [--root <dir>] [--base <branch>] [--committed] [--name <name>] [--dir <dir>]
 *       the local change: every repo of the workspace (or the one repo) against its base branch,
 *       uncommitted and untracked work included unless --committed
 *   node change-map.mjs diff <owner/name#n | PR url> [...] [--name <name>] [--dir <dir>]
 *       one or more pull requests (several: one ticket's PRs across repos), via gh
 *       Both write <dir>/<name>.diff.json (the bundle render reads) and <name>.diff.txt (the diff
 *       with each hunk labelled [h1], [h2]..., for the agent to read) and print
 *       { bundle, numbered, name, hunks, repos, skipped, omitted }. <dir> defaults to <root>/.claude/change-maps,
 *       which is kept out of git; <name> to the ticket in the branch, else the branch, else pr-<n>.
 *   node change-map.mjs render --diff <bundle.json> --map <map.json> [--format html|md|both] [--out <file>] [--open]
 *       checks the map and writes the page (default: next to the bundle, <name>.html / <name>.md).
 *       Prints { ok, out, stats, unexplained, untested }, or { ok: false, errors } and exits 1
 *       when the map points at something the diff doesn't have.
 *
 * Exits 2 on a usage error, 1 on any other failure.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBranch, findRoot, findTicket, git, gitRun, isMain, listRepos, parseArgs, readWorkspaceConfig, readWorktreeMeta, samePath, slash } from "./lib.mjs";
import { numberedDiff, parseDiff } from "./review-guide.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE = path.join(HERE, "change-map.html");
/** Untracked text files bigger than this are listed in `omitted`, not shown. */
const UNTRACKED_MAX = 2 * 1024 * 1024;
/** What a line is for, in the order the page lists them. */
export const CATEGORIES = ["happy", "alt", "edge", "error", "test", "glue", "docs", "generated", "unexplained"];
export const BRANCH_KINDS = ["edge", "error", "alt"];
export const TAGS = ["test", "glue", "docs", "generated"];
const FLOW_KINDS = ["user", "happy", "system"];
const NODE_CHANGES = ["added", "modified", "deleted", "existing"];
const ID_RE = /^[A-Za-z0-9_.-]{1,60}$/;

// ------------------------------------------------------------------ gathering the change

/** A new, untracked file as a unified diff, so it's read and mapped like any other added file. */
export function untrackedDiff(file, text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const q = /[\s"\\]/.test(file) ? JSON.stringify : (s) => s;
  return [`diff --git ${q("a/" + file)} ${q("b/" + file)}`, "new file mode 100644", "--- /dev/null", `+++ ${q("b/" + file)}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => "+" + l)].join("\n");
}

/** Files of several diffs (one per repo or PR) as one list, hunks numbered h1, h2... across all of them. */
export function bundleFiles(parts) {
  const files = [];
  let n = 0;
  for (const { repo, files: fs_ } of parts) {
    for (const f of fs_) {
      files.push({ ...f, repo, hunks: f.hunks.map((h) => ({ ...h, id: `h${++n}` })) });
    }
  }
  return files;
}

/** The diff as the agent reads it; with several repos, each file is named repo: path. */
export function numberedText(files) {
  const multi = new Set(files.map((f) => f.repo)).size > 1;
  return numberedDiff(files.map((f) => ({ ...f, path: multi ? `${f.repo}: ${f.path}` : f.path })));
}

/** One local repo's change against its base branch: { repo, base, head, branch, files } or { error }. */
export function localRepoDiff(repo, { base = null, committed = false } = {}) {
  const b = base || defaultBranch(repo.path, repo.defaultBranch);
  const ref = git(repo.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]) ? `origin/${b}` : b;
  const mb = git(repo.path, ["merge-base", "HEAD", ref]);
  if (!mb) return { repo: repo.name, error: `no common history with ${ref}` };
  const args = ["-c", "core.quotepath=on", "diff", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/", mb];
  if (committed) args.push("HEAD");
  const d = gitRun(repo.path, args, { trim: false, maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
  if (!d.ok) return { repo: repo.name, error: d.err };
  const texts = [d.out];
  const omitted = [];
  if (!committed) {
    const others = gitRun(repo.path, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false });
    for (const file of (others.out || "").split("\0").filter(Boolean)) {
      const full = path.join(repo.path, file);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (st.size > UNTRACKED_MAX) {
        omitted.push({ repo: repo.name, file: slash(file), why: `untracked, ${Math.round(st.size / 1024)} KB: too big to show` });
        continue;
      }
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) {
        texts.push(`diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files /dev/null and b/${file} differ`);
        continue;
      }
      texts.push(untrackedDiff(slash(file), buf.toString("utf-8")));
    }
  }
  return {
    repo: repo.name,
    base: ref,
    mergeBase: mb,
    head: git(repo.path, ["rev-parse", "HEAD"]) || null,
    branch: git(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"]) || null,
    files: parseDiff(texts.filter(Boolean).join("\n")),
    omitted,
  };
}

/** The local change across the workspace at root: the bundle (repos with no change are left out). */
export function localBundle(root, opts = {}) {
  const repos = listRepos(root).filter((r) => r.exists);
  if (!repos.length) throw new Error(`no git repos at ${root}`);
  const parts = [];
  const skipped = [];
  const omitted = [];
  for (const r of repos) {
    const d = localRepoDiff(r, opts);
    if (d.error) skipped.push({ repo: r.name, why: d.error });
    else {
      omitted.push(...d.omitted);
      if (d.files.length) parts.push(d);
    }
  }
  const files = bundleFiles(parts);
  return {
    source: "local",
    root,
    repos: parts.map(({ files: _f, omitted: _o, ...rest }) => rest),
    skipped,
    omitted,
    files,
  };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** owner/name#n or a GitHub PR URL → { repo, number }, or null. */
export function parsePrRef(s) {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(s);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  return short ? { repo: short[1], number: Number(short[2]) } : null;
}

/** One or more PRs as one bundle. */
export function prBundle(refs) {
  const parts = refs.map(({ repo, number }) => {
    const info = JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,headRefName,baseRefName,url,title"]));
    return { repo, number, url: info.url, title: info.title, base: info.baseRefName, head: info.headRefOid, branch: info.headRefName, files: parseDiff(gh(["pr", "diff", String(number), "--repo", repo])) };
  });
  return { source: "pr", repos: parts.map(({ files: _f, ...rest }) => rest), skipped: [], omitted: [], files: bundleFiles(parts) };
}

/** A file-safe name for the change: the ticket in a branch, else pr-<n> for PRs, else the branch. */
export function bundleName(bundle, config = {}, meta = null) {
  const branches = bundle.repos.map((r) => r.branch).filter(Boolean);
  // A worktree's own ticket names local work only: PRs may be another ticket's.
  const ticket = (bundle.source !== "pr" && meta?.ticketId) || findTicket(branches, config);
  const pr = bundle.source === "pr" && bundle.repos[0]?.number ? `pr-${bundle.repos[0].number}` : null;
  return safeName(ticket || pr || branches[0]);
}

/** A file-safe name: letters, digits, . _ -; never a dotfile (outputs listings skip those); at most 80 characters. */
export function safeName(raw) {
  return String(raw ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "change";
}

/** The output folder, created, with a .gitignore of its own so nothing in it is ever committed. */
export function outputDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return dir;
}

// ------------------------------------------------------------------ checking the map

/** The bundle's hunks by id, lines split into { t, s, n (new line), o (old line) }. */
export function hunkIndex(bundle) {
  const multi = new Set(bundle.files.map((f) => f.repo)).size > 1;
  // No prototype: a hunk id like "toString" or "__proto__" must look up nothing.
  const out = Object.create(null);
  for (const f of bundle.files) {
    for (const h of f.hunks) {
      let n = h.newStart, o = h.oldStart;
      const lines = h.lines.map((l) => {
        const t = l[0];
        const row = { t, s: l.slice(1), n: t === "-" ? null : n, o: t === "+" ? null : o };
        if (t !== "-") n++;
        if (t !== "+") o++;
        return row;
      });
      out[h.id] = { id: h.id, repo: multi ? f.repo : null, file: f.path, prose: PROSE.test(f.path), status: f.status, header: String(h.header).replace(/^@@[^@]*@@\s?/, ""), lines, cat: lines.map(() => null) };
    }
  }
  return out;
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * A code reference { hunk, from?, to?, after? } → { hunk, a, b }: lines a..b of the hunk.
 * from / to / after are text on a line (its +/-/space prefix may be included); the slice runs
 * from the first line holding `from` (searched after the line holding `after`, when given) to
 * the first line from there holding `to`. No `from`: the whole hunk.
 */
export function resolveRef(ref, hunks) {
  if (!ref || typeof ref !== "object") return { error: "not an object" };
  const h = hunks[ref.hunk];
  if (!h) return { error: `no hunk ${ref.hunk}` };
  const find = (needle, start) => h.lines.findIndex((l, i) => i >= start && (l.t + l.s).includes(needle));
  let start = 0;
  if (ref.after != null) {
    const at = find(String(ref.after), 0);
    if (at < 0) return { error: `"${ref.after}" is on no line of ${ref.hunk}` };
    start = at + 1;
  }
  if (ref.from == null || ref.from === "") return { hunk: h.id, a: 0, b: h.lines.length - 1 };
  if (/\n/.test(ref.from) || /\n/.test(ref.to ?? "")) return { error: "from and to are text on one line, not several" };
  const a = find(String(ref.from), start);
  if (a < 0) return { error: `"${ref.from}" is on no line of ${ref.hunk}${ref.after ? ` after "${ref.after}"` : ""}` };
  const b = ref.to == null || ref.to === "" ? a : find(String(ref.to), a);
  if (b < 0) return { error: `"${ref.to}" is on no line of ${ref.hunk} at or after "${ref.from}"` };
  return { hunk: h.id, a, b };
}

/** The agent's map, checked against the diff: { map, errors }. Every problem is listed, so it can fix them in one go. */
export function normalizeMap(raw, hunks) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const m = raw && typeof raw === "object" ? raw : {};
  const map = { title: str(m.title, 200), summary: str(m.summary, 2000), layers: [], nodes: [], edges: [], flows: [], tags: {} };
  if (!map.title) err("title", "missing");

  const nodeIds = new Set();
  for (const [i, n] of (Array.isArray(m.nodes) ? m.nodes : []).entries()) {
    const where = `nodes[${n?.id ?? i}]`;
    if (!n || !ID_RE.test(String(n.id ?? ""))) { err(where, "id must be letters, digits, _ . -"); continue; }
    if (nodeIds.has(n.id)) { err(where, "duplicate id"); continue; }
    nodeIds.add(n.id);
    const change = NODE_CHANGES.includes(n.change) ? n.change : "modified";
    const hs = (Array.isArray(n.hunks) ? n.hunks : []).filter((h) => (hunks[h] ? true : (err(where, `no hunk ${h}`), false)));
    map.nodes.push({ id: n.id, layer: str(n.layer, 60) || "code", file: str(n.file, 300), symbol: str(n.symbol, 120) || n.id, kind: str(n.kind, 30), change, hunks: [...new Set(hs)] });
  }
  if (!map.nodes.length) err("nodes", "at least one node");

  const layers = Array.isArray(m.layers) ? m.layers.filter((l) => l && ID_RE.test(String(l.id ?? ""))) : [];
  map.layers = layers.map((l) => ({ id: l.id, title: str(l.title, 60) || l.id }));
  for (const n of map.nodes) if (!map.layers.some((l) => l.id === n.layer)) map.layers.push({ id: n.layer, title: n.layer });

  for (const [i, e] of (Array.isArray(m.edges) ? m.edges : []).entries()) {
    if (!e || !nodeIds.has(e.from) || !nodeIds.has(e.to)) { err(`edges[${i}]`, `unknown node ${!e ? "" : nodeIds.has(e.from) ? e.to : e.from}`); continue; }
    map.edges.push({ from: e.from, to: e.to, kind: str(e.kind, 30) || "calls" });
  }

  const refs = (list, where) => (Array.isArray(list) ? list : []).flatMap((c, i) => {
    const r = resolveRef(c, hunks);
    if (r.error) { err(`${where}.code[${i}]`, r.error); return []; }
    return [r];
  });
  const flowIds = new Set();
  for (const [fi, f] of (Array.isArray(m.flows) ? m.flows : []).entries()) {
    const fw = `flows[${f?.id ?? fi}]`;
    if (!f || !ID_RE.test(String(f.id ?? "")) || flowIds.has(f.id)) { err(fw, "needs a unique id"); continue; }
    flowIds.add(f.id);
    const flow = { id: f.id, kind: FLOW_KINDS.includes(f.kind) ? f.kind : "happy", title: str(f.title, 200), trigger: str(f.trigger, 1000), steps: [] };
    if (!flow.title) err(fw, "title missing");
    for (const [si, s] of (Array.isArray(f.steps) ? f.steps : []).entries()) {
      const sw = `${fw}.steps[${si + 1}]`;
      if (!s || !nodeIds.has(s.node)) { err(sw, `unknown node ${s?.node}`); continue; }
      const step = { node: s.node, title: str(s.title, 200), text: str(s.text, 1000), code: refs(s.code, sw), branches: [] };
      if (!step.title) err(sw, "title missing");
      for (const [bi, b] of (Array.isArray(s.branches) ? s.branches : []).entries()) {
        const bw = `${sw}.branches[${b?.title ? JSON.stringify(b.title) : bi}]`;
        if (!b || !BRANCH_KINDS.includes(b.kind)) { err(bw, `kind must be ${BRANCH_KINDS.join(", ")}`); continue; }
        const tests = (Array.isArray(b.tests) ? b.tests : []).filter((t) => (t && hunks[t.hunk] ? true : (err(bw, `test in no hunk ${t?.hunk}`), false)))
          .map((t) => ({ hunk: t.hunk, name: str(t.name, 200) || "a test" }));
        step.branches.push({ kind: b.kind, title: str(b.title, 160) || "(untitled)", text: str(b.text, 1000), note: str(b.note, 400), code: refs(b.code, bw), tests });
      }
      flow.steps.push(step);
    }
    if (!flow.steps.length) err(fw, "at least one step");
    map.flows.push(flow);
  }
  if (!map.flows.length) err("flows", "at least one flow");

  for (const [h, tag] of Object.entries(m.tags && typeof m.tags === "object" ? m.tags : {})) {
    if (!hunks[h]) err(`tags.${h}`, "no such hunk");
    else if (!TAGS.includes(tag)) err(`tags.${h}`, `must be ${TAGS.join(", ")}`);
    else map.tags[h] = tag;
  }
  return { map, errors };
}

// ------------------------------------------------------------------ what each line is for

/** Structure, not behaviour: blank lines and closers ("});", "</div>", "}"). */
const TRIVIAL = /^\s*(?:[})\];,]*|<\/[\w.-]+>\s*)\s*$/;
const IMPORT = /^\s*(?:import\b|export\s+(?:type\s+)?\{[^}]*\}\s+from\b|using\s+[\w.]+;|require\(|from\s+[\w.]+\s+import\b|#include\b)/;
/** Comment lines take the category of the code they sit on: the next added line that has one. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$)|<!--|#(?![\w-]*\s*[=(:{]))/;
/** Prose files: a "#" or "*" there is a heading or a bullet, not a comment. */
const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
const isComment = (h, s) => !h.prose && COMMENT.test(s);

/**
 * Sets every added line's category on hunks (in place) and counts them. Branch slices claim
 * lines first (they're the more specific), then the happy steps; comments join the code under
 * them; what's left takes its hunk's tag, or is glue (imports), trivial (closers, blanks), or
 * unexplained: changed code no flow reaches.
 * Returns { stats, unexplained: [{ hunk, a, b }] }.
 */
export function classify(map, hunks) {
  const claim = (r, cat) => { const h = hunks[r.hunk]; for (let i = r.a; i <= r.b; i++) if (h.lines[i].t === "+" && !h.cat[i]) h.cat[i] = cat; };
  for (const f of map.flows) for (const s of f.steps) for (const b of s.branches) b.code.forEach((r) => claim(r, b.kind));
  for (const f of map.flows) for (const s of f.steps) s.code.forEach((r) => claim(r, "happy"));
  for (const h of Object.values(hunks)) {
    let next = null;
    for (let i = h.lines.length - 1; i >= 0; i--) {
      const l = h.lines[i];
      if (l.t !== "+") continue;
      if (h.cat[i]) next = h.cat[i];
      else if (isComment(h, l.s) && next) h.cat[i] = next;
      else if (!TRIVIAL.test(l.s)) next = null;
    }
  }
  const stats = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const unexplained = [];
  for (const h of Object.values(hunks)) {
    let run = null;
    h.lines.forEach((l, i) => {
      if (l.t !== "+") { run = null; return; }
      if (!h.cat[i]) h.cat[i] = map.tags[h.id] || (TRIVIAL.test(l.s) ? "trivial" : IMPORT.test(l.s) ? "glue" : isComment(h, l.s) ? "trivial" : "unexplained");
      if (h.cat[i] in stats) stats[h.cat[i]]++;
      if (h.cat[i] === "unexplained") {
        // A run carries over blank lines, closers and comments (they don't reset it), so one block is one item.
        if (run) run.b = i;
        else unexplained.push((run = { hunk: h.id, a: i, b: i }));
      } else if (h.cat[i] !== "trivial") run = null;
    });
  }
  return { stats, unexplained };
}

/** Branches with no test: "title (step n of flow)". */
export function untestedBranches(map) {
  return map.flows.flatMap((f) => f.steps.flatMap((s, i) => s.branches.filter((b) => !b.tests.length).map((b) => `${b.kind}: ${b.title} (step ${i + 1}${map.flows.length > 1 ? ` of ${f.title}` : ""})`)));
}

// ------------------------------------------------------------------ rendering

/** Everything the page needs, as one object. */
export function pageData(bundle, map, hunks, { stats, unexplained }, now = new Date()) {
  const added = Object.values(hunks).reduce((n, h) => n + h.lines.filter((l) => l.t === "+").length, 0);
  const removed = Object.values(hunks).reduce((n, h) => n + h.lines.filter((l) => l.t === "-").length, 0);
  return {
    source: { kind: bundle.source, repos: bundle.repos.map((r) => ({ name: r.repo, base: r.base, head: r.head, branch: r.branch, number: r.number ?? null, url: r.url ?? null })), files: bundle.files.length, added, removed },
    map, hunks, stats, unexplained, generatedAt: now.toISOString(),
  };
}

/** The page: the template with the data inlined (safe inside a <script> element). */
export function renderHtml(data, template = fs.readFileSync(TEMPLATE, "utf-8")) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return template.replace("/*__DATA__*/null", () => json);
}

const LABELS = { happy: "happy path", alt: "alternate outcomes", edge: "edge cases", error: "error handling", test: "tests", glue: "glue", docs: "docs", generated: "generated", unexplained: "on no flow" };
const KIND_LABEL = { edge: "Edge case", error: "Error", alt: "Alternate" };
const BRANCH_PLURAL = { edge: ["edge case", "edge cases"], error: ["error", "errors"], alt: ["alternate", "alternates"] };
const mermaidText = (s) => String(s).replace(/\s+/g, " ").replace(/`/g, "").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").slice(0, 90);
const mdText = (s) => String(s).replace(/\s*\n\s*/g, " ").replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));

/** Markdown: the weight line, each flow as a Mermaid diagram plus a list, and what no flow explains. */
export function renderMarkdown(data) {
  const { map, stats, hunks, unexplained } = data;
  const nodes = Object.fromEntries(map.nodes.map((n) => [n.id, n]));
  const base = (p) => p.split("/").pop();
  const branches = map.flows.flatMap((f) => f.steps.flatMap((s) => s.branches));
  const out = [`## Change map: ${mdText(map.title)}`, ""];
  if (map.summary) out.push(mdText(map.summary), "");
  out.push(`**Where the added lines go:** ${CATEGORIES.filter((c) => stats[c]).map((c) => `${LABELS[c]} ${stats[c]}`).join(" · ")}`);
  out.push(`**Branches:** ${branches.length} off ${map.flows.reduce((n, f) => n + f.steps.length, 0)} steps, ${branches.filter((b) => b.tests.length).length} with a test.`, "");
  for (const f of map.flows) {
    out.push(`### ${mdText(f.title)}`, "");
    if (f.trigger) out.push(mdText(f.trigger), "");
    out.push("```mermaid", "flowchart TD");
    f.steps.forEach((s, i) => {
      out.push(`  s${i}["${i + 1} · ${mermaidText(s.title)}"]`);
      if (i) out.push(`  s${i - 1} --> s${i}`);
      // One node per step for its branches, counted by kind (the list below names them): one node
      // per branch makes a diagram too wide to read in a PR comment.
      const counts = BRANCH_KINDS.map((k) => [k, s.branches.filter((b) => b.kind === k).length]).filter(([, n]) => n);
      if (counts.length) {
        const untested = s.branches.filter((b) => !b.tests.length).length;
        const label = counts.map(([k, n]) => `${n} ${BRANCH_PLURAL[k][n > 1 ? 1 : 0]}`).join(" · ") + (untested ? ` · ${untested} untested` : "");
        out.push(`  s${i} -.- b${i}(["${label}"])`, `  class b${i} branch`);
      }
    });
    out.push("  classDef branch stroke-dasharray:4 3", "```", "");
    f.steps.forEach((s, i) => {
      const n = nodes[s.node];
      const hs = [...new Set(s.code.map((r) => r.hunk))];
      out.push(`${i + 1}. **${mdText(s.title)}** · \`${base(n.file || n.symbol)}\` › \`${n.symbol}\`${hs.length ? ` (${hs.join(", ")})` : ""}${s.text ? `  \n   ${mdText(s.text)}` : ""}`);
      for (const b of s.branches) out.push(`   - ${KIND_LABEL[b.kind]}: **${mdText(b.title)}**: ${mdText(b.text)} ${b.tests.length ? "_(tested)_" : "_(no test)_"}`);
    });
    out.push("");
  }
  if (unexplained.length) {
    out.push("### Changed code on no flow", "", "Either a flow is missing or the code isn't needed.", "");
    for (const r of unexplained) {
      const h = hunks[r.hunk];
      const l = h.lines[r.a];
      out.push(`- \`${h.repo ? h.repo + ": " : ""}${h.file}:${l.n}\` \`${l.s.trim().slice(0, 80).replace(/`/g, "'")}\`${r.b > r.a ? ` and ${r.b - r.a} more line${r.b - r.a > 1 ? "s" : ""}` : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * In a Natterjack dashboard run (DASHBOARD_OUTPUTS names the run's outputs folder), writes the page
 * there as <name>.change-map.html, which the run page shows in its Map tab. Returns its path, or
 * null outside a dashboard run or when the folder can't be written; never throws. `written` is the
 * page render already wrote: when that's in the outputs folder under a change-map name, it's the one.
 */
export function copyToOutputs(html, name, dir = process.env.DASHBOARD_OUTPUTS, written = null) {
  if (!dir) return null;
  try {
    if (written && samePath(path.dirname(written), dir) && /\.change-map\.html$/i.test(written)) return written;
    const file = path.join(dir, `${safeName(String(name).replace(/\.change-map$/i, ""))}.change-map.html`);
    fs.writeFileSync(file, html);
    return file;
  } catch {
    return null;
  }
}

/** Opens a file in the default browser; never throws. */
export function openFile(file) {
  try {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {}); // a missing opener (no xdg-open) is reported here, not thrown
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ CLI

function usage(msg) { return Object.assign(new Error(msg), { usage: true }); }

/** The whole render step, for the CLI and tests: { ok, errors } or { ok, data, html?, md? }. */
export function build(bundle, rawMap, { format = "html", template, now } = {}) {
  const hunks = hunkIndex(bundle);
  const { map, errors } = normalizeMap(rawMap, hunks);
  if (errors.length) return { ok: false, errors };
  const result = classify(map, hunks);
  const data = pageData(bundle, map, hunks, result, now);
  return {
    ok: true,
    data,
    html: format === "md" ? null : renderHtml(data, template),
    md: format === "html" ? null : renderMarkdown(data),
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest, { booleans: ["committed", "open"] });
  if (cmd === "diff") {
    const refs = args._.map(parsePrRef);
    if (refs.some((r) => !r)) throw usage(`not a PR: ${args._[refs.indexOf(null)]} (use owner/name#n or its URL)`);
    const root = findRoot(args.root && args.root !== true ? args.root : process.cwd());
    const bundle = refs.length ? prBundle(refs) : localBundle(root, { base: typeof args.base === "string" ? args.base : null, committed: !!args.committed });
    const name = typeof args.name === "string" ? safeName(args.name) : bundleName(bundle, readWorkspaceConfig(root), readWorktreeMeta(root));
    const dir = outputDir(path.resolve(typeof args.dir === "string" ? args.dir : path.join(root, ".claude", "change-maps")));
    const file = path.join(dir, `${name}.diff.json`);
    const numbered = path.join(dir, `${name}.diff.txt`);
    fs.writeFileSync(file, JSON.stringify(bundle));
    const notShown = (bundle.omitted || []).map((o) => `${o.repo}: ${o.file} (${o.why})`);
    fs.writeFileSync(numbered, numberedText(bundle.files) + (notShown.length ? `\n\n=== Not shown\n${notShown.join("\n")}\n` : ""));
    const hunkCount = bundle.files.reduce((n, f) => n + f.hunks.length, 0);
    console.log(JSON.stringify({ bundle: file, numbered, name, hunks: hunkCount, repos: bundle.repos.map((r) => ({ repo: r.repo, base: r.base, branch: r.branch, files: bundle.files.filter((f) => f.repo === r.repo).length })), skipped: bundle.skipped, omitted: bundle.omitted || [] }, null, 2));
    if (!hunkCount) process.stderr.write("No changes to map.\n");
    return 0;
  }
  if (cmd === "render") {
    if (typeof args.diff !== "string" || typeof args.map !== "string") throw usage("render needs --diff <bundle.json> --map <map.json>");
    const format = typeof args.format === "string" ? args.format : "html";
    if (!["html", "md", "both"].includes(format)) throw usage("--format is html, md or both");
    const bundle = JSON.parse(fs.readFileSync(args.diff, "utf-8"));
    let rawMap;
    try { rawMap = JSON.parse(fs.readFileSync(args.map, "utf-8")); } catch (e) { console.log(JSON.stringify({ ok: false, errors: [`map: ${e.message}`] }, null, 2)); return 1; }
    const r = build(bundle, rawMap, { format });
    if (!r.ok) { console.log(JSON.stringify({ ok: false, errors: r.errors }, null, 2)); return 1; }
    const stem = typeof args.out === "string" ? args.out.replace(/\.(html|md)$/i, "") : args.diff.replace(/\.diff\.json$/i, "").replace(/\.json$/i, "");
    const out = {};
    if (r.html) fs.writeFileSync((out.html = path.resolve(stem + ".html")), r.html);
    if (r.md) fs.writeFileSync((out.md = path.resolve(stem + ".md")), r.md);
    // In a Natterjack dashboard run, a copy in the run's outputs folder is what its run page's Map tab shows.
    if (r.html) out.dashboard = copyToOutputs(r.html, path.basename(stem), process.env.DASHBOARD_OUTPUTS, out.html);
    const opened = args.open && out.html ? openFile(out.html) : false;
    const { stats, unexplained, hunks, map } = r.data;
    console.log(JSON.stringify({
      ok: true,
      out,
      opened,
      stats,
      unexplained: unexplained.map((u) => { const h = hunks[u.hunk]; return `${h.repo ? h.repo + ": " : ""}${h.file}:${h.lines[u.a].n} ${h.lines[u.a].s.trim().slice(0, 80)}${u.b > u.a ? ` (+${u.b - u.a} lines)` : ""}`; }),
      untested: untestedBranches(map),
    }, null, 2));
    return 0;
  }
  throw usage("usage: change-map.mjs diff [<pr>...] [--root <dir>] [--base <branch>] [--committed] | render --diff <bundle.json> --map <map.json> [--format html|md|both] [--out <file>] [--open]");
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.usage ? e.message : `change-map: ${e.stderr ? String(e.stderr).trim() : e.message}`);
    process.exitCode = e.usage ? 2 : 1;
  }
}

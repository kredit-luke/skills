#!/usr/bin/env node
/**
 * review-guide.mjs: the factory's guide stage, the deterministic half. The agent (the
 * review-guide skill) writes the guide; this numbers the PR's hunks for it to point at, checks
 * what it wrote, and posts it as one comment on the PR, which later runs update in place.
 *
 * Hunks are numbered h1, h2... in `gh pr diff` order, the same way the Natterjack dashboard's
 * Reviews page numbers them, so the dashboard shows a posted guide instead of writing its own.
 * The comment starts with a marker naming the commit it was written for, and ends with the guide
 * as data (base64 JSON in an HTML comment) for the dashboard to read.
 *
 * Usage:
 *   node review-guide.mjs diff --repo <owner/name> --pr <n>
 *       { repo, number, sha, title, body, base, head, hunks: [ids], numbered }: the numbered diff to write the guide from
 *   node review-guide.mjs post --repo <owner/name> --pr <n> --sha <sha> --file <guide.json> [--ticket <id>]
 *       checks the guide, posts it (or updates the one posted before): { url, updated, dropped }
 *       --ticket  record it as the ticket's guide stage on the Factory board (--root: the workspace
 *                 or WORKROOT, default the current folder; --stage-repo: the repo's name there,
 *                 default the PR repo's name)
 *   node review-guide.mjs render --file <guide.json> [--repo <owner/name> --pr <n> --sha <sha>]
 *       the comment's markdown, without posting it
 *
 * Exits 3 when the PR has moved on from --sha (write the guide again for the new commits), 2 on
 * a usage error, 1 on any other failure.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMain, parseArgs } from "./lib.mjs";
import { update } from "./factory.mjs";

export const MARKER = "natterjack:review-guide";
/** What the agent is shown at most of the numbered diff (later hunks are listed by id only). */
export const DIFF_CAP = 150_000;
/** GitHub's comment limit, with room to spare. */
const COMMENT_MAX = 65_000;
const TAGS = ["core", "supporting", "test", "generated", "formatting"];
const LISTS = ["core", "consequences", "supporting", "risk"];
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

// ------------------------------------------------------------------ the diff

/** A path as git prints it: plain, or C-quoted ("caf\303\251 x.ts"). Returns it and the text after it. */
function gitPath(s) {
  if (!s.startsWith('"')) {
    const sp = s.indexOf(" ");
    return sp < 0 ? { path: s, rest: "" } : { path: s.slice(0, sp), rest: s.slice(sp + 1) };
  }
  const bytes = [];
  const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  let i = 1;
  for (; i < s.length && s[i] !== '"'; i++) {
    if (s[i] !== "\\") { bytes.push(...Buffer.from(s[i], "utf-8")); continue; }
    const oct = /^[0-7]{3}/.exec(s.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const c = s[++i];
    bytes.push(c in ESC ? ESC[c] : c.charCodeAt(0));
  }
  return { path: Buffer.from(bytes).toString("utf-8"), rest: s.slice(i + 2) };
}

const unquote = (s) => (s.startsWith('"') ? gitPath(s).path : s);

/** A `diff --git` header's new path, quoted or not. */
function headerPath(rest) {
  if (rest.startsWith('"')) return gitPath(gitPath(rest).rest).path.replace(/^b\//, "");
  const m = rest.match(/^a\/(.*) ("?)b\/(.*)$/);
  if (!m) return rest;
  return m[2] ? gitPath(`"b/${m[3]}`).path.replace(/^b\//, "") : m[3];
}

/**
 * A unified diff as files and hunks, numbered h1, h2... in order: the dashboard's numbering
 * (server/src/review-guide.ts parseDiff), so a guide's hunk ids mean the same hunks there.
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let count = 0;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      file = { path: headerPath(line.slice(11)), oldPath: null, status: "modified", binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk || !/^[ +\-\\]/.test(line)) {
      if (line.startsWith("new file mode")) { file.status = "added"; continue; }
      if (line.startsWith("deleted file mode")) { file.status = "deleted"; continue; }
      if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = unquote(line.slice(12)); continue; }
      if (line.startsWith("rename to ")) { file.path = unquote(line.slice(10)); continue; }
      if (line.startsWith("Binary files ") || line === "GIT binary patch") { file.binary = true; continue; }
    }
    if (!hunk && line.startsWith("+++ ")) {
      const p = unquote(line.slice(4));
      if (p !== "/dev/null") file.path = p.replace(/^[ab]\//, "");
      continue;
    }
    if (!hunk && line.startsWith("--- ")) continue;
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      hunk = { id: `h${++count}`, header: line, oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line[0] === "+" || line[0] === "-" || line[0] === " ") hunk.lines.push(line);
  }
  return files;
}

/** The diff as the agent reads it: each hunk labelled with its id; past `cap` characters, later hunks by id only. */
export function numberedDiff(files, cap = DIFF_CAP) {
  const out = [];
  let size = 0;
  let cut = false;
  for (const f of files) {
    const head = `=== ${f.path}${f.oldPath ? ` (renamed from ${f.oldPath})` : ""} [${f.status}${f.binary ? ", binary" : ""}]`;
    out.push(head);
    size += head.length + 1;
    for (const h of f.hunks) {
      const body = h.lines.join("\n");
      if (cut || size + body.length > cap) {
        cut = true;
        out.push(`[${h.id}] ${h.header} (not shown: ${h.lines.length} lines)`);
        continue;
      }
      out.push(`[${h.id}] ${h.header}`, body);
      size += h.header.length + body.length + 8;
    }
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ the guide

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * The guide the agent wrote, checked: the dashboard's shape (intent, core, consequences,
 * supporting, risk, questions, tags, minutes), hunk ids that aren't in the diff dropped (and
 * listed in `dropped`), every hunk tagged (supporting when it didn't say; core when a core point
 * names it). Throws when there's nothing to post.
 */
export function normalizeGuide(raw, ids, textMax = 2000) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The guide must be a JSON object.");
  const dropped = new Set();
  const hunks = (v) => [...new Set((Array.isArray(v) ? v : []).filter((h) => {
    if (typeof h === "string" && ids.has(h)) return true;
    dropped.add(String(h));
    return false;
  }))];
  const points = (v) => (Array.isArray(v) ? v : []).slice(0, 12)
    .map((p) => ({ title: str(p?.title, 200), text: str(p?.text, textMax), hunks: hunks(p?.hunks) }))
    .filter((p) => p.title || p.text);
  const g = {
    intent: str(raw.intent, 2000),
    ...Object.fromEntries(LISTS.map((k) => [k, points(raw[k])])),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).map((q) => str(q, 500)).filter(Boolean).slice(0, 8),
    tags: {},
    minutes: Number.isFinite(Number(raw.minutes)) && Number(raw.minutes) > 0 ? Math.min(Math.round(Number(raw.minutes)), 480) : 0,
  };
  for (const id of ids) g.tags[id] = TAGS.includes(raw.tags?.[id]) ? raw.tags[id] : "supporting";
  for (const p of g.core) for (const h of p.hunks) g.tags[h] = "core";
  if (!g.intent && !g.core.length) throw new Error("The guide has no intent and no core change: nothing to post.");
  return { guide: g, dropped: [...dropped] };
}

/** GitHub's link to a line of a PR's diff (the Files tab anchors a file by its path's sha256; R new side, L old). */
function lineLink(repo, number, file, { side, line }) {
  const anchor = crypto.createHash("sha256").update(file).digest("hex");
  return `https://github.com/${repo}/pull/${number}/files#diff-${anchor}${side}${line}`;
}

/** Where a hunk's change starts: its first added line (new side), else its first removed line (old side). */
export function hunkLine(h) {
  let o = h.oldStart;
  let n = h.newStart;
  let removed = null;
  for (const l of h.lines) {
    if (l[0] === "+") return { side: "R", line: n };
    if (l[0] === "-") { removed ??= o; o++; continue; }
    o++;
    n++;
  }
  return removed != null ? { side: "L", line: removed } : { side: "R", line: h.newStart };
}

/** The guide as the comment shows it, with each hunk linked to its lines (when the diff is known). */
export function renderGuide(g, { repo = null, number = null, sha = null, files = [] } = {}) {
  const where = new Map();
  for (const f of files) for (const h of f.hunks) where.set(h.id, { path: f.path, line: hunkLine(h) });
  const ref = (id) => {
    const w = where.get(id);
    if (!w) return `\`${id}\``;
    const label = `${w.path}:${w.line.line}${w.line.side === "L" ? " (removed)" : ""}`;
    return repo && number ? `[\`${label}\`](${lineLink(repo, number, w.path, w.line)})` : `\`${label}\``;
  };
  const point = (p, i) => {
    const refs = p.hunks.length ? ` (${p.hunks.map(ref).join(", ")})` : "";
    return `${i == null ? "-" : `${i + 1}.`} **${p.title || "Untitled"}**${p.text ? `: ${p.text}` : ""}${refs}`;
  };
  const section = (title, list, numbered = false) => (list.length ? [`### ${title}`, "", ...list.map((p, i) => point(p, numbered ? i : null)), ""] : []);
  const counts = TAGS.map((t) => [t, Object.values(g.tags).filter((x) => x === t).length]).filter(([, n]) => n);
  return [
    "## Review guide",
    "",
    `_${[g.minutes ? `About ${g.minutes} min to review` : null, sha ? `for ${sha.slice(0, 7)}` : null, counts.length ? counts.map(([t, n]) => `${n} ${t}`).join(" · ") + " hunks" : null].filter(Boolean).join(" · ")}_`,
    "",
    ...(g.intent ? ["### Intent", "", g.intent, ""] : []),
    ...section("Core change (read these first)", g.core, true),
    ...section("Consequences", g.consequences),
    ...(g.supporting.length ? ["<details><summary>Supporting changes</summary>", "", ...g.supporting.map((p) => point(p)), "", "</details>", ""] : []),
    ...section("Risk and verification", g.risk),
    ...(g.questions.length ? ["### What to look at", "", ...g.questions.map((q) => `- [ ] ${q}`), ""] : []),
  ].join("\n");
}

/** The whole comment: the marker (with the commit), the guide, and the guide as data for the dashboard. */
export function guideComment(g, ctx) {
  const data = Buffer.from(JSON.stringify(g), "utf-8").toString("base64");
  return [`<!-- ${MARKER} sha=${ctx.sha} -->`, renderGuide(g, ctx), `<!-- ${MARKER}-data ${data} -->`].join("\n");
}

/** A comment's guide: { sha, guide } when it's one of these comments (null otherwise, or when its data won't read). */
export function readGuideComment(body) {
  const s = String(body || "");
  const head = new RegExp(`^<!-- ${MARKER} sha=([0-9a-f]{7,40}) -->`).exec(s);
  const data = new RegExp(`<!-- ${MARKER}-data ([A-Za-z0-9+/=]+) -->\\s*$`).exec(s);
  if (!head || !data) return null;
  try { return { sha: head[1], guide: JSON.parse(Buffer.from(data[1], "base64").toString("utf-8")) }; } catch { return null; }
}

/** The comment to update: the newest guide comment by `login`, or null. */
export function findOwnGuide(comments, login) {
  return [...(comments || [])].reverse().find((c) => c?.user?.login === login && String(c.body || "").startsWith(`<!-- ${MARKER} `)) || null;
}

// ------------------------------------------------------------------ GitHub

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf-8", input, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

function prInfo(repo, number) {
  return JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,title,body,baseRefName,headRefName"]));
}

function usage(msg) { return Object.assign(new Error(msg), { usage: true }); }

function prArgs(args) {
  const repo = String(args.repo || "");
  const number = Number(args.pr);
  if (!REPO_RE.test(repo)) throw usage("--repo must be owner/name");
  if (!Number.isInteger(number) || number <= 0) throw usage("--pr must be a PR number");
  return { repo, number };
}

function readGuideFile(file) {
  if (typeof file !== "string") throw usage("--file <guide.json> is required");
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (e) { throw new Error(`Couldn't read ${file}: ${e.message}`); }
}

/** The comment's body, made to fit: texts cut shorter until it does. */
export function fittingComment(raw, ids, ctx) {
  for (const max of [2000, 800, 300]) {
    const { guide, dropped } = normalizeGuide(raw, ids, max);
    const body = guideComment(guide, ctx);
    if (body.length <= COMMENT_MAX) return { guide, dropped, body };
  }
  throw new Error("The guide is too long for a PR comment, even shortened: make it more concise.");
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command === "diff") {
    const { repo, number } = prArgs(args);
    const pr = prInfo(repo, number);
    const files = parseDiff(gh(["pr", "diff", String(number), "--repo", repo]));
    process.stdout.write(JSON.stringify({
      repo, number, sha: pr.headRefOid, title: pr.title, body: pr.body || "", base: pr.baseRefName, head: pr.headRefName,
      hunks: files.flatMap((f) => f.hunks.map((h) => h.id)), numbered: numberedDiff(files),
    }, null, 2) + "\n");
    return;
  }
  if (command === "render") {
    const raw = readGuideFile(args.file);
    let files = [], ctx = {};
    if (args.repo) {
      const { repo, number } = prArgs(args);
      files = parseDiff(gh(["pr", "diff", String(number), "--repo", repo]));
      ctx = { repo, number, sha: typeof args.sha === "string" ? args.sha : null, files };
    }
    const ids = new Set(files.length ? files.flatMap((f) => f.hunks.map((h) => h.id)) : Object.keys(raw.tags || {}));
    process.stdout.write(renderGuide(normalizeGuide(raw, ids).guide, ctx) + "\n");
    return;
  }
  if (command === "post") {
    const { repo, number } = prArgs(args);
    const sha = String(args.sha || "");
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw usage("--sha must be the commit the guide was written for (diff's sha)");
    const raw = readGuideFile(args.file);
    const pr = prInfo(repo, number);
    if (!pr.headRefOid.toLowerCase().startsWith(sha.toLowerCase())) {
      process.stderr.write(`The PR has moved on to ${pr.headRefOid.slice(0, 7)} since ${sha.slice(0, 7)}: run diff again and write the guide for the new commits.\n`);
      process.exitCode = 3;
      return;
    }
    const files = parseDiff(gh(["pr", "diff", String(number), "--repo", repo]));
    const ids = new Set(files.flatMap((f) => f.hunks.map((h) => h.id)));
    const { body, dropped } = fittingComment(raw, ids, { repo, number, sha: pr.headRefOid, files });
    const login = gh(["api", "user", "--jq", ".login"]).trim();
    const comments = JSON.parse(gh(["api", `repos/${repo}/issues/${number}/comments?per_page=100`, "--paginate", "--slurp"])).flat();
    const mine = findOwnGuide(comments, login);
    // A push while the diff and comments were read would make the hunk ids mean other changes.
    const now = prInfo(repo, number).headRefOid;
    if (now !== pr.headRefOid) {
      process.stderr.write(`The PR moved on to ${now.slice(0, 7)} while the guide was being posted: run diff again and write the guide for the new commits.\n`);
      process.exitCode = 3;
      return;
    }
    const res = JSON.parse(mine
      ? gh(["api", `repos/${repo}/issues/comments/${mine.id}`, "--method", "PATCH", "--input", "-"], JSON.stringify({ body }))
      : gh(["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "--input", "-"], JSON.stringify({ body })));
    if (typeof args.ticket === "string") {
      const stageRepo = typeof args["stage-repo"] === "string" ? args["stage-repo"] : repo.split("/")[1];
      update("stage", { ticket: args.ticket, stage: "guide", status: "done", repo: stageRepo, agent: "review-guide", note: res.html_url }, { start: typeof args.root === "string" ? path.resolve(args.root) : process.cwd() });
    }
    process.stdout.write(JSON.stringify({ url: res.html_url, updated: !!mine, dropped }, null, 2) + "\n");
    return;
  }
  throw usage("usage: review-guide.mjs diff|post|render --repo <owner/name> --pr <n> [--sha <sha> --file <guide.json>]");
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${(e.stderr && String(e.stderr).trim()) || e.message}\n`);
    process.exitCode = e.usage ? 2 : 1;
  });
}

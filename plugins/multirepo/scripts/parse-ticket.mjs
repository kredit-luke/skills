#!/usr/bin/env node
/**
 * parse-ticket.mjs: turn a raw issue-tracker response into one normalized ticket.
 *
 * Reads what a tracker returned (Jira REST / Atlassian MCP, the Linear MCP, or
 * `gh issue view --json ...`), auto-detects which it is, and prints
 *
 *   { id, tracker, title, url, state, type, labels[], assignee, priority,
 *     description (Markdown), acceptanceCriteria, links: [{ type, id, title, state }],
 *     subtasks: [{ id, title, state }], parent, components[], customFields: [{ id, name, value }],
 *     comments: [{ id, author, created, body }], planComment, alignComment }
 *
 * planComment / alignComment are the newest comments carrying this plugin's
 * submit-plan / align markers (null when there's none).
 *
 * Inputs may be wrapped the way an MCP result spills to a file,
 * `[{ "type": "text", "text": "<json>" }]`; that's unwrapped. Jira's Atlassian
 * Document Format (ADF) is flattened to Markdown. Several inputs can be given: the
 * issue plus separately fetched comment lists (e.g. Linear's list_comments).
 *
 * Usage:
 *   node parse-ticket.mjs [<file>|- ...] [--format json|md] [--tracker jira|linear|github]
 *
 *   <file>     A saved tool result or JSON file. None, or "-", reads stdin.
 *   --format   json (default) or md (readable Markdown).
 *   --tracker  Skip detection.
 *
 * Exits 1 when no ticket can be found in the input.
 */
import fs from "node:fs";
import { isMain, parseArgs } from "./lib.mjs";

export const PLAN_MARKER = "<!-- GENERATED-BY-SUBMIT-PLAN-SKILL -->";
export const ALIGN_MARKER = "<!-- GENERATED-BY-ALIGN-SKILL -->";

// ---------------------------------------------------------------- unwrapping

const isTextItem = (x) => x && typeof x === "object" && x.type === "text" && typeof x.text === "string";

/**
 * Peels MCP wrappers off a value: JSON strings, `[{type:"text", text}]` arrays,
 * `{ content: [...] }` / `{ structuredContent }` tool results. Returns a list of
 * the JSON values found inside (non-JSON text is dropped).
 */
export function unwrap(value) {
  if (typeof value === "string") {
    const s = value.trim().replace(/^﻿/, "");
    if (!s || !"[{".includes(s[0])) return [];
    try {
      return unwrap(JSON.parse(s));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    if (value.length && value.every(isTextItem)) return value.flatMap((t) => unwrap(t.text));
    return [value];
  }
  if (value && typeof value === "object") {
    if (value.structuredContent && typeof value.structuredContent === "object") return unwrap(value.structuredContent);
    if (Array.isArray(value.content) && value.content.length && value.content.every(isTextItem) && !value.title && !value.key) {
      return unwrap(value.content);
    }
    return [value];
  }
  return [];
}

// ---------------------------------------------------------------- ADF → Markdown

const isAdf = (v) => v && typeof v === "object" && !Array.isArray(v) && v.type === "doc";

function applyMarks(text, marks = []) {
  let out = text;
  for (const m of marks) {
    if (m.type === "code") out = "`" + out + "`";
    else if (m.type === "strong") out = `**${out}**`;
    else if (m.type === "em") out = `*${out}*`;
    else if (m.type === "strike") out = `~~${out}~~`;
    else if (m.type === "link" && m.attrs?.href) out = `[${out}](${m.attrs.href})`;
  }
  return out;
}

function inline(nodes = []) {
  return nodes.map(inlineNode).join("");
}

function inlineNode(n) {
  if (!n) return "";
  switch (n.type) {
    case "text":
      return applyMarks(n.text ?? "", n.marks);
    case "hardBreak":
      return "\n";
    case "mention":
      return n.attrs?.text ? (n.attrs.text.startsWith("@") ? n.attrs.text : `@${n.attrs.text}`) : `@${n.attrs?.id ?? "user"}`;
    case "emoji":
      return n.attrs?.text || n.attrs?.shortName || "";
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return n.attrs?.url ? `<${n.attrs.url}>` : "";
    case "status":
      return n.attrs?.text ? `[${n.attrs.text}]` : "";
    case "date":
      return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "media":
    case "mediaInline":
      return "[attachment]";
    default:
      return n.content ? inline(n.content) : n.text ?? "";
  }
}

const indent = (text, pad) =>
  text
    .split("\n")
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join("\n");

function block(n, depth = 0) {
  if (!n) return "";
  const kids = n.content ?? [];
  switch (n.type) {
    case "doc":
      return blocks(kids, depth);
    case "paragraph":
      return inline(kids);
    case "heading":
      return `${"#".repeat(Math.min(Math.max(n.attrs?.level ?? 2, 1), 6))} ${inline(kids)}`;
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const start = n.attrs?.order ?? 1;
      return kids
        .map((item, i) => {
          let bullet = "- ";
          if (n.type === "orderedList") bullet = `${start + i}. `;
          if (item.type === "taskItem") bullet = item.attrs?.state === "DONE" ? "- [x] " : "- [ ] ";
          const body = item.type === "taskItem" ? inline(item.content) : blocks(item.content ?? [], depth + 1, "\n");
          return bullet + indent(body, " ".repeat(bullet.length));
        })
        .join("\n");
    }
    case "listItem":
      return blocks(kids, depth + 1, "\n");
    case "codeBlock":
      return "```" + (n.attrs?.language ?? "") + "\n" + kids.map((k) => k.text ?? "").join("") + "\n```";
    case "blockquote":
    case "panel":
      return blocks(kids, depth)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "rule":
      return "---";
    case "expand":
    case "nestedExpand":
      return [n.attrs?.title ? `**${n.attrs.title}**` : "", blocks(kids, depth)].filter(Boolean).join("\n\n");
    case "mediaSingle":
    case "mediaGroup":
      return "[attachment]";
    case "table": {
      const rows = kids.map((r) => (r.content ?? []).map((c) => blocks(c.content ?? [], depth, " ").replace(/\|/g, "\\|").replace(/\n/g, " ")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
    }
    default:
      return kids.length ? (kids.every((k) => k.type === "text" || k.type === "hardBreak" || k.type === "mention") ? inline(kids) : blocks(kids, depth)) : inlineNode(n);
  }
}

function blocks(nodes, depth = 0, sep = "\n\n") {
  return nodes
    .map((k) => block(k, depth))
    .filter((s) => s !== "")
    .join(sep);
}

/** Atlassian Document Format (or a plain string) → Markdown. */
export function adfToMarkdown(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return blocks(node).trim();
  return block(node).trim();
}

const text = (v) => (isAdf(v) || (v && typeof v === "object" && Array.isArray(v.content)) ? adfToMarkdown(v) : typeof v === "string" ? v : "");

// ---------------------------------------------------------------- helpers

const nodes = (v) => (Array.isArray(v) ? v : Array.isArray(v?.nodes) ? v.nodes : Array.isArray(v?.items) ? v.items : []);
const nameOf = (v) =>
  v == null ? null : typeof v === "string" ? v : v.displayName || v.name || v.login || v.title || v.label || v.value || null;

/** The "Acceptance criteria" section of a Markdown description (heading or bold line), or null. */
export function extractAcceptanceCriteria(md) {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  const isHead = (l) => /^\s*(#{1,6})\s+/.exec(l);
  const re = /^\s*(?:#{1,6}\s+|\*\*|__)?\s*acceptance criteria\b[^\n]*$/i;
  const start = lines.findIndex((l) => re.test(l.replace(/[*_:]+\s*$/, "")));
  if (start === -1) return null;
  const level = isHead(lines[start])?.[1].length ?? 7;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = isHead(lines[i]);
    if (h && h[1].length <= level) break;
    if (!h && level === 7 && /^\s*(\*\*|__)[^*_]+(\*\*|__):?\s*$/.test(lines[i])) break; // next bold "heading"
    out.push(lines[i]);
  }
  const body = out.join("\n").trim();
  return body || null;
}

function normalizeComment(c) {
  if (!c || typeof c !== "object") return null;
  const author =
    nameOf(c.author) || nameOf(c.user) || nameOf(c.updateAuthor) || nameOf(c.createdBy) || (typeof c.authorName === "string" ? c.authorName : null) || "Unknown";
  const body = text(c.body ?? c.text ?? c.content ?? "");
  return {
    id: c.id != null ? String(c.id) : null,
    author,
    created: c.created || c.createdAt || c.created_at || null,
    body: body.trim(),
  };
}

const looksLikeComment = (c) => c && typeof c === "object" && ("body" in c || "text" in c) && !("title" in c) && !("fields" in c);

/** A comment list in any of the shapes trackers return, or null. */
function commentList(v) {
  if (Array.isArray(v) && v.length && v.every(looksLikeComment)) return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const inner = v.comments ?? v.values ?? v.nodes;
    const list = nodes(inner).length ? nodes(inner) : Array.isArray(inner) ? inner : null;
    if (list && !v.title && !v.fields && (list.length === 0 || list.every(looksLikeComment))) return list;
  }
  return null;
}

/**
 * The newest comment carrying a marker. Matches the token inside the HTML comment,
 * since some trackers' Markdown conversion strips or escapes the `<!-- -->`.
 */
function newestWith(comments, marker) {
  const token = marker.replace(/^<!--\s*|\s*-->$/g, "");
  const hits = comments.filter((c) => c.body.includes(token));
  if (!hits.length) return null;
  return hits.reduce((a, b) => (b.created && a.created && Date.parse(b.created) < Date.parse(a.created) ? a : b));
}

function sortByCreated(comments) {
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ta = Date.parse(a.c.created ?? ""), tb = Date.parse(b.c.created ?? "");
      return Number.isNaN(ta) || Number.isNaN(tb) || ta === tb ? a.i - b.i : ta - tb;
    })
    .map((x) => x.c);
}

const ref = (r) =>
  r == null
    ? null
    : typeof r === "string"
      ? { id: r, title: null, state: null }
      : {
          id: r.key || r.identifier || (r.number != null ? `#${r.number}` : null) || r.id || null,
          title: r.fields?.summary || r.title || r.summary || null,
          state: nameOf(r.fields?.status) || nameOf(r.state) || nameOf(r.status) || null,
        };

// ---------------------------------------------------------------- detection

/** "jira" | "linear" | "github" | null for one unwrapped value. */
export function detectTracker(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (v.fields && typeof v.fields === "object" && (v.key || v.id)) return "jira";
  if (typeof v.title !== "string") return null;
  const url = String(v.url ?? "");
  if (/github\.com/i.test(url) || Array.isArray(v.assignees) || (v.number != null && "body" in v)) return "github";
  if (/linear\.app/i.test(url) || v.identifier || "description" in v) return "linear";
  if ("body" in v) return "github";
  return null;
}

/** The issue object inside an unwrapped value (Jira search results hold it in `issues`). */
function issueIn(v) {
  if (detectTracker(v)) return v;
  if (v && typeof v === "object") {
    const list = nodes(v.issues);
    if (list.length && detectTracker(list[0])) return list[0];
    if (v.issue && detectTracker(v.issue)) return v.issue;
  }
  return null;
}

// ---------------------------------------------------------------- per tracker

function fromJira(issue) {
  const f = issue.fields ?? {};
  const names = issue.names ?? {};
  const description = text(f.description).trim();
  const site = (() => {
    try {
      return issue.self ? new URL(issue.self).origin : null;
    } catch {
      return null;
    }
  })();

  const customFields = [];
  let acceptanceCriteria = null;
  for (const [key, val] of Object.entries(f)) {
    if (!key.startsWith("customfield_") || val == null) continue;
    const name = names[key] || key;
    let value = null;
    if (isAdf(val)) value = adfToMarkdown(val);
    else if (typeof val === "string" || typeof val === "number") value = String(val);
    else if (Array.isArray(val)) value = val.map(nameOf).filter(Boolean).join(", ") || null;
    else if (typeof val === "object") value = nameOf(val);
    if (!value || value === description) continue;
    customFields.push({ id: key, name, value });
    if (!acceptanceCriteria && /acceptance/i.test(name)) acceptanceCriteria = value;
  }
  if (!acceptanceCriteria) {
    // Unnamed (no expand=names) ADF custom field that is itself an AC section.
    const ac = customFields.find((c) => /^(#+\s*|\*\*)?acceptance criteria/i.test(c.value));
    acceptanceCriteria = ac ? extractAcceptanceCriteria(ac.value) ?? ac.value : extractAcceptanceCriteria(description);
  }

  const links = [];
  for (const l of f.issuelinks ?? []) {
    const other = l.outwardIssue ?? l.inwardIssue;
    if (!other) continue;
    const raw = l.outwardIssue ? l.type?.outward : l.type?.inward;
    links.push({ type: String(raw || l.type?.name || "relates to").toLowerCase().replace(/^is /, ""), ...ref(other) });
  }

  const commentSrc = f.comment?.comments ?? (Array.isArray(f.comment) ? f.comment : []);
  return {
    id: issue.key || String(issue.id),
    tracker: "jira",
    title: f.summary ?? null,
    url: site && issue.key ? `${site}/browse/${issue.key}` : null,
    state: nameOf(f.status),
    type: nameOf(f.issuetype),
    labels: (f.labels ?? []).map(nameOf).filter(Boolean),
    assignee: nameOf(f.assignee),
    priority: nameOf(f.priority),
    description,
    acceptanceCriteria,
    links,
    subtasks: (f.subtasks ?? []).map(ref),
    parent: ref(f.parent),
    components: (f.components ?? []).map(nameOf).filter(Boolean),
    customFields,
    comments: commentSrc,
  };
}

const LINEAR_PRIORITY = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };
const LINEAR_RELATION = { blocks: "blocks", blockedBy: "blocked by", relatedTo: "related to", related: "related to", duplicateOf: "duplicate of", duplicates: "duplicate of" };

function fromLinear(issue) {
  const description = text(issue.description).trim();
  const links = [];
  const rel = issue.relations;
  if (rel && !Array.isArray(rel) && typeof rel === "object" && !rel.nodes) {
    for (const [k, list] of Object.entries(rel)) {
      for (const r of nodes(list).length ? nodes(list) : list && typeof list === "object" && !Array.isArray(list) ? [list] : []) {
        links.push({ type: LINEAR_RELATION[k] || k, ...ref(r) });
      }
    }
  } else {
    for (const r of nodes(rel)) {
      const other = r.relatedIssue ?? r.issue ?? r;
      links.push({ type: LINEAR_RELATION[r.type] || String(r.type || "related to").replace(/_/g, " "), ...ref(other) });
    }
    for (const r of nodes(issue.inverseRelations)) {
      const t = r.type === "blocks" ? "blocked by" : LINEAR_RELATION[r.type] || r.type || "related to";
      links.push({ type: t, ...ref(r.issue ?? r) });
    }
  }
  const pr = issue.priority;
  const priority =
    pr == null ? null : typeof pr === "number" ? LINEAR_PRIORITY[pr] ?? String(pr) : typeof pr === "object" ? pr.name || LINEAR_PRIORITY[pr.value] || null : String(pr);
  return {
    id: issue.identifier || issue.id || null,
    tracker: "linear",
    title: issue.title,
    url: issue.url ?? null,
    state: nameOf(issue.status) || nameOf(issue.state),
    type: nameOf(issue.type) || null,
    labels: nodes(issue.labels).map(nameOf).filter(Boolean),
    assignee: nameOf(issue.assignee),
    priority,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    links,
    subtasks: nodes(issue.children ?? issue.subIssues).map(ref),
    parent: issue.parent ? ref(issue.parent) : issue.parentId ? { id: issue.parentId, title: null, state: null } : null,
    components: [],
    customFields: [],
    comments: nodes(issue.comments),
  };
}

function fromGitHub(issue) {
  const description = String(issue.body ?? "").trim();
  const m = /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/i.exec(String(issue.url ?? ""));
  const id = m ? `${m[1]}#${m[2]}` : issue.number != null ? `#${issue.number}` : null;
  const assignees = nodes(issue.assignees).map(nameOf).filter(Boolean);
  return {
    id,
    tracker: "github",
    title: issue.title,
    url: issue.url ?? null,
    state: issue.state ? String(issue.state).toLowerCase() : null,
    type: nameOf(issue.issueType ?? issue.type) || null,
    labels: nodes(issue.labels).map(nameOf).filter(Boolean),
    assignee: assignees.length ? assignees.join(", ") : nameOf(issue.assignee),
    priority: null,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    links: [],
    subtasks: [],
    parent: issue.parent ? ref(issue.parent) : null,
    components: [],
    customFields: [],
    comments: nodes(issue.comments),
  };
}

const PARSERS = { jira: fromJira, linear: fromLinear, github: fromGitHub };

/**
 * Normalizes raw input into a ticket, or throws when none holds an issue.
 * `inputs` is one raw input (a string or parsed JSON, spill-wrapped or not) or an
 * array of them: the issue plus any separately fetched comment lists, which are
 * merged in (deduplicated by id).
 */
export function parseTicket(inputs, { tracker = null } = {}) {
  const values = (Array.isArray(inputs) && !inputs.every(isTextItem) ? inputs : [inputs]).flatMap(unwrap);
  let issue = null;
  const extra = [];
  for (const v of values) {
    const found = issue ? null : issueIn(v);
    if (found) issue = found;
    else {
      const list = commentList(v);
      if (list) extra.push(...list);
    }
  }
  if (!issue) throw new Error("No ticket found in the input (expected a Jira, Linear or GitHub issue).");
  const kind = tracker || detectTracker(issue);
  const parse = PARSERS[kind];
  if (!parse) throw new Error(`Unknown tracker "${kind}".`);
  const t = parse(issue);

  const seen = new Set();
  const comments = [];
  for (const c of [...t.comments, ...extra].map(normalizeComment).filter(Boolean)) {
    if (c.id && seen.has(c.id)) continue;
    if (c.id) seen.add(c.id);
    comments.push(c);
  }
  t.comments = sortByCreated(comments);
  t.planComment = newestWith(t.comments, PLAN_MARKER);
  t.alignComment = newestWith(t.comments, ALIGN_MARKER);
  return t;
}

// ---------------------------------------------------------------- Markdown

const refLine = (r) => `${r.id ?? "?"}${r.title ? `: ${r.title}` : ""}${r.state ? ` [${r.state}]` : ""}`;

/** A ticket as readable Markdown. */
export function toMarkdown(t) {
  const out = [`# ${t.id ?? "?"}: ${t.title ?? "(untitled)"}`, ""];
  const facts = [
    ["Tracker", t.tracker],
    ["URL", t.url],
    ["Type", t.type],
    ["State", t.state],
    ["Priority", t.priority],
    ["Assignee", t.assignee],
    ["Labels", t.labels.join(", ")],
    ["Components", t.components.join(", ")],
    ["Parent", t.parent && refLine(t.parent)],
    ["Plan comment", t.planComment && `yes (${t.planComment.author}, ${String(t.planComment.created ?? "").slice(0, 10)})`],
    ["Align comment", t.alignComment && `yes (${t.alignComment.author}, ${String(t.alignComment.created ?? "").slice(0, 10)})`],
  ];
  for (const [k, v] of facts) if (v) out.push(`- **${k}:** ${v}`);
  out.push("", "## Description", "", t.description || "(empty)");
  if (t.acceptanceCriteria && !t.description.includes(t.acceptanceCriteria)) out.push("", "## Acceptance criteria", "", t.acceptanceCriteria);
  const custom = t.customFields.filter((c) => c.value !== t.acceptanceCriteria);
  const short = custom.filter((c) => !c.value.includes("\n") && c.value.length <= 120);
  if (short.length) out.push("", "## Custom fields", "", ...short.map((c) => `- **${c.name}:** ${c.value}`));
  for (const c of custom.filter((x) => !short.includes(x))) out.push("", `## ${c.name}`, "", c.value);
  if (t.links.length) out.push("", "## Links", "", ...t.links.map((l) => `- ${l.type}: ${refLine(l)}`));
  if (t.subtasks.length) out.push("", "## Subtasks", "", ...t.subtasks.map((s) => `- ${refLine(s)}`));
  if (t.comments.length) {
    out.push("", `## Comments (${t.comments.length})`);
    for (const c of t.comments) out.push("", `### ${c.author}${c.created ? `, ${String(c.created).slice(0, 10)}` : ""}`, "", c.body || "(empty)");
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- CLI

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const files = args._.length ? args._ : ["-"];
  try {
    const inputs = files.map((f) => (f === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(f, "utf-8")));
    const ticket = parseTicket(inputs, { tracker: typeof args.tracker === "string" ? args.tracker : null });
    process.stdout.write(args.format === "md" ? toMarkdown(ticket) : JSON.stringify(ticket, null, 2) + "\n");
  } catch (e) {
    process.stderr.write(`parse-ticket: ${e.message}\n`);
    process.exit(1);
  }
}

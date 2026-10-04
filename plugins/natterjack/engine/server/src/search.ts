/**
 * Workspace search — local full-text search over everything Claude and the team
 * rely on, with no model call: skills, memory, CLAUDE.md guidance, agents, the
 * docs sources (docs.json), cached tracker issues and past runs.
 *
 * Documents are split into heading sections so a hit lands on the right part of
 * a long page. Scoring is BM25 over title/section/body with prefix matching and
 * one-typo tolerance; results are collapsed to the best section per document.
 * The index is rebuilt lazily when it's more than REBUILD_MS old (a full build
 * is well under a second: the sources total a few hundred KB).
 */

import fs from "node:fs";
import path from "node:path";
import { frontmatter } from "./memory.ts";
import { docSources, notesDirOf } from "./docs.ts";
import { skillFile } from "./config.ts";

const REBUILD_MS = 30000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SECTION_MIN_CHARS = 1200; // shorter docs stay one chunk
const FIELD_WEIGHT = { title: 3, section: 2, body: 1 };
const K1 = 1.2, B = 0.75;
const STOP = new Set("a an and are as at be but by can do does for from has have how i if in into is it its of on or so that the their then there these this to use used using was we what when where which who why will with you your".split(" "));

const SOURCES = {
  skill:  { label: "Skill",  order: 0 },
  memory: { label: "Memory", order: 1 },
  guide:  { label: "Guide",  order: 2 },
  doc:    { label: "Docs",   order: 3 },
  issue:  { label: "Issue",  order: 4 },
  agent:  { label: "Agent",  order: 5 },
  run:    { label: "Run",    order: 6 },
};

class Search {
  root: any;
  memory: any;
  getIssues: any;
  getIssueLabel: () => string;
  getRuns: any;
  index: any;

  /**
   * @param {object} o
   * @param {string} o.root              workspace root
   * @param {import('./memory').Memory} o.memory
   * @param {() => object[]} o.issues    cached tracker issues (may be empty)
   * @param {() => string} o.issueLabel  the tracker's name ("Linear", "Jira", ...)
   * @param {() => object[]} o.runs      run metas
   */
  constructor({ root, memory, issues, runs, issueLabel }: { root: string; memory: any; issues: () => any[]; runs: () => any[]; issueLabel?: () => string }) {
    this.root = root;
    this.memory = memory;
    this.getIssues = issues;
    this.getIssueLabel = issueLabel || (() => "Issues");
    this.getRuns = runs;
    this.index = null;
  }

  query(q: string, { source, site, limit = 40 }: { source?: string; site?: string; limit?: number } = {}) {
    const idx = this._ensure();
    const terms = tokenize(q);
    const inSite = (d) => !site || (d.extra && d.extra.site === site);
    if (!terms.length) {
      // No query but a site: browse that site's pages (the Apps tab's "Browse").
      const docs = site ? [...idx.docs.values()].filter((d) => d.source === "doc" && inSite(d)).sort((a, b) => a.rel.localeCompare(b.rel)) : [];
      const results = docs.slice(0, limit).map((d) => resultOf(idx.chunks.find((c) => c.doc === d), [], 0));
      return { query: q, terms: [], results, counts: docs.length ? { doc: docs.length } : {}, total: docs.length, builtAt: idx.builtAt, took: 0 };
    }
    const t0 = Date.now();

    // Expand each query term to index terms: exact (1.0), prefix (0.8), one typo (0.5).
    const scores = new Map();
    const matched = new Map(); // chunk -> distinct query terms matched
    terms.forEach((qt, qi) => {
      for (const [term, weight] of expand(qt, idx)) {
        const postings = idx.postings.get(term);
        const idf = Math.log(1 + (idx.chunks.length - postings.size + 0.5) / (postings.size + 0.5));
        for (const [ci, tf] of postings) {
          const len = idx.chunks[ci].len;
          const s = weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / idx.avgLen)));
          scores.set(ci, (scores.get(ci) || 0) + s);
          let set = matched.get(ci);
          if (!set) matched.set(ci, (set = new Set()));
          set.add(qi);
        }
      }
    });

    const phrase = q.trim().toLowerCase();
    const best = new Map(); // docId -> { ci, score }
    for (const [ci, raw] of scores) {
      const c = idx.chunks[ci];
      if (!inSite(c.doc)) continue;
      // Reward matching every term, and the literal phrase.
      const coverage = matched.get(ci).size / terms.length;
      let score = raw * (0.4 + 0.6 * coverage * coverage);
      if (terms.length > 1 && phrase.length > 3 && (c.titleLc.includes(phrase) || c.bodyLc.includes(phrase))) score *= 1.5;
      if (c.doc.boost) score *= c.doc.boost;
      const prev = best.get(c.doc.id);
      if (!prev || score > prev.score) best.set(c.doc.id, { ci, score, coverage });
    }

    const all = [...best.values()].sort((a, b) => b.score - a.score);
    const top = all[0] ? all[0].score : 0;
    // Drop the long tail of weak partial matches once there are strong ones.
    const kept = all.filter((r) => r.score >= top * 0.08 || r.coverage === 1);
    // Counts cover every source so the filter chips show what the other tabs hold.
    const counts = {};
    for (const r of kept) { const s = idx.chunks[r.ci].doc.source; counts[s] = (counts[s] || 0) + 1; }
    const shown = source ? kept.filter((r) => idx.chunks[r.ci].doc.source === source) : kept;
    const results = shown.slice(0, limit).map((r) => resultOf(idx.chunks[r.ci], terms, r.score));
    return { query: q, terms, results, counts, total: shown.length, builtAt: idx.builtAt, took: Date.now() - t0 };
  }

  /** Full document for the preview pane. */
  doc(id) {
    const d = this._ensure().docs.get(id);
    if (!d) return null;
    const { chunks, boost, ...pub } = d;
    return { ...pub, sourceLabel: SOURCES[d.source].label, content: d.content || "" };
  }

  /** Every page of one docs site, for the Docs page's page list. */
  pages(site: string) {
    const docs = [...this._ensure().docs.values()].filter((d) => d.source === "doc" && d.extra && d.extra.site === site);
    return docs
      .map((d) => ({
        id: d.id,
        title: d.title,
        rel: d.extra.path || d.rel.split("/").slice(1).join("/"),
        pagePath: d.extra.pagePath,
        format: d.format,
        live: d.extra.live,
        sections: d.chunks.map((c) => c.section).filter(Boolean).slice(0, 40),
      }))
      // Index pages first, then by folder and name.
      .sort((a, b) => Number(!/(^|\/)index\.html?$|^readme\.md$/i.test(a.rel)) - Number(!/(^|\/)index\.html?$|^readme\.md$/i.test(b.rel)) || a.rel.localeCompare(b.rel));
  }

  stats() {
    const idx = this._ensure();
    const bySource = {};
    for (const d of idx.docs.values()) bySource[d.source] = (bySource[d.source] || 0) + 1;
    return { docs: idx.docs.size, chunks: idx.chunks.length, bySource, builtAt: idx.builtAt, buildMs: idx.buildMs, sources: SOURCES };
  }

  invalidate() { this.index = null; }

  // ------------------------------------------------------------ build

  _ensure() {
    if (!this.index || Date.now() - this.index.builtAt > REBUILD_MS) this.index = this._build();
    return this.index;
  }

  _build() {
    const t0 = Date.now();
    const docs = [];
    const add = (d) => { if (d && (d.chunks.length || d.content)) docs.push(d); };
    try { this._skills().forEach(add); } catch {}
    try { this._memories().forEach(add); } catch {}
    try { this._guides().forEach(add); } catch {}
    try { this._agents().forEach(add); } catch {}
    try { this._docs().forEach(add); } catch {}
    try { this._issues().forEach(add); } catch {}
    try { this._runs().forEach(add); } catch {}

    const chunks = [];
    const postings = new Map();
    let totalLen = 0;
    for (const d of docs) {
      for (const ch of d.chunks) {
        const ci = chunks.length;
        const tf = new Map();
        let len = 0;
        for (const [field, text] of [["title", d.title], ["section", ch.section || ""], ["body", ch.text]]) {
          for (const t of tokenize(text, true)) {
            tf.set(t, (tf.get(t) || 0) + FIELD_WEIGHT[field]);
            len++;
          }
        }
        for (const [t, n] of tf) {
          let p = postings.get(t);
          if (!p) postings.set(t, (p = new Map()));
          p.set(ci, n);
        }
        totalLen += len;
        chunks.push({ doc: d, section: ch.section || "", anchor: ch.anchor || "", text: ch.text, len: len || 1,
          titleLc: d.title.toLowerCase(), bodyLc: ch.text.toLowerCase() });
      }
    }
    const vocab = [...postings.keys()].sort();
    return {
      docs: new Map(docs.map((d) => [d.id, d])),
      chunks, postings, vocab,
      avgLen: totalLen / Math.max(1, chunks.length),
      builtAt: Date.now(),
      buildMs: Date.now() - t0,
    };
  }

  _skills() {
    const dir = path.join(this.root, ".claude", "skills");
    return readdir(dir).filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => {
      const file = skillFile(path.join(dir, e.name));
      const text = read(file);
      if (text == null) return null;
      const { fm, body } = frontmatter(text);
      const name = fm.name || e.name;
      const desc = fm.description || "";
      return {
        id: `skill:${name}`, source: "skill", title: `/${name}`, subtitle: desc,
        rel: rel(this.root, file), file, format: "md", content: body,
        extra: { skill: name, argumentHint: fm["argument-hint"] || "" },
        boost: 1.2,
        chunks: [{ section: "", text: desc }, ...mdSections(body)],
      };
    });
  }

  _memories() {
    const list = this.memory.list();
    return list.memories.map((m) => ({
      id: `memory:${m.file}`, source: "memory", title: m.name, subtitle: m.description,
      rel: `memory/${m.file}`, file: path.join(this.memory.dir, m.file), format: "md", content: m.body, updatedAt: m.updatedAt,
      ref: `${this.memory.dir}${path.sep}${m.file}`.split(path.sep).join("/"),
      extra: { memoryFile: m.file, type: m.type, issues: m.issues },
      boost: 1.1,
      chunks: [{ section: "", text: `${m.description}\n${m.body}` }],
    }));
  }

  _guides() {
    const files = [path.join(this.root, "CLAUDE.md")];
    for (const e of readdir(this.root)) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "worktrees" || e.name === "node_modules") continue;
      files.push(path.join(this.root, e.name, "CLAUDE.md"));
    }
    files.push(path.join(this.root, "README.md"));
    return files.map((file) => {
      const text = read(file);
      if (text == null) return null;
      const r = rel(this.root, file);
      const repo = r.includes("/") ? r.split("/")[0] : "Workspace";
      return {
        id: `guide:${r}`, source: "guide", title: `${repo} · ${path.basename(file)}`, subtitle: r,
        rel: r, file, format: "md", content: text, extra: { repo },
        chunks: mdSections(text),
      };
    });
  }

  _agents() {
    const dir = path.join(this.root, ".claude", "agents");
    return readdir(dir).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => {
      const file = path.join(dir, e.name);
      const text = read(file);
      if (text == null) return null;
      const { fm, body } = frontmatter(text);
      const desc = (fm.description || "").replace(/\\n/g, " ").slice(0, 400);
      return {
        id: `agent:${e.name}`, source: "agent", title: fm.name || e.name.replace(/\.md$/, ""), subtitle: desc,
        rel: rel(this.root, file), file, format: "md", content: body,
        chunks: [{ section: "", text: desc }, ...mdSections(body)],
      };
    });
  }

  _docs() {
    const out = [];
    for (const site of docSources().sources) {
      const key = site.key;
      const dir = notesDirOf(this.root, site);
      if (!dir) continue;
      // A store's copy lives in the ledger: its ids and paths use knowledge/<key>.
      const base = site.kind === "store" ? `knowledge/${key}` : site.dir;
      for (const file of walk(dir)) {
        const r = path.relative(dir, file).split(path.sep).join("/");
        const text = read(file);
        if (text == null) continue;
        const isHtml = /\.html?$/i.test(file);
        const parsed = isHtml ? htmlSections(text) : { title: mdTitle(text), sections: mdSections(text) };
        const pagePath = r.replace(/(^|\/)index\.html$/i, "$1");
        out.push({
          id: `doc:${base}/${r}`, source: "doc",
          title: parsed.title || humanize(path.basename(file)), subtitle: `${site.name} · ${r}`,
          rel: `${base}/${r}`, file, format: isHtml ? "html" : "md",
          content: isHtml ? parsed.sections.map((s) => (s.section ? `## ${s.section}\n\n` : "") + s.text).join("\n\n") : text,
          extra: { site: key, siteName: site.name, kind: site.kind, path: r, pagePath, live: site.live ? site.live + pagePath : null },
          chunks: parsed.sections,
        });
      }
    }
    return out;
  }

  _issues() {
    return (this.getIssues() || []).map((i) => ({
      id: `issue:${i.id}`, source: "issue", title: `${i.id} · ${i.title}`,
      subtitle: [i.team, i.state, i.assignee || "Unassigned"].join(" · "),
      rel: i.url, url: i.url, format: "none", ref: `${this.getIssueLabel()} issue ${i.id}`,
      extra: { ticket: i.id, team: i.team, state: i.state, labels: (i.labels || []).map((l) => l.name) },
      chunks: [{ section: "", text: [i.title, i.team, i.state, i.assignee, i.project, ...(i.labels || []).map((l) => l.name)].filter(Boolean).join(" · ") }],
    }));
  }

  _runs() {
    return (this.getRuns() || []).filter((r) => r.status !== "running").slice(0, 300).map((r) => ({
      id: `run:${r.id}`, source: "run", title: r.label || r.prompt.slice(0, 60),
      subtitle: `${r.status} · ${r.workspace} · ${new Date(r.startedAt).toLocaleDateString()}`,
      rel: r.id, ref: null, format: "md", content: `**Prompt**\n\n${r.prompt}\n\n**Result**\n\n${r.resultText || r.error || "(none)"}`,
      updatedAt: r.startedAt, extra: { runId: r.id, status: r.status },
      chunks: [{ section: "Prompt", text: r.prompt }, { section: "Result", text: r.resultText || r.error || "" }],
    }));
  }
}

// ------------------------------------------------------------------ helpers

function tokenize(text: string, keepStop = false) {
  const out = [];
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 && !/^\d$/.test(raw)) continue;
    if (!keepStop && STOP.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** Index terms a query term should match, with weights. */
function expand(qt, idx) {
  const out = [];
  if (idx.postings.has(qt)) out.push([qt, 1]);
  if (qt.length >= 2) {
    // Binary search to the first vocab term >= qt, then walk the prefix range.
    let lo = 0, hi = idx.vocab.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (idx.vocab[mid] < qt) lo = mid + 1; else hi = mid; }
    let n = 0;
    for (let i = lo; i < idx.vocab.length && idx.vocab[i].startsWith(qt) && n < 60; i++) {
      if (idx.vocab[i] !== qt) { out.push([idx.vocab[i], 0.8 * (qt.length / idx.vocab[i].length) ** 0.5]); n++; }
    }
  }
  if (!out.length && qt.length >= 5) {
    for (const t of idx.vocab) if (Math.abs(t.length - qt.length) <= 1 && t[0] === qt[0] && editDistance1(t, qt)) out.push([t, 0.5]);
  }
  return out;
}

function editDistance1(a, b) {
  if (a === b) return false;
  if (a.length === b.length) {
    let diff = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    // transposition
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;
  }
  return true;
}

function resultOf(chunk, terms, score) {
  const d = chunk.doc;
  return {
    id: d.id, source: d.source, sourceLabel: SOURCES[d.source].label,
    title: d.title, subtitle: d.subtitle || "", section: chunk.section, anchor: chunk.anchor,
    rel: d.rel, url: d.url || null, format: d.format, updatedAt: d.updatedAt || null,
    // How an "Ask Claude" prompt points at this: a workspace path, the memory file, or the ticket.
    ref: d.ref !== undefined ? d.ref : d.rel,
    extra: d.extra || {}, snippet: snippet(chunk.text, terms), score: Math.round(score * 100) / 100,
  };
}

function snippet(text, terms) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  const lc = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const m = re.exec(flat);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) at = terms.reduce((best, t) => { const i = lc.indexOf(t); return i >= 0 && (best < 0 || i < best) ? i : best; }, -1);
  if (at < 0) return flat.slice(0, 220) + (flat.length > 220 ? "…" : "");
  const start = Math.max(0, at - 80);
  const end = Math.min(flat.length, at + 160);
  return (start ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}

/** Split markdown into heading sections (fenced code stays with its section). */
function mdSections(md) {
  const text = String(md || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  if (text.length < SECTION_MIN_CHARS) return [{ section: "", text: stripMd(text) }];
  const out = [];
  let cur = { section: "", anchor: "", lines: [] };
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur.lines.join("").trim()) out.push(cur);
      cur = { section: stripMd(h[2]), anchor: slug(h[2]), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.lines.join("").trim() || !out.length) out.push(cur);
  return out.map((s) => ({ section: s.section, anchor: s.anchor, text: stripMd(s.lines.join("\n")) }));
}

function mdTitle(md) {
  const m = /^#\s+(.+)$/m.exec(String(md || ""));
  return m ? stripMd(m[1]) : "";
}

function stripMd(s) {
  return String(s || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Title + h2/h3 sections of a static HTML page, as plain text. */
function htmlSections(html) {
  let h = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|template|nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h);
  let title = titleTag ? htmlText(titleTag[1]).split("|")[0].split(" — ")[0].trim() : "";
  if (!title && h1) title = htmlText(h1[1]);
  const bodyM = /<body[^>]*>([\s\S]*)<\/body>/i.exec(h);
  h = bodyM ? bodyM[1] : h;

  const sections = [];
  const re = /<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let last = 0, cur = { section: "", anchor: "" }, m;
  while ((m = re.exec(h))) {
    const text = htmlText(h.slice(last, m.index));
    if (text) sections.push({ ...cur, text });
    const id = /\bid=["']([^"']+)["']/i.exec(m[2]);
    cur = { section: htmlText(m[3]), anchor: id ? id[1] : "" };
    last = re.lastIndex;
  }
  const tail = htmlText(h.slice(last));
  if (tail || !sections.length) sections.push({ ...cur, text: tail });
  // Merge tiny sections into the previous one so each chunk carries some context.
  const merged = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && s.text.length < 120 && !s.section) prev.text += " " + s.text;
    else merged.push(s);
  }
  return { title, sections: merged };
}

function htmlText(s) {
  return String(s || "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slug(s) {
  return stripMd(s).toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

function humanize(name) {
  return name.replace(/\.(md|html?)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function read(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function walk(dir, acc = []) {
  for (const e of readdir(dir)) {
    if (e.isDirectory()) {
      if (!e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist") walk(path.join(dir, e.name), acc);
    } else if (/\.(md|html?)$/i.test(e.name)) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

export { Search, tokenize, htmlSections, mdSections };

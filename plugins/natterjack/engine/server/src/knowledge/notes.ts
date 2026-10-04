/**
 * A folder of Markdown read like an Obsidian vault: frontmatter (owner, reviewed, tags),
 * [[wikilinks]] (with |alias and #heading) and relative Markdown links resolved to notes,
 * backlinks, tags (frontmatter and inline #tags) and freshness (reviewed against the
 * area's review interval). Works for any notes folder: a repo's docs or a store's cache.
 */

import fs from "node:fs";
import path from "node:path";

export type FrontValue = string | string[];
export interface Frontmatter { data: Record<string, FrontValue>; body: string; present: boolean }

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

/** YAML-ish frontmatter: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. Nothing deeper. */
export function parseFrontmatter(text: string): Frontmatter {
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text, present: false };
  const data: Record<string, FrontValue> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) || /^-\s+(.*)$/.exec(line);
    if (item && listKey) { (data[listKey] as string[]).push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { listKey = null; continue; }
    const key = kv[1].toLowerCase();
    const raw = kv[2].trim();
    if (key in data) { listKey = null; continue; } // first one wins
    if (!raw) { data[key] = []; listKey = key; continue; }
    listKey = null;
    const arr = /^\[(.*)\]$/.exec(raw);
    data[key] = arr ? arr[1].split(",").map(unquote).filter(Boolean) : unquote(raw);
  }
  return { data, body: text.slice(m[0].length), present: true };
}

/** One frontmatter field as text ("" when missing; a list joins with ", "). */
export function fmString(fm: Record<string, FrontValue>, key: string): string {
  const v = fm[key];
  return Array.isArray(v) ? v.join(", ") : v || "";
}

/** One frontmatter field as a list ("a, b" and "[a, b]" both work). */
export function fmList(fm: Record<string, FrontValue>, key: string): string[] {
  const v = fm[key];
  if (Array.isArray(v)) return v.filter(Boolean);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Set one scalar field, adding frontmatter if there's none; everything else is kept as written. */
export function setFrontmatter(text: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const m = FM_RE.exec(text);
  if (!m) return `---\n${line}\n---\n\n${text}`;
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`, "i").test(l));
  if (at >= 0) {
    // Drop a block list that belonged to it.
    let end = at + 1;
    while (end < lines.length && /^\s*-\s+/.test(lines[end])) end++;
    lines.splice(at, end - at, line);
  } else {
    lines.push(line);
  }
  const nl = m[0].includes("\r\n") ? "\r\n" : "\n";
  return `---${nl}${lines.join(nl)}${nl}---${nl}${text.slice(m[0].length)}`;
}

export interface NoteLink { target: string; heading: string | null; alias: string | null; wiki: boolean }

/** Text with fenced and inline code blanked out (links and tags inside code don't count). */
function withoutCode(body: string): string {
  return body.replace(/```[\s\S]*?(```|$)|~~~[\s\S]*?(~~~|$)/g, (m) => m.replace(/[^\n]/g, " ")).replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

/** [[wikilinks]] and relative links to .md files. */
export function extractLinks(body: string): NoteLink[] {
  const text = withoutCode(body);
  const out: NoteLink[] = [];
  for (const m of text.matchAll(/!?\[\[([^\]|#\n]*)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/g)) {
    const target = m[1].trim();
    if (!target && !m[2]) continue;
    out.push({ target, heading: m[2]?.trim() || null, alias: m[3]?.trim() || null, wiki: true });
  }
  for (const m of text.matchAll(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = m[2];
    if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) continue;
    const [p, h] = href.split("#");
    let target = p;
    try { target = decodeURIComponent(p); } catch {}
    if (!/\.md$/i.test(target)) continue;
    out.push({ target, heading: h || null, alias: m[1] || null, wiki: false });
  }
  return out;
}

/** Inline #tags (not headings, not inside code or links) plus frontmatter tags, lowercased and unique. */
export function extractTags(body: string, fm: Record<string, FrontValue> = {}): string[] {
  const tags = new Set(fmList(fm, "tags").map((t) => t.replace(/^#/, "").toLowerCase()));
  const text = withoutCode(body).replace(/\]\([^)]*\)/g, " ");
  for (const m of text.matchAll(/(^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gu)) tags.add(m[2].toLowerCase());
  return [...tags].filter(Boolean).sort();
}

/** The note title: frontmatter title, else the first # heading, else the file name. */
export function noteTitle(rel: string, fm: Record<string, FrontValue>, body: string): string {
  const t = fmString(fm, "title");
  if (t) return t;
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  if (h) return h[1].trim();
  return path.posix.basename(rel).replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

/**
 * Where a link points, Obsidian's way: a target with a folder is a path (from the vault
 * root, or relative to the note for Markdown links); a bare name matches any note with
 * that file name, preferring the one in the same folder, then the shortest path.
 */
export function resolveLink(link: NoteLink, fromRel: string, rels: string[]): string | null {
  if (!link.target) return fromRel; // [[#heading]]: this note
  const lower = new Map(rels.map((r) => [r.toLowerCase(), r]));
  const withMd = (t: string) => (/\.md$/i.test(t) ? t : `${t}.md`);
  const norm = (t: string) => path.posix.normalize(t).replace(/^\.?\//, "");
  if (!link.wiki || link.target.startsWith(".")) {
    const rel = norm(path.posix.join(path.posix.dirname(fromRel), withMd(link.target)));
    return lower.get(rel.toLowerCase()) || null;
  }
  if (link.target.includes("/")) return lower.get(norm(withMd(link.target)).toLowerCase()) || null;
  const name = withMd(link.target).toLowerCase();
  const hits = rels.filter((r) => path.posix.basename(r).toLowerCase() === name);
  if (!hits.length) return null;
  const dir = path.posix.dirname(fromRel);
  return hits.find((h) => path.posix.dirname(h) === dir) || hits.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
}

export interface Note {
  rel: string;
  title: string;
  owner: string | null;
  /** Frontmatter `reviewed` (YYYY-MM-DD), if set. */
  reviewed: string | null;
  tags: string[];
  /** File time (a store's: the object's last change). */
  updatedAt: string | null;
  /** Notes this one links to (resolved), and links that point nowhere. */
  links: string[];
  unresolved: string[];
  backlinks: string[];
  /** From frontmatter `summary` / `description`, else the first paragraph, trimmed. */
  summary: string;
}

/** A note's freshness against its area's review interval (days): reviewed date if set, else last change. */
export function freshness(note: { reviewed: string | null; updatedAt: string | null }, reviewEveryDays: number | null, now = Date.now()): { since: string | null; dueAt: string | null; stale: boolean } {
  const since = note.reviewed && !isNaN(Date.parse(note.reviewed)) ? note.reviewed : note.updatedAt;
  if (!reviewEveryDays || !since) return { since: since || null, dueAt: null, stale: false };
  const due = Date.parse(since) + reviewEveryDays * 86_400_000;
  return { since, dueAt: new Date(due).toISOString().slice(0, 10), stale: now > due };
}

function summaryOf(fm: Record<string, FrontValue>, body: string): string {
  const s = fmString(fm, "summary") || fmString(fm, "description");
  if (s) return s.slice(0, 200);
  const para = withoutCode(body).split(/\r?\n\s*\r?\n/).map((p) => p.trim()).find((p) => p && !/^(#|>|\||-{3,}|!\[)/.test(p));
  return (para || "").replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").slice(0, 200);
}

/** Parse one note (rel is "/"-separated from the vault root). */
export function parseNote(rel: string, text: string, updatedAt: string | null): Omit<Note, "links" | "unresolved" | "backlinks"> & { rawLinks: NoteLink[] } {
  const { data, body } = parseFrontmatter(text);
  const reviewed = fmString(data, "reviewed") || fmString(data, "last_reviewed") || null;
  return {
    rel, title: noteTitle(rel, data, body), owner: fmString(data, "owner") || null,
    reviewed: reviewed && /^\d{4}-\d{2}-\d{2}/.test(reviewed) ? reviewed.slice(0, 10) : null,
    tags: extractTags(body, data), updatedAt, summary: summaryOf(data, body), rawLinks: extractLinks(body),
  };
}

const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/** Every .md file under dir ("/"-separated rel paths), skipping dot folders and node_modules. */
export function walkNotes(dir: string): { rel: string; file: string; mtimeMs: number }[] {
  const out: { rel: string; file: string; mtimeMs: number }[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walk(full); }
      else if (/\.md$/i.test(e.name)) {
        try { const st = fs.statSync(full); if (st.size <= MAX_NOTE_BYTES) out.push({ rel: path.relative(dir, full).split(path.sep).join("/"), file: full, mtimeMs: st.mtimeMs }); } catch {}
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Link every parsed note: resolve links, collect backlinks. */
export function linkNotes(parsed: ReturnType<typeof parseNote>[]): Note[] {
  const rels = parsed.map((p) => p.rel);
  const back = new Map<string, Set<string>>(rels.map((r) => [r, new Set()]));
  const notes: Note[] = parsed.map(({ rawLinks, ...p }) => {
    const links = new Set<string>(), unresolved = new Set<string>();
    for (const l of rawLinks) {
      const to = resolveLink(l, p.rel, rels);
      if (to === null) unresolved.add(l.target);
      else if (to !== p.rel) { links.add(to); back.get(to)!.add(p.rel); }
    }
    return { ...p, links: [...links], unresolved: [...unresolved], backlinks: [] };
  });
  for (const n of notes) n.backlinks = [...back.get(n.rel)!].sort();
  return notes;
}

/**
 * The notes of one folder, re-parsing only files whose mtime changed. `times` overrides
 * file times (a store's cache knows each object's real last change).
 */
export class NotesIndex {
  private cache = new Map<string, { mtimeMs: number; parsed: ReturnType<typeof parseNote> }>();
  private last: { sig: string; notes: Note[] } | null = null;

  readonly dir: string;

  constructor(dir: string) { this.dir = dir; }

  notes(times?: Record<string, string | null>): Note[] {
    const files = walkNotes(this.dir);
    const sig = files.map((f) => `${f.rel}:${f.mtimeMs}`).join("|") + "#" + JSON.stringify(times || {});
    if (this.last && this.last.sig === sig) return this.last.notes;
    const seen = new Set<string>();
    const parsed = files.map((f) => {
      seen.add(f.rel);
      const updatedAt = (times && times[f.rel]) || new Date(f.mtimeMs).toISOString();
      const hit = this.cache.get(f.rel);
      if (hit && hit.mtimeMs === f.mtimeMs) return { ...hit.parsed, updatedAt };
      let text = "";
      try { text = fs.readFileSync(f.file, "utf-8"); } catch {}
      const p = parseNote(f.rel, text, updatedAt);
      this.cache.set(f.rel, { mtimeMs: f.mtimeMs, parsed: p });
      return p;
    });
    for (const k of [...this.cache.keys()]) if (!seen.has(k)) this.cache.delete(k);
    const notes = linkNotes(parsed);
    this.last = { sig, notes };
    return notes;
  }
}

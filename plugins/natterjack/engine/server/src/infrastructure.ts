/**
 * The Infrastructure page: one Markdown doc in the workspace about the team's
 * infrastructure (infrastructure.json `file`: accounts, environments, URLs, databases,
 * IPs, firewall rules), read on every request, with "quick facts" pulled out of it.
 * Nothing is copied by hand: facts come from the doc's header lines and tables, as
 * described by infrastructure.json `groups`, and the page renders the whole doc below
 * them. If a table moves or is renamed, its group simply drops out; the full doc still
 * shows. Workspaces set up before the rename have reference.json, read when
 * infrastructure.json isn't there.
 *
 * A group is { title, section?, ... } plus ONE way to get its rows:
 *   rows:    [{ label, header }]                    "**Header:** value" lines
 *            [{ label, regex }]                     first capture group anywhere in the doc
 *            [{ label, table, key, match, value? }] a key/value table: the row whose `key`
 *                                                   column is `match`; value column default "Value"
 *   table:   "<heading>" | ["<heading>", ...], label: col | [cols], value: col, note?: col,
 *            firstOf?: true (value is a comma list: keep the first), noteFromHeading?: true
 *   kv:      [{ heading, label }], value: "<key>", note?: ["<key>", ...], key?: "Property", valueColumn?: "Value"
 *            one row per key/value table
 *   extract: { table, column, pattern, label?: 1, value?: 2, noteColumn? }
 *            every regex match in one column of a table, merged by label
 *            (notes joined from noteColumn)
 */

import fs from "node:fs";
import path from "node:path";
import { readConfigFile } from "./config.ts";

export interface FactRow { label: string; value: string; note?: string }
export interface FactGroup { title: string; section: string; rows: FactRow[] }

export function infrastructure(workspaceRoot: string) {
  let { data, error } = readConfigFile("infrastructure.json");
  if (!data && !error) ({ data, error } = readConfigFile("reference.json"));
  const rel = data && typeof data.file === "string" ? data.file.replace(/\\/g, "/") : null;
  const empty = { available: false, configured: !!rel, error, title: data?.title || null, rel, file: null, markdown: "", updatedAt: null, lastUpdated: null, groups: [] };
  if (!rel || rel.split("/").some((p) => p === "..") || path.isAbsolute(rel)) return empty;
  const file = path.join(workspaceRoot, rel);
  let markdown: string;
  let updatedAt: string;
  try {
    markdown = fs.readFileSync(file, "utf-8");
    updatedAt = fs.statSync(file).mtime.toISOString();
  } catch {
    return { ...empty, file };
  }
  return {
    available: true,
    configured: true,
    error,
    title: data.title || null,
    rel,
    file,
    markdown,
    updatedAt,
    lastUpdated: data.lastUpdatedHeader ? headerValue(markdown, data.lastUpdatedHeader) : null,
    groups: quickFacts(markdown, Array.isArray(data.groups) ? data.groups : []),
  };
}

/** The configured groups, each with the rows found in `md` (empty groups are left out). */
export function quickFacts(md: string, specs: any[]): FactGroup[] {
  const groups: FactGroup[] = [];
  for (const g of specs) {
    if (!g || typeof g.title !== "string") continue;
    let rows: FactRow[] = [];
    try { rows = groupRows(md, g); } catch { rows = []; }
    rows = rows.filter((r) => r.label && r.value);
    if (rows.length) groups.push({ title: g.title, section: typeof g.section === "string" ? g.section : slug(g.title), rows });
  }
  return groups;
}

function groupRows(md: string, g: any): FactRow[] {
  if (Array.isArray(g.rows)) {
    return g.rows.map((r: any) => {
      let value: string | null = null;
      if (r.header) value = headerValue(md, r.header);
      else if (r.regex) value = (new RegExp(r.regex, "im").exec(md) || [])[1] || null;
      else if (r.table) {
        const hit = table(md, r.table).find((row) => row[r.key || "Property"] === r.match);
        value = hit ? hit[r.value || "Value"] : null;
      }
      return { label: r.label, value };
    });
  }
  if (g.table) {
    const headings: string[] = Array.isArray(g.table) ? g.table : [g.table];
    const labelCols: string[] = Array.isArray(g.label) ? g.label : [g.label];
    return headings.flatMap((h) => table(md, h).map((r) => {
      let value = r[g.value] || "";
      if (g.firstOf) value = value.split(",")[0].trim();
      return {
        label: labelCols.map((c) => r[c]).find(Boolean) || "",
        value,
        note: g.noteFromHeading ? h : g.note ? r[g.note] : undefined,
      };
    }));
  }
  if (Array.isArray(g.kv)) {
    const out: FactRow[] = [];
    for (const t of g.kv) {
      const props = Object.fromEntries(table(md, t.heading).map((r) => [r[g.key || "Property"], r[g.valueColumn || "Value"]]));
      if (props[g.value]) out.push({ label: t.label, value: props[g.value], note: (g.note || []).map((k: string) => props[k]).filter(Boolean).join(" · ") || undefined });
    }
    return out;
  }
  if (g.extract) {
    const x = g.extract;
    const merged = new Map<string, { value: string; notes: string[] }>();
    const re = new RegExp(x.pattern, "g");
    for (const r of table(md, x.table)) {
      for (const m of String(r[x.column] || "").matchAll(re)) {
        const label = String(m[x.label || 1] || "").trim();
        if (!label) continue;
        const entry = merged.get(label) || { value: m[x.value || 2], notes: [] };
        if (x.noteColumn && r[x.noteColumn]) entry.notes.push(r[x.noteColumn]);
        merged.set(label, entry);
      }
    }
    return [...merged].map(([label, e]) => ({ label, value: e.value, note: e.notes.join(", ") }));
  }
  return [];
}

/** "**Label:** value" lines near the top of the doc. */
function headerValue(md: string, label: string): string | null {
  const m = new RegExp(`^\\*\\*${escapeRe(label)}:\\*\\*\\s*(.+)$`, "m").exec(md);
  return m ? m[1].trim() : null;
}

/**
 * Rows of the first pipe table under the heading whose text is exactly `heading`
 * (any level), as { column: cell } objects with markdown emphasis stripped.
 */
export function table(md: string, heading: string): Record<string, string>[] {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${escapeRe(heading)}\\s*$`).test(l));
  if (start < 0) return [];
  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith("|")) {
    if (/^#{1,6}\s/.test(lines[i])) return []; // next heading first: no table here
    i++;
  }
  const rows: string[][] = [];
  for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
    const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/\*\*|`/g, ""));
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "---")) continue; // separator row
    rows.push(cells);
  }
  if (rows.length < 2) return [];
  const [head, ...body] = rows;
  return body.map((cells) => Object.fromEntries(head.map((h, k) => [h, cells[k] ?? ""])));
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

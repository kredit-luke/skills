/**
 * The Links page: tiles grouped in categories, from two files merged on read:
 *   team      .claude/dashboard/links.json (committed, everyone sees them)
 *   personal  .claude/ledger/links.local.json (gitignored, this machine only)
 * Same shape in both: { categories: [{ title, description?, tiles: [tile] }] }, where a
 * tile is { title, description?, icon? (emoji), url? | links?: [{ label, url }],
 * repo?: "<workspace folder>", edit?: true }. Categories with the same title merge
 * (team first). Re-read on every request; the Links page edits both through saveLink.
 *
 * Only http(s) links and dashboard-relative paths get through, so a bad entry
 * can't become a javascript: link.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, LEDGER_DIR, readConfigFile, writeConfigFile } from "./config.ts";

export type LinkScope = "team" | "personal";
const FILES: Record<LinkScope, { dir: string; name: string }> = {
  team: { dir: CONFIG_DIR, name: "links.json" },
  personal: { dir: LEDGER_DIR, name: "links.local.json" },
};

const safeUrl = (u: unknown): u is string => typeof u === "string" && (/^https?:\/\/[^\s]+$/i.test(u) || /^\/(?!\/)\S*$/.test(u));
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A top-level workspace folder, by name only (no separators or ..), or null. */
export function repoDir(root: string, name: unknown): string | null {
  return typeof name === "string" && /^[\w.-]+$/.test(name) && !/^\.+$/.test(name) ? path.join(root, name) : null;
}

/** The repo's root README (README.md, readme.md, ...), or null. */
function readmeFile(root: string, repo: string): string | null {
  const dir = repoDir(root, repo);
  if (!dir) return null;
  try {
    return fs.readdirSync(dir).find((f) => /^readme\.md$/i.test(f) && fs.statSync(path.join(dir, f)).isFile()) || null;
  } catch {
    return null;
  }
}

/** GET /api/readme?repo=: the README of a cloned workspace repo, for the Links page's Info button. */
export function readRepoReadme(root: string, repo: string | null) {
  const dir = repoDir(root, repo);
  if (!dir || !fs.existsSync(path.join(dir, ".git"))) return null;
  const file = readmeFile(root, repo!);
  if (!file) return null;
  const full = path.join(dir, file);
  return { repo, file: `${repo}/${file}`, path: full, markdown: fs.readFileSync(full, "utf-8"), updatedAt: fs.statSync(full).mtime.toISOString() };
}

function load(scope: LinkScope): { data: any; error: string | null } {
  const { dir, name } = FILES[scope];
  const { data, error } = readConfigFile(name, dir);
  return { data: data && Array.isArray(data.categories) ? data : { ...(data || {}), categories: [] }, error };
}

export function readLinks(root: string) {
  const errors: string[] = [];
  const out: any[] = [];
  for (const scope of ["team", "personal"] as LinkScope[]) {
    const { data, error } = load(scope);
    if (error) errors.push(error);
    data.categories.forEach((c: any) => {
      if (!c || !str(c.title)) return;
      let cat = out.find((x) => x.title === c.title);
      if (!cat) out.push((cat = { title: c.title, description: str(c.description), tiles: [] }));
      else if (!cat.description) cat.description = str(c.description);
      (Array.isArray(c.tiles) ? c.tiles : []).forEach((t: any, index: number) => {
        if (!t || !str(t.title)) return;
        // A cloned repo folder in the workspace: Info shows its README; "edit": true adds Make edits.
        const repo = typeof t.repo === "string" && fs.existsSync(path.join(repoDir(root, t.repo) || "", ".git")) ? t.repo : null;
        const tile = {
          title: str(t.title),
          description: str(t.description),
          icon: str(t.icon),
          url: safeUrl(t.url) ? t.url : null,
          repo,
          editable: !!repo && t.edit === true,
          readme: repo ? readmeFile(root, repo) : null,
          links: (Array.isArray(t.links) ? t.links : []).filter((l: any) => l && safeUrl(l.url)).map((l: any) => ({ label: str(l.label), url: l.url })),
          scope,
          ref: { scope, category: c.title, index },
          // As written, for the edit form (repo even when it isn't cloned here).
          raw: { repo: str(t.repo) || null, edit: t.edit === true },
        };
        if (tile.url || tile.links.length || tile.repo) cat.tiles.push(tile);
      });
    });
  }
  return {
    categories: out.filter((c) => c.tiles.length),
    error: errors.length ? errors.join("; ") : undefined,
    files: { team: ".claude/dashboard/links.json", personal: ".claude/ledger/links.local.json" },
  };
}

interface TileRef { scope: LinkScope; category: string; index: number }

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function checkScope(v: unknown): LinkScope {
  if (v === "team" || v === "personal") return v;
  throw httpError(400, "scope must be team or personal");
}

function checkRef(ref: any): TileRef | null {
  if (!ref) return null;
  return { scope: checkScope(ref.scope), category: str(ref.category), index: Number(ref.index) };
}

/** A tile from the edit form, validated and trimmed to what links.json stores. */
function cleanTile(t: any) {
  if (!t || typeof t !== "object") throw httpError(400, "Missing tile");
  const title = str(t.title).trim();
  if (!title || title.length > 80) throw httpError(400, "A title is required (up to 80 characters).");
  const description = str(t.description).trim().slice(0, 300);
  const icon = str(t.icon).trim();
  if ([...icon].length > 4) throw httpError(400, "The icon is one emoji.");
  const url = str(t.url).trim();
  if (url && !safeUrl(url)) throw httpError(400, "The link must start with https://, http:// or / (a dashboard page).");
  const links = (Array.isArray(t.links) ? t.links : [])
    .map((l: any) => ({ label: str(l && l.label).trim().slice(0, 40), url: str(l && l.url).trim() }))
    .filter((l: any) => l.label || l.url);
  if (links.length > 10) throw httpError(400, "Up to 10 links per tile.");
  for (const l of links) {
    if (!l.label) throw httpError(400, "Every link needs a label (e.g. Production).");
    if (!safeUrl(l.url)) throw httpError(400, `"${l.label}" needs a link starting with https://, http:// or /.`);
  }
  const repo = str(t.repo).trim();
  if (repo && !/^[\w.-]+$/.test(repo)) throw httpError(400, "Repo is a top-level workspace folder name.");
  if (!url && !links.length && !repo) throw httpError(400, "Add a link (or a repo for Info).");
  const out: any = { title };
  if (description) out.description = description;
  if (icon) out.icon = icon;
  if (url && !links.length) out.url = url;
  if (links.length) out.links = links;
  if (repo) out.repo = repo;
  if (repo && t.edit === true) out.edit = true;
  return out;
}

function write(scope: LinkScope, data: any) {
  const { dir, name } = FILES[scope];
  data.categories = data.categories.filter((c: any) => c && Array.isArray(c.tiles) && c.tiles.length);
  writeConfigFile(name, data, dir);
}

/** Remove the tile at ref (after checking it's still the one the form was editing). */
function removeAt(ref: TileRef, expectTitle: string | null) {
  const { data, error } = load(ref.scope);
  if (error) throw httpError(409, `${FILES[ref.scope].name} can't be read (${error}); fix it by hand first.`);
  const cat = data.categories.find((c: any) => c && c.title === ref.category);
  const tile = cat && Array.isArray(cat.tiles) ? cat.tiles[ref.index] : null;
  if (!tile || (expectTitle !== null && tile.title !== expectTitle)) {
    throw httpError(409, "That link changed since the page loaded. Reload and try again.");
  }
  cat.tiles.splice(ref.index, 1);
  return data;
}

/**
 * POST /api/links/save { scope, category, categoryDescription?, tile, original?: { ref, title } }
 * Adds a tile (or replaces `original`, possibly moving it to another category or scope).
 */
export function saveLink(root: string, body: any) {
  const scope = checkScope(body.scope);
  const category = str(body.category).trim();
  if (!category || category.length > 60) throw httpError(400, "Pick or name a category (up to 60 characters).");
  const tile = cleanTile(body.tile);
  const original = body.original ? checkRef(body.original.ref) : null;
  const originalTitle = body.original ? str(body.original.title) : null;

  let sameSpot = false;
  if (original) {
    sameSpot = original.scope === scope && original.category === category;
    const data = removeAt(original, originalTitle);
    if (sameSpot) {
      const cat = data.categories.find((c: any) => c.title === category);
      cat.tiles.splice(original.index, 0, tile);
      write(scope, data);
      return readLinks(root);
    }
    write(original.scope, data);
  }
  const { data, error } = load(scope);
  if (error) throw httpError(409, `${FILES[scope].name} can't be read (${error}); fix it by hand first.`);
  let cat = data.categories.find((c: any) => c && c.title === category);
  if (!cat) {
    cat = { title: category, tiles: [] };
    const desc = str(body.categoryDescription).trim().slice(0, 200);
    if (desc) cat.description = desc;
    data.categories.push(cat);
  }
  if (!Array.isArray(cat.tiles)) cat.tiles = [];
  cat.tiles.push(tile);
  write(scope, data);
  return readLinks(root);
}

/** POST /api/links/delete { ref, title } */
export function deleteLink(root: string, body: any) {
  const ref = checkRef(body.ref);
  if (!ref) throw httpError(400, "Missing ref");
  write(ref.scope, removeAt(ref, str(body.title)));
  return readLinks(root);
}

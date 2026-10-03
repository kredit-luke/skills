/**
 * Explore: browse, read, preview and edit files under the workspace root.
 *
 * Every path from the UI is workspace-relative ("API/src/x.cs", "" = the root)
 * and goes through resolveSafe(), which rejects anything that lands outside the
 * root, including through a symlink or junction, and anything inside .git.
 *
 * Line endings: the editor works in LF. A file's own style (LF or CRLF) and its
 * UTF-8 BOM are reported on read and restored on save, so a save never rewrites
 * the line endings of a file, whatever OS the dashboard runs on.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ExploreEntry, ExploreEol, ExploreFile, ExploreListResponse, ExploreSaveResponse } from "../../shared/api.ts";

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_SAVE_BYTES = 6 * 1024 * 1024;

/** Build output and dependency folders: listed, but only opened on request. */
const HEAVY = new Set(["node_modules", "bin", "obj", "dist", ".angular", ".vs", "worktrees", "coverage", ".next"]);

const RAW_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".xml": "text/xml; charset=utf-8",
};

export function rawType(file: string): string {
  return RAW_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function fail(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
function within(base: string, full: string): boolean {
  const b = norm(base), f = norm(full);
  return f === b || f.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * The absolute path for a workspace-relative `rel`, or an error (403 outside the
 * root or in .git, 404 missing). The real path (symlinks resolved) must also be
 * inside the root.
 */
export function resolveSafe(root: string, rel: unknown): string {
  const r = String(rel ?? "").replace(/\\/g, "/");
  if (r.includes("\0") || path.isAbsolute(r) || /^[a-z]:/i.test(r)) throw fail(403, "Paths are relative to the workspace.");
  const base = path.resolve(root);
  const full = path.resolve(base, "." + path.sep + r);
  if (!within(base, full)) throw fail(403, "That path is outside the workspace.");
  if (/(^|[\\/])\.git([\\/]|$)/.test(path.relative(base, full))) throw fail(403, ".git is not browsable.");
  let real: string;
  try { real = fs.realpathSync.native(full); } catch { throw fail(404, "Not found."); }
  if (!within(fs.realpathSync.native(base), real)) throw fail(403, "That path links outside the workspace.");
  return full;
}

/** "lf" | "crlf" | "mixed" | "none", plus the style a save should use. */
export function detectEol(text: string): { eol: ExploreEol; dominant: "lf" | "crlf" } {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const eol: ExploreEol = !crlf && !lf ? "none" : crlf && lf ? "mixed" : crlf ? "crlf" : "lf";
  return { eol, dominant: crlf > lf ? "crlf" : "lf" };
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Text, BOM and line endings of a file's bytes; null content for binary or non-UTF-8. */
export function decodeText(buf: Buffer): { content: string | null; bom: boolean; binary: boolean; utf8: boolean } {
  const bom = buf.subarray(0, 3).equals(UTF8_BOM);
  const body = bom ? buf.subarray(3) : buf;
  if (body.subarray(0, 8000).includes(0)) return { content: null, bom, binary: true, utf8: false };
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(body), bom, binary: false, utf8: true };
  } catch {
    return { content: new TextDecoder("utf-8").decode(body), bom, binary: false, utf8: false };
  }
}

/** Editor text (any line endings) → the bytes to write, in the file's style. */
export function encodeText(content: string, eol: "lf" | "crlf", bom: boolean): Buffer {
  const lf = String(content).replace(/\r\n?/g, "\n");
  const text = eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
  const bytes = Buffer.from(text, "utf-8");
  return bom ? Buffer.concat([UTF8_BOM, bytes]) : bytes;
}

const toRel = (root: string, full: string) => path.relative(path.resolve(root), full).split(path.sep).join("/");

export class Explore {
  root: string;
  constructor(root: string) { this.root = root; }

  list(rel: unknown): ExploreListResponse {
    const dir = resolveSafe(this.root, rel);
    if (!fs.statSync(dir).isDirectory()) throw fail(400, "Not a folder.");
    const entries: ExploreEntry[] = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === ".git") continue;
      const full = path.join(dir, d.name);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; } // broken link
      const kind = st.isDirectory() ? "dir" : "file";
      entries.push({
        name: d.name, kind, size: kind === "file" ? st.size : 0, mtimeMs: Math.round(st.mtimeMs),
        ...(d.isSymbolicLink() ? { link: true } : {}),
        ...(kind === "dir" && HEAVY.has(d.name.toLowerCase()) ? { heavy: true } : {}),
      });
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) : a.kind === "dir" ? -1 : 1));
    return { path: toRel(this.root, dir), entries };
  }

  read(rel: unknown): ExploreFile {
    const full = resolveSafe(this.root, rel);
    const st = fs.statSync(full);
    if (!st.isFile()) throw fail(400, "Not a file.");
    const base: ExploreFile = {
      path: toRel(this.root, full), abs: full, size: st.size, mtimeMs: Math.round(st.mtimeMs),
      content: null, eol: "none", saveEol: "lf", bom: false, binary: false, tooLarge: false, readOnlyReason: null,
    };
    if (st.size > MAX_TEXT_BYTES) return { ...base, tooLarge: true, readOnlyReason: "Too large to open here." };
    const d = decodeText(fs.readFileSync(full));
    if (d.binary) return { ...base, binary: true, bom: d.bom, readOnlyReason: "Binary file." };
    const { eol, dominant } = detectEol(d.content);
    return {
      ...base, content: d.content.replace(/\r\n?/g, "\n"), eol, saveEol: dominant, bom: d.bom,
      readOnlyReason: d.utf8 ? null : "Not UTF-8 text, so it opens read-only.",
    };
  }

  /**
   * Write `content` in the given line-ending style. `baseMtimeMs` is the mtime the
   * editor loaded; if the file changed on disk since, refuse with 409.
   */
  save(body: any): ExploreSaveResponse {
    const full = resolveSafe(this.root, body?.path);
    const st = fs.statSync(full);
    if (!st.isFile()) throw fail(400, "Not a file.");
    if (typeof body.content !== "string") throw fail(400, "content is required.");
    const eol = body.eol === "crlf" ? "crlf" : "lf";
    if (!body.force && Math.round(st.mtimeMs) !== Number(body.baseMtimeMs)) {
      throw fail(409, "The file changed on disk since you opened it.");
    }
    const bytes = encodeText(body.content, eol, !!body.bom);
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, bytes, { mode: st.mode });
    try {
      fs.renameSync(tmp, full);
    } catch {
      // Windows refuses the rename while another program holds the file open; write in place.
      try { fs.unlinkSync(tmp); } catch {}
      fs.writeFileSync(full, bytes);
    }
    const after = fs.statSync(full);
    return { path: toRel(this.root, full), mtimeMs: Math.round(after.mtimeMs), size: after.size, eol, bom: !!body.bom };
  }
}

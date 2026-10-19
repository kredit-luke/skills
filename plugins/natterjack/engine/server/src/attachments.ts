/**
 * Files attached to a run's prompt or a reply (screenshots, PDFs, logs...).
 *
 * The browser uploads each file as you add it; it waits in _staged/ until the run
 * or reply is sent, then moves into the run's own folder. Claude gets the absolute
 * paths in the prompt and reads them itself (the Read tool opens images and PDFs),
 * with the run's folder passed as --add-dir so a run in a worktree may read it.
 *
 * The other way round, each run has an outputs folder for files it makes for the person
 * (reports, PDFs, exports): created before each turn, named in the run's rules and in
 * DASHBOARD_OUTPUTS, listed and downloadable on the run page (hosted, it's the only way
 * to get a file out of the pod).
 *
 * Layout under <main workspace>/.claude/ledger/attachments/ (gitignored):
 *   _staged/<id>/<name>      uploaded, not sent yet (deleted after a day)
 *   <runId>/<id>-<name>      sent with that run (deleted keepAttachmentsDays after it's done)
 *   <runId>/outputs/...      what the run made (subfolders allowed; deleted with the rest)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Attachment, RunMeta, RunOutput } from "../../shared/api.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** Most output files a run page lists. */
export const MAX_OUTPUTS = 200;
// Files looked at before picking the newest MAX_OUTPUTS, so a huge folder can't stall a request.
const MAX_OUTPUTS_SCAN = 5000;
const ID_RE = /^[a-f0-9]{12}$/;
const RUN_ID_RE = /^[a-z0-9-]+$/i;
/** Opened in the browser; every other output (HTML and SVG included) is a download. */
const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);
const STAGED_TTL_MS = 24 * 3600 * 1000;
/** Runs in these states may still get replies soon, so their files are kept. */
const ACTIVE = new Set(["running", "waiting"]);

const KINDS: Record<string, Attachment["kind"]> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
  ".pdf": "pdf",
  ".txt": "text", ".log": "text", ".md": "text", ".json": "text", ".csv": "text", ".xml": "text", ".yml": "text", ".yaml": "text",
  ".html": "text", ".css": "text", ".scss": "text", ".js": "text", ".ts": "text", ".cs": "text", ".sql": "text", ".har": "text",
};
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** A file name that's safe on every OS: no folders, no odd characters, not too long. */
export function safeName(name: string): string {
  const base = String(name || "").split(/[\\/]/).pop()!.trim();
  const rawExt = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const ext = /^\.[a-z0-9]+$/.test(rawExt) ? rawExt : ""; // never a bare trailing dot (invalid on Windows)
  const stem = base.slice(0, base.length - path.extname(base).length).replace(/[^\w.\- ]+/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 80);
  return (stem || "file") + ext;
}

export function kindOf(name: string): Attachment["kind"] {
  return KINDS[path.extname(name).toLowerCase()] || "file";
}

export function contentTypeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return CONTENT_TYPES[ext] || (KINDS[ext] === "text" ? "text/plain; charset=utf-8" : "application/octet-stream");
}

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The prompt Claude gets: your text, then where each attached file is. */
export function promptWithAttachments(prompt: string, files: Attachment[] | null | undefined): string {
  if (!files || !files.length) return prompt;
  const lines = files.map((f) => `- ${f.path} (${f.kind === "file" ? "file" : f.kind}, ${size(f.size)})`);
  return `${prompt}\n\nAttached files. Read each one before you start (the Read tool opens images and PDFs):\n${lines.join("\n")}`;
}

/**
 * Response headers for a run's output file: PDFs and images inline, anything else
 * (HTML and SVG included, which could run script) as a download.
 */
export function outputHeaders(name: string, size: number): Record<string, string | number> {
  const type = contentTypeOf(name);
  const inline = INLINE_TYPES.has(type);
  const base = path.basename(name);
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return {
    "Content-Type": type,
    "Content-Length": size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
  };
}

export class Attachments {
  root: string;
  staged: string;

  constructor(ledgerDir: string) {
    this.root = path.join(ledgerDir, "attachments");
    this.staged = path.join(this.root, "_staged");
  }

  runDir(runId: string): string { return path.join(this.root, runId); }

  outputsDir(runId: string): string { return path.join(this.runDir(runId), "outputs"); }

  /**
   * The outputs folder's real path, or null unless it's a plain folder at exactly
   * <attachments>/<runId>/outputs: a run can write there, so it could swap in a link
   * (to the folder, or to the run's folder above it) pointing anywhere it can read.
   */
  outputsRoot(runId: string): string | null {
    if (!RUN_ID_RE.test(runId)) return null;
    try {
      const real = fs.realpathSync(this.outputsDir(runId));
      return real === path.join(fs.realpathSync(this.root), runId, "outputs") ? real : null;
    } catch {
      return null;
    }
  }

  /** The run's outputs folder, created if it isn't there yet (before each turn); a link in its place is removed. */
  ensureOutputs(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error("Bad run id");
    const dir = this.outputsDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    if (this.outputsRoot(runId)) return dir;
    // Remove the link itself, never what it points to (unlink for a symlink, rmdir for a Windows junction).
    if (fs.lstatSync(dir).isSymbolicLink()) { try { fs.unlinkSync(dir); } catch { fs.rmdirSync(dir); } }
    fs.mkdirSync(dir, { recursive: true });
    if (!this.outputsRoot(runId)) throw new Error("The run's outputs folder isn't a plain folder.");
    return dir;
  }

  /**
   * The files in a run's outputs folder, newest first: paths relative to it with `/`,
   * no dotfiles or dot folders, no symlinks, at most MAX_OUTPUTS.
   */
  outputs(runId: string): RunOutput[] {
    const root = this.outputsRoot(runId);
    if (!root) return [];
    const out: RunOutput[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_OUTPUTS_SCAN) return;
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        const name = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() && depth < 8) walk(full, name, depth + 1);
        else if (e.isFile()) {
          try { const st = fs.statSync(full); out.push({ name, size: st.size, modifiedAt: st.mtime.toISOString() }); } catch {}
        }
      }
    };
    walk(root, "", 0);
    // The cap after sorting: the newest files, not the first ones by name.
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name)).slice(0, MAX_OUTPUTS);
  }

  /**
   * Absolute path of a file in a run's outputs folder, or null: a relative path inside it
   * (no `..`, no dotfiles, not absolute), a regular file, and still inside once symlinks
   * and junctions are resolved.
   */
  output(runId: string, rel: string): string | null {
    if (!RUN_ID_RE.test(runId) || typeof rel !== "string" || !rel || rel.includes("\0")) return null;
    const parts = rel.split(/[\\/]/);
    if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || parts.some((s) => !s || s.startsWith("."))) return null;
    try {
      const root = this.outputsRoot(runId);
      if (!root) return null;
      const full = fs.realpathSync(path.join(root, ...parts));
      const inside = path.relative(root, full);
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return null;
      return fs.statSync(full).isFile() ? full : null;
    } catch {
      return null;
    }
  }

  /** Save an upload until it's sent. */
  stage(name: string, data: Buffer): { id: string; name: string; size: number; kind: Attachment["kind"] } {
    if (!data.length) throw Object.assign(new Error("The file is empty."), { status: 400 });
    if (data.length > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error(`Files can be up to ${size(MAX_ATTACHMENT_BYTES)}.`), { status: 413 });
    const id = crypto.randomBytes(6).toString("hex");
    const clean = safeName(name);
    const dir = path.join(this.staged, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, clean), data);
    return { id, name: clean, size: data.length, kind: kindOf(clean) };
  }

  /** Drop a staged upload that won't be sent (e.g. its run was refused). */
  unstage(id: string) {
    if (ID_RE.test(id)) fs.rmSync(path.join(this.staged, id), { recursive: true, force: true });
  }

  /** Check staged ids exist (before a run is created). Throws with a user-facing message. */
  check(ids: unknown): string[] {
    if (ids == null) return [];
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) throw Object.assign(new Error(`Attach up to ${MAX_ATTACHMENTS} files.`), { status: 400 });
    for (const id of ids) {
      if (typeof id !== "string" || !ID_RE.test(id) || !this._stagedFile(id)) {
        throw Object.assign(new Error("An attached file is missing; remove it and attach it again."), { status: 400 });
      }
    }
    return ids as string[];
  }

  /** Move staged uploads into the run's folder. */
  claim(runId: string, ids: string[]): Attachment[] {
    if (!ids.length) return [];
    const dir = this.runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    return ids.map((id) => {
      const src = this._stagedFile(id);
      if (!src) throw Object.assign(new Error("An attached file is missing; remove it and attach it again."), { status: 400 });
      const name = path.basename(src);
      const file = `${id}-${name}`;
      const dest = path.join(dir, file);
      fs.renameSync(src, dest);
      fs.rmSync(path.dirname(src), { recursive: true, force: true });
      return { id, name, file, size: fs.statSync(dest).size, kind: kindOf(name), path: dest };
    });
  }

  /** Absolute path of one of a run's files, or null (no traversal, must exist). */
  file(runId: string, file: string): string | null {
    if (!/^[a-z0-9-]+$/i.test(runId) || !/^[a-f0-9]{12}-[^\\/]+$/.test(file) || file.includes("..")) return null;
    const full = path.join(this.runDir(runId), file);
    try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
  }

  /**
   * Delete the files of runs that are done (not running or waiting on you) and whose
   * last turn ended more than `keepDays` ago, plus uploads never sent. 0 keeps run files.
   * Returns the ids of runs whose files were removed.
   */
  cleanup(getRun: (id: string) => RunMeta | null, isLive: (id: string) => boolean, keepDays: number, now = Date.now()): string[] {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return []; }
    for (const e of fs.existsSync(this.staged) ? fs.readdirSync(this.staged, { withFileTypes: true }) : []) {
      const dir = path.join(this.staged, e.name);
      try { if (now - fs.statSync(dir).mtimeMs > STAGED_TTL_MS) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    if (!keepDays || keepDays <= 0) return [];
    const cutoff = keepDays * 24 * 3600 * 1000;
    const removed: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "_staged") continue;
      const dir = path.join(this.root, e.name);
      const run = getRun(e.name);
      let last: number;
      if (run) {
        if (ACTIVE.has(run.status) || isLive(run.id)) continue;
        last = Date.parse(run.endedAt || run.turnStartedAt || run.startedAt);
      } else {
        try { last = fs.statSync(dir).mtimeMs; } catch { continue; } // run deleted: go by the folder's age
      }
      if (!(now - last > cutoff)) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(e.name); } catch {}
    }
    return removed;
  }

  /** Disk used by attachments, and how many runs have some. */
  usage(): { bytes: number; runs: number } {
    let bytes = 0, runs = 0;
    const walk = (dir: string): number => {
      let n = 0;
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          n += e.isDirectory() ? walk(p) : (() => { try { return fs.statSync(p).size; } catch { return 0; } })();
        }
      } catch {}
      return n;
    };
    try {
      for (const e of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const n = walk(path.join(this.root, e.name));
        bytes += n;
        if (e.name !== "_staged" && n) runs++;
      }
    } catch {}
    return { bytes, runs };
  }

  private _stagedFile(id: string): string | null {
    const dir = path.join(this.staged, id);
    try {
      const f = fs.readdirSync(dir).find((n) => fs.statSync(path.join(dir, n)).isFile());
      return f ? path.join(dir, f) : null;
    } catch {
      return null;
    }
  }
}

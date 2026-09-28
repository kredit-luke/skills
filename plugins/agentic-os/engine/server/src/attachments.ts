/**
 * Files attached to a run's prompt or a reply (screenshots, PDFs, logs...).
 *
 * The browser uploads each file as you add it; it waits in _staged/ until the run
 * or reply is sent, then moves into the run's own folder. Claude gets the absolute
 * paths in the prompt and reads them itself (the Read tool opens images and PDFs),
 * with the run's folder passed as --add-dir so a run in a worktree may read it.
 *
 * Layout under <main workspace>/.claude/ledger/attachments/ (gitignored):
 *   _staged/<id>/<name>      uploaded, not sent yet (deleted after a day)
 *   <runId>/<id>-<name>      sent with that run (deleted keepAttachmentsDays after it's done)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Attachment, RunMeta } from "../../shared/api.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const ID_RE = /^[a-f0-9]{12}$/;
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

export class Attachments {
  root: string;
  staged: string;

  constructor(ledgerDir: string) {
    this.root = path.join(ledgerDir, "attachments");
    this.staged = path.join(this.root, "_staged");
  }

  runDir(runId: string): string { return path.join(this.root, runId); }

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

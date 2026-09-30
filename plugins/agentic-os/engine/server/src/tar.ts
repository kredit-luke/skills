/**
 * Extract a .tar.gz (what `git archive --format=tar.gz` writes) into a folder, streaming.
 * Files up to 1 MB are held in memory until up to 32 of them are written in parallel
 * (creating files one by one is what makes extraction slow on Windows); bigger
 * ones stream to disk.
 *
 * Only regular files and folders are written. Symlinks, hard links and devices are
 * skipped (and counted), and every path must stay inside the target: an absolute
 * path, a drive letter or a ".." segment fails the whole extraction. Long names come
 * from pax (`path=`) or GNU (`L`) headers; git's global pax header is ignored.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BLOCK = 512;
/** Files up to this size are collected in memory and written by a pool of POOL parallel writes; bigger ones stream. */
const SMALL_FILE = 1024 * 1024;
const POOL = 32;

export interface ExtractResult { files: number; dirs: number; skipped: number; bytes: number }

/** A tar member path as a safe relative path (forward slashes), or null. */
export function safeMemberPath(p: string): string | null {
  const s = p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!s || s === "." || s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.split("/").includes("..") || s.includes("\0")) return null;
  return s;
}

const cstr = (b: Buffer, start: number, len: number) => {
  const slice = b.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString("utf-8");
};
const octal = (b: Buffer, start: number, len: number) => {
  // Base-256 (a leading 0x80 byte) for sizes over 8 GB; octal text otherwise.
  if (b[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + b[i];
    return n;
  }
  const t = cstr(b, start, len).trim();
  return t ? parseInt(t, 8) : 0;
};

/** pax records: "<len> key=value\n" … → { key: value }. */
function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(buf.subarray(i, sp).toString(), 10);
    if (!len) break;
    const rec = buf.subarray(sp + 1, i + len - 1).toString("utf-8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

class TarWriter extends Writable {
  private buf: Buffer = Buffer.alloc(0);
  /** Bytes of the current member's data still to come, and the padding after it. */
  private remaining = 0;
  private padding = 0;
  private fd: number | null = null;
  /** A small file being collected in memory, written by the pool when it's complete. */
  private small: { full: string; chunks: Buffer[] } | null = null;
  /** Files being written. Creating files one at a time is slow on Windows (each close is scanned), so small ones go in parallel. */
  private pending = new Set<Promise<void>>();
  private failed: Error | null = null;
  /** Collecting a pax / GNU long-name body instead of writing a file. */
  private meta: { kind: "pax" | "gnu" | "skip"; chunks: Buffer[] } | null = null;
  private nextPath: string | null = null;
  private zeroBlocks = 0;
  /** Folders already made: mkdir per file is most of the time on Windows. */
  private made = new Set<string>();
  readonly result: ExtractResult = { files: 0, dirs: 0, skipped: 0, bytes: 0 };
  private readonly dest: string;
  constructor(dest: string) { super(); this.dest = dest; }

  _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
    try { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; this.drain(); }
    catch (e) { this.closeFile(); return cb(e as Error); }
    if (this.failed) return cb(this.failed);
    // Backpressure: with the pool full, take no more input until a write finishes.
    if (this.pending.size >= POOL) Promise.race(this.pending).then(() => cb(this.failed));
    else cb();
  }
  _final(cb: (err?: Error | null) => void) {
    this.closeFile();
    this.settle().then(() => cb(this.failed || (this.remaining > 0 ? new Error("The archive ends in the middle of a file.") : null)));
  }

  /** Every write started so far has finished (so the caller can clean up after a failure). */
  settle(): Promise<unknown> { return Promise.allSettled([...this.pending]); }

  private closeFile() { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }

  private writeLater(full: string, data: Buffer) {
    const p: Promise<void> = fs.promises.writeFile(full, data)
      .catch((e) => { this.failed = this.failed || e; })
      .finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }

  private endFile() {
    this.closeFile();
    if (this.small) { this.writeLater(this.small.full, Buffer.concat(this.small.chunks)); this.small = null; }
  }

  private drain() {
    for (;;) {
      if (this.remaining > 0) {
        if (!this.buf.length) return;
        const n = Math.min(this.remaining, this.buf.length);
        const part = this.buf.subarray(0, n);
        if (this.fd !== null) { fs.writeSync(this.fd, part); this.result.bytes += n; }
        else if (this.small) { this.small.chunks.push(part); this.result.bytes += n; }
        else if (this.meta && this.meta.kind !== "skip") this.meta.chunks.push(Buffer.from(part));
        this.buf = this.buf.subarray(n);
        this.remaining -= n;
        if (this.remaining > 0) return;
        this.endFile();
        if (this.meta) this.endMeta();
      }
      if (this.padding > 0) {
        const n = Math.min(this.padding, this.buf.length);
        this.buf = this.buf.subarray(n);
        this.padding -= n;
        if (this.padding > 0) return;
      }
      if (this.buf.length < BLOCK) return;
      const h = this.buf.subarray(0, BLOCK);
      this.buf = this.buf.subarray(BLOCK);
      this.header(h);
    }
  }

  private endMeta() {
    const m = this.meta!;
    this.meta = null;
    const body = Buffer.concat(m.chunks);
    if (m.kind === "pax") { const p = parsePax(body).path; if (p) this.nextPath = p; }
    else if (m.kind === "gnu") this.nextPath = cstr(body, 0, body.length);
  }

  private header(h: Buffer) {
    if (h.every((b) => b === 0)) { this.zeroBlocks++; return; }
    this.zeroBlocks = 0;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new Error("Not a valid tar archive (bad header checksum).");
    const type = String.fromCharCode(h[156] || 0x30);
    const size = octal(h, 124, 12);
    const prefix = cstr(h, 345, 155);
    const name = this.nextPath ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === "x" || type === "L") { this.meta = { kind: type === "x" ? "pax" : "gnu", chunks: [] }; return this.emptyMeta(); }
    if (type === "g") { this.meta = { kind: "skip", chunks: [] }; return this.emptyMeta(); }
    this.nextPath = null;

    if (type !== "0" && type !== "5" && type !== "7") {
      // Symlink, hard link, device, fifo…: not written.
      this.result.skipped++;
      this.meta = size ? { kind: "skip", chunks: [] } : null;
      return;
    }
    const rel = safeMemberPath(name);
    if (!rel) throw new Error(`Refusing an archive entry outside the target folder: ${JSON.stringify(name)}`);
    const full = path.join(this.dest, rel);
    if (type === "5") { this.mkdir(full); this.result.dirs++; return; }
    this.mkdir(path.dirname(full));
    this.result.files++;
    if (size <= SMALL_FILE) { this.small = { full, chunks: [] }; if (!size) this.endFile(); return; }
    this.fd = fs.openSync(full, "w");
  }

  private mkdir(dir: string) {
    if (this.made.has(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    this.made.add(dir);
  }

  /** A pax/GNU header with an empty body finishes right away. */
  private emptyMeta() { if (this.remaining === 0) this.endMeta(); }
}

/** Extract archive (.tar.gz) into dest (created if need be). */
export async function extractTarGz(archive: string, dest: string): Promise<ExtractResult> {
  fs.mkdirSync(dest, { recursive: true });
  const out = new TarWriter(dest);
  try {
    await pipeline(fs.createReadStream(archive, { highWaterMark: 1 << 20 }), zlib.createGunzip({ chunkSize: 1 << 18 }), out);
  } catch (e) {
    await out.settle(); // no write still running when the caller removes the folder
    throw e;
  }
  return out.result;
}

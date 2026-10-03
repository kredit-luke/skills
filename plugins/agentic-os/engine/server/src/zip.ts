/**
 * Extract a .zip (what `git archive --format=zip` writes: stored or deflated entries,
 * no zip64) into a folder. The workspace snapshot is a zip so people can open it by
 * hand on Windows; this is for where there's no unzip (the hosted image's boot).
 *
 * The same rules as tar.ts: only files and folders are written (symlinks are skipped
 * and counted), and every path must stay inside the target or the whole extraction fails.
 * Each entry's size and CRC-32 are checked; a corrupt entry fails it too.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { safeMemberPath, type ExtractResult } from "./tar.ts";

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const POOL = 32;

export async function extractZip(archive: string, dest: string): Promise<ExtractResult> {
  const buf = fs.readFileSync(archive);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd === -1) throw new Error("Not a zip archive (no end of central directory).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("zip64 archives aren't supported.");

  fs.mkdirSync(dest, { recursive: true });
  const result: ExtractResult = { files: 0, dirs: 0, skipped: 0, bytes: 0 };
  const made = new Set<string>();
  const mkdir = (d: string) => { if (!made.has(d)) { fs.mkdirSync(d, { recursive: true }); made.add(d); } };
  const pending = new Set<Promise<void>>();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error("Corrupt zip (bad central directory entry).");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf-8");
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new Error(`Encrypted zip entries aren't supported (${name}).`);
    if ((mode & 0o170000) === 0o120000) { result.skipped++; continue; }
    const rel = safeMemberPath(name);
    if (!rel) throw new Error(`Refusing an archive entry outside the target folder: ${JSON.stringify(name)}`);
    const full = path.join(dest, rel);
    if (name.endsWith("/")) { mkdir(full); result.dirs++; continue; }

    if (buf.readUInt32LE(local) !== LOCAL) throw new Error(`Corrupt zip (bad local header for ${name}).`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`Unsupported zip compression method ${method} (${name}).`);
    if (data.length !== size) throw new Error(`Corrupt zip (${name} is ${data.length} bytes, expected ${size}).`);
    // A flipped bit can keep the size (stored entries always do): without this, a damaged
    // workspace would be installed and stamped as current.
    if (zlib.crc32(data) !== crc) throw new Error(`Corrupt zip (${name} fails its CRC-32 check).`);

    mkdir(path.dirname(full));
    const w: Promise<void> = fs.promises.writeFile(full, data).finally(() => { pending.delete(w); });
    pending.add(w);
    result.files++;
    result.bytes += size;
    if (pending.size >= POOL) await Promise.race(pending);
  }
  await Promise.all(pending);
  return result;
}

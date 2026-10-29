/** Write a file whole or not at all: to a temp file beside it, then renamed over it. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * `data` to `file` (its folder made if need be), via a randomly named temp file renamed over it
 * (copied, where a rename over an open file fails on Windows). `mode`: e.g. 0o600 for a secret.
 * A failed write removes its temp file, which may hold that secret.
 */
export function writeAtomic(file: string, data: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

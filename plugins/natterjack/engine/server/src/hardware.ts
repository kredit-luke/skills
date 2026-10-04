/**
 * What this computer has for running models: disk space where it matters (the workspace,
 * Ollama's model folder), memory, and GPUs with their video memory. The Machine page shows
 * it in its summary; the Models page uses it to say whether a model fits.
 *
 * GPUs: NVIDIA from nvidia-smi (any OS); Apple silicon shares RAM with the GPU (unified
 * memory, of which Ollama uses up to about three quarters); anything else is named on
 * Windows (Win32_VideoController) without a size, since AdapterRAM stops at 4 GB.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Gpu { name: string; vramGb: number | null; unified?: boolean }
export interface Disk { path: string; freeGb: number; totalGb: number }
export interface Hardware {
  memoryGb: number;
  freeMemoryGb: number;
  gpus: Gpu[];
  /** The drive the workspace is on. */
  disk: Disk | null;
}

const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Free and total space on the drive holding `p` (or its nearest folder that exists), or null. */
export function diskOf(p: string): Disk | null {
  let dir = path.resolve(p);
  for (;;) {
    try {
      const s = fs.statfsSync(dir);
      return { path: dir, freeGb: round1((s.bavail * s.bsize) / GB), totalGb: round1((s.blocks * s.bsize) / GB) };
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  }
}

function exec(file: string, args: string[], timeout = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: "utf-8" }, (err, out) => resolve(err ? null : String(out || "")));
  });
}

/** nvidia-smi's csv (name, memory.total in MiB), one GPU per line. */
export function parseNvidiaSmi(out: string): Gpu[] {
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).flatMap((l) => {
    const m = /^(.*),\s*(\d+)\s*(?:MiB)?$/.exec(l);
    return m ? [{ name: m[1].trim(), vramGb: round1(Number(m[2]) / 1024) }] : [];
  });
}

async function gpus(): Promise<Gpu[]> {
  const nv = await exec("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (nv) {
    const list = parseNvidiaSmi(nv);
    if (list.length) return list;
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    const chip = ((await exec("sysctl", ["-n", "machdep.cpu.brand_string"])) || "Apple silicon").trim();
    return [{ name: chip, vramGb: round1((os.totalmem() / GB) * 0.75), unified: true }];
  }
  if (process.platform === "win32") {
    const out = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_VideoController).Name"]);
    return (out || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/basic display|remote display/i.test(s)).map((name) => ({ name, vramGb: null }));
  }
  return [];
}

let cache: { at: number; value: Promise<Hardware> } | null = null;

/** This machine's hardware, cached for a minute (GPUs don't change; disk and free memory move slowly). */
export function hardware(root: string, force = false): Promise<Hardware> {
  if (cache && !force && Date.now() - cache.at < 60_000) return cache.value;
  const value = gpus().catch(() => []).then((g) => ({
    memoryGb: Math.round(os.totalmem() / GB),
    freeMemoryGb: round1(os.freemem() / GB),
    gpus: g,
    disk: diskOf(root),
  }));
  cache = { at: Date.now(), value };
  return value;
}

#!/usr/bin/env node
/**
 * What a workspace changed in its dashboard engine, as a patch against the
 * version it installed: the starting point for contributing improvements back.
 *
 *   node engine-diff.mjs <workspace> [--base <engine folder>] [--out changes.patch]
 *
 * The patch is relative to the engine folder, so it applies inside
 * plugins/agentic-os/engine/ of a clone of the skills repo:
 *   git apply --directory=plugins/agentic-os/engine changes.patch
 * Prints a file summary; writes the patch with --out (or prints it).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { args, fetchEngine, hashFile, isMain, listFiles, readJson } from "./lib.mjs";

export function engineDiff(root, { base: baseArg } = {}) {
  root = path.resolve(root);
  const dash = path.join(root, "dashboard");
  const lock = readJson(path.join(root, ".claude", "dashboard", "engine.json"));
  const baseDir = baseArg ? path.resolve(baseArg) : lock && fetchEngine(lock.version, lock.sourceRepo);
  if (!baseDir) return { ok: false, error: "Couldn't get the installed engine version to compare with (no engine.json, offline, or no such tag). Pass --base." };
  const files = [...new Set([...listFiles(baseDir), ...listFiles(dash)])].filter((f) => f !== "ENGINE.json").sort();
  const changed = files.filter((f) => hashFile(path.join(baseDir, f)) !== hashFile(path.join(dash, f)));
  let patch = "";
  for (const rel of changed) {
    const a = fs.existsSync(path.join(baseDir, rel)) ? path.join(baseDir, rel) : (process.platform === "win32" ? "NUL" : "/dev/null");
    const b = fs.existsSync(path.join(dash, rel)) ? path.join(dash, rel) : (process.platform === "win32" ? "NUL" : "/dev/null");
    let out = "";
    try { out = execFileSync("git", ["diff", "--no-index", "--no-color", a, b], { encoding: "utf-8" }); }
    catch (e) { out = e.stdout || ""; } // exit 1 = there are differences
    // Rewrite the absolute paths to engine-relative ones.
    patch += out.replace(/^(diff --git |--- |\+\+\+ )(?:a\/)?\S+( (?:b\/)?\S+)?$/gm, (line, head) =>
      head === "diff --git " ? `diff --git a/${rel} b/${rel}` : head === "--- " ? (a.endsWith("NUL") || a === "/dev/null" ? "--- /dev/null" : `--- a/${rel}`) : (b.endsWith("NUL") || b === "/dev/null" ? "+++ /dev/null" : `+++ b/${rel}`));
  }
  return { ok: true, version: lock && lock.version, changed, patch };
}

if (isMain(import.meta)) {
  const a = args();
  if (!a._[0]) { console.error("Usage: node engine-diff.mjs <workspace> [--base <engine folder>] [--out changes.patch]"); process.exit(2); }
  const r = engineDiff(a._[0], { base: a.base });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  if (!r.changed.length) { console.log(`No changes to the engine (${r.version}).`); process.exit(0); }
  console.log(`${r.changed.length} file(s) differ from engine ${r.version}:\n${r.changed.map((f) => "  " + f).join("\n")}`);
  if (a.out) { fs.writeFileSync(a.out, r.patch); console.log(`Patch written to ${a.out}`); }
  else console.log("\n" + r.patch);
}

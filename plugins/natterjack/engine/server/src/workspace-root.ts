/**
 * Where the engine sits in a workspace. The engine folder is the team's choice
 * (natterjack/ by default, tools/ops-console, ...; recorded as `dir` in
 * .claude/dashboard/engine.json); workspaces set up before that was configurable
 * have it in dashboard/. The config folder .claude/dashboard/ never moves, so it's
 * what finds the workspace. bin/dashboard.mjs and web/proxy.conf.mjs carry a copy
 * of findWorkspaceRoot (they're plain JavaScript that runs before anything is built).
 */

import fs from "node:fs";
import path from "node:path";

/** The engine folder when engine.json doesn't name one. */
export const LEGACY_ENGINE_DIR = "dashboard";

/**
 * The workspace an engine folder belongs to: the nearest folder above it that has
 * .claude/dashboard/, else the engine's parent (a workspace with no config yet).
 */
export function findWorkspaceRoot(engineDir: string): string {
  const parent = path.dirname(path.resolve(engineDir));
  for (let dir = parent; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".claude", "dashboard"))) return dir;
    if (path.dirname(dir) === dir) return parent;
  }
}

/** A relative folder inside the workspace (forward slashes, no "..", not under .claude/), or null. */
export function safeEngineDir(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!s || s.startsWith("/") || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split("/");
  if (parts.includes("..") || parts.includes(".") || parts[0] === ".claude") return null;
  return s;
}

/** The engine's folder in a workspace, relative to it: engine.json's `dir`, else dashboard. */
export function engineDirOf(root: string): string {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, ".claude", "dashboard", "engine.json"), "utf-8").replace(/^﻿/, ""));
    return safeEngineDir(lock && lock.dir) || LEGACY_ENGINE_DIR;
  } catch {
    return LEGACY_ENGINE_DIR;
  }
}

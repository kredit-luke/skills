/**
 * Skills that come from Claude Code plugins enabled for this workspace (a `multirepo`
 * plugin's `/multirepo:implement`), next to the workspace's own .claude/skills.
 *
 * Enabled: `enabledPlugins` ("name@marketplace": true/false) in the user settings, then the
 * project's .claude/settings.json, then .claude/settings.local.json; a later file wins.
 * Where: the CLI's plugins/installed_plugins.json, the entry of local, then project scope for
 * this workspace, else user scope; skills where its manifest says (see declaredSkillPaths). Never throws: anything missing or broken
 * just means no plugin skills.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PluginSkillDir { plugin: string; dir: string }

/** ~/.claude, or $CLAUDE_CONFIG_DIR. */
function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, "")); } catch { return null; }
}

const obj = (v: any): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// Real paths, so a junction, symlink or Windows 8.3 short name matches the path the CLI
// recorded; a path that doesn't exist compares as resolved (as in workspaces.ts).
function realPath(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => realPath(p).replace(/[\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

function sources(root: string) {
  const dir = claudeDir();
  return {
    settings: [path.join(dir, "settings.json"), path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json")],
    installed: path.join(dir, "plugins", "installed_plugins.json"),
  };
}

/** Plugin keys ("name@marketplace") enabled for the workspace, in the order first seen. */
export function enabledPlugins(root: string): string[] {
  const on = new Map<string, boolean>();
  for (const file of sources(root).settings) {
    for (const [k, v] of Object.entries(obj(obj(readJson(file)).enabledPlugins))) {
      if (typeof v === "boolean") on.set(k, v);
    }
  }
  return [...on].filter(([, v]) => v).map(([k]) => k);
}

/** Most specific scope first: an install for this workspace beats the user-wide one. */
const SCOPE_RANK: Record<string, number> = { local: 0, project: 1, user: 2 };

function installFor(entries: Record<string, any>[], root: string): Record<string, any> | null {
  const usable = entries.filter((e) => typeof e.installPath === "string" && (e.scope === "user"
    || ((e.scope === "project" || e.scope === "local") && typeof e.projectPath === "string" && samePath(e.projectPath, root))));
  usable.sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]);
  return usable[0] || null;
}

const pathList = (v: any): string[] | null =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;

/**
 * Where a plugin keeps its skills: `skills` in its .claude-plugin/plugin.json (a path or a
 * list), else the marketplace entry's `skills` (how a `strict: false` entry declares them),
 * else `skills/`. Paths are relative to the plugin's folder and must stay inside it.
 */
function declaredSkillPaths(installPath: string, key: string): string[] {
  const own = pathList(obj(readJson(path.join(installPath, ".claude-plugin", "plugin.json"))).skills);
  let paths = own;
  if (!paths) {
    const [name, market] = key.split("@");
    if (market) {
      const manifest = readJson(path.join(claudeDir(), "plugins", "marketplaces", market, ".claude-plugin", "marketplace.json"));
      const entry = (Array.isArray(obj(manifest).plugins) ? manifest.plugins : []).map(obj).find((p: any) => p.name === name);
      paths = entry ? pathList(entry.skills) : null;
    }
  }
  const base = path.resolve(installPath);
  return (paths && paths.length ? paths : ["skills"])
    .map((p) => path.resolve(base, p))
    .filter((p) => p === base || p.startsWith(base + path.sep));
}

/** Skill folders under each path: the path itself when it holds a SKILL.md, else its subfolders. */
function skillFolders(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === "skill.md")) { out.push(p); continue; }
    for (const d of entries) {
      if (d.isDirectory() && !d.name.startsWith("_")) out.push(path.join(p, d.name));
    }
  }
  return [...new Set(out)];
}

/** The skill folders, plus the files and folders whose change should re-read them. */
function uncachedDirs(root: string): { dirs: PluginSkillDir[]; watch: string[] } {
  const installed = obj(obj(readJson(sources(root).installed)).plugins);
  const dirs: PluginSkillDir[] = [];
  const watch: string[] = [];
  for (const key of enabledPlugins(root)) {
    const hit = installFor(Array.isArray(installed[key]) ? installed[key].map(obj) : [], root);
    if (!hit) continue;
    const plugin = key.split("@")[0];
    const market = key.split("@")[1];
    const paths = declaredSkillPaths(hit.installPath, key);
    // A skills folder appearing or going changes its parent's mtime; a skill added, the folder's.
    watch.push(hit.installPath, path.join(hit.installPath, ".claude-plugin", "plugin.json"), ...paths, ...paths.map((p) => path.dirname(p)));
    if (market) watch.push(path.join(claudeDir(), "plugins", "marketplaces", market, ".claude-plugin", "marketplace.json"));
    for (const dir of skillFolders(paths)) dirs.push({ plugin, dir });
  }
  return { dirs, watch: [...new Set(watch)] };
}

const cache = new Map<string, { sig: string; dirs: PluginSkillDir[]; watch: string[]; watchSig: string }>();

const mtimes = (files: string[]) => files.map((f) => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return `${f}:-`; } }).join("|");

/**
 * Every enabled plugin's skill folders, re-read when a settings or installed_plugins file
 * changes, or a plugin's manifest or skills folders do.
 */
export function pluginSkillDirs(root: string): PluginSkillDir[] {
  try {
    const { settings, installed } = sources(root);
    const sig = mtimes([...settings, installed]);
    const hit = cache.get(root);
    if (hit && hit.sig === sig && mtimes(hit.watch) === hit.watchSig) return hit.dirs;
    const { dirs, watch } = uncachedDirs(root);
    cache.set(root, { sig, dirs, watch, watchSig: mtimes(watch) });
    return dirs;
  } catch {
    return [];
  }
}

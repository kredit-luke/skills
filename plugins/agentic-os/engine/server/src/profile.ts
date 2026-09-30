/**
 * The viewer's role, per person (<ledger>/profile.json). A role (workspace.json `roles`)
 * is on one of two profiles:
 *
 *   developer (default)  everything
 *   reader               for people who read the code but don't build or run it (often
 *                        with a downloaded snapshot instead of clones): no Implement, and
 *                        the role hides nav pages and project skills
 *
 * A role can also set how Claude answers them: its `outputStyle` goes into the
 * workspace's .claude/settings.local.json (per person, never committed), so it applies
 * in the terminal, the desktop app and the dashboard's runs alike.
 *
 * Hidden skills are switched off in Claude Code itself, not just on the Skills page:
 * they're set to "off" in settings.local.json `skillOverrides`, which removes them from
 * the / menu and refuses them by name. Only what this file set is ever removed or
 * changed again; a skill override or output style someone set there themselves wins.
 */

import fs from "node:fs";
import path from "node:path";
import { workspaceConfig, type RoleConfig } from "./config.ts";

export type Profile = "developer" | "reader";

interface ProfileState {
  /** The role picked; null when only the profile was set (a first snapshot download), so they're still asked. */
  role: string | null;
  profile: Profile;
  chosenAt: string | null;
  /** Skill names this dashboard set to "off" in settings.local.json skillOverrides. */
  skillsOff: string[];
  /** The output style this dashboard set in settings.local.json, if any. */
  outputStyle: string | null;
}

export interface ResolvedProfile extends ProfileState {
  /** profile.json exists. */
  chosen: boolean;
  /** The role picked is one of the team's (else they should be asked). */
  roleChosen: boolean;
  /** The role in effect: the one picked, else the first role on the profile. */
  current: RoleConfig;
}

const SKILL_NAME = /^[\w.:-]+$/;
const STYLE_NAME = /^[\w .:-]{1,80}$/;

const profileFile = (ledgerDir: string) => path.join(ledgerDir, "profile.json");
const settingsFile = (root: string) => path.join(root, ".claude", "settings.local.json");

const firstOn = (roles: RoleConfig[], profile: Profile) => roles.find((r) => r.profile === profile) || roles[0];

export function readProfile(ledgerDir: string, roles: RoleConfig[] = workspaceConfig().roles): ResolvedProfile {
  let s: any = null;
  try { s = JSON.parse(fs.readFileSync(profileFile(ledgerDir), "utf-8")); } catch {}
  const picked = s && typeof s.role === "string" ? roles.find((r) => r.id === s.role) : undefined;
  const current = picked || firstOn(roles, s && s.profile === "reader" ? "reader" : "developer");
  return {
    role: picked ? picked.id : null,
    profile: current.profile,
    chosenAt: s && typeof s.chosenAt === "string" ? s.chosenAt : null,
    skillsOff: s && Array.isArray(s.skillsOff) ? s.skillsOff.filter((n: unknown) => typeof n === "string") : [],
    outputStyle: s && typeof s.outputStyle === "string" ? s.outputStyle : null,
    chosen: !!s,
    roleChosen: !!picked,
    current,
  };
}

function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}

/** Read settings.local.json, let `edit` change it, and write it back if it did. Refuses a file that isn't a JSON object. */
function editSettings<T>(root: string, edit: (settings: any) => { changed: boolean; result: T }): T {
  const file = settingsFile(root);
  let settings: any = {};
  let text: string | null = null;
  try { text = fs.readFileSync(file, "utf-8"); } catch {}
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error(".claude/settings.local.json isn't valid JSON; fix it before changing your role."); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(".claude/settings.local.json isn't a JSON object.");
  }
  const { changed, result } = edit(settings);
  if (changed) writeJsonAtomic(file, settings);
  return result;
}

function applySkills(settings: any, want: string[], ours: string[]): { changed: boolean; next: string[] } {
  const overrides: Record<string, string> = settings.skillOverrides && typeof settings.skillOverrides === "object" ? { ...settings.skillOverrides } : {};
  const wanted = new Set(want.filter((n) => SKILL_NAME.test(n)));
  const next: string[] = [];
  let changed = false;
  // Ours that are no longer wanted: remove, if they're still what we set.
  for (const n of ours) {
    if (wanted.has(n)) continue;
    if (overrides[n] === "off") { delete overrides[n]; changed = true; }
  }
  for (const n of wanted) {
    if (ours.includes(n) && overrides[n] === "off") { next.push(n); continue; }
    if (n in overrides) continue; // the person's own setting wins
    overrides[n] = "off";
    next.push(n);
    changed = true;
  }
  if (changed) {
    if (Object.keys(overrides).length) settings.skillOverrides = overrides;
    else delete settings.skillOverrides;
  }
  return { changed, next };
}

/** outputStyle: `want`, unless the person set a style of their own; ours goes when it's no longer wanted. */
function applyStyle(settings: any, want: string | null, ours: string | null): { changed: boolean; next: string | null } {
  const cur: string | undefined = typeof settings.outputStyle === "string" ? settings.outputStyle : undefined;
  const mine = cur !== undefined && cur === ours;
  const w = want && STYLE_NAME.test(want) ? want : null;
  if (cur !== undefined && !mine) return { changed: false, next: null }; // theirs, even if it's the same name
  if (w) return { changed: cur !== w, next: (settings.outputStyle = w) };
  if (mine) { delete settings.outputStyle; return { changed: true, next: null }; }
  return { changed: false, next: null };
}

/**
 * Make settings.local.json skillOverrides match: `want` "off" (unless the person set that
 * skill themselves), and none of ours left otherwise. Returns the names now ours.
 */
export function syncSkillOverrides(root: string, want: string[], ours: string[]): string[] {
  return editSettings(root, (s) => { const r = applySkills(s, want, ours); return { changed: r.changed, result: r.next }; });
}

/**
 * Set (or re-apply) a role by id; or only a profile, which takes its first role but
 * leaves the question open (a first snapshot download).
 */
export function setRole(ledgerDir: string, root: string, pick: { role: string } | { profile: Profile }, roles: RoleConfig[] = workspaceConfig().roles): ResolvedProfile {
  const current = readProfile(ledgerDir, roles);
  const role = "role" in pick ? roles.find((r) => r.id === pick.role) : firstOn(roles, pick.profile);
  if (!role) throw new Error(`There's no role "${(pick as { role: string }).role}" (this workspace has ${roles.map((r) => r.id).join(", ")}).`);
  const roleId = "role" in pick ? role.id : null;
  const applied = editSettings(root, (s) => {
    const skills = applySkills(s, role.hiddenSkills, current.skillsOff);
    const style = applyStyle(s, role.outputStyle, current.outputStyle);
    return { changed: skills.changed || style.changed, result: { skillsOff: skills.next, outputStyle: style.next } };
  });
  const same = current.chosen && current.role === roleId && current.profile === role.profile;
  const state: ProfileState = { role: roleId, profile: role.profile, chosenAt: same ? current.chosenAt : new Date().toISOString(), ...applied };
  writeJsonAtomic(profileFile(ledgerDir), state);
  return readProfile(ledgerDir, roles);
}

/** On start: someone's hidden skills and output style follow workspace.json if it changed since. */
export function reapplyProfile(ledgerDir: string, root: string, roles: RoleConfig[] = workspaceConfig().roles) {
  const p = readProfile(ledgerDir, roles);
  if (!p.chosen) return;
  try { setRole(ledgerDir, root, p.role ? { role: p.role } : { profile: p.profile }, roles); } catch {}
}

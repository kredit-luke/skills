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
 *
 * On a hosted dashboard the role can be assigned instead (DASHBOARD_ROLE, which the
 * People page sets): it's applied at startup, and the person can't change it.
 *
 * Access is separate from the role. A role says who someone is and how Claude answers
 * them; its profile is only the access it gives by default. A person's `access` (full =
 * developer, read = reader) overrides it: a technical ops person can be Operations with
 * full access. The reader restrictions (`profiles.reader`'s hidden pages and skills, no
 * Implement or Publish) follow access; the role's own hidden pages and skills and its
 * output style follow the role. Hosted, DASHBOARD_ACCESS assigns it, locked like the role.
 */

import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "./atomic-write.ts";
import { workspaceConfig, type RoleConfig } from "./config.ts";

export type Profile = "developer" | "reader";

interface ProfileState {
  /** The role picked; null when only the profile was set (a first snapshot download), so they're still asked. */
  role: string | null;
  /** The access in effect: their own `access`, else the role's profile. */
  profile: Profile;
  /** Their own access, over the role's default; null = the role's. */
  access: Profile | null;
  /** `access` came from DASHBOARD_ACCESS, not their own choice: it goes when the assignment does. */
  accessAssigned: boolean;
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
  /** What their access hides: the reader profile's pages and skills (read access) plus the role's own. */
  hiddenPages: string[];
  hiddenSkills: string[];
}

type ReaderBase = { hiddenPages: string[]; hiddenSkills: string[] };
const readerBase = (): ReaderBase => workspaceConfig().profiles.reader;

/** "full" / "read" (and the profile names) → a profile; "" or "default" → null (the role's); anything else → undefined. */
export function parseAccess(v: unknown): Profile | null | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "default") return null;
  if (s === "full" || s === "developer") return "developer";
  if (s === "read" || s === "reader" || s === "read-only") return "reader";
  return undefined;
}
export const accessName = (p: Profile): "full" | "read" => (p === "reader" ? "read" : "full");

/** What a role hides on a given access: the reader base when it's read access, plus the role's own. */
export function effectiveHidden(role: RoleConfig, profile: Profile, reader: ReaderBase = readerBase()) {
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    pages: union(profile === "reader" ? reader.hiddenPages : [], role.ownHiddenPages),
    skills: union(profile === "reader" ? reader.hiddenSkills : [], role.ownHiddenSkills),
  };
}

const SKILL_NAME = /^[\w.:-]+$/;
// Any letters (a team style can be "Français"), digits, spaces and _ . : -
const STYLE_NAME = /^[\p{L}\p{N} _.:-]{1,80}$/u;

const profileFile = (ledgerDir: string) => path.join(ledgerDir, "profile.json");
const settingsFile = (root: string) => path.join(root, ".claude", "settings.local.json");

const firstOn = (roles: RoleConfig[], profile: Profile) => roles.find((r) => r.profile === profile) || roles[0];

export function readProfile(ledgerDir: string, roles: RoleConfig[] = workspaceConfig().roles, reader: ReaderBase = readerBase()): ResolvedProfile {
  let s: any = null;
  try { s = JSON.parse(fs.readFileSync(profileFile(ledgerDir), "utf-8")); } catch {}
  const access = s && (s.access === "developer" || s.access === "reader") ? (s.access as Profile) : null;
  const picked = s && typeof s.role === "string" ? roles.find((r) => r.id === s.role) : undefined;
  // No role picked: the first role on the access they have (or had, from a first snapshot download).
  const current = picked || firstOn(roles, access || (s && s.profile === "reader" ? "reader" : "developer"));
  const profile = access || current.profile;
  const hidden = effectiveHidden(current, profile, reader);
  return {
    role: picked ? picked.id : null,
    profile,
    access,
    accessAssigned: !!(access && s && s.accessAssigned === true),
    chosenAt: s && typeof s.chosenAt === "string" ? s.chosenAt : null,
    skillsOff: s && Array.isArray(s.skillsOff) ? s.skillsOff.filter((n: unknown) => typeof n === "string") : [],
    outputStyle: s && typeof s.outputStyle === "string" ? s.outputStyle : null,
    chosen: !!s,
    roleChosen: !!picked,
    current,
    hiddenPages: hidden.pages,
    hiddenSkills: hidden.skills,
  };
}

const writeJsonAtomic = (file: string, data: unknown) => writeAtomic(file, JSON.stringify(data, null, 2) + "\n");

/** Read settings.local.json, let `edit` change it, and write it back if it did. Refuses a file that isn't a JSON object. */
export function editSettings<T>(root: string, edit: (settings: any) => { changed: boolean; result: T }, doing = "changing your role"): T {
  const file = settingsFile(root);
  let settings: any = {};
  let text: string | null = null;
  try { text = fs.readFileSync(file, "utf-8"); } catch {}
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error(`.claude/settings.local.json isn't valid JSON; fix it before ${doing}.`); }
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
export function setRole(ledgerDir: string, root: string, pick: { role: string } | { profile: Profile }, roles: RoleConfig[] = workspaceConfig().roles, reader: ReaderBase = readerBase()): ResolvedProfile {
  const current = readProfile(ledgerDir, roles, reader);
  const role = "role" in pick ? roles.find((r) => r.id === pick.role) : firstOn(roles, pick.profile);
  if (!role) throw new Error(`There's no role "${(pick as { role: string }).role}" (this workspace has ${roles.map((r) => r.id).join(", ")}).`);
  const roleId = "role" in pick ? role.id : null;
  // Picking a role keeps the access they have (their own, or an assigned one); setting only a profile replaces it.
  const keep = "role" in pick;
  return write(ledgerDir, root, current, role, roleId, keep ? current.access : null, reader, roles, keep && current.accessAssigned);
}

/**
 * Their access over the role's default (null = the role's). Keeps the role and its question.
 * `assigned`: it's DASHBOARD_ACCESS's, not their own choice (it goes when the assignment does).
 */
export function setAccess(ledgerDir: string, root: string, access: Profile | null, roles: RoleConfig[] = workspaceConfig().roles, reader: ReaderBase = readerBase(), assigned = false): ResolvedProfile {
  const current = readProfile(ledgerDir, roles, reader);
  return write(ledgerDir, root, current, current.current, current.role, access, reader, roles, assigned && !!access);
}

function write(ledgerDir: string, root: string, current: ResolvedProfile, role: RoleConfig, roleId: string | null, access: Profile | null, reader: ReaderBase, roles: RoleConfig[], accessAssigned = false): ResolvedProfile {
  const profile = access || role.profile;
  const hidden = effectiveHidden(role, profile, reader);
  const applied = editSettings(root, (s) => {
    const skills = applySkills(s, hidden.skills, current.skillsOff);
    const style = applyStyle(s, role.outputStyle, current.outputStyle);
    return { changed: skills.changed || style.changed, result: { skillsOff: skills.next, outputStyle: style.next } };
  });
  const same = current.chosen && current.role === roleId && current.profile === profile;
  const state: ProfileState = { role: roleId, profile, access, accessAssigned, chosenAt: same ? current.chosenAt : new Date().toISOString(), ...applied };
  writeJsonAtomic(profileFile(ledgerDir), state);
  return readProfile(ledgerDir, roles, reader);
}

/**
 * On start: someone's hidden skills and output style follow workspace.json if it changed since.
 * A `locked` role (DASHBOARD_ROLE) is applied as if they'd picked it, whatever they had; if
 * that fails (say settings.local.json isn't valid JSON) this throws, so the dashboard doesn't
 * start with the role picker locked but the permissions of the role they had before.
 */
export function reapplyProfile(ledgerDir: string, root: string, roles: RoleConfig[] = workspaceConfig().roles, locked: string | null = null, lockedAccess: Profile | null = null) {
  const p = readProfile(ledgerDir, roles);
  if (!p.chosen && !locked && !lockedAccess) return;
  try {
    if (p.chosen || locked) setRole(ledgerDir, root, locked ? { role: locked } : p.role ? { role: p.role } : { profile: p.access || p.profile }, roles);
    // An assigned access (DASHBOARD_ACCESS) over whatever they had. An assignment that's gone takes
    // its access with it (back to the role's); an access they chose themselves stays (setRole kept it).
    if (lockedAccess) setAccess(ledgerDir, root, lockedAccess, roles, undefined, true);
    else if (p.accessAssigned) setAccess(ledgerDir, root, null, roles);
  } catch (e) {
    if (locked || lockedAccess) throw new Error(`Couldn't apply the assigned ${locked ? `role "${locked}" (DASHBOARD_ROLE)` : ""}${locked && lockedAccess ? " and " : ""}${lockedAccess ? `access "${accessName(lockedAccess)}" (DASHBOARD_ACCESS)` : ""}: ${(e as Error).message}`);
  }
}

export const ROLE_LOCKED = "Your role is set by whoever manages your hosted dashboard.";
export const ACCESS_LOCKED = "Your access is set by whoever manages your hosted dashboard.";

/** DASHBOARD_ACCESS: full or read, assigned on the People page. Null when unset or unknown (with a warning). */
export function lockedAccess(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = console.warn): Profile | null {
  const raw = String(env.DASHBOARD_ACCESS || "").trim();
  if (!raw) return null;
  const a = parseAccess(raw);
  if (a) return a;
  warn(`DASHBOARD_ACCESS "${raw}" isn't full or read; it follows the role.`);
  return null;
}

/** POST /api/profile { access } under an assigned access: the refusal, or null. */
export function refuseAccessChange(locked: Profile | null, want: Profile | null): string | null {
  return locked && want !== locked ? ACCESS_LOCKED : null;
}

/**
 * DASHBOARD_ROLE: the role whoever manages this hosted dashboard assigned it (the People
 * page sets it). Null when it isn't set, or isn't one of `roles` (with a warning: the
 * person then picks their own, as without it).
 */
export function lockedRole(roles: RoleConfig[], env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = console.warn): string | null {
  const id = String(env.DASHBOARD_ROLE || "").trim();
  if (!id) return null;
  if (roles.some((r) => r.id === id)) return id;
  warn(`DASHBOARD_ROLE "${id}" isn't one of this workspace's roles (${roles.map((r) => r.id).join(", ") || "none"}); people pick their own.`);
  return null;
}

/** POST /api/profile under a locked role: the refusal, or null when nothing would change. */
export function refuseRoleChange(locked: string | null, pick: { role: string } | { profile: Profile }): string | null {
  if (!locked) return null;
  return "role" in pick && pick.role === locked ? null : ROLE_LOCKED;
}

/** The access-related part of GET /api/profile. */
export function accessInfo(p: ResolvedProfile, locked: Profile | null) {
  return { access: accessName(p.profile), accessOwn: p.access ? accessName(p.access) : null, roleAccess: accessName(p.current.profile), accessLocked: !!locked };
}

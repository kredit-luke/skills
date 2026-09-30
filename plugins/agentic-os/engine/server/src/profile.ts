/**
 * The viewer's workspace profile, per person (<ledger>/profile.json):
 *
 *   developer (default)  everything
 *   reader               for people who read the code but don't build or run it (often
 *                        with a downloaded snapshot instead of clones): no Implement, and
 *                        workspace.json profiles.reader hides nav pages and project skills
 *
 * Hidden skills are switched off in Claude Code itself, not just on the Skills page:
 * they're set to "off" in the workspace's .claude/settings.local.json `skillOverrides`
 * (per person, never committed), which removes them from the / menu and refuses them
 * by name. Only entries this file added are ever removed again; a skill someone set
 * there themselves is left as it is.
 */

import fs from "node:fs";
import path from "node:path";

export type Profile = "developer" | "reader";

interface ProfileState {
  profile: Profile;
  chosenAt: string | null;
  /** Skill names this dashboard set to "off" in settings.local.json skillOverrides. */
  skillsOff: string[];
}

const DEFAULT: ProfileState = { profile: "developer", chosenAt: null, skillsOff: [] };
const SKILL_NAME = /^[\w.:-]+$/;

const profileFile = (ledgerDir: string) => path.join(ledgerDir, "profile.json");
const settingsFile = (root: string) => path.join(root, ".claude", "settings.local.json");

export function readProfile(ledgerDir: string): ProfileState & { chosen: boolean } {
  try {
    const s = JSON.parse(fs.readFileSync(profileFile(ledgerDir), "utf-8"));
    return {
      profile: s.profile === "reader" ? "reader" : "developer",
      chosenAt: typeof s.chosenAt === "string" ? s.chosenAt : null,
      skillsOff: Array.isArray(s.skillsOff) ? s.skillsOff.filter((n: unknown) => typeof n === "string") : [],
      chosen: true,
    };
  } catch { return { ...DEFAULT, chosen: false }; }
}

function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}

/**
 * Make settings.local.json skillOverrides match: the reader's hidden skills "off"
 * (unless the person set that skill themselves), and none of ours left otherwise.
 * Returns the names now ours. Refuses to touch a settings file that isn't valid JSON.
 */
export function syncSkillOverrides(root: string, want: string[], ours: string[]): string[] {
  const file = settingsFile(root);
  let settings: any = {};
  let text: string | null = null;
  try { text = fs.readFileSync(file, "utf-8"); } catch {}
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new Error(".claude/settings.local.json isn't valid JSON; fix it before changing the profile."); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(".claude/settings.local.json isn't a JSON object.");
  }
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
    writeJsonAtomic(file, settings);
  }
  return next;
}

/** Set (or re-apply) the profile; the reader's hidden skills come from workspace.json. */
export function setProfile(ledgerDir: string, root: string, profile: Profile, readerHiddenSkills: string[]): ProfileState {
  const current = readProfile(ledgerDir);
  const skillsOff = syncSkillOverrides(root, profile === "reader" ? readerHiddenSkills : [], current.skillsOff);
  const same = current.chosen && current.profile === profile;
  const state: ProfileState = { profile, chosenAt: same ? current.chosenAt : new Date().toISOString(), skillsOff };
  writeJsonAtomic(profileFile(ledgerDir), state);
  return state;
}

/** On start: a reader's hidden skills follow workspace.json if it changed since. */
export function reapplyProfile(ledgerDir: string, root: string, readerHiddenSkills: string[]) {
  const p = readProfile(ledgerDir);
  if (!p.chosen) return;
  try { setProfile(ledgerDir, root, p.profile, readerHiddenSkills); } catch {}
}

/**
 * Skills deck + routines config, the skill catalog, and the routine scheduler.
 *
 * Config lives in <main workspace>/.claude/dashboard/deck.json (committed):
 *   limits   { maxConcurrentRuns, pauseAtSessionPct, pauseAtWeeklyPct, runBudget, dailyBudgetUsd? }
 *   presets  [{ id, label, prompt, args?, model, effort, permissionMode, budgetUsd, workspace? }]
 *            `prompt` may contain {argName} placeholders filled from `args`.
 *   routines [{ id, preset, at: "HH:MM", days: "daily"|"weekdays"|["mon",...], workspace?, enabled }]
 *
 * Personal overrides (the Settings page) live in .claude/ledger/settings.json (gitignored):
 * { limits?, defaults? }, laid over the team file key by key, so changing your own
 * limits never changes anyone else's.
 *
 * Both files are re-read on every request so edits apply without a restart.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { skillFile } from "./config.ts";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Subscription-first: new runs (manual and routine) pause when /usage says a
// window is nearly spent. runBudget turns on the per-run API-equivalent cap
// (--max-budget-usd, from each preset's budgetUsd); off, runs have no cap, since on a
// subscription it only stops working runs. dailyBudgetUsd is an optional API-equivalent cap.
// keepAttachmentsDays: a finished run's attached files are deleted this many days after
// its last turn (0 keeps them forever).
const DEFAULT_LIMITS = { maxConcurrentRuns: 3, pauseAtSessionPct: 90, pauseAtWeeklyPct: 90, runBudget: false, keepAttachmentsDays: 14, dailyBudgetUsd: null };
/** What the Settings page can change, and the range each takes. */
const PERSONAL_LIMITS: Record<string, { min?: number; max?: number; bool?: boolean }> = {
  maxConcurrentRuns: { min: 1, max: 10 },
  pauseAtSessionPct: { min: 10, max: 100 },
  pauseAtWeeklyPct: { min: 10, max: 100 },
  runBudget: { bool: true },
  keepAttachmentsDays: { min: 0, max: 365 },
};
// Issues tab: which tracker teams/projects and workflow states (by name) to show, states in
// column order; empty = all. implementTeams: teams whose implement-state issues (workspace.json
// issues.implementStates) get the /implement buttons (code work only); empty = every team.
// Model and effort for every run that doesn't pick its own (the dialog, Explain, routines,
// Implement from Issues). Presets follow it unless they set model/effort themselves.
const DEFAULT_RUN = { model: "opus", effort: "medium" };
const DEFAULT_ISSUES = { teams: [], states: [], implementPreset: "implement", implementTeams: [] };

function readFrontmatter(file: string): Record<string, string> {
  try {
    const text = fs.readFileSync(file, "utf-8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
    return out;
  } catch {
    return {};
  }
}

class Deck {
  workspaceRoot: any;
  configPath: any;
  settingsPath: string;

  constructor(workspaceRoot, settingsPath?: string) {
    this.workspaceRoot = workspaceRoot;
    this.configPath = path.join(workspaceRoot, ".claude", "dashboard", "deck.json");
    this.settingsPath = settingsPath || path.join(workspaceRoot, ".claude", "ledger", "settings.json");
  }

  /** deck.json alone: what everyone gets unless they override it. */
  teamConfig() {
    try {
      const cfg = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
      return {
        limits: { ...DEFAULT_LIMITS, ...(cfg.limits || {}) },
        presets: cfg.presets || [],
        routines: cfg.routines || [],
        issues: { ...DEFAULT_ISSUES, ...(cfg.issues || {}) },
        defaults: { ...DEFAULT_RUN, ...(cfg.defaults || {}) },
      };
    } catch (e) {
      return { limits: { ...DEFAULT_LIMITS }, presets: [], routines: [], issues: { ...DEFAULT_ISSUES }, defaults: { ...DEFAULT_RUN }, error: `deck.json: ${e.message}` };
    }
  }

  /** The config in effect: the team file with your personal settings on top. */
  config() {
    const team = this.teamConfig();
    const mine = this.personal();
    return { ...team, limits: { ...team.limits, ...mine.limits }, defaults: { ...team.defaults, ...mine.defaults } };
  }

  /** Your overrides from the Settings page (only the keys you changed). */
  personal(): { limits: Record<string, any>; defaults: Record<string, any>; issues: { query?: string } } {
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));
      const obj = (v) => (v && typeof v === "object" ? v : {});
      const issues = typeof obj(s.issues).query === "string" ? { query: s.issues.query } : {};
      return { limits: obj(s.limits), defaults: obj(s.defaults), issues };
    } catch {
      return { limits: {}, defaults: {}, issues: {} };
    }
  }

  /**
   * Save personal overrides. Each key is a new value, or null to go back to the team
   * default. `allowed` holds the valid models and efforts. Throws on a bad value.
   */
  savePersonal(patch: { limits?: Record<string, any>; defaults?: Record<string, any>; issues?: { query?: string | null } }, allowed: { models: (m: string) => boolean; efforts: string[] }) {
    const cur = this.personal();
    if (patch.issues && "query" in patch.issues) {
      const q = patch.issues.query;
      if (q === null || (typeof q === "string" && !q.trim())) delete cur.issues.query;
      else if (typeof q !== "string" || q.length > 500 || /[\r\n]/.test(q)) throw new Error("Your board filter must be one line, up to 500 characters.");
      else cur.issues.query = q.trim();
    }
    for (const [k, v] of Object.entries(patch.limits || {})) {
      const rule = PERSONAL_LIMITS[k];
      if (!rule) throw new Error(`Unknown setting ${k}`);
      if (v === null) { delete cur.limits[k]; continue; }
      if (rule.bool) {
        if (typeof v !== "boolean") throw new Error(`${k} must be true or false`);
      } else if (!Number.isInteger(v) || v < rule.min! || v > rule.max!) {
        throw new Error(`${k} must be a whole number from ${rule.min} to ${rule.max}`);
      }
      cur.limits[k] = v;
    }
    for (const [k, v] of Object.entries(patch.defaults || {})) {
      if (k !== "model" && k !== "effort") throw new Error(`Unknown setting ${k}`);
      if (v === null) { delete cur.defaults[k]; continue; }
      if (k === "model" && (typeof v !== "string" || !allowed.models(v))) throw new Error(`Invalid model ${v}`);
      if (k === "effort" && !allowed.efforts.includes(v)) throw new Error(`Unknown effort ${v}`);
      cur.defaults[k] = v;
    }
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(cur, null, 2));
    return cur;
  }

  preset(id) {
    return this.config().presets.find((p) => p.id === id) || null;
  }

  /**
   * Fill {placeholders} and append each ticked option's text (e.g. " --auto");
   * throws if a declared arg is missing. Options not in `options` use their default.
   */
  renderPrompt(preset, args = {}, options: Record<string, boolean> = {}) {
    let prompt = preset.prompt;
    for (const a of preset.args || []) {
      const v = String(args[a.name] || "").trim();
      if (!v && a.required !== false) throw new Error(`Missing ${a.label || a.name}`);
      if (a.pattern && v && !new RegExp(a.pattern).test(v)) throw new Error(`${a.label || a.name} doesn't look right`);
      prompt = prompt.split(`{${a.name}}`).join(v);
    }
    prompt = prompt.replace(/\s+$/, "");
    for (const o of preset.options || []) {
      const on = typeof options[o.name] === "boolean" ? options[o.name] : !!o.default;
      if (on && o.append) prompt += String(o.append);
    }
    return prompt;
  }

  /** Project skills from .claude/skills/<name>/SKILL.md. */
  skills() {
    const dir = path.join(this.workspaceRoot, ".claude", "skills");
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => {
        const fm = readFrontmatter(skillFile(path.join(dir, e.name)));
        return {
          name: fm.name || e.name,
          description: fm.description || "",
          argumentHint: fm["argument-hint"] || "",
        };
      })
      .filter((s) => s.description)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Claude Desktop scheduled tasks (~/.claude/scheduled-tasks) — display only. */
  desktopTasks() {
    const dir = path.join(os.homedir(), ".claude", "scheduled-tasks");
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const fm = readFrontmatter(skillFile(path.join(dir, e.name)));
        return { id: e.name, name: fm.name || e.name, description: fm.description || "" };
      });
  }
}

function routineDays(days) {
  if (!days || days === "daily") return DAY_KEYS;
  if (days === "weekdays") return DAY_KEYS.slice(1, 6);
  return Array.isArray(days) ? days.map((d) => d.toLowerCase().slice(0, 3)) : DAY_KEYS;
}

/** Next local Date a routine will fire, or null if it never will. */
function nextFire(routine, from = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(routine.at || "");
  if (!m) return null;
  const days = routineDays(routine.days);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d > from && days.includes(DAY_KEYS[d.getDay()])) return d;
  }
  return null;
}

/**
 * Minute-granularity scheduler. Fires each enabled routine at most once per
 * scheduled slot; last-fired slots persist so a restart doesn't double-fire.
 */
class Scheduler {
  deck: any;
  stateFile: any;
  fire: any;
  state: any;
  timer: any;

  constructor(deck, stateFile, fire) {
    this.deck = deck;
    this.stateFile = stateFile;
    this.fire = fire; // (routine, preset) => { ok, error?, run? }
    this.state = {};
    try { this.state = JSON.parse(fs.readFileSync(stateFile, "utf-8")); } catch {}
  }

  start() {
    this.timer = setInterval(() => this.tick(), 30 * 1000);
    this.timer.unref();
  }

  _save() {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2)); } catch {}
  }

  tick(now = new Date()) {
    const { routines } = this.deck.config();
    for (const r of routines) {
      if (!r.enabled) continue;
      const m = /^(\d{1,2}):(\d{2})$/.exec(r.at || "");
      if (!m) continue;
      const slot = new Date(now);
      slot.setHours(Number(m[1]), Number(m[2]), 0, 0);
      // Fire within a 10-minute grace window after the slot (covers sleep/restart).
      const late = now.getTime() - slot.getTime();
      if (late < 0 || late > 10 * 60 * 1000) continue;
      if (!routineDays(r.days).includes(DAY_KEYS[slot.getDay()])) continue;
      const slotKey = slot.toISOString();
      if (this.state[r.id] && this.state[r.id].slot === slotKey) continue;
      const preset = this.deck.preset(r.preset);
      const outcome = preset ? this.fire(r, preset) : { ok: false, error: `Unknown preset ${r.preset}` };
      this.state[r.id] = { slot: slotKey, firedAt: now.toISOString(), ok: outcome.ok, error: outcome.error || null, runId: outcome.run ? outcome.run.id : null };
      this._save();
    }
  }

  view(now = new Date()) {
    const { routines } = this.deck.config();
    return routines.map((r) => {
      const next = nextFire(r, now);
      return {
        ...r,
        nextAt: next ? next.toISOString() : null,
        last: this.state[r.id] || null,
      };
    });
  }
}

export { Deck, Scheduler, nextFire };

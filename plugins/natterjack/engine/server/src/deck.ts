/**
 * Skills deck + routines config and the skill catalog (the routine scheduler is routines.ts).
 *
 * Config lives in <main workspace>/.claude/dashboard/deck.json (committed):
 *   limits   { maxConcurrentRuns, pauseAtSessionPct, pauseAtWeeklyPct, runBudget, dailyBudgetUsd?, adoptSessions? }
 *   presets  [{ id, label, prompt, args?, model, effort, permissionMode, budgetUsd, workspace? }]
 *            `prompt` may contain {argName} placeholders filled from `args`.
 *   routines [Routine]  { id, preset | prompt, at: "HH:MM" | every: "2h", days?, ... } (routines.ts;
 *            your own are in .claude/ledger/routines.json)
 *   loops    { allowCommands?: [regex] }  check watches whose command matches one run without asking
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
import type { SkillInfo } from "../../shared/api.ts";
import { skillFile } from "./config.ts";
import { pluginSkillDirs } from "./plugin-skills.ts";

// Subscription-first: new runs (manual and routine) pause when /usage says a
// window is nearly spent. runBudget turns on the per-run API-equivalent cap
// (--max-budget-usd, from each preset's budgetUsd); off, runs have no cap, since on a
// subscription it only stops working runs. dailyBudgetUsd is an optional API-equivalent cap.
// keepAttachmentsDays: a finished run's attached files are deleted this many days after
// its last turn (0 keeps them forever). adoptSessions: every new Claude Code session started in a
// terminal in the workspace becomes a run by itself (sessions.ts), so Remote control mirrors it too.
const DEFAULT_LIMITS = { maxConcurrentRuns: 3, pauseAtSessionPct: 90, pauseAtWeeklyPct: 90, runBudget: false, keepAttachmentsDays: 14, dailyBudgetUsd: null, adoptSessions: false };
/** What the Settings page can change, and the range each takes. */
const PERSONAL_LIMITS: Record<string, { min?: number; max?: number; bool?: boolean }> = {
  maxConcurrentRuns: { min: 1, max: 10 },
  pauseAtSessionPct: { min: 10, max: 100 },
  pauseAtWeeklyPct: { min: 10, max: 100 },
  runBudget: { bool: true },
  keepAttachmentsDays: { min: 0, max: 365 },
  adoptSessions: { bool: true },
};
// Issues tab: which tracker teams/projects and workflow states (by name) to show, states in
// column order; empty = all. implementTeams: teams whose implement-state issues (workspace.json
// issues.implementStates) get the Implement buttons (code work only); empty = every team.
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

/** A skill folder as the skill list shows it, or null when it has no description or is agent-only. */
function skillInfo(dir: string, plugin?: string): SkillInfo | null {
  const fm = readFrontmatter(skillFile(dir));
  if (!fm.description || fm["user-invocable"] === "false") return null;
  const name = fm.name || path.basename(dir);
  return {
    name: plugin ? `${plugin}:${name}` : name,
    description: fm.description,
    argumentHint: fm["argument-hint"] || "",
    ...(plugin ? { plugin } : {}),
  };
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
        loops: { allowCommands: Array.isArray(cfg.loops?.allowCommands) ? cfg.loops.allowCommands : [] },
        issues: { ...DEFAULT_ISSUES, ...(cfg.issues || {}) },
        defaults: { ...DEFAULT_RUN, ...(cfg.defaults || {}) },
      };
    } catch (e) {
      return { limits: { ...DEFAULT_LIMITS }, presets: [], routines: [], loops: { allowCommands: [] }, issues: { ...DEFAULT_ISSUES }, defaults: { ...DEFAULT_RUN }, error: `deck.json: ${e.message}` };
    }
  }

  /** The config in effect: the team file with your personal settings on top. */
  config() {
    const team = this.teamConfig();
    const mine = this.personal();
    const limits = { ...team.limits, ...mine.limits };
    // A hosted dashboard's profile (People page) caps runs from the deployment; it beats the files.
    const pinned = parseInt(process.env.DASHBOARD_MAX_CONCURRENT_RUNS || "", 10);
    if (pinned >= 1 && pinned <= 10) limits.maxConcurrentRuns = pinned;
    return { ...team, limits, defaults: { ...team.defaults, ...mine.defaults } };
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

  /**
   * What Implement types into an interactive session (the Issues page's terminal mode): the
   * issues.implementPreset prompt with every option off (a person is there to answer, so no
   * --auto), or `/implement <ticket>` when the deck has no such preset. Throws like renderPrompt.
   */
  implementPrompt(ticket: string) {
    const preset = this.preset(this.config().issues.implementPreset);
    if (!preset) return `/implement ${ticket}`;
    const off = Object.fromEntries((preset.options || []).map((o) => [o.name, false]));
    return this.renderPrompt(preset, { ticket }, off);
  }

  /**
   * Project skills from .claude/skills/<name>/SKILL.md, then those of the Claude Code plugins
   * enabled for the workspace as `<plugin>:<name>`. Agent-only skills (`user-invocable: false`)
   * are left out: nobody types them.
   */
  skills(): SkillInfo[] {
    const dir = path.join(this.workspaceRoot, ".claude", "skills");
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    const local = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => skillInfo(path.join(dir, e.name)))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    const plugins = pluginSkillDirs(this.workspaceRoot)
      .map((d) => skillInfo(d.dir, d.plugin))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...local, ...plugins];
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

export { Deck };


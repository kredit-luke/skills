/**
 * Routines: runs the dashboard starts on a schedule (shared/api.ts Routine).
 *
 * Team routines are deck.json `routines`; your own live in .claude/ledger/routines.json
 * with any team routine you switched off (or on) for yourself:
 *   { "routines": [Routine...], "team": { "<id>": { "enabled": false } } }
 * Both are re-read on every tick, so edits apply without a restart.
 *
 * The scheduler checks every 30 s. Each routine has slots (an `at` time on its days, or
 * every N minutes lined up with local midnight, inside `between`); a slot fires at most once,
 * and the last slot each routine fired (or skipped) is kept in scheduler-state.json so a
 * restart doesn't fire it again. A slot is skipped while the routine's last run is still
 * working or waiting on a question, so routines never pile up.
 */

import fs from "node:fs";
import path from "node:path";
import type { Routine, RoutineInput, RoutineLast, RoutineView } from "../../shared/api.ts";
import { DAY_KEYS, daysLabel, formatMinutes, inWindow, parseClock, parseDuration, parseWindow, routineDays } from "../../shared/loops.ts";
import { writeAtomic } from "./atomic-write.ts";

/** Routines start whole runs: no closer than this. */
export const ROUTINE_MIN_EVERY = 15;
const ROUTINE_MAX_EVERY = 1440;
const DEFAULT_CATCH_UP = 10;
const MAX_CATCH_UP = 1440;
const PROMPT_MAX = 8000;
const LABEL_MAX = 80;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MODEL_RE = /^[a-z][a-z0-9.\-/]{1,80}(\[[a-z0-9]+\])?$/i;
/** A local or team model (models/routes.ts: local/<tag>, team/<endpoint>/<model>); launch checks it's available. */
const ROUTED_MODEL_RE = /^(local|team)\/\S{1,160}$/;
/** The scheduler ticks every 30 s: a slot stays reachable at least this long, even with no catch-up. */
const TICK_WINDOW_MS = 60 * 1000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES = ["auto", "acceptEdits", "dontAsk", "plan"];

/** A label as a routine id: "Morning brief" → "morning-brief". */
export function routineId(label: string): string {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "routine";
}

/**
 * A routine as it's stored, checked and tidied: unknown keys dropped, empty ones left out.
 * Throws an Error that says what's wrong. `presets`: the preset ids that exist (checked when given).
 */
export function checkRoutine(input: any, opts: { presets?: string[]; defaultEnabled?: boolean } = {}): Routine {
  if (!input || typeof input !== "object") throw new Error("A routine must be an object.");
  const str = (v: unknown) => (v == null ? "" : String(v).trim());
  const id = str(input.id);
  if (!ID_RE.test(id)) throw new Error("A routine's id is lowercase letters, digits and dashes.");
  // Without "enabled": on for one you create, off for a team routine (deck.json routines were always opt-in).
  const out: Routine = { id, enabled: typeof input.enabled === "boolean" ? input.enabled : opts.defaultEnabled ?? true };
  const label = str(input.label);
  if (label.length > LABEL_MAX) throw new Error(`The name is longer than ${LABEL_MAX} characters.`);
  if (label) out.label = label;

  const preset = str(input.preset);
  const prompt = str(input.prompt);
  if (!preset && !prompt) throw new Error("Say what the routine does: a prompt or a preset.");
  if (preset && prompt) throw new Error("A routine runs a prompt or a preset, not both.");
  if (preset) {
    if (opts.presets && !opts.presets.includes(preset)) throw new Error(`Unknown preset ${preset}.`);
    out.preset = preset;
  }
  if (prompt.length > PROMPT_MAX) throw new Error(`The prompt is longer than ${PROMPT_MAX} characters.`);
  if (prompt) out.prompt = prompt;
  if (input.args && typeof input.args === "object" && !Array.isArray(input.args)) {
    const args = Object.fromEntries(Object.entries(input.args).map(([k, v]) => [k, str(v)]).filter(([, v]) => v));
    if (Object.keys(args).length) out.args = args;
  }

  const at = str(input.at);
  const every = input.every == null || input.every === "" ? "" : input.every;
  if (at && every) throw new Error("A routine runs at a time or on an interval, not both.");
  if (!at && !every) throw new Error("Say when the routine runs: a time (\"at\") or an interval (\"every\").");
  if (at) {
    if (parseClock(at) === null) throw new Error(`"${at}" isn't a time (use HH:MM, e.g. 08:30).`);
    out.at = at.padStart(5, "0");
  } else {
    const minutes = parseDuration(every);
    if (minutes === null) throw new Error(`"${every}" isn't an interval (use 30m, 2h...).`);
    if (minutes < ROUTINE_MIN_EVERY || minutes > ROUTINE_MAX_EVERY) throw new Error(`A routine runs every ${ROUTINE_MIN_EVERY} minutes to 24 hours.`);
    out.every = String(every).trim();
    const between = str(input.between);
    if (between) {
      if (!parseWindow(between)) throw new Error(`"${between}" isn't a time window (use 08:00-18:00).`);
      out.between = between;
    }
  }
  if (input.days != null && input.days !== "") {
    if (!routineDays(input.days).length) throw new Error("Pick at least one day.");
    out.days = typeof input.days === "string" && ["daily", "weekdays", "weekends"].includes(input.days)
      ? input.days
      : routineDays(input.days);
  }

  if (input.mode != null && input.mode !== "") {
    if (input.mode !== "fresh" && input.mode !== "continue") throw new Error(`Unknown mode ${input.mode} (fresh or continue).`);
    if (input.mode === "continue") out.mode = "continue";
  }
  const workspace = str(input.workspace);
  if (workspace) {
    if (!/^[\w.-]{1,80}$/.test(workspace)) throw new Error(`Unknown workspace ${workspace}.`);
    out.workspace = workspace;
  }
  const model = str(input.model);
  if (model) {
    if (!MODEL_RE.test(model) && !ROUTED_MODEL_RE.test(model)) throw new Error(`Invalid model ${model}.`);
    out.model = model;
  }
  const effort = str(input.effort);
  if (effort) {
    if (!EFFORTS.includes(effort)) throw new Error(`Unknown effort ${effort}.`);
    out.effort = effort as Routine["effort"];
  }
  const mode = str(input.permissionMode);
  if (mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`Unsupported permission mode ${mode}.`);
    out.permissionMode = mode as Routine["permissionMode"];
  }
  if (input.catchUpMinutes != null && input.catchUpMinutes !== "") {
    const n = Number(input.catchUpMinutes);
    if (!Number.isInteger(n) || n < 0 || n > MAX_CATCH_UP) throw new Error(`Catch-up is 0 to ${MAX_CATCH_UP} minutes.`);
    out.catchUpMinutes = n;
  }
  return out;
}

/** The schedule in words: "Weekdays at 08:30", "Every 2 h, 08:00-18:00, weekdays". */
export function describeSchedule(r: Partial<Routine>): string {
  const days = daysLabel(r.days);
  if (r.at) return `${days} at ${r.at}`;
  const minutes = parseDuration(r.every);
  if (minutes === null) return "No schedule";
  return [`Every ${formatMinutes(minutes)}`, r.between || "", days === "Daily" ? "" : days.toLowerCase()].filter(Boolean).join(", ");
}

function atMidnight(d: Date, addDays = 0): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + addDays);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Every slot of a routine on one local day (midnight `day`), in order. */
function slotsOn(r: Routine, day: Date): Date[] {
  const days = routineDays(r.days);
  if (!days.includes(DAY_KEYS[day.getDay()])) return [];
  const at = (minute: number) => { const d = new Date(day); d.setHours(Math.floor(minute / 60), minute % 60, 0, 0); return d; };
  if (r.at) {
    const m = parseClock(r.at);
    return m === null ? [] : [at(m)];
  }
  const every = parseDuration(r.every);
  if (every === null || every < ROUTINE_MIN_EVERY) return [];
  const win = r.between ? parseWindow(r.between) : null;
  const out: Date[] = [];
  for (let m = 0; m < 1440; m += every) if (!win || inWindow(m, win)) out.push(at(m));
  return out;
}

/**
 * The slot that's due at `now`, if any: the latest slot at or before now that's still within
 * reach (an `at` slot for catchUpMinutes after it, an interval slot until the next one).
 */
export function dueSlot(r: Routine, now = new Date()): Date | null {
  let latest: Date | null = null;
  // Today first, then yesterday (a slot just before midnight, caught up after it).
  for (const offset of [0, -1]) {
    const past = slotsOn(r, atMidnight(now, offset)).filter((d) => d <= now);
    if (past.length) { latest = past[past.length - 1]; break; }
  }
  if (!latest) return null;
  const late = now.getTime() - latest.getTime();
  if (r.at) return late <= Math.max((r.catchUpMinutes ?? DEFAULT_CATCH_UP) * 60000, TICK_WINDOW_MS) ? latest : null;
  const every = parseDuration(r.every)!;
  return late < Math.max(every, r.catchUpMinutes ?? 0) * 60000 ? latest : null;
}

/** When a routine fires next after `from` (within 8 days), or null. */
export function nextFire(r: Routine, from = new Date()): Date | null {
  for (let i = 0; i < 9; i++) {
    const next = slotsOn(r, atMidnight(from, i)).find((d) => d > from);
    if (next) return next;
  }
  return null;
}

/** What the schedule is, as a key: a routine whose schedule changed starts over. */
function scheduleKey(r: Routine): string {
  return JSON.stringify([r.at || "", r.every || "", r.between || "", routineDays(r.days).join(",")]);
}

// ------------------------------------------------------------------ the routines file

interface PersonalFile { routines: any[]; team: Record<string, { enabled: boolean }> }

/** A routine in effect: where it's from, and why it can't run (if so). */
export interface ResolvedRoutine { routine: Routine; source: "team" | "personal"; overridden: boolean; problem: string | null }

/**
 * Team routines (from the deck's config) and your own, as one list. Team routines are
 * checked but never rejected: one that doesn't check out shows its problem instead of running.
 */
export class Routines {
  file: string;
  team: () => { routines: any[]; presets: { id: string }[] };

  constructor(file: string, team: Routines["team"]) {
    this.file = file;
    this.team = team;
  }

  personal(): PersonalFile {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      return { routines: Array.isArray(d.routines) ? d.routines : [], team: d.team && typeof d.team === "object" ? d.team : {} };
    } catch {
      return { routines: [], team: {} };
    }
  }

  private _write(d: PersonalFile) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify(d, null, 2) + "\n");
  }

  list(): ResolvedRoutine[] {
    const { routines: teamList, presets } = this.team();
    const presetIds = presets.map((p) => p.id);
    const mine = this.personal();
    const out: ResolvedRoutine[] = [];
    const seen = new Set<string>();
    const add = (raw: any, source: "team" | "personal") => {
      const id = String(raw?.id || "");
      if (seen.has(id)) return;
      seen.add(id);
      let routine: Routine;
      let problem: string | null = null;
      try { routine = checkRoutine(raw, { presets: presetIds, defaultEnabled: source === "personal" }); } catch (e) {
        routine = { ...(raw && typeof raw === "object" ? raw : {}), id, enabled: false };
        problem = (e as Error).message;
      }
      const override = source === "team" ? mine.team[id] : undefined;
      const overridden = !!override && typeof override.enabled === "boolean" && override.enabled !== routine.enabled;
      if (overridden) routine = { ...routine, enabled: override!.enabled };
      out.push({ routine, source, overridden, problem });
    };
    for (const r of teamList) add(r, "team");
    for (const r of mine.routines) add(r, "personal");
    return out;
  }

  get(id: string): ResolvedRoutine | null {
    return this.list().find((r) => r.routine.id === id) || null;
  }

  /** Create or replace one of your own routines. Returns it as saved. */
  save(input: RoutineInput): Routine {
    const { presets, routines: teamList } = this.team();
    const mine = this.personal();
    const teamIds = new Set(teamList.map((r: any) => String(r?.id || "")));
    let id = String(input.id || "").trim();
    if (id) {
      if (teamIds.has(id)) throw new Error("That's one of the team's routines (deck.json): you can switch it off for yourself, or change it in deck.json.");
      if (!mine.routines.some((r) => r?.id === id)) throw new Error(`No routine ${id} of yours to change.`);
    } else {
      const base = routineId(input.label || input.prompt || input.preset || "");
      const taken = new Set([...teamIds, ...mine.routines.map((r) => String(r?.id || ""))]);
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    }
    const routine = checkRoutine({ ...input, id }, { presets: presets.map((p) => p.id) });
    const i = mine.routines.findIndex((r) => r?.id === id);
    if (i >= 0) mine.routines[i] = routine;
    else mine.routines.push(routine);
    this._write(mine);
    return routine;
  }

  /** Delete one of your own routines. */
  remove(id: string) {
    const mine = this.personal();
    const i = mine.routines.findIndex((r) => r?.id === id);
    if (i < 0) throw new Error(this.team().routines.some((r: any) => r?.id === id) ? "Team routines are removed in deck.json; you can switch this one off for yourself." : `No routine ${id}.`);
    mine.routines.splice(i, 1);
    this._write(mine);
  }

  /** Switch a routine on or off: yours in place, a team one for you only. */
  setEnabled(id: string, on: boolean): Routine {
    const mine = this.personal();
    const own = mine.routines.find((r) => r?.id === id);
    if (own) {
      own.enabled = on;
      this._write(mine);
      return this.get(id)!.routine;
    }
    const team = this.team().routines.find((r: any) => r?.id === id);
    if (!team) throw new Error(`No routine ${id}.`);
    if ((team.enabled === true) === on) delete mine.team[id];
    else mine.team[id] = { enabled: on };
    this._write(mine);
    return this.get(id)!.routine;
  }
}

// ------------------------------------------------------------------ the scheduler

interface SlotState extends RoutineLast { slot?: string; schedule?: string }

/** What firing a routine did: the run it started (or replied to), or why it couldn't. */
export interface FireOutcome { ok: boolean; error?: string; runId?: string }

export interface SchedulerOptions {
  /** Start the routine's run. `lastRunId` is its previous run (for mode "continue"). */
  fire: (routine: Routine, lastRunId: string | null) => FireOutcome;
  /** Why a run can't take another turn yet ("still working"), or null when it's done. */
  busy: (runId: string) => string | null;
}

export class Scheduler {
  routines: Routines;
  stateFile: string;
  opts: SchedulerOptions;
  state: Record<string, SlotState> = {};
  timer: ReturnType<typeof setInterval> | null = null;

  constructor(routines: Routines, stateFile: string, opts: SchedulerOptions) {
    this.routines = routines;
    this.stateFile = stateFile;
    this.opts = opts;
    try { this.state = JSON.parse(fs.readFileSync(stateFile, "utf-8")) || {}; } catch {}
  }

  start() {
    this.timer = setInterval(() => { try { this.tick(); } catch {} }, 30 * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private _save() {
    try { writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2)); } catch {}
  }

  tick(now = new Date()) {
    for (const { routine: r, problem } of this.routines.list()) {
      if (!r.enabled || problem) continue;
      const prev = this.state[r.id];
      const schedule = scheduleKey(r);
      const slot = dueSlot(r, now);
      const slotKey = slot ? slot.toISOString() : "";
      // A new interval routine (or one whose schedule changed) starts with the next slot, not
      // the one it was created in. Recorded even when no slot is due (outside `between`), so
      // the first slot to come does fire. An `at` routine still fires within its catch-up time.
      if (r.every && (!prev || (prev.schedule && prev.schedule !== schedule))) {
        this.state[r.id] = { ...(prev || { firedAt: "", ok: true }), slot: slotKey, schedule };
        this._save();
        continue;
      }
      if (!slot) continue;
      // State from before schedules were recorded has no `schedule`: same slot, same routine.
      if (prev && prev.slot === slotKey && (prev.schedule ?? schedule) === schedule) continue;
      this._fire(r, now, { slot: slotKey, schedule });
    }
  }

  /** Run a routine now, off its schedule (the Loops page's Run now). */
  runNow(id: string, now = new Date()): RoutineLast {
    const found = this.routines.get(id);
    if (!found) throw new Error(`No routine ${id}.`);
    if (found.problem) throw new Error(found.problem);
    return this._fire(found.routine, now, { manual: true });
  }

  private _fire(r: Routine, now: Date, extra: { slot?: string; schedule?: string; manual?: boolean }): RoutineLast {
    const prev = this.state[r.id];
    const lastRunId = prev?.runId || null;
    const busy = lastRunId ? this.opts.busy(lastRunId) : null;
    if (busy) {
      const skipped: SlotState = { ...(prev as SlotState), ...extra, manual: prev?.manual, skipped: `Skipped: the last run is ${busy}.`, skippedAt: now.toISOString() };
      if (extra.manual) throw new Error(`The last run is ${busy}.`);
      this.state[r.id] = skipped;
      this._save();
      return skipped;
    }
    let outcome: FireOutcome;
    try { outcome = this.opts.fire(r, lastRunId); } catch (e) { outcome = { ok: false, error: (e as Error).message }; }
    const next: SlotState = {
      slot: extra.slot ?? prev?.slot,
      schedule: extra.schedule ?? prev?.schedule,
      firedAt: now.toISOString(),
      ok: outcome.ok,
      error: outcome.ok ? null : outcome.error || "It didn't start.",
      // A failed start keeps the last run, so "continue" still has one to reply to.
      runId: outcome.runId || lastRunId,
      skipped: null,
      skippedAt: null,
      manual: !!extra.manual,
    };
    this.state[r.id] = next;
    this._save();
    return next;
  }

  /** The Loops page's list (and Home's). */
  view(now = new Date()): RoutineView[] {
    return this.routines.list().map(({ routine: r, source, overridden, problem }) => {
      const s = this.state[r.id];
      const next = r.enabled && !problem ? nextFire(r, now) : null;
      return {
        ...r,
        source,
        overridden,
        problem,
        schedule: describeSchedule(r),
        nextAt: next ? next.toISOString() : null,
        last: s && (s.firedAt || s.skippedAt)
          ? { firedAt: s.firedAt, ok: s.ok, runId: s.runId ?? null, error: s.error ?? null, skipped: s.skipped ?? null, skippedAt: s.skippedAt ?? null, manual: !!s.manual }
          : null,
      };
    });
  }
}

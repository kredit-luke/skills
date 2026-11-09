/** The Loops page's pure parts: what a watch is in words, and the routine form's draft. Unit tested. */

import type { Preset, RoutineInput, RoutineView, RunMeta, RunWatch } from '../../../../../shared/api';
import { DAY_KEYS, formatMinutes, routineDays } from '../../../../../shared/loops';

/** A run's watch is on. */
export function watching(r: Pick<RunMeta, 'watch'>): boolean {
  return !!r.watch && !r.watch.endedAt;
}

/** What a watch waits for, in words. */
export function watchWhat(w: RunWatch): string {
  if (w.kind === 'every') return `Every ${formatMinutes(w.everyMinutes)}`;
  if (w.kind === 'check') return `${w.until === 'success' ? 'Until it succeeds' : 'When it changes'}, checked every ${formatMinutes(w.everyMinutes)}`;
  const prs = w.prs.map((p) => `${p.repo}#${p.number}`).join(', ');
  return `${prs || 'Pull requests'}, checked every ${formatMinutes(w.everyMinutes)}`;
}

export function watchKindLabel(w: RunWatch): string {
  return w.kind === 'every' ? 'Interval' : w.kind === 'check' ? 'Check' : 'Pull requests';
}

/** The routine form, as the page edits it: plain strings, days as a choice or a set. */
export interface RoutineDraft {
  id: string | null;
  label: string;
  what: 'prompt' | 'preset';
  prompt: string;
  preset: string;
  args: Record<string, string>;
  when: 'at' | 'every';
  at: string;
  every: string;
  between: boolean;
  from: string;
  to: string;
  days: 'daily' | 'weekdays' | 'weekends' | 'custom';
  custom: string[];
  mode: 'fresh' | 'continue';
  workspace: string;
  model: string;
  effort: string;
  catchUp: string;
  /** Kept as they were when editing: the form doesn't show them, and saving replaces the routine. */
  enabled: boolean;
  permissionMode: string;
}

export function blankDraft(): RoutineDraft {
  return {
    id: null, label: '', what: 'prompt', prompt: '', preset: '', args: {},
    when: 'at', at: '09:00', every: '2h', between: false, from: '08:00', to: '18:00',
    days: 'weekdays', custom: ['mon'], mode: 'fresh', workspace: 'main', model: '', effort: '', catchUp: '',
    enabled: true, permissionMode: '',
  };
}

/** A routine (or Claude's proposal, or a run to repeat) as a draft. */
export function draftFrom(r: Partial<RoutineView> & { prompt?: string }): RoutineDraft {
  const d = blankDraft();
  d.id = r.id ?? null;
  d.label = r.label || '';
  if (r.preset) { d.what = 'preset'; d.preset = r.preset; d.args = { ...(r.args || {}) }; }
  else d.prompt = r.prompt || '';
  if (r.every) {
    d.when = 'every';
    d.every = r.every;
    const [from, to] = (r.between || '').split(/\s*[-–]\s*/);
    if (from && to) { d.between = true; d.from = from; d.to = to; }
  } else if (r.at) d.at = r.at;
  if (r.days === undefined || r.days === 'daily') d.days = 'daily';
  else if (r.days === 'weekdays' || r.days === 'weekends') d.days = r.days;
  else { d.days = 'custom'; d.custom = routineDays(r.days); }
  d.mode = r.mode === 'continue' ? 'continue' : 'fresh';
  d.workspace = r.workspace || 'main';
  d.model = r.model || '';
  d.effort = r.effort || '';
  d.catchUp = r.catchUpMinutes != null ? String(r.catchUpMinutes) : '';
  d.enabled = r.enabled !== false;
  d.permissionMode = r.permissionMode || '';
  return d;
}

/** The draft as POST /api/routines takes it (the server checks it). */
export function draftToInput(d: RoutineDraft, presets: Preset[] = []): RoutineInput {
  const out: RoutineInput = { label: d.label.trim() || undefined, enabled: d.enabled };
  if (d.permissionMode) out.permissionMode = d.permissionMode as RoutineInput['permissionMode'];
  if (d.id) out.id = d.id;
  if (d.what === 'preset') {
    out.preset = d.preset;
    const names = new Set((presets.find((p) => p.id === d.preset)?.args || []).map((a) => a.name));
    const args = Object.fromEntries(Object.entries(d.args).filter(([k, v]) => names.has(k) && v.trim()));
    if (Object.keys(args).length) out.args = args;
  } else out.prompt = d.prompt;
  if (d.when === 'at') out.at = d.at;
  else {
    out.every = d.every.trim();
    if (d.between) out.between = `${d.from}-${d.to}`;
  }
  out.days = d.days === 'custom' ? DAY_KEYS.filter((k) => d.custom.includes(k)) : d.days;
  if (d.mode === 'continue') out.mode = 'continue';
  if (d.workspace) out.workspace = d.workspace;
  if (d.model) out.model = d.model;
  if (d.effort) out.effort = d.effort as RoutineInput['effort'];
  if (d.catchUp.trim()) out.catchUpMinutes = Number(d.catchUp);
  return out;
}

/** The last time a routine fired, in a few words, and whether it went wrong. */
export function lastSummary(r: RoutineView): { text: string; bad: boolean } | null {
  const l = r.last;
  if (!l) return null;
  if (l.skipped && (!l.firedAt || (l.skippedAt || '') > l.firedAt)) return { text: l.skipped, bad: true };
  if (!l.firedAt) return null;
  if (!l.ok) return { text: `Didn't start: ${l.error || 'unknown error'}`, bad: true };
  return { text: l.manual ? 'Run by hand' : 'Ran', bad: false };
}

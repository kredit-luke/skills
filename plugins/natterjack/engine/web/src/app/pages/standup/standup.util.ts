import type { StandupItem, StandupSource } from '../../../../../shared/api';

/** The window the page covers: back to the start of today, the last workday, the last two, or the last five (a week). */
export type StandupWindow = 'today' | 'workday' | '2-workdays' | 'week';

const WORKDAYS: Record<Exclude<StandupWindow, 'today'>, number> = { workday: 1, '2-workdays': 2, week: 5 };

/** Monday to Friday. */
export function isWorkday(d: Date): boolean { const w = d.getDay(); return w >= 1 && w <= 5; }

/**
 * Midnight (local time) at the start of the window: today for 'today', else `n` workdays before
 * today (Monday's last workday is Friday; a weekend's too). Workdays are Monday to Friday.
 */
export function windowStart(now: Date, w: StandupWindow): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (w === 'today') return d;
  for (let left = WORKDAYS[w]; left > 0;) {
    d.setDate(d.getDate() - 1);
    if (isWorkday(d)) left--;
  }
  return d;
}

/** A date input's value (YYYY-MM-DD) as local midnight, or null. */
export function dateStart(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A local date as YYYY-MM-DD (the draft's day, a date input's value). */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The "Since …" heading: today, yesterday, a weekday this past week, else the date. */
export function sinceLabel(since: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today.getTime() - new Date(since.getFullYear(), since.getMonth(), since.getDate()).getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Since yesterday';
  if (days < 7) return `Since ${since.toLocaleDateString(undefined, { weekday: 'long' })}`;
  return `Since ${since.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

export type StandupPart = 'done' | 'next' | 'blockers';

/** The sources with something in `part`, each with those items. */
export function withItems(sources: StandupSource[], part: StandupPart): { source: StandupSource; items: StandupItem[] }[] {
  return sources.filter((s) => s[part].length).map((s) => ({ source: s, items: s[part] }));
}

/** Where an item opens: a page on this dashboard (a run, a meeting), a link elsewhere (https only), or nowhere. */
export function itemTarget(i: StandupItem): { route: string[]; query: Record<string, string> | null } | { href: string } | null {
  if (i.runId) return { route: ['/runs', i.runId], query: null };
  if (i.meetingId) return { route: ['/meetings'], query: { m: i.meetingId } };
  return i.url && /^https:\/\//i.test(i.url) ? { href: i.url } : null;
}

// Loops: durations and times as watch blocks, routines and the Loops page write them. The
// server (Node type stripping, .ts extensions) and the web build both compile this file, so it
// has no imports.

/**
 * Minutes in "15m", "2h", "1d", "90" (minutes), "1h30m" or a number of minutes; null when it
 * isn't one or isn't a positive whole number of minutes.
 */
export function parseDuration(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) > 0 ? Number(s) : null;
  const re = /(\d+)(minutes?|mins|min|m|hours?|hrs?|h|days?|d)/gy;
  let total = 0;
  let pos = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    const unit = m[2][0];
    total += Number(m[1]) * (unit === 'd' ? 1440 : unit === 'h' ? 60 : 1);
    pos = re.lastIndex;
  }
  return pos === s.length && total > 0 ? total : null;
}

/** 90 → "1 h 30 min", 1440 → "1 day". */
export function formatMinutes(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? '1 day' : `${min / 1440} days`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

/** "08:30" → minutes after midnight; null when it isn't a time. */
export function parseClock(v: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** "08:00-18:00" → [480, 1080]; null when it isn't a window. An end before the start runs past midnight. */
export function parseWindow(v: unknown): [number, number] | null {
  const parts = String(v ?? '').split(/\s*[-–]\s*/);
  if (parts.length !== 2) return null;
  const a = parseClock(parts[0]);
  const b = parseClock(parts[1]);
  return a === null || b === null || a === b ? null : [a, b];
}

/** Whether a minute of the day is inside a window from parseWindow (start included, end not). */
export function inWindow(minute: number, w: [number, number]): boolean {
  return w[0] < w[1] ? minute >= w[0] && minute < w[1] : minute >= w[0] || minute < w[1];
}

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** A routine's `days` as day keys: "daily" (or nothing), "weekdays", "weekends" or a list like ["mon", "Thursday"]. */
export function routineDays(days: unknown): string[] {
  if (!days || days === 'daily') return DAY_KEYS;
  if (days === 'weekdays') return DAY_KEYS.slice(1, 6);
  if (days === 'weekends') return ['sun', 'sat'];
  const list = Array.isArray(days) ? days : String(days).split(/[\s,]+/);
  return list.map((d) => String(d).toLowerCase().slice(0, 3)).filter((d) => DAY_KEYS.includes(d));
}

/** The days in words: "Daily", "Weekdays", "Mon, Thu". */
export function daysLabel(days: unknown): string {
  const keys = routineDays(days);
  if (keys.length === 7) return 'Daily';
  if (keys.length === 5 && DAY_KEYS.slice(1, 6).every((d) => keys.includes(d))) return 'Weekdays';
  if (keys.length === 2 && keys.includes('sat') && keys.includes('sun')) return 'Weekends';
  if (!keys.length) return 'Never';
  return DAY_KEYS.filter((d) => keys.includes(d)).map((d) => d[0].toUpperCase() + d.slice(1)).join(', ');
}

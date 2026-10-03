/**
 * Chart colours. Series are coloured by entity (model family), never by rank, and
 * never with the status colours (green/amber/red mean succeeded/waiting/failed
 * elsewhere). Okabe–Ito based, so the families stay distinguishable with the
 * common colour-vision deficiencies.
 */
export const FAMILY_COLORS: Record<string, string> = {
  opus: '#0072B2',
  sonnet: '#E69F00',
  haiku: '#56B4E9',
  fable: '#CC79A7',
  other: '#8A8F9E',
};

export function familyOf(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1].toLowerCase() : 'other';
}

/** Distinct shades for several models of one family (newest darkest). */
export function modelColor(model: string, index = 0): string {
  const base = FAMILY_COLORS[familyOf(model)];
  return index ? shade(base, Math.min(0.45, 0.22 * index)) : base;
}

/** Status colours for run outcomes (these ARE statuses, so they reuse the status palette). */
export const STATUS_COLORS: Record<string, string> = {
  succeeded: '#1E9E57',
  waiting: '#D69A1F',
  running: '#3B6FD4',
  failed: '#D64545',
  interrupted: '#B06A2C',
  cancelled: '#9AA0AE',
  handedOff: '#7A5CC7',
};

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix(n >> 16), g = mix((n >> 8) & 255), b = mix(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** 1234 → "1.2K", 3400676 → "3.4M". */
export function compact(n: number): string {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

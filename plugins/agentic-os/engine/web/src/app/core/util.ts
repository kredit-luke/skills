/** Small formatting helpers shared by every page. Pure functions. */

export function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "3m ago", "in 2h", "just now". Accepts ISO strings or epoch ms. */
export function relTime(t: string | number | null | undefined, now = Date.now()): string {
  const ms = typeof t === 'number' ? t : t ? Date.parse(t) : NaN;
  if (!ms) return '';
  let diff = now - ms;
  if (diff < 0) {
    diff = -diff;
    if (diff < 3600000) return 'in ' + Math.max(1, Math.round(diff / 60000)) + 'm';
    if (diff < 86400000) return 'in ' + Math.round(diff / 3600000) + 'h';
    return 'in ' + Math.round(diff / 86400000) + 'd';
  }
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

export function usd(n: number | null | undefined): string {
  return '$' + (n || 0).toFixed(2);
}

export function dur(ms: number | null | undefined): string {
  if (ms == null || isNaN(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

export function pct(a: number, b: number): string {
  return b ? Math.round((a / b) * 100) + '%' : '—';
}

/** Local Windows or POSIX path -> vscode://file/C:/path/with/forward/slashes */
export function vscodeUrl(p: string | null | undefined): string {
  return 'vscode://file/' + String(p || '').replace(/\\/g, '/');
}

export function tokens(n: number | null | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

/** 512 B, 12 KB, 3.4 MB, 1.2 GB */
export function bytes(n: number | null | undefined): string {
  const v = n || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
  if (v < 1024 ** 3) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 ** 3).toFixed(1) + ' GB';
}

/** A file name for a pasted screenshot, which arrives as "image.png": screenshot-2026-09-26-1405.png */
export function pastedName(type: string, at = new Date()): string {
  const ext = ({ 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[type] || 'png';
  const p = (n: number) => String(n).padStart(2, '0');
  return `screenshot-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.${ext}`;
}

export function lsGet(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private window */ }
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

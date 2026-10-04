/**
 * Pages load their code on first visit. After the dashboard is rebuilt (a restart,
 * an upgrade) a tab that was already open asks for files the new build no longer has,
 * or asked while they were being replaced, and the browser keeps that failure for the
 * life of the page. Loading the address afresh picks up the new build. Once per
 * address per minute, so a file that's really missing shows the error instead of looping.
 */

const KEY = 'dash.chunkReload';
const WINDOW_MS = 60_000;

/** A failed lazy load (Chrome, Firefox and Safari word it differently). */
export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(msg);
}

/** Whether to reload for this address now (and remember that we did). */
export function shouldReload(url: string, store: Pick<Storage, 'getItem' | 'setItem'>, now = Date.now()): boolean {
  let last: { url: string; at: number } | null = null;
  try { last = JSON.parse(store.getItem(KEY) || 'null'); } catch {}
  if (last && last.url === url && now - last.at < WINDOW_MS) return false;
  try { store.setItem(KEY, JSON.stringify({ url, at: now })); } catch {}
  return true;
}

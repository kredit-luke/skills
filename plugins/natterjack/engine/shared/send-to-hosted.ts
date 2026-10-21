// No imports: the server (Node type stripping, .ts extensions) and the web build both
// compile this file, and they disagree on how a relative import is written.

/** Run statuses between turns: a reply can go, and the run can be sent to the hosted dashboard. */
export const BETWEEN_TURNS: readonly string[] = ['waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'];

/**
 * Send to hosted's source, as an origin, or null: only a dashboard on the same computer as
 * the browser (http on localhost) may send a run, so a link can't point the hosted import
 * page at a bundle on someone else's server.
 */
export function localDashboardOrigin(from: string | null | undefined): string | null {
  try {
    const u = new URL(from || '');
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.pathname !== '/' || u.search || u.username) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Runs that started waiting for you since the last look: in `now` but not in `seen`.
 * The first look (seen null) reports none, so opening the dashboard doesn't chime for
 * runs that were already waiting.
 */
export function newlyWaiting(seen: ReadonlySet<string> | null, now: readonly string[]): string[] {
  return seen ? now.filter((id) => !seen.has(id)) : [];
}

/** "(3) " in front of the tab title while runs wait for you; nothing at 0. */
export function titlePrefix(waiting: number): string {
  return waiting > 0 ? `(${waiting > 99 ? '99+' : waiting}) ` : '';
}

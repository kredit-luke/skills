/**
 * The viewer's own tracker activity, for the Standup page (IssueTracker.activity): what they
 * changed since a time, and the open issues assigned to them. Shared by the adapters.
 */

/** What the viewer did to an issue since a time: what, e.g. "moved To Do → In Progress", "commented". at: the latest of it. */
export interface IssueChange { id: string; title: string; url: string; state: string; what: string[]; at: string }

/** An open issue assigned to the viewer. priority: the tracker's rank (1 highest, 0 none). blocked: its state or a label says so. */
export interface AssignedIssue { id: string; title: string; url: string; state: string; priority: number; priorityLabel: string; blocked: boolean; updatedAt: string }

/** errors: parts that couldn't be read (e.g. one repository); the rest is still there. */
export interface TrackerActivity { changed: IssueChange[]; assigned: AssignedIssue[]; errors?: string[] }

/** Issues each activity query asks for. */
export const ACTIVITY_LIMIT = 50;

/** Whether an issue reads as blocked: its state or one of its labels says "blocked" ("blocking" and "blocker" mean it holds others up). */
export function isBlocked(state: string, labels: string[]): boolean {
  return [state, ...labels].some((s) => /\bblocked\b/i.test(String(s || "")));
}

/** Assigned issues by priority (1 first, none last), then most recently updated. */
export function byPriority(a: AssignedIssue, b: AssignedIssue): number {
  const rank = (p: number) => (p > 0 ? p : 99);
  return rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
}

/** `since` as whole minutes before now, at least one: a relative JQL date, so the Jira site's time zone doesn't matter. */
export function minutesAgo(since: string, now = Date.now()): number {
  return Math.max(1, Math.ceil((now - Date.parse(since)) / 60000));
}

/** Whether time `t` (any date format) is at or after `since`. */
export function isSince(t: unknown, since: string): boolean {
  const ms = Date.parse(String(t ?? ""));
  return Number.isFinite(ms) && ms >= Date.parse(since);
}

/** An ISO time without milliseconds (GitHub search's dates). */
export function searchTime(since: string): string {
  return new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Adds `what` to an issue's change (once), keeping the latest time (any date format; kept as ISO). */
export function noteChange(map: Map<string, IssueChange>, base: Omit<IssueChange, "what" | "at">, what: string, when: string) {
  const t = Date.parse(when);
  const at = new Date(Number.isFinite(t) ? t : 0).toISOString();
  const c = map.get(base.id) || { ...base, what: [], at };
  if (!c.what.includes(what)) c.what.push(what);
  if (at > c.at) c.at = at;
  map.set(base.id, c);
}

/** The changes, newest first. */
export function changesOf(map: Map<string, IssueChange>): IssueChange[] {
  return [...map.values()].filter((c) => c.what.length).sort((a, b) => b.at.localeCompare(a.at));
}

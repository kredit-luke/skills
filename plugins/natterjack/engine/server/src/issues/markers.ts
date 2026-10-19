/**
 * Markers: tokens like "roam-meeting-<id>" written into an issue's description so it can be
 * found again (meetings/tickets.ts). A tracker's text search is fuzzy (word stems, tokens split
 * at hyphens), so each adapter keeps only the issues whose text has the marker exactly.
 */

import type { LinkedIssue, LinkedIssues } from "./index.ts";

/**
 * What a Jira or Linear key looks like ("ENG-12"): nothing that could add a path, query or fragment to its link.
 * Matches Jira Cloud and Linear keys; others (e.g. a custom Data Center key pattern) get no link rather than a wrong one.
 */
export const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Whether issueUrl should build a link for `id` (a Jira or Linear key). issueUrl also gets keys an Ask run reported. */
export const isIssueKey = (id: string) => ISSUE_KEY_RE.test(id);

/** Results each linkedIssues search asks for; a search that returns this many may have more. */
export const LINKED_LIMIT = 100;

/** Whether `text` has `marker` as a whole token: not inside a longer id ("…-ab" in "…-abc"). */
export function hasMarker(text: string, marker: string): boolean {
  if (!marker) return false;
  for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) {
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + marker.length] ?? "";
    if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) return true;
  }
  return false;
}

/** Each issue under every marker its text has exactly (an issue can carry several); `truncated`: a search hit LINKED_LIMIT. */
export function byMarker(markers: string[], found: { issue: LinkedIssue; text: string }[], truncated = false): LinkedIssues {
  const out: LinkedIssues = new Map<string, LinkedIssue[]>();
  if (truncated) out.truncated = true;
  for (const { issue, text } of found) {
    for (const m of markers) {
      if (!hasMarker(text, m)) continue;
      const list = out.get(m) || [];
      if (!list.some((x) => x.key === issue.key)) list.push(issue);
      out.set(m, list);
    }
  }
  return out;
}

/** Markers split into groups of at most `size`. */
export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

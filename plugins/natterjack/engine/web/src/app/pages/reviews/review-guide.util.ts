import type { DiffFile, DiffHunk, HunkTag, ReviewGuide } from '../../../../../shared/api';

/** A hunk with the file it's in, as the diff pane shows it. */
export interface PlacedHunk { file: DiffFile; hunk: DiffHunk }
/** A group of the diff pane: hunks of one kind, in reading order. */
export interface HunkGroup { tag: HunkTag | 'all'; label: string; open: boolean; hunks: PlacedHunk[] }

const GROUPS: { tag: HunkTag; label: string; open: boolean }[] = [
  { tag: 'core', label: 'Core change', open: true },
  { tag: 'supporting', label: 'Supporting', open: true },
  { tag: 'test', label: 'Tests', open: false },
  { tag: 'generated', label: 'Generated', open: false },
  { tag: 'formatting', label: 'Formatting only', open: false },
];

/**
 * The diff pane's groups. Without a guide: one group, in file order. With one: by tag, core
 * hunks in the order the guide's core points name them (then any other core hunk), the rest in
 * file order. Empty groups are left out.
 */
export function groupHunks(files: DiffFile[], guide: ReviewGuide | null): HunkGroup[] {
  const all: PlacedHunk[] = files.flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })));
  if (!guide) return all.length ? [{ tag: 'all', label: 'Changes', open: true, hunks: all }] : [];
  const byId = new Map(all.map((p) => [p.hunk.id, p]));
  const tagOf = (id: string): HunkTag => guide.tags[id] || 'supporting';
  const coreOrder: string[] = [];
  for (const p of guide.core) for (const id of p.hunks) if (!coreOrder.includes(id) && byId.has(id)) coreOrder.push(id);
  for (const p of all) if (tagOf(p.hunk.id) === 'core' && !coreOrder.includes(p.hunk.id)) coreOrder.push(p.hunk.id);
  return GROUPS.map((g) => ({
    ...g,
    hunks: g.tag === 'core' ? coreOrder.map((id) => byId.get(id)!) : all.filter((p) => tagOf(p.hunk.id) === g.tag && !coreOrder.includes(p.hunk.id)),
  })).filter((g) => g.hunks.length);
}

/** Where a hunk starts, for its link text: "src/http.ts:42". */
export function hunkLabel(files: DiffFile[], id: string): string {
  for (const f of files) {
    const h = f.hunks.find((x) => x.id === id);
    if (h) return `${f.path.split('/').pop()}:${h.newStart || h.oldStart}`;
  }
  return id;
}

/** A line comment not posted yet (the PR's new side), with the commit whose diff it was written on. */
export interface DraftComment { path: string; line: number; body: string; sha?: string }

/** Where a PR's draft line comments are kept in this browser. */
export function draftsKey(repo: string, n: number): string { return `natterjack.review-drafts.${repo}#${n}`; }

/** A diff line's key: the file and its new-side line. */
export function lineKey(path: string, line: number): string { return `${path}:${line}`; }

/** The localStorage key for a reviewer's chapter checklist on one commit of one PR. */
export function progressKey(repo: string, number: number, sha: string): string {
  return `natterjack.review.${repo}#${number}@${sha}`;
}

/** What a file with no lines to show is: binary, a pure rename, an empty file added or deleted, or a mode change. */
export function noHunkLabel(f: Pick<DiffFile, 'binary' | 'status'>): string {
  if (f.binary) return 'binary file, not shown.';
  if (f.status === 'renamed') return 'renamed, contents unchanged.';
  if (f.status === 'added') return 'new empty file.';
  if (f.status === 'deleted') return 'deleted (it was empty).';
  return 'no line changes (mode or metadata only).';
}

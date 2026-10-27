import type { MergeMethod, ReviewPr, ReviewPrDetail, ReviewSummary } from '../../../../../shared/api';

export type ReviewFilter = 'requested' | 'all' | 'mine';

export interface ReviewFilters { filter: ReviewFilter; org: string; author?: string; text: string; drafts: boolean }

/** A PR's key, "owner/name#n". */
export function prKey(p: { repo: string; number: number }): string { return `${p.repo}#${p.number}`; }

/**
 * The PRs a filter shows. Drafts are left out unless asked for (yours always show), org
 * matches the repo's owner, author the PR's author, and text matches the title, repo, number or author.
 */
export function filterPrs(prs: ReviewPr[], f: ReviewFilters): ReviewPr[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  return prs.filter((p) => {
    if (f.filter === 'requested' && !p.requested) return false;
    if (f.filter === 'mine' && !p.mine) return false;
    if (p.isDraft && !f.drafts && !p.mine) return false;
    if (f.org && p.repo.split('/')[0].toLowerCase() !== f.org.toLowerCase()) return false;
    if (f.author && (p.author || '') !== f.author) return false;
    if (!words.length) return true;
    const hay = `${p.title} ${p.repo}#${p.number} ${p.author || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The authors of these PRs, most PRs first (then by name), for the author filter. */
export function authorsOf(prs: ReviewPr[]): { login: string; count: number }[] {
  const n = new Map<string, number>();
  for (const p of prs) if (p.author) n.set(p.author, (n.get(p.author) || 0) + 1);
  return [...n].map(([login, count]) => ({ login, count })).sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

/** The reviews worth showing: a verdict, or comments that left line comments (a bot's "looks fine" comment isn't). */
export function shownReviews(reviews: ReviewPrDetail['reviews']): ReviewPrDetail['reviews'] {
  return reviews.filter((r) => r.state !== 'COMMENTED' || r.comments > 0);
}

const METHODS: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
export function methodLabel(m: MergeMethod): string { return METHODS[m] || m; }

/** Why the PR can't be merged from here, or null (GitHub still checks its own rules). */
export function mergeBlock(d: Pick<ReviewPrDetail, 'isDraft' | 'mergeable' | 'mergeState' | 'mergeMethods'>): string | null {
  if (d.isDraft || d.mergeState === 'DRAFT') return 'Drafts can\'t be merged.';
  if (d.mergeable === 'CONFLICTING' || d.mergeState === 'DIRTY') return 'It has merge conflicts.';
  if (!d.mergeMethods.length) return 'The repository allows no merge method.';
  return null;
}

/** What GitHub's merge state says before merging, or null when nothing stands out. */
export function mergeNote(state: string): string | null {
  switch (state) {
    case 'BLOCKED': return 'GitHub says it\'s blocked (required reviews or checks), so it may refuse.';
    case 'BEHIND': return 'The branch is behind its base; the repository may require updating it first.';
    case 'UNSTABLE': return 'Some checks are failing.';
    default: return null;
  }
}

/** The newer of two summaries (by when each was made); either may be missing. */
export function newerSummary(a: ReviewSummary | null | undefined, b: ReviewSummary | null | undefined): ReviewSummary | null {
  if (!a || !b) return a || b || null;
  return Date.parse(a.at) >= Date.parse(b.at) ? a : b;
}

/**
 * Whether to ask for a PR's summary: it has none, or the one it has is older than the PR's
 * last activity (maybe a push; the server answers from its saved one when the commit is the same).
 */
export function needsSummary(p: ReviewPr, made?: ReviewSummary | null): boolean {
  const s = made || p.summary;
  if (!s) return true;
  return Date.parse(s.at) < Date.parse(p.updatedAt);
}

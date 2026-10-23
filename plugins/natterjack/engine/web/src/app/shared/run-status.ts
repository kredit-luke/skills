import type { RunMeta } from '../../../../shared/api';

export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Finished fine in the last day and not rated yet: it may still be waiting on you (e.g. "test this
 * and tell me"). Never a run mirrored from a linked computer (RunMeta.remote): it's rated there.
 */
export function toReview(r: Pick<RunMeta, 'status' | 'verdict' | 'endedAt' | 'remote'>, now = Date.now()): boolean {
  if (r.remote) return false;
  return r.status === 'succeeded' && !r.verdict && !!r.endedAt && now - Date.parse(r.endedAt) < REVIEW_WINDOW_MS;
}

/** Finished and not rated yet. Never a mirrored run (RunMeta.remote): it's rated on the computer, as in toReview. */
export function unrated(r: Pick<RunMeta, 'status' | 'verdict' | 'remote'>): boolean {
  if (r.remote) return false;
  return r.status !== 'running' && r.status !== 'waiting' && !r.verdict;
}

/**
 * Waiting for an answer you can give here: a local run, or a mirrored run whose computer has
 * Remote control on. `linkEnabled` is the link's live state (DataService.remoteLinks) when known;
 * otherwise the run's own `remote.enabled`. The "Needs answer" chip, Focus and the Activity
 * waiting pill all use this, through DataService.needsAnswer.
 */
export function needsAnswer(r: Pick<RunMeta, 'status' | 'remote'>, linkEnabled?: boolean): boolean {
  if (r.status !== 'waiting') return false;
  return !r.remote || (linkEnabled ?? r.remote.enabled);
}

/** Status label + badge class, so colour never carries meaning alone (§13). */
export function runStatus(r: Pick<RunMeta, 'status' | 'warning'> & Partial<Pick<RunMeta, 'handedOffTo'>>): { label: string; cls: string; dot: string } {
  if (r.status === 'handedOff' && r.handedOffTo === 'hosted') return { label: 'Moved to hosted', cls: 'navy', dot: 'handedOff' };
  switch (r.status) {
    case 'running': return { label: 'Running', cls: 'live', dot: 'running' };
    case 'waiting': return { label: 'Needs your answer', cls: 'amber', dot: 'waiting' };
    case 'succeeded': return r.warning ? { label: 'Background work stopped', cls: 'amber', dot: 'warning' } : { label: 'Done', cls: 'ok', dot: 'succeeded' };
    case 'failed': return { label: 'Failed', cls: 'bad', dot: 'failed' };
    case 'cancelled': return { label: 'Cancelled', cls: 'amber', dot: 'cancelled' };
    case 'interrupted': return { label: 'Interrupted', cls: 'amber', dot: 'interrupted' };
    case 'handedOff': return { label: 'In terminal', cls: 'navy', dot: 'handedOff' };
    default: return { label: String(r.status), cls: '', dot: '' };
  }
}

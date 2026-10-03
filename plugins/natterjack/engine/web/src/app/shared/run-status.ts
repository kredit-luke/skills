import type { RunMeta } from '../../../../shared/api';

export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Finished fine in the last day and not rated yet: it may still be waiting on you (e.g. "test this and tell me"). */
export function toReview(r: Pick<RunMeta, 'status' | 'verdict' | 'endedAt'>, now = Date.now()): boolean {
  return r.status === 'succeeded' && !r.verdict && !!r.endedAt && now - Date.parse(r.endedAt) < REVIEW_WINDOW_MS;
}

/** Status label + badge class, so colour never carries meaning alone (§13). */
export function runStatus(r: Pick<RunMeta, 'status' | 'warning'>): { label: string; cls: string; dot: string } {
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

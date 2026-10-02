import type { RunEvent } from '../../../../shared/api';

/** What the run page holds for one run: its events so far and the stream id to resume after. */
export interface RunEvents {
  events: RunEvent[];
  /** Dedupe keys of `events`. */
  seen: Set<string>;
  /** SSE id of the next event the stream would send (the count received over it). */
  next: number;
  /** Rough size (the events' JSON length), for the cache's cap. */
  bytes: number;
}

/**
 * Events of the runs opened most recently, so switching back to one shows its
 * transcript at once and its stream sends only what came after. Safe because a
 * run's events are only ever appended, and an event's SSE id is its index.
 * Least recently opened runs go first once there are more than `maxRuns` or
 * their events pass `maxBytes`; the run being opened is always kept.
 */
export class RunEventCache {
  maxRuns = 6;
  maxBytes = 40_000_000;
  private runs = new Map<string, RunEvents>();

  /** The run's entry (made empty if new), marked most recently opened. The caller fills it in place. */
  open(id: string): RunEvents {
    const entry = this.runs.get(id) || { events: [], seen: new Set<string>(), next: 0, bytes: 0 };
    this.runs.delete(id);
    this.runs.set(id, entry);
    this.trim(id);
    return entry;
  }

  has(id: string): boolean { return this.runs.has(id); }

  private trim(keep: string): void {
    let total = 0;
    for (const e of this.runs.values()) total += e.bytes;
    for (const [id, e] of this.runs) {
      if (this.runs.size <= this.maxRuns && total <= this.maxBytes) return;
      if (id === keep) continue;
      this.runs.delete(id);
      total -= e.bytes;
    }
  }
}

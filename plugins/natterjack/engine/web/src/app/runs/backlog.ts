/**
 * Whether the open run's backlog (its saved events) is still loading. The run page opens a run with
 * start(seq) and ends loading with end(seq) when the backlog is in: the stream's first `meta` (the
 * server writes it right after replaying the saved events), the plain GET of the events finishing or
 * failing, or the run itself failing to load. A stale run's end (an older seq) is ignored, and only
 * the first end counts, so the page pins and reveals the transcript once per run.
 */
export class BacklogTracker {
  private seq = 0;
  private waiting = false;

  get loading(): boolean { return this.waiting; }

  start(seq: number): void {
    this.seq = seq;
    this.waiting = true;
  }

  /** True when this ended loading: `seq` is the open run and it was still loading. */
  end(seq: number): boolean {
    if (seq !== this.seq || !this.waiting) return false;
    this.waiting = false;
    return true;
  }
}

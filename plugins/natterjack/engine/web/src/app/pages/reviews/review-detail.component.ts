import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import type { ReviewPrDetail, ReviewSummary } from '../../../../../shared/api';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { relTime } from '../../core/util';
import { ReviewActionsComponent } from './review-actions.component';
import { shownReviews } from './reviews.util';

/** Files listed before "Show all". */
const FILES_SHOWN = 40;

const CHECKS: Record<string, { label: string; cls: string }> = {
  passing: { label: 'Checks passing', cls: 'good' },
  failing: { label: 'Checks failing', cls: 'bad' },
  pending: { label: 'Checks running', cls: 'amber' },
  none: { label: 'No checks', cls: '' },
};

const DECISIONS: Record<string, { label: string; cls: string }> = {
  APPROVED: { label: 'Approved', cls: 'good' },
  CHANGES_REQUESTED: { label: 'Changes requested', cls: 'bad' },
  REVIEW_REQUIRED: { label: 'Review required', cls: 'amber' },
};

/** One pull request on the Reviews page: its summary, checks, reviews and the files it changes. */
@Component({
  selector: 'dash-review-detail',
  imports: [RouterLink, ReviewActionsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="panel detail" aria-live="polite">
      <header class="hd">
        <div class="ttl-row">
          <h2>{{ d()?.title || repo() + '#' + number() }}</h2>
          <button class="btn ghost sm" type="button" (click)="closed.emit()" aria-label="Close">Close</button>
        </div>
        <div class="sub">
          <span class="mono">{{ repo() }}#{{ number() }}</span>
          @if (d(); as d) {
            · {{ d.author || 'unknown' }} · opened {{ rel(d.createdAt) }}
            · <span class="mono">{{ d.head }} → {{ d.base }}</span>
          }
        </div>
      </header>

      @if (err()) { <div class="err-note">{{ err() }}</div> }
      @else if (!d()) { <div class="empty">Loading…</div> }
      @else {
        <section class="summary">
          <h3>What it does</h3>
          @if (current(); as s) {
            <p>{{ s.text }}</p>
          } @else if (sumErr()) {
            <p class="err-note">Couldn't summarize: {{ sumErr() }}</p>
          } @else if (summarizing()) {
            <p class="faint">Summarizing…</p>
          } @else {
            <p class="faint">No summary for this commit yet.</p>
          }
          <button class="linkish" type="button" (click)="summarize(!!current())" [disabled]="summarizing()">{{ current() ? 'Summarize again' : 'Summarize' }}</button>
        </section>

        <div class="facts">
          @if (d()!.state === 'MERGED') { <span class="tag good">Merged</span> } @else if (d()!.state === 'CLOSED') { <span class="tag">Closed</span> }
          @if (d()!.isDraft) { <span class="tag">Draft</span> }
          <span class="tag" [class]="checks().cls" [title]="d()!.failingChecks.join(', ')">{{ checks().label }}</span>
          @if (decision(); as dec) { <span class="tag" [class]="dec.cls">{{ dec.label }}</span> }
          @if (d()!.mergeable === 'CONFLICTING') { <span class="tag bad">Merge conflict</span> }
          <span class="diffstat"><span class="add">+{{ d()!.additions }}</span> <span class="del">−{{ d()!.deletions }}</span> in {{ d()!.changedFiles }} {{ d()!.changedFiles === 1 ? 'file' : 'files' }}</span>
        </div>

        <dash-review-actions [repo]="repo()" [number]="number()" [detail]="d()!" [mine]="isMine()" (changed)="refresh()" (merged)="merged$.emit()">
          <a class="btn primary sm" [routerLink]="[]" [queryParams]="{ view: 'guide' }" queryParamsHandling="merge">Guided review</a>
          <a trail class="btn ghost sm" [href]="d()!.url" target="_blank" rel="noopener">Open on GitHub</a>
        </dash-review-actions>

        @if (d()!.failingChecks.length) {
          <p class="failing">Failing: {{ d()!.failingChecks.join(', ') }}</p>
        }

        @if (shownReviews().length) {
          <section>
            <h3>Reviews</h3>
            <ul class="reviews">
              @for (r of shownReviews(); track r.author) {
                <li><b>{{ r.author }}</b> <span class="tag" [class.good]="r.state === 'APPROVED'" [class.bad]="r.state === 'CHANGES_REQUESTED'">{{ stateLabel(r.state) }}</span>
                  @if (r.comments) { <span class="faint">{{ r.comments }} line {{ r.comments === 1 ? 'comment' : 'comments' }}</span> }
                  <span class="faint">{{ rel(r.at) }}</span></li>
              }
            </ul>
          </section>
        }

        <section>
          <h3>Files</h3>
          <ul class="files">
            @for (f of shownFiles(); track f.path) {
              <li><span class="path">{{ f.path }}</span> <span class="add">+{{ f.additions }}</span> <span class="del">−{{ f.deletions }}</span></li>
            }
          </ul>
          @if (d()!.files.length > shownFiles().length) {
            <button class="linkish" type="button" (click)="allFiles.set(true)">Show all {{ d()!.files.length }} files</button>
          }
        </section>

        @if (d()!.body.trim()) {
          <details>
            <summary>Description</summary>
            <pre class="body">{{ d()!.body }}</pre>
          </details>
        }
      }
    </article>
  `,
  styles: [`
    .detail { padding: 16px 20px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
    .ttl-row { display: flex; align-items: flex-start; gap: 12px; }
    h2 { flex: 1; margin: 0; font-size: 16px; line-height: 1.35; overflow-wrap: anywhere; }
    h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-faint); font-weight: 600; }
    .sub { margin-top: 4px; font-size: 12px; color: var(--ink-faint); overflow-wrap: anywhere; }
    .mono, .path { font-family: var(--font-mono); }
    .summary p { margin: 0 0 6px; font-size: 14px; line-height: 1.5; color: var(--ink); }
    .faint { color: var(--ink-faint); }
    .facts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .diffstat { font-size: 12px; color: var(--ink-soft); }
    .add { color: var(--green); font-family: var(--font-mono); font-size: 11.5px; }
    .del { color: var(--red); font-family: var(--font-mono); font-size: 11.5px; }
    .failing { margin: 0; font-size: 12.5px; color: var(--red); }
    ul { list-style: none; margin: 0; padding: 0; }
    .reviews li { font-size: 13px; padding: 3px 0; display: flex; align-items: center; gap: 8px; }
    .files li { font-size: 12px; padding: 2px 0; display: flex; gap: 8px; align-items: baseline; }
    .files .path { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--ink-soft); }
    details summary { cursor: pointer; font-size: 13px; color: var(--ink-soft); }
    .body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; background: var(--paper-2); padding: 10px 12px; border-radius: 8px; max-height: 420px; overflow: auto; }
  `],
})
export class ReviewDetailComponent {
  private readonly api = inject(ApiService);
  readonly repo = input.required<string>();
  readonly number = input.required<number>();
  /** The person's login on the code host (their own PRs can't be approved). */
  readonly viewer = input<string | null>(null);
  /** A summary the list already has for it (made on this page). */
  readonly summary = input<ReviewSummary | null>(null);
  readonly summarized = output<ReviewSummary>();
  readonly closed = output<void>();
  /** The PR merged: the list should drop it. */
  readonly merged$ = output<void>({ alias: 'merged' });

  readonly d = signal<ReviewPrDetail | null>(null);
  readonly err = signal<string | null>(null);
  readonly summarizing = signal(false);
  readonly sumErr = signal<string | null>(null);
  readonly allFiles = signal(false);
  readonly shownReviews = computed(() => shownReviews(this.d()?.reviews || []));
  readonly isMine = computed(() => { const v = this.viewer(); const d = this.d(); return !!v && !!d && d.author === v; });
  /** Bumped per PR, so an answer for the previous one is dropped. */
  private gen = 0;

  /** The summary for the PR's current commit: the detail's own, or one the list made since. */
  readonly current = computed(() => {
    const d = this.d();
    const s = this.summary();
    if (s && d && s.sha === d.sha) return s;
    return d?.summary || null;
  });
  readonly checks = computed(() => CHECKS[this.d()?.checks || 'none']);
  readonly decision = computed(() => DECISIONS[this.d()?.decision || ''] || null);
  readonly shownFiles = computed(() => { const f = this.d()?.files || []; return this.allFiles() ? f : f.slice(0, FILES_SHOWN); });

  constructor() {
    effect(() => { this.load(this.repo(), this.number()); });
  }

  rel(t: string): string { return relTime(t); }
  stateLabel(s: string): string { return s.replace(/_/g, ' ').toLowerCase(); }

  private async load(repo: string, n: number): Promise<void> {
    const gen = ++this.gen;
    this.d.set(null);
    this.err.set(null);
    this.sumErr.set(null);
    this.allFiles.set(false);
    // A request for the previous PR may still be out; its finally won't clear these for this one.
    this.summarizing.set(false);
    try {
      const d = await this.api.get<ReviewPrDetail>(`/api/reviews/pr?repo=${encodeURIComponent(repo)}&number=${n}`);
      if (gen !== this.gen) return;
      this.d.set(d);
      if (!this.current()) this.summarize(false);
    } catch (e) {
      if (gen === this.gen) this.err.set((e as Error).message);
    }
  }

  /** Reloads the PR's checks and reviews in place (after posting a review). */
  async refresh(): Promise<void> {
    const gen = this.gen;
    try {
      const d = await this.api.get<ReviewPrDetail>(`/api/reviews/pr?repo=${encodeURIComponent(this.repo())}&number=${this.number()}`);
      if (gen === this.gen) this.d.set(d);
    } catch { /* keep what's shown */ }
  }

  async summarize(force: boolean): Promise<void> {
    const gen = this.gen;
    this.summarizing.set(true);
    this.sumErr.set(null);
    try {
      const s = await this.api.post<ReviewSummary>('/api/reviews/summary', { repo: this.repo(), number: this.number(), force });
      if (gen !== this.gen) return;
      this.summarized.emit(s);
      // A summary for a newer commit means the PR moved: reload all of it (files, checks, the sha
      // that approve and merge are bound to) rather than pairing new text with the old commit.
      if (s.sha === this.d()?.sha) this.d.update((d) => (d ? { ...d, summary: s } : d));
      else this.refresh();
    } catch (e) {
      if (gen === this.gen) this.sumErr.set((e as Error).message);
    } finally {
      if (gen === this.gen) this.summarizing.set(false);
    }
  }
}

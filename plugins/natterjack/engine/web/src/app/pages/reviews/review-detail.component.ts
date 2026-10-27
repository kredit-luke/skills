import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AgentId, MergeMethod, ReviewEvent, ReviewPrDetail, ReviewSubmitted, ReviewSummary } from '../../../../../shared/api';
import { RouterLink } from '@angular/router';
import { usableAgents } from '../../core/agents';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { relTime } from '../../core/util';
import { AgentReviewComponent } from './agent-review.component';
import { mergeBlock, mergeNote, methodLabel, shownReviews } from './reviews.util';

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
  imports: [RouterLink, FormsModule, AgentReviewComponent],
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

        <div class="actions">
          <a class="btn primary sm" [routerLink]="[]" [queryParams]="{ view: 'guide' }" queryParamsHandling="merge">Guided review</a>
          <span class="ask">
            <button class="btn sm" type="button" (click)="askAgent()" [disabled]="agentBusy() || !agents().length" [title]="agents().length ? '' : 'No coding agent is installed and signed in.'">{{ agentBusy() ? 'Reviewing…' : agentDone() ? 'Review again' : 'Ask agent for review' }}</button>
            @if (agents().length > 1) {
              <select class="agent-sel" [ngModel]="agent()" (ngModelChange)="agentPick.set($event)" aria-label="Agent that reviews">
                @for (a of agents(); track a.id) { <option [value]="a.id">{{ a.label }}</option> }
              </select>
            }
          </span>
          <a class="btn ghost sm" [href]="d()!.url" target="_blank" rel="noopener">Open on GitHub</a>
        </div>

        @if (d()!.state === 'OPEN' || merged()) {
        <section class="yours">
          @if (verdict(); as v) {
            <label class="lbl" for="review-text">{{ v === 'APPROVE' ? 'Approve, with a comment (optional)' : 'What needs to change' }}</label>
            <textarea id="review-text" rows="3" [ngModel]="verdictText()" (ngModelChange)="verdictText.set($event)"></textarea>
            <div class="btns">
              <button class="btn sm" type="button" [class.primary]="v === 'APPROVE'" [class.danger]="v === 'REQUEST_CHANGES'" (click)="submitVerdict()" [disabled]="sending() || (v === 'REQUEST_CHANGES' && !verdictText().trim())">{{ sending() ? 'Sending…' : v === 'APPROVE' ? 'Approve on GitHub' : 'Request changes on GitHub' }}</button>
              <button class="btn ghost sm" type="button" (click)="verdict.set(null)" [disabled]="sending()">Cancel</button>
            </div>
          } @else if (merging()) {
            <div class="btns">
              @if (d()!.mergeMethods.length > 1) {
                <select class="agent-sel" [ngModel]="mergeMethod()" (ngModelChange)="mergeMethod.set($event)" aria-label="Merge method">
                  @for (m of d()!.mergeMethods; track m) { <option [value]="m">{{ methodLabel(m) }}</option> }
                </select>
              }
              <button class="btn primary sm" type="button" (click)="merge()" [disabled]="sending()">{{ sending() ? 'Merging…' : 'Confirm ' + methodLabel(mergeMethod()).toLowerCase() }}</button>
              <button class="btn ghost sm" type="button" (click)="merging.set(false)" [disabled]="sending()">Cancel</button>
            </div>
            <p class="faint">Merges commit <span class="mono">{{ d()!.sha.slice(0, 7) }}</span> into {{ d()!.base }} on GitHub{{ d()!.deletesBranch ? ', and GitHub deletes the branch' : '' }}.@if (mergeNote(); as n) { {{ ' ' + n }} }</p>
          } @else if (!merged()) {
            <div class="btns">
              @if (!isMine()) {
                <button class="btn sm" type="button" (click)="startVerdict('APPROVE')">Approve</button>
                <button class="btn sm" type="button" (click)="startVerdict('REQUEST_CHANGES')">Request changes</button>
              }
              <button class="btn sm" type="button" (click)="startMerge()" [disabled]="!!mergeBlock()" [title]="mergeBlock() || ''">Merge…</button>
              @if (mergeBlock(); as b) { <span class="faint">{{ b }}</span> }
            </div>
          }
          @if (verdictErr()) { <p class="err-note">{{ verdictErr() }}</p> }
          @if (verdictDone(); as v) {
            <p class="ok">{{ v.state === 'APPROVED' ? 'Approved' : 'Changes requested' }} on GitHub. @if (v.url) { <a [href]="v.url" target="_blank" rel="noopener">View</a> }</p>
          }
          @if (merged()) { <p class="ok">Merged into {{ d()!.base }}. <a [href]="d()!.url" target="_blank" rel="noopener">View on GitHub</a></p> }
        </section>
        }

        <dash-agent-review [repo]="repo()" [number]="number()" [mine]="isMine()" (submitted)="refresh()" />

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
    .actions, .yours .btns { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .ask { display: inline-flex; align-items: center; gap: 6px; }
    .agent-sel { font: inherit; font-size: 12.5px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); }
    .yours { display: flex; flex-direction: column; gap: 6px; }
    .yours .lbl { font-size: 12.5px; color: var(--ink-soft); }
    .yours textarea { font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; resize: vertical; }
    .yours p { margin: 0; font-size: 13px; }
    .ok { color: var(--green); }
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
  private readonly data = inject(DataService);
  private readonly launch = inject(LaunchService);
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
  private readonly agentReview = viewChild(AgentReviewComponent);
  /** Agents installed and signed in; the one picked here, else the one runs start on. */
  readonly agents = computed(() => usableAgents(this.data.agents()));
  readonly agentPick = signal<AgentId | null>(null);
  readonly agent = computed<AgentId>(() => { const p = this.agentPick(); return p && this.agents().some((a) => a.id === p) ? p : this.launch.agent(); });
  readonly agentBusy = computed(() => !!this.agentReview()?.running());
  /** The review showing is the picked agent's: asking again makes a new one. */
  readonly agentDone = computed(() => this.agentReview()?.review()?.agent === this.agent());
  readonly verdict = signal<ReviewEvent | null>(null);
  readonly verdictText = signal('');
  readonly sending = signal(false);
  readonly verdictErr = signal<string | null>(null);
  readonly verdictDone = signal<ReviewSubmitted | null>(null);
  readonly merging = signal(false);
  readonly merged = signal(false);
  readonly mergeMethod = signal<MergeMethod>('squash');
  readonly shownReviews = computed(() => shownReviews(this.d()?.reviews || []));
  readonly mergeBlock = computed(() => { const d = this.d(); return d ? mergeBlock(d) : null; });
  readonly mergeNote = computed(() => mergeNote(this.d()?.mergeState || ''));
  readonly methodLabel = methodLabel;
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
    this.verdict.set(null);
    this.verdictText.set('');
    this.verdictErr.set(null);
    this.verdictDone.set(null);
    this.merging.set(false);
    this.merged.set(false);
    // A request for the previous PR may still be out; its finally won't clear these for this one.
    this.sending.set(false);
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

  /** Asks the picked agent for a review: a new one when its review is the one showing, else its saved one if it has one. */
  askAgent(): void {
    const id = this.agent();
    const label = this.agents().find((a) => a.id === id)?.label || id;
    this.agentReview()?.run(id, label, this.agentDone());
  }

  startVerdict(v: ReviewEvent): void {
    this.verdict.set(v);
    this.verdictErr.set(null);
    this.verdictDone.set(null);
    this.merging.set(false);
  }

  startMerge(): void {
    this.mergeMethod.set(this.d()?.mergeMethods[0] || 'squash');
    this.verdict.set(null);
    this.verdictErr.set(null);
    this.merging.set(true);
  }

  async merge(): Promise<void> {
    const d = this.d();
    if (!d) return;
    const gen = this.gen;
    this.sending.set(true);
    this.verdictErr.set(null);
    try {
      await this.api.post('/api/reviews/merge', { repo: this.repo(), number: this.number(), method: this.mergeMethod(), sha: d.sha });
      if (gen !== this.gen) return;
      this.merging.set(false);
      this.merged.set(true);
      this.merged$.emit();
    } catch (e) {
      if (gen === this.gen) this.verdictErr.set((e as Error).message);
    } finally {
      if (gen === this.gen) this.sending.set(false);
    }
  }

  async submitVerdict(): Promise<void> {
    const event = this.verdict();
    if (!event) return;
    const gen = this.gen;
    this.sending.set(true);
    this.verdictErr.set(null);
    try {
      const done = await this.api.post<ReviewSubmitted>('/api/reviews/submit', { repo: this.repo(), number: this.number(), event, body: this.verdictText(), sha: this.d()?.sha, comments: [] });
      if (gen !== this.gen) return;
      this.verdictDone.set(done);
      this.verdict.set(null);
      this.verdictText.set('');
      this.refresh();
    } catch (e) {
      if (gen === this.gen) this.verdictErr.set((e as Error).message);
    } finally {
      if (gen === this.gen) this.sending.set(false);
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

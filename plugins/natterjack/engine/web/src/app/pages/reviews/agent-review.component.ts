import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AgentFinding, AgentId, AgentReview, ReviewEvent, ReviewSubmitted } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { relTime } from '../../core/util';
import { commentBody, groupFindings, initialPicks, placeOf } from './agent-review.util';

/**
 * A coding agent's review of a PR on the Reviews page: its findings in four groups (bugs,
 * performance, security, nitpicks), each one pickable and editable, and posting the picked ones
 * to the PR as line comments (or with a request for changes). The detail panel's "Ask agent for
 * review" button calls run(); a saved review for the PR's current commit shows on its own.
 */
@Component({
  selector: 'dash-agent-review',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (running() || review() || err()) {
      <section class="agent" aria-live="polite">
        <h3>Agent review</h3>
        @if (running()) {
          <p class="faint">{{ runningLabel() }} is reviewing the PR… {{ elapsed() }}s</p>
        } @else if (err()) {
          <p class="err-note">Couldn't review: {{ err() }}</p>
        }
        @if (review(); as r) {
          <p class="by"><b>{{ r.agentLabel }}</b> <span class="faint">· {{ rel(r.at) }}</span> — {{ r.summary || 'No summary.' }}</p>
          @if (!r.findings.length) {
            <p class="faint">No problems found.</p>
          }
          @for (g of groups(); track g.id) {
            <h4>{{ g.label }} <span class="n">{{ g.items.length }}</span></h4>
            <ul class="findings">
              @for (f of g.items; track f.id) {
                <li [class.posted]="posted().has(f.id)">
                  <input type="checkbox" [checked]="picked().has(f.id)" [disabled]="posted().has(f.id) || posting()" (change)="toggle(f.id)" [attr.aria-label]="'Post: ' + f.title" />
                  <div class="body">
                    <div class="ttl">
                      @if (f.category !== 'nitpick') { <span class="sev" [class]="f.severity">{{ f.severity }}</span> }
                      <b>{{ f.title }}</b>
                      @if (posted().has(f.id)) { <span class="tag good">Posted</span> }
                    </div>
                    <div class="where">
                      <span class="mono">{{ place(f) || 'The whole PR' }}</span>
                      @if (!f.onDiff) { <span class="faint"> · goes in the review's text, not on a line</span> }
                    </div>
                    @if (editing() === f.id) {
                      <textarea rows="4" [ngModel]="textOf(f)" (ngModelChange)="setText(f.id, $event)" [attr.aria-label]="'Comment for ' + f.title"></textarea>
                      <button class="linkish" type="button" (click)="editing.set(null)">Done</button>
                    } @else {
                      <p>{{ textOf(f) }}</p>
                      @if (!posted().has(f.id)) { <button class="linkish" type="button" (click)="editing.set(f.id)">Edit</button> }
                    }
                  </div>
                </li>
              }
            </ul>
          }
          @if (r.findings.length) {
            <div class="actions">
              <button class="btn primary sm" type="button" (click)="post('COMMENT')" [disabled]="!pickCount() || posting()">{{ posting() ? 'Posting…' : 'Post ' + pickCount() + ' as comments' }}</button>
              @if (!mine()) {
                <button class="btn sm" type="button" (click)="post('REQUEST_CHANGES')" [disabled]="!pickCount() || posting()">Request changes with {{ pickCount() }}</button>
              }
              <span class="faint">Posted as you, on GitHub.</span>
            </div>
          }
          @if (postErr()) { <p class="err-note">Couldn't post: {{ postErr() }}</p> }
          @if (done(); as d) {
            <p class="ok">{{ d.state === 'CHANGES_REQUESTED' ? 'Requested changes with' : 'Posted' }} {{ d.comments }} line {{ d.comments === 1 ? 'comment' : 'comments' }}{{ d.movedToBody ? ' (+' + d.movedToBody + ' in the review text)' : '' }}.
              @if (d.url) { <a [href]="d.url" target="_blank" rel="noopener">View on GitHub</a> }
            </p>
          }
        }
      </section>
    }
  `,
  styles: [`
    .agent { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line-soft); padding-top: 12px; }
    h3 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-faint); font-weight: 600; }
    h4 { margin: 6px 0 0; font-size: 13px; color: var(--ink); }
    h4 .n { font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); margin-left: 4px; }
    p { margin: 0; font-size: 13px; line-height: 1.5; }
    .by { color: var(--ink-soft); }
    .faint { color: var(--ink-faint); }
    .ok { color: var(--green); }
    .mono { font-family: var(--font-mono); }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--line-soft); border-radius: 8px; }
    li.posted { opacity: .7; }
    li > input { margin-top: 3px; }
    .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .ttl { font-size: 13px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; overflow-wrap: anywhere; }
    .where { font-size: 11.5px; color: var(--ink-soft); overflow-wrap: anywhere; }
    .body p { color: var(--ink-soft); white-space: pre-wrap; overflow-wrap: anywhere; }
    textarea { font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; resize: vertical; width: 100%; box-sizing: border-box; }
    .body .linkish { align-self: flex-start; }
    .sev { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; padding: 1px 6px; border-radius: 5px; background: var(--paper-2); }
    .sev.high { background: var(--red-bg); color: var(--red); }
    .sev.medium { background: var(--yellow-bg); color: var(--yellow); }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; }
    .actions .faint { font-size: 12px; }
  `],
})
export class AgentReviewComponent {
  private readonly api = inject(ApiService);
  readonly repo = input.required<string>();
  readonly number = input.required<number>();
  /** The person's own PR: GitHub won't take a request for changes on it. */
  readonly mine = input(false);
  /** After posting: the PR's reviews changed. */
  readonly submitted = output<void>();

  readonly review = signal<AgentReview | null>(null);
  readonly running = signal(false);
  readonly runningLabel = signal('');
  readonly elapsed = signal(0);
  readonly err = signal<string | null>(null);
  readonly picked = signal<Set<string>>(new Set());
  readonly posted = signal<Set<string>>(new Set());
  readonly edits = signal<Record<string, string>>({});
  readonly editing = signal<string | null>(null);
  readonly posting = signal(false);
  readonly postErr = signal<string | null>(null);
  readonly done = signal<ReviewSubmitted | null>(null);
  private gen = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly groups = computed(() => groupFindings(this.review()?.findings || []));
  readonly pickCount = computed(() => [...this.picked()].filter((id) => !this.posted().has(id)).length);

  constructor() {
    effect(() => { this.load(this.repo(), this.number()); });
    inject(DestroyRef).onDestroy(() => this.stopTimer());
  }

  rel(t: string): string { return relTime(t); }
  place(f: AgentFinding): string { return placeOf(f); }
  textOf(f: AgentFinding): string { return this.edits()[f.id] ?? f.text; }
  setText(id: string, text: string): void { this.edits.update((m) => ({ ...m, [id]: text })); }
  toggle(id: string): void { this.picked.update((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  private show(r: AgentReview | null): void {
    this.review.set(r);
    this.picked.set(initialPicks(r?.findings || []));
    this.posted.set(new Set());
    this.edits.set({});
    this.editing.set(null);
    this.done.set(null);
    this.postErr.set(null);
  }

  private async load(repo: string, n: number): Promise<void> {
    const gen = ++this.gen;
    this.stopTimer();
    this.running.set(false);
    this.posting.set(false);
    this.err.set(null);
    this.show(null);
    try {
      const r = await this.api.get<AgentReview | null>(`/api/reviews/agent?repo=${encodeURIComponent(repo)}&number=${n}`);
      if (gen === this.gen && r) this.show(r);
    } catch { /* no saved review */ }
  }

  /** Asks the agent for a new review (force: even when this agent already reviewed this commit). */
  async run(agent: AgentId, label: string, force: boolean): Promise<void> {
    const gen = this.gen;
    this.running.set(true);
    this.runningLabel.set(label);
    this.err.set(null);
    this.elapsed.set(0);
    this.stopTimer();
    const t0 = Date.now();
    this.timer = setInterval(() => this.elapsed.set(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      const r = await this.api.post<AgentReview>('/api/reviews/agent', { repo: this.repo(), number: this.number(), agent, force });
      if (gen === this.gen) this.show(r);
    } catch (e) {
      if (gen === this.gen) this.err.set((e as Error).message);
    } finally {
      if (gen === this.gen) { this.running.set(false); this.stopTimer(); }
    }
  }

  async post(event: ReviewEvent): Promise<void> {
    const r = this.review();
    if (!r) return;
    const picks = r.findings.filter((f) => this.picked().has(f.id) && !this.posted().has(f.id));
    if (!picks.length) return;
    const gen = this.gen;
    this.posting.set(true);
    this.postErr.set(null);
    try {
      const comments = picks.map((f) => ({ path: f.onDiff ? f.file! : (f.file || ''), line: f.onDiff ? f.line! : (f.line || 0), body: commentBody(f, this.textOf(f), r.agentLabel) }));
      const body = event === 'REQUEST_CHANGES' ? `Requesting changes after an agent review (${r.agentLabel}).` : '';
      const done = await this.api.post<ReviewSubmitted>('/api/reviews/submit', { repo: this.repo(), number: this.number(), event, body, sha: r.sha, comments });
      if (gen !== this.gen) return;
      this.done.set(done);
      this.posted.update((s) => new Set([...s, ...picks.map((f) => f.id)]));
      this.submitted.emit();
    } catch (e) {
      if (gen === this.gen) this.postErr.set((e as Error).message);
    } finally {
      if (gen === this.gen) this.posting.set(false);
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

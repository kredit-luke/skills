import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AgentId, MergeMethod, ReviewEvent, ReviewPrDetail, ReviewSubmitted } from '../../../../../shared/api';
import { usableAgents } from '../../core/agents';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { AgentReviewComponent } from './agent-review.component';
import { mergeBlock, mergeNote, methodLabel } from './reviews.util';

/**
 * What a reviewer can do with a pull request, shared by the detail panel and the guided review:
 * ask an agent for a review (its findings show below), approve, request changes, and merge.
 * Content projected in goes at the start of the button row; `[trail]` content at its end.
 */
@Component({
  selector: 'dash-review-actions',
  imports: [FormsModule, AgentReviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="actions">
      <ng-content />
      <span class="ask">
        <button class="btn sm" type="button" (click)="askAgent()" [disabled]="agentBusy() || !agents().length" [title]="agents().length ? '' : 'No coding agent is installed and signed in.'">{{ agentBusy() ? 'Reviewing…' : agentDone() ? 'Review again' : 'Ask agent for review' }}</button>
        @if (agents().length > 1) {
          <select class="agent-sel" [ngModel]="agent()" (ngModelChange)="agentPick.set($event)" aria-label="Agent that reviews">
            @for (a of agents(); track a.id) { <option [value]="a.id">{{ a.label }}</option> }
          </select>
        }
      </span>
      <ng-content select="[trail]" />
    </div>

    @if (d().state === 'OPEN' || merged()) {
    <section class="yours">
      @if (verdict(); as v) {
        <label class="lbl" [for]="textId">{{ v === 'APPROVE' ? 'Approve, with a comment (optional)' : 'What needs to change' }}</label>
        <textarea [id]="textId" rows="3" [ngModel]="verdictText()" (ngModelChange)="verdictText.set($event)"></textarea>
        <div class="btns">
          <button class="btn sm" type="button" [class.primary]="v === 'APPROVE'" [class.danger]="v === 'REQUEST_CHANGES'" (click)="submitVerdict()" [disabled]="sending() || !!hold() || (v === 'REQUEST_CHANGES' && !verdictText().trim())" [title]="hold() || ''">{{ sending() ? 'Sending…' : v === 'APPROVE' ? 'Approve on GitHub' : 'Request changes on GitHub' }}</button>
          <button class="btn ghost sm" type="button" (click)="verdict.set(null)" [disabled]="sending()">Cancel</button>
        </div>
      } @else if (merging()) {
        <div class="btns">
          @if (d().mergeMethods.length > 1) {
            <select class="agent-sel" [ngModel]="mergeMethod()" (ngModelChange)="mergeMethod.set($event)" aria-label="Merge method">
              @for (m of d().mergeMethods; track m) { <option [value]="m">{{ methodLabel(m) }}</option> }
            </select>
          }
          <button class="btn primary sm" type="button" (click)="merge()" [disabled]="sending() || !!hold()" [title]="hold() || ''">{{ sending() ? 'Merging…' : 'Confirm ' + methodLabel(mergeMethod()).toLowerCase() }}</button>
          <button class="btn ghost sm" type="button" (click)="merging.set(false)" [disabled]="sending()">Cancel</button>
        </div>
        <p class="faint">Merges commit <span class="mono">{{ d().sha.slice(0, 7) }}</span> into {{ d().base }} on GitHub{{ d().deletesBranch ? ', and GitHub deletes the branch' : '' }}.@if (mergeNote(); as n) { {{ ' ' + n }} }</p>
      } @else if (!merged()) {
        <div class="btns">
          @if (!mine()) {
            <button class="btn sm" type="button" (click)="startVerdict('APPROVE')" [disabled]="!!hold()" [title]="hold() || ''">Approve</button>
            <button class="btn sm" type="button" (click)="startVerdict('REQUEST_CHANGES')" [disabled]="!!hold()" [title]="hold() || ''">Request changes</button>
          }
          <button class="btn sm" type="button" (click)="startMerge()" [disabled]="!!hold() || !!mergeBlock()" [title]="hold() || mergeBlock() || ''">Merge…</button>
          @if (hold() || mergeBlock(); as b) { <span class="faint">{{ b }}</span> }
        </div>
      }
      @if (verdictErr()) { <p class="err-note">{{ verdictErr() }}</p> }
      @if (verdictDone(); as v) {
        <p class="ok">{{ v.state === 'APPROVED' ? 'Approved' : 'Changes requested' }} on GitHub. @if (v.url) { <a [href]="v.url" target="_blank" rel="noopener">View</a> }</p>
      }
      @if (merged()) { <p class="ok">Merged into {{ d().base }}. <a [href]="d().url" target="_blank" rel="noopener">View on GitHub</a></p> }
    </section>
    }

    <dash-agent-review [repo]="repo()" [number]="number()" [sha]="d().sha" [mine]="mine()" (submitted)="changed.emit()" />
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 14px; }
    .mono { font-family: var(--font-mono); }
    .faint { color: var(--ink-faint); }
    .actions, .yours .btns { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .ask { display: inline-flex; align-items: center; gap: 6px; }
    .agent-sel { font: inherit; font-size: 12.5px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); }
    .yours { display: flex; flex-direction: column; gap: 6px; }
    .yours .lbl { font-size: 12.5px; color: var(--ink-soft); }
    .yours textarea { font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; resize: vertical; }
    .yours p { margin: 0; font-size: 13px; }
    .ok { color: var(--green); }
  `],
})
export class ReviewActionsComponent {
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly launch = inject(LaunchService);
  readonly repo = input.required<string>();
  readonly number = input.required<number>();
  /** The PR as last read: approve and merge are bound to its commit. */
  readonly d = input.required<ReviewPrDetail>({ alias: 'detail' });
  /** The person opened it (their own PRs can't be approved). */
  readonly mine = input(false);
  /** Why approving and merging wait (e.g. the diff shown isn't this commit's yet); null when they don't. */
  readonly hold = input<string | null>(null);
  /** A review was posted: the PR's checks and reviews should be read again. */
  readonly changed = output<void>();
  /** The PR merged. */
  readonly merged$ = output<void>({ alias: 'merged' });

  private static seq = 0;
  readonly textId = `review-text-${++ReviewActionsComponent.seq}`;
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
  readonly mergeBlock = computed(() => mergeBlock(this.d()));
  readonly mergeNote = computed(() => mergeNote(this.d().mergeState || ''));
  readonly methodLabel = methodLabel;
  /** Bumped per PR, so an answer for the previous one is dropped. */
  private gen = 0;

  constructor() {
    // Another PR or a new commit: start clean, so an open approval or merge can't land on code it wasn't
    // opened for. A re-read of the same commit (checks, reviews) keeps it. A request for the previous
    // one may still be out; its finally won't clear these.
    effect(() => {
      this.repo(); this.number(); this.d().sha;
      untracked(() => {
        this.gen++;
        this.verdict.set(null);
        this.verdictText.set('');
        this.verdictErr.set(null);
        this.verdictDone.set(null);
        this.merging.set(false);
        this.merged.set(false);
        this.sending.set(false);
      });
    });
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
    this.mergeMethod.set(this.d().mergeMethods[0] || 'squash');
    this.verdict.set(null);
    this.verdictErr.set(null);
    this.merging.set(true);
  }

  async merge(): Promise<void> {
    const gen = this.gen;
    this.sending.set(true);
    this.verdictErr.set(null);
    try {
      await this.api.post('/api/reviews/merge', { repo: this.repo(), number: this.number(), method: this.mergeMethod(), sha: this.d().sha });
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
      const done = await this.api.post<ReviewSubmitted>('/api/reviews/submit', { repo: this.repo(), number: this.number(), event, body: this.verdictText(), sha: this.d().sha, comments: [] });
      if (gen !== this.gen) return;
      this.verdictDone.set(done);
      this.verdict.set(null);
      this.verdictText.set('');
      this.changed.emit();
    } catch (e) {
      if (gen === this.gen) this.verdictErr.set((e as Error).message);
    } finally {
      if (gen === this.gen) this.sending.set(false);
    }
  }
}

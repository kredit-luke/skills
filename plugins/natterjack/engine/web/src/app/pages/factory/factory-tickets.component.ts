import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import type { FactoryGateResult, FactoryItem, FactoryItemStep, FactoryRatingValue, FactoryStepState, FactoryStepStatus } from '../../../../../shared/api';

const RATING_WORDS: Record<FactoryRatingValue, string> = { right: 'right', 'should-have-asked': 'should have asked a person', 'could-have-approved': 'could have approved' };
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { relTime } from '../../core/util';
import { approverVerdict, checkMark, duration, gateName, guideLink, specLevel } from './factory.util';

const STEP_MARK: Record<FactoryStepState, string> = { done: '✓', running: '●', failed: '✕', waiting: '!', skipped: '–', pending: '○' };
const STEP_WORD: Record<FactoryStepState, string> = { done: 'Done', running: 'Under way', failed: 'Failed', waiting: 'Waiting', skipped: 'Skipped', pending: 'Not reached' };
const ROW_MARK: Record<FactoryStepStatus, string> = { done: '✓', running: '●', failed: '✕', pending: '○', skipped: '–' };
const STATE: Record<FactoryItem['state'], { label: string; cls: string }> = {
  moving: { label: 'Working', cls: 'good' }, waiting: { label: 'Waiting', cls: 'amber' }, failing: { label: 'Failing', cls: 'bad' },
  idle: { label: 'Idle', cls: '' }, done: { label: 'Done', cls: 'good' },
};

/**
 * The Factory's Tickets view: a row per work item with its whole pipeline as a track, and on
 * demand every step's times, per-repo rows (with the pipeline's notes) and gate decisions.
 */
@Component({
  selector: 'dash-factory-tickets',
  imports: [RouterLink, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="items">
      @for (it of items(); track it.ticket) {
        <li class="item" [class]="'item s-' + it.state" [id]="'ticket-' + it.ticket">
          <div class="head">
            <button class="exp" type="button" (click)="toggle(it.ticket)" [attr.aria-expanded]="open().has(it.ticket)" [attr.aria-label]="(open().has(it.ticket) ? 'Hide' : 'Show') + ' details for ' + it.ticket">{{ open().has(it.ticket) ? '▾' : '▸' }}</button>
            @if (it.url) { <a class="tk" [href]="it.url" target="_blank" rel="noopener">{{ it.ticket }}</a> } @else { <span class="tk">{{ it.ticket }}</span> }
            <span class="ttl">{{ it.title || '' }}</span>
            <span class="tag" [class]="state(it).cls">{{ state(it).label }}</span>
            @if (it.reason) { <span class="why">{{ it.reason }}</span> }
            @if (it.spec; as sp) {
              <button class="spec tag" type="button" [class]="'spec tag ' + level(sp.level).cls" (click)="toggle(it.ticket)" [title]="'Spec readiness ' + sp.score + '/100: ' + level(sp.level).label + '. Ready at ' + sp.readyAt + '.'">Spec {{ sp.score }} · {{ level(sp.level).label }}</button>
            }
          </div>
          <div class="meta">
            @if (it.agent) { <span>{{ it.agent }}{{ it.model ? ' · ' + it.model : '' }}</span> }
            <span [title]="it.startedAt">started {{ rel(it.startedAt) }}</span>
            <span>{{ it.mode }}</span>
            @if (it.costUsd || it.budgetUsd) { <span [class.over]="it.budgetUsd != null && it.costUsd > it.budgetUsd">\${{ it.costUsd.toFixed(2) }}{{ it.budgetUsd != null ? ' of $' + it.budgetUsd : '' }}</span> }
            @if (it.risk; as r) { <span class="risk" [class]="'risk ' + r.level" [title]="r.rationale || ''">{{ r.level }} risk</span> }
            @for (p of it.prs; track p.url) {
              <a [href]="p.url" target="_blank" rel="noopener">{{ p.repo || 'PR' }}{{ p.number ? ' #' + p.number : '' }}{{ p.state === 'merged' ? ' (merged)' : '' }}</a>
              @if (guideLink(p); as q) { <a [routerLink]="['/reviews']" [queryParams]="q" title="The PR's guided review on the Reviews page">Guided review</a> }
            }
            @if (it.askingRunId) { <a class="answer" [routerLink]="['/runs', it.askingRunId]">Answer the question</a> }
            @else if (it.runIds.length) { <a [routerLink]="['/runs', it.runIds[0]]">Latest run</a> }
          </div>
          <ol class="track" [attr.aria-label]="it.ticket + ' pipeline'">
            @for (s of it.steps; track s.id) {
              <li class="step" [class]="'step st-' + s.state" [class.gate]="s.kind === 'gate'" [class.cur]="s.current" [title]="tip(s)">
                <span class="mk" aria-hidden="true">{{ mark(s.state) }}</span>{{ s.label }}
                @if (took(s); as d) { <span class="dur">{{ d }}</span> }
              </li>
            }
          </ol>
          @if (it.error) { <p class="err-note">Stopped: {{ it.error }}</p> }

          @if (it.waitingGate; as g) {
            <section class="decide" [attr.aria-label]="'Decide the ' + g.label + ' for ' + it.ticket">
              <p class="ask"><b>Waiting for a decision at the {{ g.label }}</b><span class="faint">since {{ rel(g.since) }}</span>@if (g.reason) { <span class="faint">{{ g.reason }}</span> }</p>
              @if (it.plan) {
                <button class="linkish" type="button" (click)="togglePlan(it.ticket)">{{ plans()[it.ticket] !== undefined ? 'Hide the plan' : 'Read the plan' }}</button>
                @if (plans()[it.ticket]; as p) { <pre class="plan">{{ p }}</pre> }
              }
              @if (it.implementLive) {
                <p class="faint">Its implement run is still going, so this is decided there@if (it.askingRunId) {: <a [routerLink]="['/runs', it.askingRunId]">answer the question</a>}.</p>
              } @else if (canDecide()) {
                <textarea rows="2" [ngModel]="notes()[it.ticket] || ''" (ngModelChange)="setNote(it.ticket, $event)" placeholder="A note for the record (optional; say why when rejecting)" [attr.aria-label]="'Note on the ' + g.label"></textarea>
                <div class="btns">
                  @if (g.id === 'merge') {
                    <button class="btn primary sm" type="button" (click)="decide(it, 'approved', false)" [disabled]="busy() === it.ticket" title="Record the approval; merging happens on the code host">{{ busy() === it.ticket ? 'Saving…' : 'Approve' }}</button>
                  } @else {
                    <button class="btn primary sm" type="button" (click)="decide(it, 'approved', true)" [disabled]="busy() === it.ticket">{{ busy() === it.ticket ? 'Saving…' : 'Approve and continue' }}</button>
                    <button class="btn sm" type="button" (click)="decide(it, 'approved', false)" [disabled]="busy() === it.ticket" title="Record the approval without starting a run now">Approve only</button>
                  }
                  <button class="btn danger sm" type="button" (click)="decide(it, 'rejected', false)" [disabled]="busy() === it.ticket">Reject</button>
                </div>
                @if (g.id === 'merge') { <p class="faint">Merging happens on the code host (or the Reviews page); this records the decision.</p> }
              } @else {
                <p class="faint">Deciding needs full access (Settings → Access).</p>
              }
            </section>
          }

          @if (open().has(it.ticket)) {
            <div class="details">
              <dl>
                @if (it.branch) { <dt>Branch</dt><dd class="mono">{{ it.branch }}</dd> }
                @if (it.workroot) { <dt>Works in</dt><dd class="mono">{{ it.workroot }}</dd> }
                @if (it.plan) { <dt>Plan</dt><dd class="mono">{{ it.plan }}</dd> }
                @if (it.repos.length) { <dt>Repos</dt><dd>@for (r of it.repos; track r.repo) { <span class="repo" [class]="'repo st-' + r.status">{{ r.repo }} {{ rowMark(r.status) }}</span> }</dd> }
                @if (it.runIds.length > 1) { <dt>Runs</dt><dd>@for (id of it.runIds; track id; let i = $index) { <a [routerLink]="['/runs', id]">{{ i === 0 ? 'latest' : '#' + (it.runIds.length - i) }}</a>{{ $last ? '' : ' · ' }} }</dd> }
              </dl>
              @if (it.spec; as sp) {
                <section class="specd">
                  <h3>Spec readiness <span class="tag" [class]="level(sp.level).cls">{{ sp.score }}/100 · {{ level(sp.level).label }}</span>
                    <span class="faint">ready at {{ sp.readyAt }}, needs work from {{ sp.needsWorkAt }}{{ sp.minScore != null ? ', unattended runs need ' + sp.minScore : '' }} · scored {{ rel(sp.at) }}</span></h3>
                  <ul>
                    @for (c of sp.checks; track c.id) {
                      @if (c.weight) {
                        <li><span class="mk" [class.st-done]="c.score >= 1" [class.st-waiting]="c.score > 0 && c.score < 1" [class.st-failed]="!c.score">{{ cmark(c.score) }}</span>
                          <b>{{ c.label }}</b> <span>{{ c.finding }}</span>
                          @if (c.override; as o) { <span class="faint">(the agent changed this from {{ cmark(o.from) }}: {{ o.reason }})</span> }
                        </li>
                      }
                    }
                  </ul>
                </section>
              }
              @if (it.approver; as a) {
                <section class="specd apd">
                  <h3>Approver <span class="risk" [class]="'risk ' + a.level">{{ a.level }} risk</span>
                    <span class="tag" [class]="verdict(a).cls">{{ verdict(a).label }}</span>
                    <span class="faint">{{ a.enforced ? 'decides' : 'advisory' }} · {{ gateName(a.gate) }} gate · {{ rel(a.at) }}{{ a.judged && a.rulesLevel ? ' · it judged ' + a.judged + ', the rules say ' + a.rulesLevel : '' }}</span></h3>
                  @if (a.rationale) { <p class="why">{{ a.rationale }}</p> }
                  @if (a.rules.length) {
                    <ul>@for (r of a.rules; track $index) { <li><span class="risk" [class]="'risk ' + r.level">{{ r.level }}</span> <span>{{ r.detail }}</span></li> }</ul>
                  }
                  @if (a.concerns.length) {
                    <p class="faint">Its concerns</p>
                    <ul>@for (c of a.concerns; track $index) { <li>{{ c }}</li> }</ul>
                  }
                  @if (a.blockers.length) {
                    <p class="faint">Not approved without a person because</p>
                    <ul>@for (b of a.blockers; track $index) { <li>{{ b }}</li> }</ul>
                  } @else if (a.sampled) { <p class="faint">Every condition was met; it was sampled for a person anyway.</p> }
                  <div class="rate">
                    @if (it.approverRating; as r) {
                      <span class="faint">Rated by {{ r.by }}: <b>{{ ratingWord(r.rating) }}</b>{{ r.note ? ' (' + r.note + ')' : '' }}</span>
                    } @else { <span class="faint">Was this call right?</span> }
                    @if (canDecide()) {
                      <button class="linkish" type="button" (click)="rate(it, 'right')" [disabled]="busy() === it.ticket">Right</button>
                      <button class="linkish" type="button" (click)="rate(it, 'should-have-asked')" [disabled]="busy() === it.ticket" title="It let through something a person should have seen">Should have asked a person</button>
                      <button class="linkish" type="button" (click)="rate(it, 'could-have-approved')" [disabled]="busy() === it.ticket" title="It sent something safe to a person">Could have approved</button>
                    }
                  </div>
                </section>
              }
              @if (it.overridable; as o) {
                @if (canDecide() && !it.implementLive) {
                  <section class="specd ovr">
                    <h3>Override</h3>
                    <p class="faint">The {{ gateName(o.gate) }} gate was approved by {{ o.by === 'auto' ? 'its checks' : 'the Approver' }} {{ rel(o.at) }}. Overriding it records your rejection in its history and stops the ticket.</p>
                    <textarea rows="2" [ngModel]="notes()[it.ticket] || ''" (ngModelChange)="setNote(it.ticket, $event)" placeholder="Why (required: it goes in the audit log)" aria-label="Why you're overriding it"></textarea>
                    <div class="btns"><button class="btn danger sm" type="button" (click)="override(it)" [disabled]="busy() === it.ticket || !(notes()[it.ticket] || '').trim()">Override and stop</button></div>
                  </section>
                }
              }
              <table>
                <thead><tr><th>Step</th><th>State</th><th>Started</th><th>Took</th><th>What happened</th></tr></thead>
                <tbody>
                  @for (s of it.steps; track s.id) {
                    @if (s.state !== 'pending' || s.current) {
                      <tr [class.cur]="s.current">
                        <td>{{ s.label }}</td>
                        <td><span class="mk" [class]="'mk st-' + s.state">{{ mark(s.state) }}</span> {{ word(s.state) }}</td>
                        <td class="faint" [title]="s.startedAt || ''">{{ s.startedAt ? rel(s.startedAt) : '' }}</td>
                        <td class="faint">{{ took(s) }}</td>
                        <td>
                          @for (r of s.repos; track $index) {
                            <div class="line"><span class="mk" [class]="'mk st-' + r.status">{{ rowMark(r.status) }}</span> @if (r.repo) { <b>{{ r.repo }}</b> } @if (r.agent) { <span class="faint">{{ r.agent }}</span> } @if (r.note) { — {{ r.note }} }</div>
                          }
                          @for (d of s.decisions; track $index) {
                            <div class="line">{{ d.decision }}@if (d.by) { by <b>{{ d.by }}</b> } @if (d.mode) { <span class="faint">({{ d.mode }})</span> } <span class="faint" [title]="d.at">{{ rel(d.at) }}</span>@if (d.risk) { · <span class="risk" [class]="'risk ' + d.risk">{{ d.risk }} risk</span> }@if (d.rationale) { — {{ d.rationale }} }</div>
                          }
                          @if (!s.repos.length && !s.decisions.length && s.state === 'skipped') { <span class="faint">Not reported; a later step was.</span> }
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
          }
        </li>
      }
    </ul>
  `,
  styles: [`
    .items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .item { background: #fff; border: 1px solid var(--line-soft); border-left: 3px solid var(--line); border-radius: 10px; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .item.s-moving { border-left-color: var(--green); }
    .item.s-waiting { border-left-color: var(--yellow); }
    .item.s-failing { border-left-color: var(--red); }
    .head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .exp { border: 0; background: transparent; cursor: pointer; font-size: 13px; color: var(--ink-soft); padding: 2px 4px; }
    .tk { font-family: var(--font-mono); font-weight: 600; font-size: 13px; }
    .ttl { font-size: 14px; color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
    .why { font-size: 12.5px; color: var(--ink-soft); font-style: italic; }
    .meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ink-faint); padding-left: 26px; }
    .meta .over { color: var(--red); }
    .track { list-style: none; margin: 0; padding: 0 0 0 26px; display: flex; flex-wrap: wrap; gap: 4px; }
    .step { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; padding: 3px 8px; border-radius: 999px; background: var(--paper-2); color: var(--ink-faint); border: 1px solid transparent; white-space: nowrap; }
    .step.gate { border: 1px dashed var(--line); background: transparent; }
    .step.st-done { color: var(--green); }
    .step.st-running { color: var(--brand-700); background: var(--paper-2); font-weight: 600; }
    .step.st-failed { color: var(--red); background: var(--red-bg); }
    .step.st-waiting { color: var(--yellow); background: var(--yellow-bg); font-weight: 600; }
    .step.st-skipped { opacity: .55; text-decoration: line-through; }
    .step.cur { border-color: currentColor; border-style: solid; }
    .dur { font-family: var(--font-mono); font-size: 10.5px; opacity: .8; }
    .details { padding-left: 26px; display: flex; flex-direction: column; gap: 10px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; font-size: 12.5px; }
    dt { color: var(--ink-faint); }
    dd { margin: 0; overflow-wrap: anywhere; }
    .mono { font-family: var(--font-mono); font-size: 12px; }
    .repo { font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: 5px; background: var(--paper-2); margin-right: 4px; }
    .repo.st-done { color: var(--green); }
    .repo.st-failed { color: var(--red); }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint); font-weight: 600; padding: 4px 8px; }
    td { padding: 6px 8px; border-top: 1px solid var(--line-soft); vertical-align: top; }
    tr.cur td { background: var(--paper-2); }
    td:first-child { white-space: nowrap; font-weight: 600; }
    .faint { color: var(--ink-faint); }
    .decide { margin-left: 26px; padding: 10px 12px; border: 1px solid var(--yellow); background: var(--yellow-bg); border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
    .decide .ask { margin: 0; font-size: 13px; display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
    .decide textarea { font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; resize: vertical; background: #fff; }
    .decide .btns { display: flex; flex-wrap: wrap; gap: 8px; }
    .decide .linkish { align-self: flex-start; }
    .plan { margin: 0; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; background: #fff; border: 1px solid var(--line-soft); border-radius: 6px; padding: 10px 12px; }
    .answer { font-weight: 600; }
    @media (max-width: 700px) { .decide { margin-left: 0; } }
    .spec.tag { cursor: pointer; border: 0; font: inherit; font-size: 10.5px; }
    .specd h3 { margin: 0 0 6px; font-size: 12.5px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
    .specd h3 .faint { font-weight: 400; font-size: 12px; }
    .apd p { margin: 4px 0; font-size: 12.5px; }
    .apd ul + p { margin-top: 8px; }
    .apd .rate { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; margin-top: 8px; font-size: 12.5px; }
    .ovr textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; }
    .ovr .btns { margin-top: 6px; }
    .specd ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; }
    .specd li { display: flex; flex-wrap: wrap; gap: 0 6px; align-items: baseline; }
    .line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 5px; }
    .line + .line { margin-top: 3px; }
    .mk.st-done { color: var(--green); }
    .mk.st-failed { color: var(--red); }
    .mk.st-running { color: var(--brand-700); }
    .mk.st-waiting { color: var(--yellow); }
    .risk { text-transform: uppercase; font-size: 10px; font-family: var(--font-mono); padding: 0 5px; border-radius: 4px; background: var(--paper-2); }
    .risk.high { background: var(--red-bg); color: var(--red); }
    .risk.medium { background: var(--yellow-bg); color: var(--yellow); }
    .risk.low { color: var(--green); }
    @media (max-width: 700px) { .meta, .track, .details { padding-left: 0; } table { display: block; overflow-x: auto; } }
  `],
})
export class FactoryTicketsComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly items = input.required<FactoryItem[]>();
  /** The person may decide gates (full access). */
  readonly canDecide = input(false);
  /** A ticket to open and scroll to (?ticket=, e.g. from a Board card). */
  readonly focus = input<string | null>(null);
  readonly open = signal<Set<string>>(new Set());
  readonly notes = signal<Record<string, string>>({});
  /** Plans read so far, by ticket (undefined: not shown). */
  readonly plans = signal<Record<string, string>>({});
  readonly busy = signal<string | null>(null);
  /** A clock for steps still going (the board only changes when something is reported). */
  private readonly now = signal(Date.now());

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
    // Open and scroll to ?ticket= once, when it first shows: not again on every live refresh.
    let handled: string | null = null;
    effect(() => {
      const f = this.focus();
      if (!f || f === handled || !this.items().some((i) => i.ticket === f)) return;
      handled = f;
      this.open.update((s) => new Set([...s, f]));
      setTimeout(() => document.getElementById('ticket-' + f)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    });
  }

  setNote(ticket: string, text: string): void { this.notes.update((m) => ({ ...m, [ticket]: text })); }

  async togglePlan(ticket: string): Promise<void> {
    if (this.plans()[ticket] !== undefined) { this.plans.update((m) => { const { [ticket]: _, ...rest } = m; return rest; }); return; }
    try {
      const p = await this.api.get<{ path: string; text: string }>(`/api/factory/plan?ticket=${encodeURIComponent(ticket)}`);
      this.plans.update((m) => ({ ...m, [ticket]: p.text }));
    } catch (e) { this.toast.error(`Couldn't read the plan: ${(e as Error).message}`); }
  }

  /** Records the decision; approving and continuing starts the ticket's next implement run. */
  async decide(it: FactoryItem, decision: 'approved' | 'rejected', resume: boolean): Promise<void> {
    const g = it.waitingGate;
    if (!g) return;
    this.busy.set(it.ticket);
    try {
      const r = await this.api.post<FactoryGateResult>('/api/factory/gate', { ticket: it.ticket, gate: g.id, decision, note: this.notes()[it.ticket] || '', resume });
      this.setNote(it.ticket, '');
      if (decision === 'rejected') this.toast.show(`Rejected ${it.ticket} at the ${g.label}.`);
      else if (r.run) this.toast.show(`Approved ${it.ticket} at the ${g.label}; a run carries it on.`);
      else if (r.launchError) this.toast.error(`Approved, but no run started: ${r.launchError}`);
      else this.toast.show(`Approved ${it.ticket} at the ${g.label}.`);
    } catch (e) {
      this.toast.error((e as Error).message);
    } finally {
      this.busy.set(null);
    }
  }

  /** A person's verdict on the Approver's latest call (what its override rate is made of). */
  async rate(it: FactoryItem, rating: FactoryRatingValue): Promise<void> {
    const a = it.approver;
    if (!a) return;
    this.busy.set(it.ticket);
    try {
      await this.api.post('/api/factory/rate', { ticket: it.ticket, assessmentAt: a.at, rating });
      this.toast.show(`Thanks: rated the Approver's call on ${it.ticket}.`);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busy.set(null); }
  }

  /** Overrides an automatic approval: recorded as this person's rejection, with why; the ticket stops. */
  async override(it: FactoryItem): Promise<void> {
    const o = it.overridable;
    const note = (this.notes()[it.ticket] || '').trim();
    if (!o || !note) return;
    this.busy.set(it.ticket);
    try {
      await this.api.post<FactoryGateResult>('/api/factory/gate', { ticket: it.ticket, gate: o.gate, override: true, note });
      this.setNote(it.ticket, '');
      this.toast.show(`Overrode the ${gateName(o.gate)} gate on ${it.ticket}; it's stopped.`);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busy.set(null); }
  }

  ratingWord(r: FactoryRatingValue): string { return RATING_WORDS[r]; }

  toggle(ticket: string): void {
    this.open.update((s) => { const n = new Set(s); n.has(ticket) ? n.delete(ticket) : n.add(ticket); return n; });
  }

  state(it: FactoryItem) { return STATE[it.state]; }
  mark(s: FactoryStepState): string { return STEP_MARK[s]; }
  word(s: FactoryStepState): string { return STEP_WORD[s]; }
  rowMark(s: FactoryStepStatus): string { return ROW_MARK[s]; }
  level = specLevel;
  guideLink = guideLink;
  verdict = approverVerdict;
  gateName = gateName;
  cmark = checkMark;
  rel(t: string): string { return relTime(t); }
  took(s: FactoryItemStep): string {
    if (s.state === 'pending' || s.state === 'skipped') return '';
    const d = duration(s.startedAt, s.endedAt, this.now());
    // A decision made the moment it was asked for has no wait worth showing.
    return d === '0s' ? '' : d;
  }
  tip(s: FactoryItemStep): string {
    const t = this.took(s);
    return `${s.label}: ${STEP_WORD[s.state].toLowerCase()}${t ? ` (${t})` : ''}${s.current ? ', current step' : ''}`;
  }
}

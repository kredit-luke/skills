import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { FactoryBoard, FactoryIntake, FactoryItem, FactoryStepStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { FactoryTicketsComponent } from './factory-tickets.component';
import { guideLink, lineLanes, metricLine, specLevel } from './factory.util';

type View = 'tickets' | 'board' | 'line';
const VIEW_KEY = 'natterjack.factory.view';

const MARK: Record<FactoryStepStatus, string> = { done: '✓', running: '●', failed: '✕', pending: '○', skipped: '–' };
const STATE: Record<FactoryItem['state'], { label: string; cls: string }> = {
  moving: { label: 'Working', cls: 'good' },
  waiting: { label: 'Waiting', cls: 'amber' },
  failing: { label: 'Failing', cls: 'bad' },
  idle: { label: 'Idle', cls: '' },
  done: { label: 'Done', cls: 'good' },
};

/**
 * The Factory: agent work from ticket to merged PR. Three views of the same items (?view=,
 * remembered in this browser): Tickets, a row per item with its whole pipeline and the details of
 * each step; Board, a card per item in the column of the first stage or gate it hasn't finished;
 * and Line, a lane per stage and gate showing what's being worked on and what waits there, with the
 * bottleneck marked. Columns come from the policy (Factory policy page); items from what pipelines
 * report. The throughput strip and Pull work in (the policy's intake, up to the WIP limit) sit on top.
 */
@Component({
  selector: 'dash-factory',
  imports: [PageHeaderComponent, RouterLink, FactoryTicketsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dash-page-header eyebrow="Agents" title="Factory" [sub]="api.copy('factorySub', 'Agent work from ticket to merged PR, one card per ticket.')">
      @if (board(); as b) { <span class="ty">{{ b.wip.inFlight }} of {{ b.wip.limit }} in flight{{ b.preset ? ' · ' + b.preset : '' }}@if (b.approverStats.judged) { · <span [title]="b.approverStats.judged + ' of ' + b.approverStats.assessed + ' Approver calls judged by a person: ' + b.approverStats.tooLenient + ' too lenient, ' + b.approverStats.tooStrict + ' too strict'">Approver wrong {{ wrongRate(b.approverStats) }}</span> }</span> }
      <div class="seg" role="group" aria-label="View">
        <button type="button" [class.on]="view() === 'tickets'" [attr.aria-pressed]="view() === 'tickets'" (click)="setView('tickets')">Tickets</button>
        <button type="button" [class.on]="view() === 'board'" [attr.aria-pressed]="view() === 'board'" (click)="setView('board')">Board</button>
        <button type="button" [class.on]="view() === 'line'" [attr.aria-pressed]="view() === 'line'" (click)="setView('line')">Line</button>
      </div>
      <a class="btn ghost sm" href="/api/factory/audit?format=csv" download title="Every gate decision, Approver assessment and rating, as CSV">Audit log</a>
      <a class="btn ghost sm" routerLink="/factory/settings">Policy</a>
    </dash-page-header>

    @if (err() && !board()) { <div class="warn-note">{{ err() }}</div> }
    @else if (!board()) { <div class="empty">Loading…</div> }
    @else {
      @let b = board()!;
      @if (!b.configured) {
        <div class="note">The factory has no policy yet: work reported to it shows below, under the Supervised defaults. <a routerLink="/factory/settings">Set the policy</a></div>
      } @else if (!b.enabled) {
        <div class="note">The factory is off, so nothing picks up tickets for it. Work reported to it still shows. <a routerLink="/factory/settings">Turn it on</a></div>
      }
      @for (e of b.errors; track e) { <div class="warn-note">{{ e }}</div> }
      @if (b.items.length) {
        <div class="metrics" aria-label="Throughput, last 30 days">
          @for (m of metrics(); track m.label) { <span [title]="m.title"><b>{{ m.value }}</b> {{ m.label }}</span> }
        </div>
      }
      @if (b.enabled && b.canDecide) {
        <div class="intake">
          @if (!intake()) {
            <button class="btn sm" type="button" (click)="previewIntake()" [disabled]="pulling()">{{ pulling() ? 'Looking…' : 'Pull work in' }}</button>
            <span class="faint">The policy's intake tickets assigned to you, up to the free WIP slots.</span>
          } @else {
            @let i = intake()!;
            @if (i.error) { <span class="err-note">{{ i.error }}</span> }
            @if (i.note) { <span class="faint">{{ i.note }}</span> }
            @else if (!i.candidates.length) { <span class="faint">Nothing waiting to come in.</span> }
            @else {
              <span>{{ i.candidates.length }} ready: @for (c of i.candidates.slice(0, 8); track c.ticket) { <span class="mono">{{ c.ticket }}</span>{{ $last ? '' : ', ' }} }{{ i.candidates.length > 8 ? '…' : '' }} · {{ i.free }} free {{ i.free === 1 ? 'slot' : 'slots' }}</span>
              <button class="btn primary sm" type="button" (click)="pullIn()" [disabled]="pulling() || !i.free">{{ pulling() ? 'Starting…' : 'Start ' + Math.min(i.free, i.candidates.length) }}</button>
            }
            <button class="linkish" type="button" (click)="intake.set(null)">Close</button>
          }
        </div>
      }

      @if (!b.items.length) {
        <div class="panel empty-board">
          <p><b>Nothing in the factory yet.</b></p>
          <p>A card appears when a pipeline reports a ticket's progress, e.g. <code>/multirepo:implement ENG-123</code> run in this workspace (from Issues, Ask or a terminal).</p>
        </div>
      }

      @if (view() === 'tickets') {
        <dash-factory-tickets [items]="b.items" [canDecide]="b.canDecide" [focus]="focus()" />
      } @else if (view() === 'line') {
        <div class="line" role="list" aria-label="The line">
          @for (l of lanes().lanes; track l.id) {
            <section class="lane" [class.gate]="l.kind === 'gate'" [class.neck]="l.id === lanes().bottleneck" role="listitem" [attr.aria-label]="l.label">
              <h2>{{ l.label }}@if (l.id === lanes().bottleneck) { <span class="tag amber" title="The most work waits here">bottleneck</span> }</h2>
              <div class="slots">
                @for (w of l.working; track w.ticket) { <a class="chip work" [routerLink]="[]" [queryParams]="{ view: 'tickets', ticket: w.ticket }" [title]="w.title || ''">● {{ w.ticket }}{{ w.repos.length ? ' · ' + w.repos.join(', ') : '' }}</a> }
                @for (w of l.waiting; track w.ticket) { <a class="chip wait" [routerLink]="[]" [queryParams]="{ view: 'tickets', ticket: w.ticket }" [title]="w.reason || ''">◷ {{ w.ticket }}</a> }
                @for (w of l.failing; track w.ticket) { <a class="chip fail" [routerLink]="[]" [queryParams]="{ view: 'tickets', ticket: w.ticket }" [title]="w.reason || ''">✕ {{ w.ticket }}</a> }
                @for (w of l.idle; track w.ticket) { <a class="chip" [routerLink]="[]" [queryParams]="{ view: 'tickets', ticket: w.ticket }" title="Not started here yet">○ {{ w.ticket }}</a> }
                @if (!l.working.length && !l.waiting.length && !l.failing.length && !l.idle.length) { <span class="faint">nothing here</span> }
              </div>
            </section>
          }
        </div>
      } @else {
      <div class="board" role="list" aria-label="Pipeline">
        @for (col of b.columns; track col.id) {
          <section class="col" [class.gate]="col.kind === 'gate'" role="listitem" [attr.aria-label]="col.label">
            <h2>{{ col.label }} <span class="n">{{ byColumn()[col.id]?.length || 0 }}</span></h2>
            @for (it of byColumn()[col.id] || []; track it.ticket) {
              <article class="card" [class]="'card s-' + it.state">
                <div class="top">
                  @if (it.url) { <a class="tk mono" [href]="it.url" target="_blank" rel="noopener">{{ it.ticket }}</a> } @else { <span class="tk mono">{{ it.ticket }}</span> }
                  <span class="tag" [class]="state(it).cls">{{ state(it).label }}</span>
                </div>
                @if (it.title) { <div class="ttl">{{ it.title }}</div> }
                @if (it.reason) { <div class="why">{{ it.reason }}</div> }
                @if (it.spec; as sp) { <span class="tag spec" [class]="'tag spec ' + level(sp.level).cls" [title]="'Spec readiness ' + sp.score + '/100'">Spec {{ sp.score }}</span> }
                @if (it.repos.length) {
                  <div class="repos">
                    @for (r of it.repos; track r.repo) {
                      <span class="repo" [class]="'repo st-' + r.status" [title]="r.repo + ': ' + (r.stage || 'not started') + ' ' + r.status">{{ r.repo }} {{ mark(r.status) }}</span>
                    }
                  </div>
                }
                <div class="meta">
                  @if (it.agent) { <span>{{ it.agent }}{{ it.model ? ' · ' + it.model : '' }}</span> }
                  <span [title]="it.startedAt">started {{ rel(it.startedAt) }}</span>
                  @if (it.costUsd || it.budgetUsd) {
                    <span [class.over]="it.budgetUsd != null && it.costUsd > it.budgetUsd">\${{ it.costUsd.toFixed(2) }}{{ it.budgetUsd != null ? ' / $' + it.budgetUsd : '' }}</span>
                  }
                  @if (it.risk; as r) { <span class="risk" [class]="'risk ' + r.level" [title]="it.approver ? it.approver.reason : (r.rationale || '')">{{ r.level }} risk{{ it.approver?.wouldApprove && !it.approver?.enforced ? ' · would approve' : '' }}</span> }
                </div>
                @if (it.waitingGate; as g) { <a class="decide-link" [routerLink]="[]" [queryParams]="{ view: 'tickets', ticket: it.ticket }">Decide the {{ g.label.toLowerCase() }}</a> }
                @if (it.prs.length || it.runIds.length) {
                  <div class="links">
                    @for (p of it.prs; track p.url) {
                      <a [href]="p.url" target="_blank" rel="noopener">{{ p.repo || 'PR' }}{{ p.number ? ' #' + p.number : '' }}{{ p.state === 'merged' ? ' (merged)' : '' }}</a>
                      @if (guideLink(p); as q) { <a [routerLink]="['/reviews']" [queryParams]="q" title="The PR's guided review on the Reviews page">Guided review</a> }
                    }
                    @if (it.runIds.length) { <a [routerLink]="['/runs', it.runIds[0]]">Latest run</a> }
                  </div>
                }
              </article>
            }
          </section>
        }
      </div>
      }
    }
  `,
  styles: [`
    .note { margin-bottom: 12px; font-size: 13px; color: var(--ink-soft); background: var(--paper-2); border: 1px solid var(--line-soft); border-radius: 8px; padding: 10px 12px; }
    .empty-board { padding: 14px 16px; margin-bottom: 12px; font-size: 13px; color: var(--ink-soft); }
    .empty-board p { margin: 0 0 4px; }
    .board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(230px, 1fr); gap: 10px; overflow-x: auto; padding-bottom: 8px; align-items: start; }
    .col { background: var(--paper-2); border-radius: 10px; padding: 8px; min-height: 120px; display: flex; flex-direction: column; gap: 8px; }
    .col.gate { background: transparent; border: 1px dashed var(--line); }
    h2 { margin: 2px 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint); font-weight: 600; display: flex; justify-content: space-between; }
    .n { font-family: var(--font-mono); }
    .card { background: #fff; border: 1px solid var(--line-soft); border-left: 3px solid var(--line); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; min-width: 0; }
    .card.s-moving { border-left-color: var(--green); }
    .card.s-waiting { border-left-color: var(--yellow); }
    .card.s-failing { border-left-color: var(--red); }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .tk { font-weight: 600; font-size: 12px; }
    .mono { font-family: var(--font-mono); }
    .ttl { color: var(--ink); line-height: 1.35; overflow-wrap: anywhere; }
    .why { color: var(--ink-soft); font-style: italic; }
    .repos { display: flex; flex-wrap: wrap; gap: 4px; }
    .repo { font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: 5px; background: var(--paper-2); color: var(--ink-soft); }
    .repo.st-done { color: var(--green); }
    .repo.st-running { color: var(--brand-700); }
    .repo.st-failed { color: var(--red); background: var(--red-bg); }
    .meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11.5px; color: var(--ink-faint); }
    .meta .over { color: var(--red); }
    .risk { text-transform: uppercase; font-size: 10px; font-family: var(--font-mono); padding: 0 5px; border-radius: 4px; background: var(--paper-2); }
    .risk.high { background: var(--red-bg); color: var(--red); }
    .risk.medium { background: var(--yellow-bg); color: var(--yellow); }
    .risk.low { color: var(--green); }
    .links { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; }
    .spec { align-self: flex-start; font-size: 10.5px; }
    .decide-link { font-size: 12px; font-weight: 600; }
    .metrics { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.5px; color: var(--ink-soft); margin-bottom: 10px; }
    .metrics b { color: var(--ink); font-family: var(--font-mono); }
    .intake { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 12px; font-size: 12.5px; }
    .line { display: flex; flex-direction: column; gap: 6px; }
    .lane { display: grid; grid-template-columns: 160px 1fr; gap: 10px; align-items: center; background: var(--paper-2); border-radius: 8px; padding: 6px 10px; }
    .lane.gate { background: transparent; border: 1px dashed var(--line); }
    .lane.neck { box-shadow: inset 3px 0 0 var(--yellow); }
    .lane h2 { margin: 0; display: flex; gap: 6px; align-items: center; justify-content: flex-start; }
    .slots { display: flex; flex-wrap: wrap; gap: 6px; min-height: 22px; align-items: center; }
    .chip { font-family: var(--font-mono); font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: #fff; border: 1px solid var(--line-soft); text-decoration: none; color: var(--ink); }
    .chip.work { border-color: var(--green); }
    .chip.wait { border-color: var(--yellow); }
    .chip.fail { border-color: var(--red); color: var(--red); }
    @media (max-width: 640px) { .lane { grid-template-columns: 1fr; } }
  `],
})
export class FactoryComponent implements OnInit {
  readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap);
  /** ?view=, else the one picked last in this browser, else Tickets. */
  /** ?ticket=: open that ticket's row (from a Board card's Decide link). */
  readonly focus = computed(() => this.query()?.get('ticket') || null);
  readonly view = computed<View>(() => {
    const q = this.query()?.get('view');
    if (q === 'board' || q === 'tickets' || q === 'line') return q;
    try { const v = localStorage.getItem(VIEW_KEY); return v === 'board' || v === 'line' ? v : 'tickets'; } catch { return 'tickets'; }
  });
  private readonly loaded = signal<FactoryBoard | null>(null);
  readonly err = signal<string | null>(null);

  /** The live topic once it has sent the board, else what this page loaded. */
  readonly board = computed(() => this.data.factory() || this.loaded());
  readonly byColumn = computed(() => {
    const out: Record<string, FactoryItem[]> = {};
    for (const it of this.board()?.items || []) (out[it.column] ||= []).push(it);
    return out;
  });

  readonly lanes = computed(() => lineLanes(this.board()?.columns || [], this.board()?.items || []));
  readonly metrics = computed(() => { const b = this.board(); return b ? metricLine(b.metrics) : []; });
  readonly intake = signal<FactoryIntake | null>(null);
  readonly pulling = signal(false);
  private readonly toast = inject(ToastService);
  readonly Math = Math;

  async previewIntake(): Promise<void> {
    this.pulling.set(true);
    try { this.intake.set(await this.api.get<FactoryIntake>('/api/factory/intake')); }
    catch (e) { this.toast.error((e as Error).message); }
    finally { this.pulling.set(false); }
  }

  /** Starts implement runs for the intake's tickets, up to the free slots. */
  async pullIn(): Promise<void> {
    this.pulling.set(true);
    try {
      const r = await this.api.post<{ started: { ticket: string }[]; stopped: string | null }>('/api/factory/intake', {});
      if (r.started.length) this.toast.show(`Started ${r.started.map((s) => s.ticket).join(', ')}.${r.stopped ? ' ' + r.stopped : ''}`);
      else this.toast.error(r.stopped || 'Nothing started.');
      this.intake.set(null);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.pulling.set(false); }
  }

  async ngOnInit(): Promise<void> {
    try { this.loaded.set(await this.api.get<FactoryBoard>('/api/factory')); }
    catch (e) { this.err.set((e as Error).message); }
  }

  setView(v: View): void {
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ }
    this.router.navigate([], { queryParams: { view: v }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  state(it: FactoryItem) { return STATE[it.state]; }
  mark(s: FactoryStepStatus): string { return MARK[s]; }
  level = specLevel;
  guideLink = guideLink;
  /** Of the Approver's calls a person judged, the share they said were wrong (too lenient matters most). */
  wrongRate(s: { judged: number; tooLenient: number; tooStrict: number }): string {
    const wrong = s.tooLenient + s.tooStrict;
    return `${Math.round((wrong / s.judged) * 100)}% (${wrong}/${s.judged}${s.tooLenient ? `, ${s.tooLenient} too lenient` : ''})`;
  }
  rel(t: string): string { return relTime(t); }
}

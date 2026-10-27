import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { FactoryBoard, FactoryItem, FactoryStepStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { FactoryTicketsComponent } from './factory-tickets.component';
import { specLevel } from './factory.util';

type View = 'tickets' | 'board';
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
 * The Factory: agent work from ticket to merged PR, read-only for now. Two views of the same items
 * (?view=, remembered in this browser): Tickets, a row per item with its whole pipeline and the
 * details of each step; and Board, a card per item in the column of the first stage or gate it
 * hasn't finished, which shows where work piles up. Columns come from the policy (Factory policy
 * page); items from what pipelines report.
 */
@Component({
  selector: 'dash-factory',
  imports: [PageHeaderComponent, RouterLink, FactoryTicketsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dash-page-header eyebrow="Agents" title="Factory" [sub]="api.copy('factorySub', 'Agent work from ticket to merged PR, one card per ticket.')">
      @if (board(); as b) { <span class="ty">{{ b.wip.inFlight }} of {{ b.wip.limit }} in flight{{ b.preset ? ' · ' + b.preset : '' }}</span> }
      <div class="seg" role="group" aria-label="View">
        <button type="button" [class.on]="view() === 'tickets'" [attr.aria-pressed]="view() === 'tickets'" (click)="setView('tickets')">Tickets</button>
        <button type="button" [class.on]="view() === 'board'" [attr.aria-pressed]="view() === 'board'" (click)="setView('board')">Board</button>
      </div>
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

      @if (!b.items.length) {
        <div class="panel empty-board">
          <p><b>Nothing in the factory yet.</b></p>
          <p>A card appears when a pipeline reports a ticket's progress, e.g. <code>/multirepo:implement ENG-123</code> run in this workspace (from Issues, Ask or a terminal).</p>
        </div>
      }

      @if (view() === 'tickets') {
        <dash-factory-tickets [items]="b.items" />
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
                  @if (it.risk; as r) { <span class="risk" [class]="'risk ' + r.level" [title]="r.rationale || ''">{{ r.level }} risk</span> }
                </div>
                @if (it.prs.length || it.runIds.length) {
                  <div class="links">
                    @for (p of it.prs; track p.url) {
                      <a [href]="p.url" target="_blank" rel="noopener">{{ p.repo || 'PR' }}{{ p.number ? ' #' + p.number : '' }}{{ p.state === 'merged' ? ' (merged)' : '' }}</a>
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
  `],
})
export class FactoryComponent implements OnInit {
  readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap);
  /** ?view=, else the one picked last in this browser, else Tickets. */
  readonly view = computed<View>(() => {
    const q = this.query()?.get('view');
    if (q === 'board' || q === 'tickets') return q;
    try { return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'tickets'; } catch { return 'tickets'; }
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
  rel(t: string): string { return relTime(t); }
}

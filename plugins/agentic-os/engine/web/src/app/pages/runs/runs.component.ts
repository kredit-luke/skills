import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { RunMeta } from '../../../../../shared/api';
import { DataService } from '../../core/data.service';
import { dur, lsGet, lsSet, pct } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { RunRowComponent } from '../../shared/run-row.component';
import { toReview } from '../../shared/run-status';
import { RunDetailComponent } from './run-detail.component';

/** Status chips. Selecting several shows runs matching any of them; none selected = all. */
const CHIPS: { key: string; label: string; test: (r: RunMeta) => boolean }[] = [
  { key: 'flagged', label: 'Flagged', test: (r) => !!r.flagged },
  { key: 'running', label: 'Running', test: (r) => r.status === 'running' },
  { key: 'waiting', label: 'Needs answer', test: (r) => r.status === 'waiting' },
  { key: 'review', label: 'To review', test: (r) => toReview(r) },
  { key: 'succeeded', label: 'Done', test: (r) => r.status === 'succeeded' },
  { key: 'failed', label: 'Failed', test: (r) => r.status === 'failed' || r.status === 'interrupted' },
  { key: 'cancelled', label: 'Cancelled', test: (r) => r.status === 'cancelled' },
  { key: 'handedOff', label: 'In terminal', test: (r) => r.status === 'handedOff' },
  { key: 'unrated', label: 'Unrated', test: (r) => !['running', 'waiting'].includes(r.status) && !r.verdict },
];
const FOCUS = ['flagged', 'running', 'waiting', 'review'];
const KEYS = new Set(CHIPS.map((c) => c.key));
const parse = (s: string | null | undefined) => new Set(String(s || '').split(',').map((x) => x.trim()).filter((x) => KEYS.has(x)));

@Component({
  selector: 'dash-runs',
  imports: [PageHeaderComponent, RunRowComponent, RunDetailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './runs.component.scss',
  template: `
    <dash-page-header eyebrow="Runs" title="Runs" sub="Every headless Claude run: live transcript, subagents, questions it asks you, and replies." />
    <div class="runs-layout">
      <div class="col">
        <div class="panel">
          <div class="panel-h"><h2>History</h2><span class="shown">{{ list().length }} of {{ data.runs().length }}</span></div>
          <div class="chips" role="group" aria-label="Filter runs by status">
            <button type="button" class="chip preset" [class.on]="isFocus()" (click)="setFilter(isFocus() ? [] : focus)" title="Only what needs you now: flagged, running, waiting for an answer, and finished in the last day but not rated yet">Focus</button>
            <button type="button" class="chip" [class.on]="!selected().size" (click)="setFilter([])">All</button>
            <span class="sep"></span>
            @for (c of chips(); track c.key) {
              <button type="button" class="chip" [class.on]="selected().has(c.key)" [attr.aria-pressed]="selected().has(c.key)" (click)="toggle(c.key)">
                {{ c.label }} <span class="n" [class.hot]="c.hot">{{ c.count }}</span>
              </button>
            }
          </div>
          <div class="panel-b runs-list">
            @for (r of list(); track r.id) { <dash-run-row [run]="r" [selected]="r.id === selectedId()" [keepQuery]="true" /> }
            @empty { <div class="empty">{{ selected().size ? 'Nothing here right now.' : 'No runs yet.' }}</div> }
          </div>
        </div>
        <div class="panel">
          <div class="panel-h"><h2>Track record</h2></div>
          @if (trust().length) {
            <table class="trust-table">
              <tr><th>Preset</th><th>Runs</th><th>OK</th><th>Good</th><th>Avg time</th></tr>
              @for (t of trust(); track t.id) {
                <tr><td>{{ t.label }}</td><td>{{ t.runs }}</td><td>{{ t.ok }}</td><td>{{ t.good }}</td><td>{{ t.avg }}</td></tr>
              }
            </table>
          } @else { <div class="empty">No finished runs yet.</div> }
          <div class="hint">Verdicts are yours: mark each finished run <b>good</b> or <b>needed fix</b>. A preset earns more autonomy once it has a real record.</div>
        </div>
      </div>
      <div class="detail-col">
        @if (selectedId(); as id) {
          <dash-run-detail [runId]="id" />
        } @else {
          <div class="panel"><div class="empty" style="padding:3rem">Select a run.</div></div>
        }
      </div>
    </div>
  `,
})
export class RunsComponent {
  readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** Route param (/runs/:id), bound via withComponentInputBinding. */
  readonly id = input<string | undefined>(undefined);
  readonly focus = FOCUS;
  /** Selected status chips: from the URL (?status=running,waiting) if present, else the last choice. */
  readonly selected = signal<Set<string>>(parse(this.route.snapshot.queryParamMap.get('status') ?? lsGet('dash.runs.status', '')));
  readonly isFocus = computed(() => this.selected().size === FOCUS.length && FOCUS.every((k) => this.selected().has(k)));
  readonly chips = computed(() => CHIPS.map((c) => {
    const count = this.data.runs().filter(c.test).length;
    return { key: c.key, label: c.label, count, hot: (c.key === 'waiting' || c.key === 'running' || c.key === 'flagged') && count > 0 };
  }));

  readonly selectedId = computed(() => this.id() || null);
  readonly list = computed(() => {
    const sel = this.selected();
    if (!sel.size) return this.data.runs();
    const tests = CHIPS.filter((c) => sel.has(c.key)).map((c) => c.test);
    const hits = this.data.runs().filter((r) => tests.some((t) => t(r)));
    // In a filtered view, flagged runs come first (stable, so newest-first holds within each group).
    return [...hits.filter((r) => r.flagged), ...hits.filter((r) => !r.flagged)];
  });
  readonly trust = computed(() => {
    const stats = this.data.stats();
    const rows = (this.data.deck()?.presets || []).map((p) => ({ id: p.id, label: p.label, s: stats[p.id] }));
    if (stats['_adhoc']) rows.push({ id: '_adhoc', label: 'Ad-hoc', s: stats['_adhoc'] });
    return rows.filter((r) => r.s).map((r) => ({
      id: r.id, label: r.label, runs: r.s.runs, ok: pct(r.s.succeeded, r.s.runs),
      good: r.s.rated ? r.s.good + '/' + r.s.rated : '—', avg: dur(r.s.durationMs / r.s.runs),
    }));
  });

  constructor() {
    // Open the newest run when none is selected (replaceUrl so Back still works).
    effect(() => {
      if (this.id()) return;
      const first = this.list()[0] || this.data.runs()[0];
      if (first) this.router.navigate(['/runs', first.id], { replaceUrl: true, queryParamsHandling: 'preserve' });
    });
  }

  toggle(key: string): void {
    const s = new Set(this.selected());
    if (s.has(key)) s.delete(key); else s.add(key);
    this.setFilter([...s]);
  }

  /** Keeps the choice in localStorage and the URL (bookmarkable). The open run stays open even if filtered out. */
  setFilter(keys: string[]): void {
    const s = new Set(keys.filter((k) => KEYS.has(k)));
    this.selected.set(s);
    const csv = CHIPS.map((c) => c.key).filter((k) => s.has(k)).join(',');
    lsSet('dash.runs.status', csv);
    this.router.navigate([], { relativeTo: this.route, queryParams: { status: csv || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }
}

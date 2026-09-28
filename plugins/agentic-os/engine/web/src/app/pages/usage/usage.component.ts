import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import type { TokenCounts, UsageHistoryResponse, UsageMeter, UsageReport } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { FAMILY_COLORS, STATUS_COLORS, compact, familyOf, modelColor } from '../../core/palette';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { esc, relTime } from '../../core/util';
import { BarChartComponent, type BarSeries, LineChartComponent, type LineSeries } from '../../shared/charts';
import { PageHeaderComponent } from '../../shared/page-header.component';

type Metric = 'all' | 'output' | 'input' | 'cacheRead' | 'requests';
const METRICS: { id: Metric; label: string; hint: string }[] = [
  { id: 'all', label: 'All tokens', hint: 'Input, output, cache reads and cache writes' },
  { id: 'output', label: 'Output', hint: 'Tokens Claude wrote' },
  { id: 'input', label: 'Input', hint: 'New input tokens plus cache writes (what a turn adds to the context)' },
  { id: 'cacheRead', label: 'Cache reads', hint: 'Context re-read from the prompt cache: usually most of the volume in long sessions' },
  { id: 'requests', label: 'Requests', hint: 'Model calls' },
];
const RUN_STATUSES = ['succeeded', 'waiting', 'failed', 'interrupted', 'cancelled', 'handedOff', 'running'];

function pick(c: TokenCounts, m: Metric): number {
  switch (m) {
    case 'output': return c.output;
    case 'input': return c.input + c.cacheWrite;
    case 'cacheRead': return c.cacheRead;
    case 'requests': return c.requests;
    default: return c.input + c.output + c.cacheRead + c.cacheWrite;
  }
}

@Component({
  selector: 'dash-usage',
  imports: [PageHeaderComponent, BarChartComponent, LineChartComponent, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './usage.component.scss',
  template: `
    <dash-page-header eyebrow="Claude" title="Usage" sub="Your plan limits, where your tokens go, and what the dashboard ran. Covers Claude Code on this machine; claude.ai and other devices aren't included.">
      <span class="seg">@for (d of [7, 30, 90]; track d) { <button type="button" [class.on]="days() === d" (click)="setDays(d)">{{ d }} days</button> }</span>
      <button class="btn ghost sm" (click)="refresh()" [disabled]="busy()">{{ busy() ? 'Reading…' : 'Refresh' }}</button>
    </dash-page-header>

    <!-- Plan limits -->
    <div class="stats">
      @for (m of meters(); track m.label) {
        <div class="stat-card" [title]="m.label + (cap(m) ? ' · new runs pause at ' + cap(m) + '%' : '')">
          <div class="k">{{ m.label }}</div>
          <div class="v">{{ m.pct }}%<small>used</small></div>
          <div [class]="meterCls(m)"><i [style.width.%]="m.pct > 100 ? 100 : m.pct"></i></div>
          @if (m.resets) { <div class="reset">resets {{ m.resets }}</div> }
        </div>
      } @empty {
        <div class="stat-card"><div class="k">Plan limits</div><div class="v">—<small>{{ report()?.error || 'reading /usage…' }}</small></div></div>
      }
      <div class="stat-card"><div class="k">Tokens · {{ days() }} days</div><div class="v">{{ fmt(totalTokens()) }}<small>{{ fmt(hist()?.tokens?.totals?.requests || 0) }} requests</small></div>
        <div class="extra">{{ fmt(hist()?.tokens?.totals?.output || 0) }} output</div></div>
      <div class="stat-card"><div class="k">Active days</div><div class="v">{{ activeDays() }}<small>/ {{ days() }}</small></div>
        <div class="extra">{{ sessions() }} sessions</div></div>
    </div>

    <div class="panel">
      <div class="panel-h"><h2>Plan limits over time</h2><span class="ty">{{ report()?.plan || '' }}</span></div>
      <div class="panel-b chart-b">
        @if (limitSeries().length) {
          <dash-line-chart [series]="limitSeries()" [from]="limitFrom()" [to]="now()" [threshold]="pauseAt()" [thresholdLabel]="'runs pause at ' + pauseAt() + '%'" ariaLabel="Session and weekly usage over time" />
          <div class="legend">@for (s of limitSeries(); track s.key) { <span><i [style.background]="s.color"></i>{{ s.label }}</span> }</div>
        } @else {
          <div class="empty">Readings build up from here: the dashboard records /usage whenever it changes (it reads it every couple of minutes while running).</div>
        }
      </div>
    </div>

    <div class="panel">
      <div class="panel-h"><h2>Tokens per day</h2>
        <span class="seg">@for (m of metrics; track m.id) { <button type="button" [class.on]="metric() === m.id" (click)="metric.set(m.id)" [title]="m.hint">{{ m.label }}</button> }</span>
      </div>
      <div class="panel-b chart-b">
        @if (!hist()) { <div class="empty">{{ error() || 'Indexing your Claude Code sessions (a few seconds the first time)…' }}</div> }
        @else {
          <dash-bar-chart [labels]="dayLabels()" [series]="modelSeries()" [values]="dayValues()" ariaLabel="Tokens per day by model" />
          <div class="legend">@for (s of modelSeries(); track s.key) { <span><i [style.background]="s.color"></i>{{ s.label }}</span> }</div>
        }
      </div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="panel-h"><h2>By model</h2><span class="ty">{{ metricLabel() }}</span></div>
        <table class="tbl">
          <tr><th>Model</th><th class="num">Requests</th><th class="num">Output</th><th class="num">All tokens</th><th class="bar-col">Share</th></tr>
          @for (m of byModel(); track m.model) {
            <tr><td><i class="dot" [style.background]="m.color"></i>{{ m.model }}</td><td class="num">{{ fmt(m.requests) }}</td><td class="num">{{ fmt(m.output) }}</td>
              <td class="num">{{ fmt(m.all) }}</td><td class="bar-col"><span class="share"><i [style.width.%]="m.share" [style.background]="m.color"></i></span><span class="pct">{{ m.share.toFixed(0) }}%</span></td></tr>
          } @empty { <tr><td colspan="5" class="empty">No usage in this range.</td></tr> }
        </table>
      </div>
      <div class="panel">
        <div class="panel-h"><h2>By project</h2><span class="ty">{{ metricLabel() }} · top {{ byProject().length }}</span></div>
        <table class="tbl">
          @for (p of byProject(); track p.project) {
            <tr><td class="proj">{{ p.project }}</td><td class="num">{{ fmt(p.value) }}</td>
              <td class="bar-col wide"><span class="share">@for (s of p.segs; track s.model) { <i [style.width.%]="s.pct" [style.background]="s.color" [title]="s.model"></i> }</span></td></tr>
          } @empty { <tr><td colspan="3" class="empty">No usage in this range.</td></tr> }
        </table>
      </div>
    </div>

    <div class="grid2">
      <div class="panel">
        <div class="panel-h"><h2>When you use Claude</h2><span class="ty">requests by hour of day · {{ days() }} days</span></div>
        <div class="panel-b chart-b">
          <dash-bar-chart [labels]="hourLabels" [series]="hourSeries" [values]="hourValues()" [labelEvery]="3" ariaLabel="Requests by hour of day" />
        </div>
      </div>
      <div class="panel">
        <div class="panel-h"><h2>What's using your limits</h2><span class="ty">from /usage</span></div>
        <div class="panel-b">
          @if (report(); as u) {
            @for (b of u.insights || []; track b.title) {
              <div class="usage-block"><div class="t">{{ b.title }}</div><ul>@for (it of b.items; track $index) { <li [innerHTML]="insight(it) | trustedHtml"></li> }</ul></div>
            } @empty { <div class="empty">{{ u.error || 'No breakdown yet.' }}</div> }
            @if (u.fetchedAt) { <div class="hint">Read {{ rel(u.fetchedAt) }}.</div> }
          } @else { <div class="empty">Reading /usage…</div> }
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-h"><h2>Dashboard runs per day</h2><span class="ty">{{ runTotal() }} runs · {{ runTurns() }} turns</span></div>
      <div class="panel-b chart-b">
        <dash-bar-chart [labels]="runLabels()" [series]="runSeries()" [values]="runValues()" [format]="int" ariaLabel="Dashboard runs per day by outcome" />
        <div class="legend">@for (s of runSeries(); track s.key) { <span><i [style.background]="s.color"></i>{{ s.label }}</span> }</div>
      </div>
    </div>

    <div class="hint foot">Tokens come from Claude Code's session files on this machine (every session, not only dashboard runs), deduplicated per request. On a subscription they aren't billed; the plan limits above are what count.
      @if (hist()?.tokens; as t) { Indexed {{ t.files }} session files{{ t.firstScanMs ? ' (first scan ' + (t.firstScanMs / 1000).toFixed(1) + 's)' : '' }}. }</div>
  `,
})
export class UsageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  readonly metrics = METRICS;
  readonly days = signal(30);
  readonly metric = signal<Metric>('all');
  readonly hist = signal<UsageHistoryResponse | null>(null);
  readonly report = signal<UsageReport | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly now = signal(Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly meters = computed<UsageMeter[]>(() => this.report()?.meters || []);
  readonly pauseAt = computed(() => this.data.overview()?.stats?.pauseAtWeeklyPct ?? 90);
  readonly metricLabel = computed(() => METRICS.find((m) => m.id === this.metric())!.label);

  readonly totalTokens = computed(() => { const t = this.hist()?.tokens?.totals; return t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0; });
  readonly activeDays = computed(() => (this.hist()?.tokens?.days || []).filter((d) => Object.keys(d.byModel).length).length);
  readonly sessions = computed(() => (this.hist()?.tokens?.days || []).reduce((a, d) => a + d.sessions, 0));

  /** Models present in range, ordered by volume, each with its family colour (shaded per version). */
  private readonly modelOrder = computed(() => {
    const seen: Record<string, number> = {};
    return (this.hist()?.tokens?.models || []).map((m) => {
      const fam = familyOf(m.model);
      const idx = seen[fam] = (seen[fam] ?? -1) + 1;
      return { model: m.model, color: modelColor(m.model, idx) };
    });
  });
  readonly modelSeries = computed<BarSeries[]>(() => [...this.modelOrder()].reverse().map((m) => ({ key: m.model, label: short(m.model), color: m.color })));
  readonly dayLabels = computed(() => (this.hist()?.tokens?.days || []).map((d) => dayLabel(d.date)));
  readonly dayValues = computed(() => (this.hist()?.tokens?.days || []).map((d) => this.modelSeries().map((s) => (d.byModel[s.key] ? pick(d.byModel[s.key], this.metric()) : 0))));

  readonly byModel = computed(() => {
    const models = this.hist()?.tokens?.models || [];
    const colors = new Map(this.modelOrder().map((m) => [m.model, m.color]));
    const sum = models.reduce((a, m) => a + pick(m, this.metric()), 0) || 1;
    return models.map((m) => ({ model: m.model, color: colors.get(m.model) || FAMILY_COLORS['other'], requests: m.requests, output: m.output,
      all: m.input + m.output + m.cacheRead + m.cacheWrite, share: (pick(m, this.metric()) / sum) * 100 }));
  });
  readonly byProject = computed(() => {
    const colors = new Map(this.modelOrder().map((m) => [m.model, m.color]));
    const list = (this.hist()?.tokens?.projects || []).slice(0, 10);
    const max = Math.max(1, ...list.map((p) => pick(p, this.metric())));
    return list.map((p) => {
      const value = pick(p, this.metric());
      const modelTotal = Object.values(p.models).reduce((a, b) => a + b, 0) || 1;
      // Bar length = this project's value relative to the largest; split by model share.
      return { project: p.project, value, segs: Object.entries(p.models).sort((a, b) => b[1] - a[1])
        .map(([model, v]) => ({ model, color: colors.get(model) || FAMILY_COLORS['other'], pct: (v / modelTotal) * (value / max) * 100 })) };
    });
  });

  readonly hourLabels = Array.from({ length: 24 }, (_, h) => (h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : h - 12 + 'p'));
  readonly hourSeries: BarSeries[] = [{ key: 'req', label: 'Requests', color: FAMILY_COLORS['opus'] }];
  readonly hourValues = computed(() => (this.hist()?.tokens?.hours || new Array(24).fill(0)).map((n) => [n]));

  readonly limitFrom = computed(() => this.now() - Math.min(this.days(), 14) * 86400000);
  readonly limitSeries = computed<LineSeries[]>(() => {
    const snaps = this.hist()?.limits || [];
    if (!snaps.length) return [];
    const byLabel = new Map<string, LineSeries>();
    const color = (kind: string, label: string) => kind === 'session' ? '#0072B2' : /all models/i.test(label) ? '#E69F00' : FAMILY_COLORS[familyOf(label)] || '#8A8F9E';
    for (const s of snaps) {
      for (const m of s.meters) {
        let ser = byLabel.get(m.label);
        if (!ser) byLabel.set(m.label, (ser = { key: m.label, label: m.label.replace(/^Current /, ''), color: color(m.kind, m.label), points: [] }));
        ser.points.push({ t: Date.parse(s.at), v: m.pct });
      }
    }
    return [...byLabel.values()];
  });

  readonly runLabels = computed(() => (this.hist()?.runs || []).map((d) => dayLabel(d.date)));
  readonly runSeries = computed<BarSeries[]>(() => {
    const present = new Set((this.hist()?.runs || []).flatMap((d) => Object.keys(d.byStatus)));
    return RUN_STATUSES.filter((s) => present.has(s)).map((s) => ({ key: s, label: s === 'handedOff' ? 'continued in terminal' : s, color: STATUS_COLORS[s] }));
  });
  readonly runValues = computed(() => (this.hist()?.runs || []).map((d) => this.runSeries().map((s) => d.byStatus[s.key] || 0)));
  readonly runTotal = computed(() => (this.hist()?.runs || []).reduce((a, d) => a + Object.values(d.byStatus).reduce((x, y) => x + y, 0), 0));
  readonly runTurns = computed(() => (this.hist()?.runs || []).reduce((a, d) => a + d.turns, 0));

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => { this.now.set(Date.now()); this.load(); }, 60000);
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  setDays(d: number): void { this.days.set(d); this.load(); }

  async load(force = false): Promise<void> {
    try {
      const [h, u] = await Promise.all([
        this.api.get<UsageHistoryResponse>(`/api/usage/history?days=${this.days()}${force ? '&force=1' : ''}`),
        this.api.get<UsageReport>('/api/usage' + (force ? '?force=1' : '')),
      ]);
      this.hist.set(h);
      this.report.set(u);
      this.error.set(null);
    } catch (e) { this.error.set((e as Error).message); }
  }
  async refresh(): Promise<void> {
    this.busy.set(true);
    try { await this.load(true); } finally { this.busy.set(false); this.now.set(Date.now()); }
  }

  cap(m: UsageMeter): number | null {
    const s = this.data.overview()?.stats;
    return m.kind === 'session' ? s?.pauseAtSessionPct ?? 90 : m.kind === 'week' ? s?.pauseAtWeeklyPct ?? 90 : null;
  }
  meterCls(m: UsageMeter): string {
    const c = this.cap(m) || 100;
    return m.pct >= c ? 'meter over' : m.pct >= c * 0.8 ? 'meter warn' : 'meter';
  }
  fmt(n: number): string { return compact(n); }
  readonly int = (n: number) => String(Math.round(n));
  rel(t: string | number): string { return relTime(t); }
  /** Bold the leading or trailing percentage ("81% of your usage…", "/worktree 1%"). */
  insight(item: string): string { return esc(item).replace(/^(\d+%)|(\d+%)$/, '<b>$&</b>'); }
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function short(model: string): string { return model.replace(/^claude-/, '').replace(/-\d{8}$/, ''); }

import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { Issue, IssueDetail, IssuesResponse, RunMeta } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { ToastService } from '../../core/toast.service';
import { copyText, lsGet, lsSet, relTime } from '../../core/util';
import { MdPipe } from '../../core/md.pipe';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { IssueSummaryComponent } from '../../shared/issue-summary.component';
import { PageHeaderComponent } from '../../shared/page-header.component';

@Component({
  selector: 'dash-issues',
  imports: [PageHeaderComponent, RouterLink, IssueSummaryComponent, MdPipe, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './issues.component.scss',
  templateUrl: './issues.component.html',
})
export class IssuesComponent implements OnInit, OnDestroy {
  readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly launch = inject(LaunchService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly resp = signal<IssuesResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly team = signal(lsGet('dash.issues.team', 'All'));
  readonly q = signal(lsGet('dash.issues.q', ''));
  readonly mine = signal(lsGet('dash.issues.mine') === '1');
  readonly key = signal('');
  readonly connectErr = signal('');
  readonly busyTicket = signal<string | null>(null);
  /** Your board filter as typed; follows the saved one whenever the board reloads. */
  readonly queryDraft = linkedSignal(() => this.resp()?.query?.value || '');

  readonly detailId = signal<string | null>(null);
  readonly detail = signal<IssueDetail | null>(null);
  readonly detailErr = signal<string | null>(null);
  readonly descClamp = 600;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly teams = computed(() => ['All', ...(this.resp()?.teams || [])]);
  readonly filtered = computed(() => {
    const d = this.resp();
    if (!d) return [];
    const q = this.q().toLowerCase().trim();
    return d.issues.filter((i) => {
      if (this.team() !== 'All' && i.team !== this.team()) return false;
      if (this.mine() && (!d.viewer || i.assignee !== d.viewer)) return false;
      if (!q) return true;
      return [i.id, i.title, i.assignee || '', i.project || '', ...i.labels.map((l) => l.name)].join(' ').toLowerCase().includes(q);
    });
  });
  readonly lanes = computed(() => (this.resp()?.states || []).map((s) => {
    const items = this.filtered().filter((i) => i.state === s)
      .sort((a, b) => (a.priority || 9) - (b.priority || 9) || b.updatedAt.localeCompare(a.updatedAt));
    return { state: s, items, color: items[0]?.stateColor || 'var(--ink-faint)' };
  }));
  readonly meta = computed(() => {
    const d = this.resp();
    if (!d || !d.connected) return '';
    const n = this.filtered().length;
    return n + ' issue' + (n === 1 ? '' : 's') + (d.fetchedAt ? ' · updated ' + relTime(d.fetchedAt) : '') + (d.viewer ? ' · ' + d.viewer : '');
  });
  readonly filtersActive = computed(() => this.team() !== 'All' || !!this.q() || this.mine());
  readonly detailIssue = computed(() => this.resp()?.issues.find((i) => i.id === this.detailId()) || null);

  ngOnInit(): void {
    this.load(false);
    // The tracker is cached server-side for 60s; this also keeps "Implementing…" badges current.
    this.timer = setInterval(() => this.load(false), 30000);
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async load(force: boolean): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    try { this.resp.set(await this.api.get<IssuesResponse>('/api/issues' + (force ? '?force=1' : ''))); this.error.set(null); }
    catch (e) { this.error.set((e as Error).message); }
    finally { this.loading.set(false); }
  }

  setTeam(t: string): void { this.team.set(t); lsSet('dash.issues.team', t); }
  setQ(v: string): void { this.q.set(v); lsSet('dash.issues.q', v); }
  setMine(v: boolean): void { this.mine.set(v); lsSet('dash.issues.mine', v ? '1' : '0'); }
  resetFilters(): void { this.setTeam('All'); this.setQ(''); this.setMine(false); }

  /** Save your board filter (it's yours: .claude/ledger/settings.json) and refetch the board with it. */
  async saveQuery(): Promise<void> {
    try {
      await this.api.post('/api/settings', { issues: { query: this.queryDraft().trim() || null } });
      await this.load(true);
    } catch (e) { this.toast.error((e as Error).message); }
  }
  rel(t: string): string { return relTime(t); }
  priCls(i: Issue): string { return i.priority === 1 ? 'pri urgent' : i.priority === 2 ? 'pri high' : 'pri'; }
  claudeQueued(i: Issue): boolean { return i.labels.some((l) => l.name.toLowerCase() === 'claude'); }
  running(i: Issue): boolean { return !!i.lastRun && (i.lastRun.status === 'running' || i.lastRun.status === 'waiting'); }

  async connect(): Promise<void> {
    this.connectErr.set('');
    try {
      await this.api.post('/api/issues/connect', { key: this.key() });
      this.key.set('');
      this.toast.show(this.api.trackerLabel() + ' connected');
      this.load(true);
    } catch (e) { this.connectErr.set((e as Error).message); }
  }

  implementAuto(i: Issue): void {
    // Reuse the launch dialog so model, effort and the runaway cap can be reviewed first.
    this.launch.open({ presetId: this.data.deck()?.issues?.implementPreset || 'implement', prefill: { ticket: i.id } });
  }

  async implementTerminal(i: Issue): Promise<void> {
    try {
      const r = await this.api.post<{ opened: boolean; command: string }>('/api/issues/implement', { ticket: i.id, mode: 'terminal' });
      if (r.opened) this.toast.show('Opened /implement ' + i.id + ' in a terminal');
      else if (await copyText(r.command)) this.toast.show('Copied: ' + r.command);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async explain(i: Issue): Promise<void> {
    this.busyTicket.set(i.id);
    try {
      const r = await this.api.post<{ run: RunMeta }>('/api/issues/explain', { ticket: i.id });
      this.data.upsertRun(r.run);
      this.router.navigate(['/runs', r.run.id]);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busyTicket.set(null); }
  }

  async openDetail(i: Issue, ev?: Event): Promise<void> {
    ev?.preventDefault();
    this.detailId.set(i.id);
    this.detail.set(null);
    this.detailErr.set(null);
    try { this.detail.set(await this.api.get<IssueDetail>('/api/issues/issue?id=' + encodeURIComponent(i.id))); }
    catch (e) { this.detailErr.set((e as Error).message); }
  }
  closeDetail(): void { this.detailId.set(null); }
}

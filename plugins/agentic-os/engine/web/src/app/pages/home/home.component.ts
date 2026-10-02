import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Preset } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { pct, relTime } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { RunRowComponent } from '../../shared/run-row.component';
import { SlashInputComponent } from '../../shared/slash-input.component';

@Component({
  selector: 'dash-home',
  imports: [RouterLink, IconComponent, PageHeaderComponent, RunRowComponent, SlashInputComponent, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './home.component.scss',
  templateUrl: './home.component.html',
})
export class HomeComponent {
  readonly data = inject(DataService);
  private readonly api = inject(ApiService);
  private readonly launch = inject(LaunchService);
  private readonly toast = inject(ToastService);

  readonly adhoc = signal('');
  readonly inboxBusy = signal(false);

  readonly ov = this.data.overview;
  // A role that hides the Apps or Workspaces page (readers) doesn't get their Home tiles either.
  private readonly hiddenPages = computed(() => new Set(this.api.boot()?.profile?.hiddenPages || []));
  readonly showApps = computed(() => !this.hiddenPages().has('apps'));
  readonly showWorkspaces = computed(() => !this.hiddenPages().has('workspaces'));
  readonly apps = computed(() => {
    let up = 0, total = 0;
    for (const w of this.data.status()?.workspaces || []) for (const a of w.apps) { if (!a.available) continue; total++; if (a.running) up++; }
    return { up, total };
  });
  readonly weekLine = computed(() => { const s = this.ov()?.stats; return s ? pct(s.weekSucceeded, s.weekRuns) + ' succeeded' : ''; });

  readonly active = computed(() => this.data.runs().filter((r) => r.status === 'running' || r.status === 'waiting' || (r.watch && !r.watch.endedAt)));
  readonly sessions = computed(() => {
    const mine = new Set(this.data.runs().map((r) => r.sessionId));
    return (this.ov()?.sessions || []).filter((s) => !mine.has(s.sessionId));
  });
  readonly recent = computed(() => this.data.runs().filter((r) => r.status !== 'running' && r.status !== 'waiting' && !(r.watch && !r.watch.endedAt)).slice(0, 8));

  readonly routines = computed(() => {
    const rs = this.ov()?.routines || [];
    const presets = new Map((this.data.deck()?.presets || []).map((p) => [p.id, p]));
    let nextId: string | null = null, nextAt = Infinity;
    for (const r of rs) if (r.enabled && r.nextAt && Date.parse(r.nextAt) < nextAt) { nextAt = Date.parse(r.nextAt); nextId = r.id; }
    return rs.slice().sort((a, b) => (a.at || '').localeCompare(b.at || '')).map((r) => {
      const status = !r.enabled ? 'off' : r.id === nextId ? 'next' : 'queued';
      const last = r.last ? (r.last.ok ? 'last fired ' + relTime(r.last.firedAt) : 'last attempt failed: ' + r.last.error) : 'never fired';
      const days = Array.isArray(r.days) ? r.days.join(', ') : r.days || 'daily';
      return { r, label: presets.get(r.preset)?.label || r.preset, status, detail: days + ' · ' + last, when: status === 'next' ? 'next · ' + relTime(r.nextAt) : status, runId: r.last?.runId || null };
    });
  });

  readonly machineBanner = computed(() => {
    const m = this.data.machine();
    if (!m || (!m.problems && !m.warnings)) return null;
    const missing = m.checks.filter((c) => c.status === 'missing').map((c) => c.label);
    return { problems: m.problems, warnings: m.warnings, missing: missing.slice(0, 4).join(', ') + (missing.length > 4 ? '…' : '') };
  });

  readonly inboxItems = computed(() => this.data.inbox()?.items || []);
  readonly inboxCount = computed(() => this.inboxItems().filter((i) => i.severity !== 'info').length);

  rel(t: string | null | undefined): string { return relTime(t); }
  presetMeta(p: Preset): string { return [p.model || this.launch.model(), p.effort || this.launch.effort()].join(' · '); }
  presetStats(id: string): string {
    const st = this.data.stats()[id];
    if (!st || !st.runs) return 'no runs yet';
    let line = '<b>' + st.runs + '</b> run' + (st.runs === 1 ? '' : 's') + ' · ' + pct(st.succeeded, st.runs) + ' ok';
    if (st.rated) line += ' · ' + st.good + '/' + st.rated + ' good';
    return line;
  }
  cwdTail(cwd: string): string { return String(cwd || '').replace(/\\/g, '/').split('/').slice(-2).join('/'); }
  wsDots(): { name: string; ticketId: string | null; dots: { cls: string; title: string }[]; up: number; total: number }[] {
    return (this.data.status()?.workspaces || []).map((w) => {
      const apps = w.apps.filter((a) => a.available);
      return {
        name: w.name, ticketId: w._ticketId,
        dots: apps.map((a) => ({ cls: a.running ? 'succeeded' : a.busy ? 'running' : '', title: a.name + (a.port ? ' :' + a.port : '') })),
        up: apps.filter((a) => a.running).length, total: apps.length,
      };
    });
  }

  openPreset(p: Preset): void { this.launch.open({ presetId: p.id }); }
  runAdhoc(): void {
    if (!this.adhoc().trim()) return;
    this.launch.open({ prompt: this.adhoc(), focusPrompt: false });
    this.adhoc.set('');
  }

  async refreshInbox(): Promise<void> {
    this.inboxBusy.set(true);
    await this.data.loadInbox(true);
    this.inboxBusy.set(false);
  }
}

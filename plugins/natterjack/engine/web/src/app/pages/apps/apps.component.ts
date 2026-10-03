import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import type { AppStatus, Job } from '../../../../../shared/api';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { dur, relTime } from '../../core/util';
import { AppButtonsComponent } from '../../shared/app-buttons.component';
import { LogsService } from '../../shared/logs-dialog.component';
import { PageHeaderComponent } from '../../shared/page-header.component';

@Component({
  selector: 'dash-apps',
  imports: [PageHeaderComponent, AppButtonsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './apps.component.scss',
  templateUrl: './apps.component.html',
})
export class AppsComponent implements OnInit {
  readonly data = inject(DataService);
  private readonly launch = inject(LaunchService);
  private readonly logs = inject(LogsService);

  readonly main = this.data.mainWorkspace;
  readonly byKey = computed(() => new Map((this.main()?.apps || []).map((a) => [a.key, a])));
  readonly stacks = computed(() => Object.entries(this.data.stacks()).map(([id, s]) => {
    const apps = s.apps.map((k) => this.byKey().get(k)).filter((a): a is AppStatus => !!a);
    const avail = apps.filter((a) => a.available);
    const up = avail.filter((a) => a.running).length;
    const busy = this.data.jobs().some((j) => j.status === 'running' && j.workspace === 'main' && j.label.includes(s.label));
    return { id, s, apps, avail, up, busy };
  }));
  /** Apps by group, in apps.json order (a group the config doesn't list goes last). */
  readonly groups = computed(() => {
    const apps = this.main()?.apps || [];
    const order = [...this.data.appGroups()];
    for (const a of apps) if (!order.some((g) => g.id === a.group)) order.push({ id: a.group, label: a.group });
    return order.map(({ id, label }) => ({ g: id, label, apps: apps.filter((a) => a.group === id) })).filter((x) => x.apps.length);
  });
  readonly jobs = computed(() => this.data.jobs().slice(0, 15));

  ngOnInit(): void {
    this.data.loadStatus();
  }

  dotClass(a: AppStatus): string {
    if (!a.available) return 'na';
    if (a.busy && !a.running) return 'starting';
    return a.running ? 'running' : 'stopped';
  }
  stackAction(action: 'start' | 'stop', id: string): void { this.data.appAction({ action, workspace: 'main', stack: id }); }
  changes(repo: string, name: string): void {
    this.launch.open({ prompt: 'Working in repo ' + repo + ': ', workspace: 'main', focusPrompt: true, title: 'Make changes · ' + name });
  }
  jobDot(j: Job): string { return j.status === 'running' ? 'running' : j.status === 'succeeded' ? 'succeeded' : j.status === 'interrupted' ? 'interrupted' : 'failed'; }
  jobMeta(j: Job): string { return j.workspaceName + ' · ' + relTime(j.startedAt) + (j.endedAt ? ' · ' + dur(Date.parse(j.endedAt) - Date.parse(j.startedAt)) : ''); }
  openJob(j: Job): void { this.logs.open({ title: j.label + ' · ' + j.workspaceName, job: j.id }); }
}

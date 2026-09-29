import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Job, RepoInfo, ReposResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { copyText, relTime } from '../../core/util';
import { LogsService } from '../../shared/logs-dialog.component';
import { PageHeaderComponent } from '../../shared/page-header.component';

const EXAMPLE = `{
  "$schema": "./dashboard/shared/repos.schema.json",
  "repos": [
    { "name": "api", "relativePath": "api", "remote": "https://github.com/acme/api.git", "layer": "backend" },
    { "name": "web", "relativePath": "apps/web", "remote": "https://github.com/acme/web.git", "layer": "frontend" }
  ]
}`;

@Component({
  selector: 'dash-repos',
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './repos.component.scss',
  template: `
    <dash-page-header eyebrow="Repos" title="Repos" sub="The repos in repos.json and whether each one is on this machine.">
      @if (cloneable().length) {
        <button class="btn primary sm" [disabled]="cloning()" (click)="clone(null)">{{ cloning() ? 'Cloning…' : 'Clone missing (' + cloneable().length + ')' }}</button>
      }
      <button class="btn sm" (click)="load()">Refresh</button>
    </dash-page-header>

    @let r = repos();
    @if (!r) { <div class="empty">Loading…</div> }
    @else {
      @if (r.error) { <div class="warn-note">{{ r.error }}</div> }
      @if (!r.configured) {
        <div class="panel"><div class="empty md tight" style="padding:2rem">
          <p>There's no <code>repos.json</code> at the workspace root. List the repos this workspace is made of, each with the folder it lives in and where to clone it from; then this page can clone the missing ones on a new machine.</p>
          <pre class="example" title="Click to copy" (click)="copy(example)">{{ example }}</pre>
          <p>Only <code>name</code> is required (the folder defaults to it). The schema is <code>dashboard/shared/repos.schema.json</code>.</p>
        </div></div>
      }

      @if (job(); as j) {
        <div class="panel job-panel" (click)="openJob(j)" title="Show the log">
          <div class="t"><span [class]="'sdot ' + jobDot(j)"></span>{{ j.label }}<span class="ty">{{ relTime(j.startedAt) }}{{ j.error ? ' · ' + j.error : '' }}</span></div>
          <ol>
            @for (s of j.steps; track $index) {
              <li [class.failed]="s.status === 'failed'"><span class="m">@if (s.status === 'done') { ✓ } @else if (s.status === 'failed') { ✕ } @else { <span class="spin"></span> }</span>{{ s.label }}{{ s.error ? ': ' + s.error : '' }}</li>
            }
          </ol>
        </div>
      }

      @for (g of groups(); track g.label) {
        <div class="panel">
          <div class="panel-h"><h2>{{ g.label }} <span class="ty">{{ g.here }}/{{ g.items.length }} here</span></h2></div>
          @for (x of g.items; track x.relativePath) {
            <div class="repo" [class]="'repo ' + x.state">
              <span class="ic" [title]="stateLabel(x)">{{ x.state === 'cloned' ? '✓' : x.state === 'missing' ? '✕' : '!' }}</span>
              <div class="main">
                <div class="nm">{{ x.name }} <code class="rel">{{ x.relativePath }}</code></div>
                @if (x.remote) { <div class="remote">{{ x.remote }}</div> }
              </div>
              <div class="side">
                @if (x.state === 'cloned') {
                  <span class="ver">{{ x.branch || '?' }}</span>
                  @if (x.changes) { <span class="chg" [title]="x.changes + ' files with uncommitted changes'">{{ x.changes }} changed</span> }
                } @else if (x.state === 'missing' && x.remote) {
                  <button class="btn sm" [disabled]="cloning()" (click)="clone([x.name])">Clone</button>
                } @else {
                  <span class="ty">{{ stateLabel(x) }}</span>
                }
              </div>
            </div>
          }
        </div>
      }
    }
  `,
})
export class ReposComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);
  private readonly logs = inject(LogsService);
  readonly repos = signal<ReposResponse | null>(null);
  readonly example = EXAMPLE;
  readonly relTime = relTime;

  /** The latest Clone job in main (the one this page started, or an earlier one). */
  readonly job = computed<Job | null>(() => this.data.jobs().find((j) => j.workspace === 'main' && j.label.startsWith('Clone')) || null);
  readonly cloning = computed(() => this.job()?.status === 'running');
  readonly cloneable = computed(() => (this.repos()?.repos || []).filter((x) => x.state === 'missing' && !!x.remote));
  /** Repos by layer, in file order; one "Repos" group when none has a layer. */
  readonly groups = computed(() => {
    const list = this.repos()?.repos || [];
    const layered = list.some((x) => x.layer);
    const labels: string[] = [];
    for (const x of list) { const l = layered ? x.layer || 'Other' : 'Repos'; if (!labels.includes(l)) labels.push(l); }
    return labels.map((label) => {
      const items = list.filter((x) => (layered ? x.layer || 'Other' : 'Repos') === label);
      return { label: layered ? label.charAt(0).toUpperCase() + label.slice(1) : label, items, here: items.filter((x) => x.state === 'cloned').length };
    });
  });

  /** Changes only when the clone job's steps or status do (jobs are re-fetched every 2s as new objects). */
  private readonly jobKey = computed(() => {
    const j = this.job();
    return j ? j.id + ':' + j.status + ':' + j.steps.map((s) => s.status).join() : '';
  });

  constructor() {
    // Each finished step of a clone (and its end) shows up in the list without a click.
    effect(() => { if (this.jobKey()) untracked(() => this.load()); });
  }

  ngOnInit(): void {
    this.load();
    this.data.loadJobs();
  }

  async load(): Promise<void> {
    try { this.repos.set(await this.api.get<ReposResponse>('/api/repos')); }
    catch (e) { this.toast.error((e as Error).message); }
  }

  async clone(names: string[] | null): Promise<void> {
    try {
      const r = await this.api.post<{ job: Job }>('/api/repos/clone', names ? { names } : {});
      this.toast.show(r.job.label + '…');
      await this.data.loadJobs();
    } catch (e) { this.toast.error((e as Error).message); }
  }

  stateLabel(x: RepoInfo): string {
    if (x.state === 'cloned') return 'cloned';
    if (x.state === 'not-git') return 'folder has files but no .git; left alone';
    return x.remote ? 'not cloned' : 'not here, and no remote to clone it from';
  }
  jobDot(j: Job): string { return j.status === 'running' ? 'running' : j.status === 'succeeded' ? 'succeeded' : j.status === 'interrupted' ? 'interrupted' : 'failed'; }
  openJob(j: Job): void { this.logs.open({ title: j.label + ' · ' + j.workspaceName, job: j.id }); }
  async copy(text: string): Promise<void> { if (await copyText(text)) this.toast.show('Copied'); }
}

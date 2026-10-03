import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Job, PublishPlanResponse, RepoInfo, ReposResponse, SnapshotRepo, SnapshotStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { MdPipe } from '../../core/md.pipe';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { copyText, relTime } from '../../core/util';
import { LogsService } from '../../shared/logs-dialog.component';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { KeyFieldsComponent } from '../../shared/key-fields.component';

const EXAMPLE = `{
  "$schema": "./dashboard/shared/repos.schema.json",
  "repos": [
    { "name": "api", "relativePath": "api", "remote": "https://github.com/acme/api.git", "layer": "backend" },
    { "name": "web", "relativePath": "apps/web", "remote": "https://github.com/acme/web.git", "layer": "frontend" }
  ]
}`;
/** A published snapshot older than this gets a warning: the publish job has probably stopped. */
const STALE_DAYS = 3;

@Component({
  selector: 'dash-repos',
  imports: [PageHeaderComponent, MdPipe, TrustedHtmlPipe, KeyFieldsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './repos.component.scss',
  template: `
    <dash-page-header eyebrow="Repos" title="Repos" [sub]="reader() ? 'The workspace\\'s code on this machine: read-only copies you download, or clones.' : 'The repos in repos.json and whether each one is on this machine.'">
      @if (downloadable().length) {
        <button class="btn primary sm" [disabled]="busy()" (click)="download(null)">{{ downloading() ? 'Downloading…' : (anyLocal() ? 'Update code' : 'Download code') + ' (' + downloadable().length + ')' }}</button>
      }
      @if (!reader() && cloneable().length) {
        <button class="btn sm" [class.primary]="!downloadable().length" [disabled]="busy()" (click)="clone(null)">{{ cloning() ? 'Cloning…' : 'Clone missing (' + cloneable().length + ')' }}</button>
      }
      <button class="btn sm" (click)="load(true)">Refresh</button>
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

      @if (snap(); as s) {
        <div class="panel snap">
          <div class="panel-h"><h2>Read-only copy <span class="ty">{{ s.label || s.sourceKind }}</span></h2>
            <span class="acts">
              @if (!reader() && s.canPublish && !plan()) {
                <button class="btn sm" [disabled]="busy() || planning()" (click)="startPublish()" title="Upload each repo's default branch, as it is on origin now, for people who download the code">{{ planning() ? 'Checking the repos…' : publishing() ? 'Publishing…' : 'Publish now' }}</button>
              }
              @if (s.connection?.connected && s.connection?.source === 'file') { <button class="btn ghost sm" (click)="disconnect()">Disconnect</button> }
            </span>
          </div>
          <div class="panel-b">
            @if (s.error) { <div class="warn-note">{{ s.error }}</div> }
            @if (!s.label) {
              <p class="ty">repos.json names a snapshot source this dashboard doesn't have an adapter for.</p>
            } @else if (!s.connection?.connected) {
              @if (s.connect; as help) {
                <div class="connect">
                  <h3>{{ help.title }}</h3>
                  <ol>@for (st of help.steps; track $index) { <li class="md tight" [innerHTML]="st | md | trustedHtml"></li> }</ol>
                  @if (help.needsKey) {
                    <form (submit)="$event.preventDefault(); connect()">
                      <dash-key-fields [fields]="help.keyFields" [placeholder]="help.placeholder" [(value)]="key" />
                      <button class="btn primary" type="submit" [disabled]="connecting() || !key().trim()">Connect</button>
                    </form>
                  }
                  @if (connectError()) { <div class="form-err">{{ connectError() }}</div> }
                </div>
              }
            } @else {
              <p class="ty">
                @if (s.builtAt) { Published {{ relTime(s.builtAt) }}{{ s.connection?.viewer ? ' · signed in as ' + s.connection?.viewer : '' }}. }
                Copies are the default branch without history, and are replaced as a whole on update: don't edit files in them.
              </p>
              @if (staleDays(); as d) { <div class="warn-note">The published copy is {{ d }} days old; whoever runs the publish job should check it.</div> }
              @if (workspaceBehind()) {
                <div class="warn-note">A newer copy of the workspace itself (skills, dashboard) is published.
                  @if (s.workspace?.installer; as inst) { Run <code>{{ inst }}</code> from {{ s.label }} again to update it (your downloaded code and settings stay). }
                  @else { Download <code>workspace.zip</code> again from {{ s.label }} and extract it over this folder. }
                </div>
              }
            }
            @if (plan(); as pl) {
              <div class="confirm">
                <h3>Publish to {{ pl.label }}?</h3>
                <p class="ty">These are uploaded as they are on origin now: each repo's default branch, without history. Anyone who can view the {{ pl.label }} source can download them. Your local branches and uncommitted changes aren't included.</p>
                <table>
                  @for (t of pl.repos; track t.name) {
                    <tr><td class="nm">{{ t.name }}</td><td><code>{{ t.branch }}</code></td><td><code [title]="t.sha">{{ t.sha.slice(0, 10) }}</code></td><td class="subj" [title]="t.subject">{{ t.subject }}</td><td class="ty">{{ relTime(t.committedAt) }}</td></tr>
                  }
                  @if (pl.workspace; as w) {
                    <tr><td class="nm">workspace files</td><td><code>{{ w.branch }}</code></td><td><code [title]="w.sha">{{ w.sha.slice(0, 10) }}</code></td><td class="subj" [title]="w.subject">{{ w.subject }}</td><td class="ty">{{ relTime(w.committedAt) }}</td></tr>
                  }
                </table>
                @if (pl.skipped.length) {
                  <div class="warn-note">Not from this machine (the last published copy of each stays): @for (k of pl.skipped; track k.name; let last = $last) { <b>{{ k.name }}</b> ({{ k.reason }}){{ last ? '' : ', ' }} }</div>
                }
                <div class="btns">
                  <button class="btn primary sm" [disabled]="busy()" (click)="publish(pl.planId)">Publish {{ pl.repos.length }} repo{{ pl.repos.length === 1 ? '' : 's' }}</button>
                  <button class="btn ghost sm" (click)="plan.set(null)">Cancel</button>
                </div>
              </div>
            }
          </div>
        </div>
      }

      @if (job(); as j) {
        <div class="panel job-panel" (click)="openJob(j)" title="Show the log">
          <div class="t"><span [class]="'sdot ' + jobDot(j)"></span>{{ j.label }}<span class="ty">{{ relTime(j.startedAt) }}{{ j.error ? ' · ' + j.error : '' }}</span></div>
          <ol>
            @for (st of j.steps; track $index) {
              <li [class.failed]="st.status === 'failed'"><span class="m">@if (st.status === 'done') { ✓ } @else if (st.status === 'failed') { ✕ } @else { <span class="spin"></span> }</span>{{ st.label }}{{ st.error ? ': ' + st.error : '' }}</li>
            }
          </ol>
        </div>
      }

      @for (g of groups(); track g.label) {
        <div class="panel">
          <div class="panel-h"><h2>{{ g.label }} <span class="ty">{{ g.here }}/{{ g.items.length }} here</span></h2></div>
          @for (x of g.items; track x.relativePath) {
            @let sr = snapRow(x.name);
            <div class="repo" [class]="'repo ' + x.state">
              <span class="ic" [title]="stateLabel(x)">{{ x.state === 'cloned' ? '✓' : x.state === 'snapshot' ? '↓' : x.state === 'missing' ? '✕' : '!' }}</span>
              <div class="main">
                <div class="nm">{{ x.name }} <code class="rel">{{ x.relativePath }}</code></div>
                @if (x.remote && !reader()) { <div class="remote">{{ x.remote }}</div> }
              </div>
              <div class="side">
                @if (x.state === 'cloned') {
                  <span class="ver">{{ x.branch || '?' }}</span>
                  @if (x.changes) { <span class="chg" [title]="x.changes + ' files with uncommitted changes'">{{ x.changes }} changed</span> }
                } @else if (x.state === 'snapshot') {
                  <span class="ver" [title]="sr?.local?.sha || ''">copy of {{ sr?.local ? relTime(sr!.local!.builtAt) : '?' }}</span>
                  @if (sr?.needsDownload) { <button class="btn sm" [disabled]="busy()" (click)="download([x.name])">Update</button> }
                } @else if (x.state === 'missing' && sr?.needsDownload) {
                  <button class="btn sm" [disabled]="busy()" (click)="download([x.name])">Download</button>
                } @else if (x.state === 'missing' && x.remote && !reader()) {
                  <button class="btn sm" [disabled]="busy()" (click)="clone([x.name])">Clone</button>
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
  readonly snap = signal<SnapshotStatus | null>(null);
  readonly key = signal('');
  readonly connecting = signal(false);
  readonly connectError = signal<string | null>(null);
  readonly example = EXAMPLE;
  readonly relTime = relTime;
  readonly reader = computed(() => this.api.boot()?.profile?.current === 'reader');

  /** The latest Clone / Download / Publish job in main (the one this page started, or an earlier one). */
  readonly job = computed<Job | null>(() => this.data.jobs().find((j) => j.workspace === 'main' && /^(Clone|Download|Publish)\b/.test(j.label)) || null);
  readonly busy = computed(() => this.job()?.status === 'running');
  readonly cloning = computed(() => this.busy() && this.job()!.label.startsWith('Clone'));
  readonly downloading = computed(() => this.busy() && this.job()!.label.startsWith('Download'));
  readonly publishing = computed(() => this.busy() && this.job()!.label.startsWith('Publish'));
  /** Publish now: what would be uploaded, shown for a yes before anything goes up. */
  readonly plan = signal<PublishPlanResponse | null>(null);
  readonly planning = signal(false);
  readonly cloneable = computed(() => (this.repos()?.repos || []).filter((x) => x.state === 'missing' && !!x.remote));
  readonly downloadable = computed(() => (this.snap()?.connection?.connected ? this.snap()!.repos.filter((x) => x.needsDownload) : []));
  readonly anyLocal = computed(() => (this.repos()?.repos || []).some((x) => x.state === 'snapshot'));
  readonly staleDays = computed(() => {
    const at = this.snap()?.builtAt;
    const days = at ? Math.floor((Date.now() - Date.parse(at)) / 86_400_000) : 0;
    return days >= STALE_DAYS ? days : 0;
  });
  readonly workspaceBehind = computed(() => {
    const w = this.snap()?.workspace;
    return !!w && !!w.local && w.local.sha !== w.latest.sha;
  });
  /** Repos by layer, in file order; one "Repos" group when none has a layer. */
  readonly groups = computed(() => {
    const list = this.repos()?.repos || [];
    const layered = list.some((x) => x.layer);
    const labels: string[] = [];
    for (const x of list) { const l = layered ? x.layer || 'Other' : 'Repos'; if (!labels.includes(l)) labels.push(l); }
    return labels.map((label) => {
      const items = list.filter((x) => (layered ? x.layer || 'Other' : 'Repos') === label);
      return { label: layered ? label.charAt(0).toUpperCase() + label.slice(1) : label, items, here: items.filter((x) => x.state === 'cloned' || x.state === 'snapshot').length };
    });
  });
  private readonly snapByName = computed(() => new Map((this.snap()?.repos || []).map((x) => [x.name, x])));

  /** Changes only when the job's steps or status do (jobs are re-fetched every 2s as new objects). */
  private readonly jobKey = computed(() => {
    const j = this.job();
    return j ? j.id + ':' + j.status + ':' + j.steps.map((s) => s.status).join() : '';
  });

  constructor() {
    // Each finished step of a clone or download (and its end) shows up in the list without a click.
    effect(() => { if (this.jobKey()) untracked(() => this.load(false)); });
  }

  ngOnInit(): void {
    this.load(false);
    this.data.loadJobs();
  }

  snapRow(name: string): SnapshotRepo | null { return this.snapByName().get(name) || null; }

  async load(force: boolean): Promise<void> {
    try {
      const r = await this.api.get<ReposResponse>('/api/repos');
      this.repos.set(r);
      if (r.snapshotSource) this.snap.set(await this.api.get<SnapshotStatus>('/api/snapshot' + (force ? '?force=1' : '')));
      else this.snap.set(null);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async connect(): Promise<void> {
    this.connecting.set(true);
    this.connectError.set(null);
    try {
      await this.api.post('/api/snapshot/connect', { key: this.key().trim() });
      this.key.set('');
      await this.load(true);
    } catch (e) { this.connectError.set((e as Error).message); }
    finally { this.connecting.set(false); }
  }

  async disconnect(): Promise<void> {
    try { await this.api.post('/api/snapshot/disconnect', {}); await this.load(false); }
    catch (e) { this.toast.error((e as Error).message); }
  }

  async clone(names: string[] | null): Promise<void> { await this.startJob('/api/repos/clone', names); }
  async download(names: string[] | null): Promise<void> { await this.startJob('/api/snapshot/download', names); }

  /** Fetch each repo's default branch and show what would go up; nothing is uploaded yet. */
  async startPublish(): Promise<void> {
    this.planning.set(true);
    try { this.plan.set(await this.api.post<PublishPlanResponse>('/api/snapshot/plan', {})); }
    catch (e) { this.toast.error((e as Error).message); }
    finally { this.planning.set(false); }
  }

  async publish(planId: string): Promise<void> {
    try {
      const r = await this.api.post<{ job: Job }>('/api/snapshot/publish', { planId });
      this.plan.set(null);
      this.toast.show(r.job.label + '…');
      await this.data.loadJobs();
    } catch (e) {
      this.toast.error((e as Error).message);
      this.plan.set(null);
    }
  }

  private async startJob(url: string, names: string[] | null): Promise<void> {
    try {
      const r = await this.api.post<{ job: Job }>(url, names ? { names } : {});
      this.toast.show(r.job.label + '…');
      await this.data.loadJobs();
    } catch (e) { this.toast.error((e as Error).message); }
  }

  stateLabel(x: RepoInfo): string {
    if (x.state === 'cloned') return 'cloned';
    if (x.state === 'snapshot') return 'read-only copy';
    if (x.state === 'not-git') return 'folder has files but no .git; left alone';
    if (this.snap() && !x.snapshot) return 'not in the read-only copy';
    if (this.reader()) return this.snap()?.connection?.connected ? 'not published yet' : 'not here';
    return x.remote ? 'not cloned' : 'not here, and no remote to clone it from';
  }
  jobDot(j: Job): string { return j.status === 'running' ? 'running' : j.status === 'succeeded' ? 'succeeded' : j.status === 'interrupted' ? 'interrupted' : 'failed'; }
  openJob(j: Job): void { this.logs.open({ title: j.label + ' · ' + j.workspaceName, job: j.id }); }
  async copy(text: string): Promise<void> { if (await copyText(text)) this.toast.show('Copied'); }
}

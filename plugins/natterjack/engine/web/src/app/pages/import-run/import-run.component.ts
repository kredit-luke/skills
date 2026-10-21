import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ImportRunJob } from '../../../../../shared/api';
import { localDashboardOrigin } from '../../../../../shared/send-to-hosted';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

type Step = 'ready' | 'fetching' | 'importing' | 'confirming' | 'unconfirmed' | 'failed';

const POLL_MS = 1500;

/**
 * The hosted end of Send to hosted (/import-run?from=&run=&t=, opened by the person's own
 * dashboard). Asks first, then fetches the run from that dashboard with the single-use
 * token, imports it here (POST /api/runs/import, a job it polls) and tells the other
 * dashboard it arrived, which makes that copy read-only. Asking first matters: anyone can
 * send someone a link.
 */
@Component({
  selector: 'dash-import-run',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel import-card">
      <div class="panel-h"><h2>Move a run here</h2></div>
      <div class="ic-b">
        @if (!source) {
          <div class="err-note">This link doesn't come from a dashboard on your computer, so nothing was imported. Use Send to hosted on the run's page there.</div>
        } @else {
          <p class="lead">Your dashboard at <code>{{ source }}</code> is sending a run (<code>{{ runId }}</code>): its conversation, and the worktree it worked in with any unpushed commits and changes. Once it's here, that copy becomes read-only and you carry on here.</p>
          <p class="lead">Only continue if you just clicked Send to hosted on your computer.</p>
          @switch (step()) {
            @case ('ready') {
              <div class="row"><button class="btn primary" (click)="go()">Move it here</button></div>
            }
            @case ('fetching') { <p class="progress">Fetching it from your computer… (your browser may ask to allow access to your local network: allow it)</p> }
            @case ('importing') { <p class="progress">Setting up the run and its worktree… (this fetches each repo, so it can take a minute)</p> }
            @case ('confirming') { <p class="progress">Telling your computer it's here…</p> }
            @case ('unconfirmed') {
              <div class="err-note" role="alert">The run is here, but your computer's dashboard didn't take the hand-over: {{ error() }} Its copy is still open there, so don't reply to it on both. Carry on here, and leave that one alone (or delete it).</div>
              <div class="row"><a class="btn primary" [routerLink]="['/runs', importedId()]">Open the run here</a></div>
            }
            @case ('failed') {
              <div class="err-note" role="alert">{{ error() }}</div>
              @if (canRetry()) { <div class="row"><button class="btn" (click)="go()">Try again</button></div> }
            }
          }
          @for (w of warnings(); track $index) { <div class="warn-note">{{ w }}</div> }
        }
      </div>
    </div>
  `,
  styles: [`
    .import-card { max-width: 640px; margin: 24px auto; }
    .ic-b { padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 12px; }
    .lead { margin: 0; font-size: 13.5px; color: var(--ink-soft); line-height: 1.5; }
    .progress { margin: 0; font-size: 13.5px; color: var(--ink); }
    .row { display: flex; gap: 8px; }
    code { font-family: var(--font-mono); font-size: 12.5px; }
  `],
})
export class ImportRunComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly params = inject(ActivatedRoute).snapshot.queryParamMap;

  readonly source = localDashboardOrigin(this.params.get('from'));
  readonly runId = this.params.get('run') || '';
  private readonly token = this.params.get('t') || '';
  readonly step = signal<Step>('ready');
  readonly error = signal('');
  readonly warnings = signal<string[]>([]);
  readonly importedId = signal('');
  /** The bundle is fetched once: after that a retry can only re-try the import itself. */
  private bundle: Blob | null = null;
  readonly canRetry = signal(false);
  private stopped = false;

  ngOnDestroy(): void { this.stopped = true; }

  async go(): Promise<void> {
    if (!this.source) return;
    this.error.set('');
    this.canRetry.set(false);
    const q = '?t=' + encodeURIComponent(this.token);
    try {
      if (!this.bundle) {
        this.step.set('fetching');
        let res: Response;
        try { res = await fetch(this.source + '/api/handoff/bundle' + q, { credentials: 'omit' }); }
        catch { throw new Error(`Couldn't reach your dashboard at ${this.source}. Check it's running and that the browser may access your local network, then send the run again.`); }
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `Your dashboard answered ${res.status}.`);
        this.bundle = await res.blob();
      }
      this.step.set('importing');
      this.canRetry.set(true); // from here a failure can be retried with the bundle already fetched
      const job = await this.waitFor(await this.api.upload<ImportRunJob>('/api/runs/import', this.bundle));
      if (job.state !== 'done' || !job.run) throw new Error(job.error || 'The import failed.');
      this.canRetry.set(false);
      this.warnings.set(job.warnings || []);
      this.importedId.set(job.run.id);

      this.step.set('confirming');
      const refused = await this.confirm(q, location.origin + '/runs/' + job.run.id);
      if (refused) {
        this.error.set(refused);
        this.step.set('unconfirmed');
        return;
      }
      this.toast.show('Run moved here');
      this.router.navigate(['/runs', job.run.id]);
    } catch (e) {
      this.error.set((e as Error).message);
      this.step.set('failed');
    }
  }

  /** Poll the import until it's done or failed. */
  private async waitFor(job: ImportRunJob): Promise<ImportRunJob> {
    while (job.state === 'running' && !this.stopped) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      job = await this.api.get<ImportRunJob>('/api/runs/import/' + job.id);
    }
    return job;
  }

  /** Tell the other dashboard; null when it took it, else why not. */
  private async confirm(q: string, url: string): Promise<string | null> {
    try {
      const res = await fetch(this.source + '/api/handoff/confirm' + q, {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      });
      if (res.ok) return null;
      return ((await res.json().catch(() => ({}))) as { error?: string }).error || `It answered ${res.status}.`;
    } catch {
      return "It couldn't be reached.";
    }
  }
}

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { ImportRunResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

type Step = 'ready' | 'fetching' | 'importing' | 'confirming' | 'done' | 'failed';

/** Only a dashboard on the same computer as this browser can send a run (server/src/handoff.ts localDashboardOrigin). */
function localOrigin(from: string | null): string | null {
  try {
    const u = new URL(from || '');
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.pathname !== '/' || u.search || u.username) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The hosted end of Send to hosted (/import-run?from=&run=&t=, opened by the person's own
 * dashboard). Asks first, then fetches the run from that dashboard with the single-use
 * token, imports it here (POST /api/runs/import) and tells the other dashboard it arrived,
 * which makes that copy read-only. Asking first matters: anyone can send someone a link.
 */
@Component({
  selector: 'dash-import-run',
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
export class ImportRunComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly params = inject(ActivatedRoute).snapshot.queryParamMap;

  readonly source = localOrigin(this.params.get('from'));
  readonly runId = this.params.get('run') || '';
  private readonly token = this.params.get('t') || '';
  readonly step = signal<Step>('ready');
  readonly error = signal('');
  readonly warnings = signal<string[]>([]);
  /** The bundle is fetched once: after that a retry can only re-try the import itself. */
  private bundle: Blob | null = null;
  readonly canRetry = signal(false);

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
      let imported: ImportRunResponse;
      try { imported = await this.api.upload<ImportRunResponse>('/api/runs/import', this.bundle); }
      catch (e) { this.canRetry.set(true); throw e; }
      this.warnings.set(imported.warnings || []);
      this.step.set('confirming');
      const runUrl = location.origin + '/runs/' + imported.run.id;
      try {
        await fetch(this.source + '/api/handoff/confirm' + q, {
          method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: runUrl }),
        });
      } catch {
        // The run is here either way; the other copy unlocks itself after a while.
        this.toast.error("The run is here, but your computer's dashboard didn't hear back: don't reply to it there.");
      }
      this.step.set('done');
      this.toast.show('Run moved here');
      this.router.navigate(['/runs', imported.run.id]);
    } catch (e) {
      this.error.set((e as Error).message);
      this.step.set('failed');
    }
  }
}

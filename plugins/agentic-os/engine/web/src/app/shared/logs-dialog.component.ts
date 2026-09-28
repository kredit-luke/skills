import { ChangeDetectionStrategy, Component, ElementRef, Injectable, OnDestroy, effect, inject, signal, untracked, viewChild } from '@angular/core';
import type { LogFiles } from '../../../../shared/api';
import { ApiService } from '../core/api.service';

export interface LogsRequest { title: string; job?: string; workspace?: string; app?: string }

@Injectable({ providedIn: 'root' })
export class LogsService {
  readonly request = signal<LogsRequest | null>(null);
  open(r: LogsRequest): void { this.request.set(r); }
  close(): void { this.request.set(null); }
}

/** Tails an app or job log every 2s while open; sticks to the bottom only if you're there. */
@Component({
  selector: 'dash-logs-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (req(); as r) {
      <div class="modal" (mousedown)="onBackdrop($event)">
        <div class="modal-card wide" (keydown.escape)="close()">
          <div class="panel-h"><h2>{{ r.title }}</h2><button class="btn ghost sm" (click)="close()">Close</button></div>
          <div class="logs-body" #body>
            @if (files() === null) { <div class="empty">Loading…</div> }
            @else if (!files()!.length) { <div class="empty">No log yet. Logs appear once the app is started from the dashboard.</div> }
            @else {
              @for (f of files()!; track f.file) { <h4>{{ f.file }}</h4><pre>{{ f.text }}</pre> }
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .logs-body { max-height: 70vh; overflow: auto; padding: 0.6rem 1rem 1rem; }
    h4 { font-size: 0.68rem; color: var(--text-muted); font-family: var(--mono); font-weight: 500; margin: 0.6rem 0 0.3rem; }
    pre { font-family: var(--mono); font-size: 0.7rem; line-height: 1.45; white-space: pre-wrap; word-break: break-word; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.75rem; }
  `],
})
export class LogsDialogComponent implements OnDestroy {
  private readonly svc = inject(LogsService);
  private readonly api = inject(ApiService);
  readonly req = this.svc.request;
  readonly files = signal<LogFiles['files'] | null>(null);
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const r = this.req();
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (!r) return;
      untracked(() => {
        this.files.set(null);
        this.refresh(true);
        this.timer = setInterval(() => this.refresh(false), 2000);
      });
    });
  }

/** Close on a press on the backdrop itself. Returns nothing: a `false` from a template handler would preventDefault every press inside the dialog. */
  onBackdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.close(); }
  close(): void { this.svc.close(); }

  private async refresh(first: boolean): Promise<void> {
    const r = this.req();
    if (!r) return;
    const q = r.job ? 'job=' + encodeURIComponent(r.job) : 'workspace=' + encodeURIComponent(r.workspace || '') + '&app=' + encodeURIComponent(r.app || '');
    const el = this.body()?.nativeElement;
    const atBottom = first || !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    try { this.files.set((await this.api.get<LogFiles>('/api/apps/log?' + q)).files); } catch { this.files.set([]); }
    if (atBottom) setTimeout(() => { const b = this.body()?.nativeElement; if (b) b.scrollTop = b.scrollHeight; });
  }

  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }
}

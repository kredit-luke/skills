import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { SessionFolder, SessionFoldersResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { relTime } from '../../core/util';

/**
 * Settings, Sessions from other folders: folders outside the workspace whose Claude Code sessions
 * From terminal lists too (e.g. a project worked on before this workspace), each with its own
 * "open new ones by itself". Personal: kept in <ledger>/session-folders.json.
 */
@Component({
  selector: 'dash-session-folders',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Settings' panel and row rules (width, spacing, .row/.t/.h): a child component doesn't get the
  // page's emulated styles, so it loads the same sheet (as remote-link does), plus its list rows.
  styleUrls: ['./settings.component.scss'],
  styles: [`
    .sf-list { padding: 0 16px 14px; }
    .sf-sub { font-size: 11.5px; font-weight: 600; color: var(--ink-soft); margin: 4px 0 2px; }
    .sf-none { font-size: 12.5px; color: var(--ink-soft); padding: 6px 0; }
    .sf-row { display: flex; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--line-soft); }
    .sf-path { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sf-meta { font-size: 11.5px; color: var(--ink-soft); white-space: nowrap; }
    .sf-add { display: flex; gap: 8px; margin-top: 10px; }
    .sf-add input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12px; padding: 5px 8px; }
  `],
  template: `
    <div class="panel">
      <div class="panel-h"><h2>Sessions from other folders</h2></div>
      <div class="rows">
        <div class="row">
          <div class="lbl">
            <div class="t">Other folders</div>
            <div class="h">
              Folders outside this workspace whose Claude Code sessions <b>From terminal</b> (Activity) lists too, say a project you worked in before this one.
              Open one to carry it on where it is, or move it into this workspace to carry it on here.
            </div>
          </div>
        </div>
      </div>
      <div class="sf-list">
        @if (folders().length) {
          @for (f of folders(); track f.path) {
            <div class="sf-row">
              <span class="sf-path" [title]="f.path">{{ f.path }}</span>
              <label class="chk" title="New sessions started there show up in Activity by themselves (and on the hosted dashboard, with Remote control on)">
                <input type="checkbox" [checked]="f.auto" [disabled]="saving()" (change)="setAuto(f, $any($event.target).checked)"> Open new ones by itself
              </label>
              <button class="btn sm" type="button" [disabled]="saving()" (click)="remove(f)">Remove</button>
            </div>
          }
        } @else if (!loading()) { <div class="sf-none">None added yet.</div> }
        @if (suggestions().length) {
          <div class="sf-sub">Where you've used Claude Code lately</div>
          @for (s of suggestions(); track s.path) {
            <div class="sf-row">
              <span class="sf-path" [title]="s.path">{{ s.path }}</span>
              <span class="sf-meta">{{ s.sessions }} session{{ s.sessions === 1 ? '' : 's' }} · {{ relTime(s.lastActivityAt) }}</span>
              <button class="btn sm" type="button" [disabled]="saving()" (click)="add(s.path)">Add</button>
            </div>
          }
        }
        <div class="sf-add">
          <input type="text" placeholder="Or a folder's full path, e.g. C:\\Development\\old-project" [value]="typed()" (input)="typed.set($any($event.target).value)" (keydown.enter)="add(typed())" [disabled]="saving()">
          <button class="btn sm" type="button" [disabled]="saving() || !typed().trim()" (click)="add(typed())">Add</button>
        </div>
      </div>
    </div>
  `,
})
export class SessionFoldersComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly folders = signal<SessionFolder[]>([]);
  readonly suggestions = signal<SessionFoldersResponse['suggestions']>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly typed = signal('');
  readonly relTime = relTime;

  constructor() {
    this.api.get<SessionFoldersResponse>('/api/sessions/folders')
      .then((r) => this.show(r))
      .catch((e) => this.toast.error((e as Error).message))
      .finally(() => this.loading.set(false));
  }

  add(p: string): void {
    const path = p.trim();
    if (!path) return;
    this.save([...this.folders(), { path, auto: false }], () => this.typed.set(''));
  }
  remove(f: SessionFolder): void { this.save(this.folders().filter((x) => x !== f)); }
  setAuto(f: SessionFolder, auto: boolean): void { this.save(this.folders().map((x) => (x === f ? { ...x, auto } : x))); }

  private async save(folders: SessionFolder[], done?: () => void): Promise<void> {
    this.saving.set(true);
    try {
      const r = await this.api.post<{ folders: SessionFolder[] }>('/api/sessions/folders', { folders: folders.map(({ path, auto }) => ({ path, auto })) });
      this.folders.set(r.folders);
      // What's chosen now isn't suggested any more (the server works suggestions out only when the page loads).
      const chosen = new Set(r.folders.map((f) => f.path.toLowerCase()));
      this.suggestions.update((list) => list.filter((s) => !chosen.has(s.path.toLowerCase())));
      done?.();
    } catch (e) {
      this.toast.error((e as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  private show(r: SessionFoldersResponse): void {
    this.folders.set(r.folders);
    this.suggestions.set(r.suggestions);
  }
}

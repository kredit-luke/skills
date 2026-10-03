import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { AppStatus, WorkspaceStatus } from '../../../../shared/api';
import { DataService } from '../core/data.service';
import { AppButtonsComponent } from './app-buttons.component';

/** One workspace's apps: status dot, name, buttons and port link per app (Workspaces page + run Apps tab). */
@Component({
  selector: 'dash-workspace-apps',
  imports: [AppButtonsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .toolbar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; padding: 0.75rem 1.1rem; border-bottom: 1px solid var(--line-soft); }
    .toolbar .count { font-size: 0.75rem; color: var(--text-muted); }
    .toolbar .grow { flex: 1; }
    .links { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    /* Hairline grid via cell borders (a gap+background grid paints empty trailing cells grey). */
    .apps { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); overflow: hidden; }
    .app { background: var(--surface); padding: 1rem 1.25rem; display: flex; align-items: center; gap: 0.75rem; border-right: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); margin: 0 -1px -1px 0; }
    .app:hover { background: var(--surface-hover); }
    .app.off { opacity: 0.5; }
    .app-info { flex: 1; min-width: 0; }
    .app-name { font-size: 0.875rem; font-weight: 500; margin-bottom: 0.15rem; }
    .app-type { font-size: 0.7rem; color: var(--text-muted); }
    .fallback { font-size: 0.7rem; color: var(--text-muted); margin-top: 0.15rem; }
    .fallback.down { color: var(--red); }
  `],
  template: `
    @let ws = workspace();
    @if (toolbar()) {
      <div class="toolbar">
        <span class="count">{{ countLabel() }}</span>
        @if (running().length) {
          <span class="links">@for (a of running(); track a.key) { @if (a.url) { <a class="app-url running" [href]="a.url" target="_blank" rel="noopener" [title]="a.name">{{ a.name }} :{{ a.port }}</a> } @else { <span class="app-url running" [title]="a.name">{{ a.name }}</span> } }</span>
        }
        <span class="grow"></span>
        @if (avail().length) {
          @if (anyBusy()) { <span class="busy-label"><span class="spin"></span>working…</span> }
          @else {
            @if (platformDown()) { <button class="btn primary sm" (click)="startStack()" [title]="stack()?.hint || stack()?.description || ''">Start stack</button> }
            @if (running().length) { <button class="btn danger sm" (click)="stopAll()">Stop all</button> }
          }
        }
      </div>
    }
    <div class="apps">
      @for (app of ws.apps; track app.key) {
        <div class="app" [class.off]="!app.available && !app.fallback">
          <span [class]="'status-dot ' + dotClass(app)"></span>
          <div class="app-info"><div class="app-name">{{ app.name }}</div><div class="app-type">{{ app.type }}</div>
            @if (app.fallback; as fb) {
              <div class="fallback" [class.down]="!fb.running" [title]="'Apps in this worktree reach the main workspace\\'s ' + app.name + ' on :' + fb.port">
                {{ app.available ? 'Using main\\'s' : 'Not cloned: using main\\'s' }}{{ fb.running ? '' : ' (down)' }}</div>
            }
            @if (app.available) { <dash-app-buttons [app]="app" [workspace]="ws.slug" style="margin-top:0.4rem" /> }</div>
          @if (!app.available && app.fallback; as fb) { <a class="app-url" [class.running]="fb.running" [class.stopped]="!fb.running" [href]="'http://localhost:' + fb.port" target="_blank" rel="noopener">:{{ fb.port }}</a> }
          @else if (app.port) { <a class="app-url" [class.running]="app.running" [class.stopped]="!app.running" [href]="app.url" target="_blank" rel="noopener">:{{ app.port }}</a> }
          @else { <span class="app-type" title="Ports are allocated on first start">no port yet</span> }
        </div>
      }
    </div>
  `,
})
export class WorkspaceAppsComponent {
  private readonly data = inject(DataService);
  readonly workspace = input.required<WorkspaceStatus>();
  /** Show the count, running-site links and Start stack / Stop all above the grid. */
  readonly toolbar = input(false);

  readonly avail = computed(() => this.workspace().apps.filter((a) => a.available));
  readonly running = computed(() => this.avail().filter((a) => a.running && a.url));
  readonly anyBusy = computed(() => this.avail().some((a) => !!a.busy));
  /** The default stack (apps.json defaultStack): its apps here, and whether any is down. */
  readonly stack = computed(() => { const id = this.data.defaultStack(); return id ? { id, ...this.data.stacks()[id] } : null; });
  readonly platformDown = computed(() => {
    const s = this.stack();
    const p = s ? this.avail().filter((a) => (s.apps || []).includes(a.key)) : [];
    return p.length > 0 && p.some((a) => !a.running);
  });
  readonly countLabel = computed(() => this.avail().filter((a) => a.running).length + '/' + this.avail().length + ' running');

  dotClass(a: AppStatus): string { if (!a.available) return a.fallback ? (a.fallback.running ? 'running' : 'stopped') : 'na'; if (a.busy && !a.running) return 'starting'; return a.running ? 'running' : 'stopped'; }
  startStack(): void { const s = this.stack(); if (s) this.data.appAction({ action: 'start', workspace: this.workspace().slug, stack: s.id }); }
  stopAll(): void { this.data.appAction({ action: 'stop-all', workspace: this.workspace().slug }); }
}

import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from './core/api.service';
import { DataService } from './core/data.service';
import { LaunchService } from './core/launch.service';
import { SearchService } from './core/search.service';
import { ToastService } from './core/toast.service';
import { WorkspaceTitleStrategy } from './core/title.strategy';
import { IconComponent } from './shared/icon.component';
import { LaunchDialogComponent } from './shared/launch-dialog.component';
import { LogsDialogComponent, LogsService } from './shared/logs-dialog.component';
import { RolePromptComponent } from './shared/role-prompt.component';
import { SearchPaletteComponent } from './shared/search-palette.component';

/** `group` starts a labelled section of the sidebar at that item. */
interface NavItem { path: string; label: string; icon: string; exact?: boolean; group?: string }

@Component({
  selector: 'dash-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, LaunchDialogComponent, SearchPaletteComponent, LogsDialogComponent, RolePromptComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          @if (api.workspace()?.logo; as logo) {
            <img [src]="logo" [alt]="api.workspace()!.logoAlt">
          } @else if (api.workspace()?.name) {
            <span class="brand-name">{{ api.workspace()!.name }}</span>
          }
          <span class="brand-label">{{ api.workspace()?.title || 'Workspace dashboard' }}</span>
        </div>
        <button class="search-trigger" type="button" (click)="search.open()" title="Search skills, memory, docs, issues and runs (Ctrl+K)">
          <dash-icon name="search" style="width:15px;height:15px" /><span>Search</span><kbd>Ctrl K</kbd>
        </button>
        <nav class="side-nav">
          @for (n of visibleNav(); track n.path) {
            @if (n.group) { <div class="grp">{{ n.group }}</div> }
            <a [routerLink]="n.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: !!n.exact }" [title]="n.label">
              <dash-icon [name]="n.icon" style="width:17px;height:17px" />
              <span class="lbl-t">{{ n.label }}</span>
              @switch (n.path) {
                @case ('/runs') {
                  @if (data.waitingCount()) { <span class="pill amber" title="Waiting for your answer">{{ data.waitingCount() }}</span> }
                  @if (data.runningCount()) { <span class="pill" title="Running">{{ data.runningCount() }}</span> }
                }
                @case ('/apps') { @if (data.runningJobs()) { <span class="pill">{{ data.runningJobs() }}</span> } }
                @case ('/machine') { @if (machineProblems()) { <span class="pill red" title="Missing requirements">{{ machineProblems() }}</span> } }
              }
            </a>
          }
        </nav>
        <div class="side-foot">
          <div class="live"><span class="dot" [class.off]="!api.connected()"></span><span class="txt">{{ api.connected() ? 'Live' : 'Disconnected' }}</span></div>
          <div class="txt">{{ data.runsToday() }} run{{ data.runsToday() === 1 ? '' : 's' }} today</div>
        </div>
      </aside>
      <main class="content"><div class="wrap"><router-outlet /></div></main>
    </div>
    <dash-launch-dialog />
    <dash-search-palette />
    <dash-logs-dialog />
    <dash-role-prompt />
    @if (toast.current(); as t) { <div class="toast" [class.err]="t.err" role="status">{{ t.msg }}</div> }
  `,
})
export class AppComponent implements OnInit {
  readonly api = inject(ApiService);
  readonly data = inject(DataService);
  readonly search = inject(SearchService);
  readonly toast = inject(ToastService);
  private readonly launch = inject(LaunchService);
  private readonly logs = inject(LogsService);
  private readonly titles = inject(WorkspaceTitleStrategy);

  readonly nav: NavItem[] = [
    { path: '/', label: 'Home', icon: 'home', exact: true },
    { path: '/links', label: 'Links', icon: 'links', group: 'Company' },
    { path: '/docs', label: 'Docs', icon: 'docs' },
    { path: '/reference', label: 'Reference', icon: 'reference' },
    { path: '/issues', label: 'Issues', icon: 'issues' },
    { path: '/ask', label: 'Ask', icon: 'ask', group: 'Claude' },
    { path: '/runs', label: 'Runs', icon: 'runs' },
    { path: '/skills', label: 'Skills', icon: 'skills' },
    { path: '/usage', label: 'Usage', icon: 'usage' },
    { path: '/apps', label: 'Apps', icon: 'apps', group: 'Workspace' },
    { path: '/workspaces', label: 'Workspaces', icon: 'workspaces' },
    { path: '/repos', label: 'Repos', icon: 'repos' },
    { path: '/explore', label: 'Explore', icon: 'explore' },
    { path: '/memory', label: 'Memory', icon: 'memory' },
    { path: '/machine', label: 'Machine', icon: 'machine' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];
  /** The nav minus the pages this person's role hides; a hidden group's first page hands its heading on. */
  readonly visibleNav = computed<NavItem[]>(() => {
    const hidden = new Set(this.api.boot()?.profile?.hiddenPages || []);
    const out: NavItem[] = [];
    let heading: string | undefined;
    for (const n of this.nav) {
      if (n.group) heading = n.group;
      if (hidden.has(n.path.replace(/^\//, ''))) continue;
      out.push(heading ? { ...n, group: heading } : { ...n, group: undefined });
      heading = undefined;
    }
    return out;
  });
  readonly machineProblems = computed(() => this.data.machine()?.problems || 0);

  ngOnInit(): void {
    this.api.loadBoot().then(() => {
      const ws = this.api.workspace();
      if (!ws) return;
      // The team's favicon, and "<page> · <title> · <name>" titles (WorkspaceTitleStrategy).
      if (ws.favicon) document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute('href', ws.favicon);
      this.titles.refresh();
    });
    this.data.start();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (this.search.isOpen()) this.search.close(); else this.search.open();
    } else if (e.key === '/' && !typing && !document.querySelector('.modal')) {
      e.preventDefault();
      this.search.open();
    } else if (e.key === 'Escape') {
      if (this.search.isOpen()) this.search.close();
      else if (this.launch.request()) this.launch.close();
      else if (this.logs.request()) this.logs.close();
    }
  }
}

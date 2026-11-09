import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, map } from 'rxjs';
import { ApiService } from './core/api.service';
import type { UpdateInfo } from '../../../shared/api';
import { bootStartedAt, waitForRestart } from './core/restart';
import { DataService } from './core/data.service';
import { navLabel, onboardingNow, rolePromptWanted, shouldAutoOpen } from './core/onboarding';
import { LaunchService } from './core/launch.service';
import { SearchService } from './core/search.service';
import { ToastService } from './core/toast.service';
import { WorkspaceTitleStrategy } from './core/title.strategy';
import { AttentionService } from './core/attention.service';
import { IconComponent } from './shared/icon.component';
import { LaunchDialogComponent } from './shared/launch-dialog.component';
import { LogsDialogComponent, LogsService } from './shared/logs-dialog.component';
import { RolePromptComponent } from './shared/role-prompt.component';
import { SearchPaletteComponent } from './shared/search-palette.component';

/**
 * `group` starts a labelled section of the sidebar at that item. `needs`: a boot field the
 * page depends on; while it's null the page isn't in the nav (meetings: meetings.json).
 */
interface NavItem { path: string; label: string; icon: string; exact?: boolean; group?: string; needs?: 'meetings' }

/** A sidebar section: its heading (none for the top one), the pages showing, and how many the toggle covers (0: no toggle). */
interface NavSection { key: string; group?: string; shown: NavItem[]; open: boolean; more: number; toggleLabel: string }

/** Pages a section shows before its Show more toggle. */
const NAV_SECTION_MAX = 4;
/** The sections someone opened, as a JSON array of group names. */
const NAV_OPEN_KEY = 'dash.nav.open';

function readOpenSections(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(NAV_OPEN_KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Whether the page at `path` is this nav item's (routerLinkActive's rule: exact, or the item's path and below). */
function isActivePath(n: NavItem, path: string): boolean {
  return path === n.path || (!n.exact && path.startsWith(n.path + '/'));
}

/** Set once Get started has opened by itself in this tab, so it doesn't again until the next session. */
const SETUP_OPENED = 'dash.setup.opened';

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
          @if (setupLabel(); as l) {
            <!-- Get started, on top while required steps are left (pages/setup). -->
            <a routerLink="/setup" routerLinkActive="active" class="setup-nav" [title]="l">
              <dash-icon name="bolt" style="width:17px;height:17px" />
              <span class="lbl-t">{{ l }}</span>
            </a>
          }
          @for (sec of navSections(); track sec.key) {
            @if (sec.group) { <div class="grp">{{ sec.group }}</div> }
            @for (n of sec.shown; track n.path) {
            <a [routerLink]="n.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: !!n.exact }" [title]="n.label">
              <dash-icon [name]="n.icon" style="width:17px;height:17px" />
              <span class="lbl-t">{{ n.label }}</span>
              @switch (n.path) {
                @case ('/runs') {
                  @if (data.activityWaiting()) { <span class="pill amber" title="Waiting for your answer">{{ data.activityWaiting() }}</span> }
                  @if (data.runningCount()) { <span class="pill" title="Running">{{ data.runningCount() }}</span> }
                }
                @case ('/apps') { @if (data.runningJobs()) { <span class="pill">{{ data.runningJobs() }}</span> } }
                @case ('/knowledge') { @if (knowledgeStale()) { <span class="pill amber" title="Notes past their review date">{{ knowledgeStale() }}</span> } }
                @case ('/connections') { @if (connectionProblems()) { <span class="pill red" title="Servers your team relies on that aren't working for you">{{ connectionProblems() }}</span> } }
                @case ('/machine') { @if (machineProblems()) { <span class="pill red" title="Missing requirements">{{ machineProblems() }}</span> } }
              }
            </a>
            }
            @if (sec.more) {
              <!-- The section's name in the title and aria-label: in the narrow sidebar headings and text are hidden. -->
              <button type="button" class="nav-more" (click)="toggleSection(sec.key)" [attr.aria-expanded]="sec.open"
                [title]="sec.toggleLabel" [attr.aria-label]="sec.toggleLabel">
                <dash-icon [name]="sec.open ? 'chevron-up' : 'chevron-down'" style="width:15px;height:15px" />
                <span class="lbl-t">{{ sec.open ? 'Show less' : 'Show ' + sec.more + ' more' }}</span>
              </button>
            }
          }
        </nav>
        <div class="side-foot">
          <div class="live"><span class="dot" [class.off]="!api.connected()"></span><span class="txt">{{ api.connected() ? 'Live' : 'Disconnected' }}</span></div>
          <div class="txt">{{ data.runsToday() }} run{{ data.runsToday() === 1 ? '' : 's' }} today</div>
          @if (api.boot()?.version; as v) {
            <div class="txt ver">
              <span title="Engine version">v{{ v }}</span>
              @if (!api.hosted()) {
                @switch (restarting()) {
                  @case ('restarting') { <span class="restarting"><span class="spin"></span> restarting…</span> }
                  @case ('failed') { <button type="button" class="restart" (click)="restart()" title="It didn't come back: see .claude/ledger/dashboard-restart.log">retry restart</button> }
                  @default { <button type="button" class="restart" (click)="restart()" title="Restart the dashboard server (picks up engine updates)">restart</button> }
                }
              }
            </div>
          }
          @if (update(); as u) {
            <div class="txt ver update">
              <button type="button" class="restart" (click)="upgrade()" [title]="'Natterjack ' + u.latest + ' is out (this dashboard runs ' + u.current + '). Click to run /natterjack:upgrade.'">v{{ u.latest }} available</button>
              @if (u.notes) { <a class="restart" [href]="u.notes" target="_blank" rel="noopener" title="What's new">notes</a> }
            </div>
          }
        </div>
      </aside>
      <main class="content"><div class="wrap"><router-outlet /></div></main>
    </div>
    <dash-launch-dialog />
    <dash-search-palette />
    <dash-logs-dialog />
    @if (rolePrompt()) { <dash-role-prompt /> }
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
  private readonly router = inject(Router);
  /** Started here: the app badge, title count, chime and notifications for runs waiting on you. */
  private readonly attention = inject(AttentionService);

  readonly nav: NavItem[] = [
    { path: '/', label: 'Home', icon: 'home', exact: true },
    { path: '/standup', label: 'My updates', icon: 'standup' },
    { path: '/issues', label: 'Issues', icon: 'issues', group: 'Company' },
    { path: '/meetings', label: 'Meetings', icon: 'meetings', needs: 'meetings' },
    { path: '/infrastructure', label: 'Infrastructure', icon: 'infrastructure' },
    { path: '/links', label: 'Links', icon: 'links' },
    { path: '/knowledge', label: 'Knowledge', icon: 'docs' },
    { path: '/ask', label: 'Ask', icon: 'ask', group: 'Agents' },
    { path: '/runs', label: 'Activity', icon: 'runs' },
    { path: '/factory', label: 'Factory', icon: 'factory' },
    { path: '/reviews', label: 'Reviews', icon: 'reviews' },
    { path: '/loops', label: 'Loops', icon: 'loops' },
    { path: '/skills', label: 'Skills', icon: 'skills' },
    { path: '/models', label: 'Models', icon: 'models' },
    { path: '/connections', label: 'Connections', icon: 'connections' },
    { path: '/usage', label: 'Usage', icon: 'usage' },
    { path: '/apps', label: 'Apps', icon: 'apps', group: 'Workspace' },
    { path: '/workspaces', label: 'Workspaces', icon: 'workspaces' },
    { path: '/explore', label: 'Explore', icon: 'explore' },
    { path: '/people', label: 'People', icon: 'people' },
    { path: '/repos', label: 'Repos', icon: 'repos' },
    { path: '/memory', label: 'Memory', icon: 'memory' },
    { path: '/machine', label: 'Machine', icon: 'machine' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];
  /** The nav minus the pages this person's role hides and the ones this workspace hasn't set up; a hidden group's first page hands its heading on. */
  readonly visibleNav = computed<NavItem[]>(() => {
    const boot = this.api.boot();
    const hidden = new Set(boot?.profile?.hiddenPages || []);
    const out: NavItem[] = [];
    let heading: string | undefined;
    for (const n of this.nav) {
      if (n.group) heading = n.group;
      if (hidden.has(n.path.replace(/^\//, '')) || (n.needs && !boot?.[n.needs])) continue;
      out.push(heading ? { ...n, group: heading } : { ...n, group: undefined });
      heading = undefined;
    }
    return out;
  });
  /** Sections of the sidebar whose hidden items are showing, per browser (localStorage). */
  private readonly openSections = signal<Set<string>>(readOpenSections());
  /**
   * The visible nav split at its group headings. A section shows its first NAV_SECTION_MAX
   * pages, then a Show more toggle; the page you're on stays in view while it's collapsed.
   */
  readonly navSections = computed<NavSection[]>(() => {
    const path = this.url().split(/[?#]/)[0];
    const sections: { key: string; group?: string; items: NavItem[] }[] = [];
    for (const n of this.visibleNav()) {
      if (n.group || !sections.length) sections.push({ key: n.group || '', group: n.group, items: [] });
      sections[sections.length - 1].items.push(n);
    }
    return sections.map((s) => {
      const open = this.openSections().has(s.key);
      const extra = s.group ? s.items.slice(NAV_SECTION_MAX) : [];
      const shown = open || !extra.length ? s.items
        : [...s.items.slice(0, NAV_SECTION_MAX), ...extra.filter((n) => isActivePath(n, path))];
      // Open: the toggle reads Show less. Shut: it counts what's still hidden (none if the only extra is the page you're on).
      const more = open ? extra.length : s.items.length - shown.length;
      const toggleLabel = open ? `Show fewer ${s.group} pages` : `Show ${more} more ${s.group} page${more === 1 ? '' : 's'}`;
      return { key: s.key, group: s.group, open, shown, more, toggleLabel };
    });
  });
  toggleSection(key: string): void {
    this.openSections.update((set) => {
      const next = new Set(set);
      if (!next.delete(key)) next.add(key);
      try { localStorage.setItem(NAV_OPEN_KEY, JSON.stringify([...next])); } catch { /* private mode: this tab only */ }
      return next;
    });
  }
  readonly machineProblems = computed(() => this.data.machine()?.problems || 0);
  readonly connectionProblems = computed(() => this.data.connections()?.problems || 0);
  /** Get started: the page's count once loaded, the boot payload's before. */
  private readonly setup = computed(() => onboardingNow(this.api.boot()?.onboarding, this.data.onboarding()));
  readonly setupLabel = computed(() => (this.setup().enabled ? navLabel(this.setup().remaining) : null));
  /** The page they're on, for the role modal (it stays away from /setup, where the role step asks). */
  private readonly url = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map(() => this.router.url)), { initialValue: this.router.url });
  /** Until openSetup() has decided whether to open /setup by itself (Home holds the role modal till then). */
  private readonly autoOpening = signal(true);
  /** The old role modal only where Get started doesn't ask (it's off, its role step is, or they aren't on it). */
  readonly rolePrompt = computed(() => rolePromptWanted(this.api.boot(), this.data.onboarding(), this.url(), this.autoOpening()));
  readonly knowledgeStale = computed(() => this.data.docSites().reduce((n, s) => n + (s.stale || 0), 0));

  /**
   * A newer Natterjack release (GET /api/update, from asknatterjack.com/version.json), offered to
   * people who build on a local dashboard: a hosted one's engine comes with its image.
   */
  private readonly updateInfo = signal<UpdateInfo | null>(null);
  readonly update = computed(() => {
    const u = this.updateInfo();
    return u?.available && !this.api.hosted() && this.api.boot()?.profile?.current !== 'reader' ? u : null;
  });

  upgrade(): void {
    this.launch.open({ prompt: '/natterjack:upgrade', title: 'Upgrade Natterjack' });
  }

  /** Asks again after the server's first check, then hourly (the server checks twice a day). */
  private pollUpdate(delayMs = 30_000): void {
    setTimeout(async () => {
      try { this.updateInfo.set(await this.api.get<UpdateInfo>('/api/update')); } catch {}
      if (this.updateInfo()?.enabled !== false) this.pollUpdate(60 * 60_000);
    }, delayMs);
  }

  /** The Restart link in the sidebar footer: idle, waiting for the new server, or it didn't come back. */
  readonly restarting = signal<'idle' | 'restarting' | 'failed'>('idle');

  async restart(): Promise<void> {
    if (this.restarting() === 'restarting') return;
    const running = this.data.runningCount();
    const warn = running
      ? `Restart the dashboard? ${running} run${running === 1 ? ' is' : 's are'} in progress and will be interrupted (reply to one to carry on). Apps keep running.`
      : 'Restart the dashboard? It comes back in a few seconds (longer if the engine changed and the UI needs rebuilding). Apps keep running.';
    if (!confirm(warn)) return;
    const before = this.api.boot()?.startedAt || '';
    try {
      await this.api.post('/api/restart');
    } catch (e) {
      this.toast.error((e as Error).message);
      return;
    }
    this.restarting.set('restarting');
    this.toast.show('Restarting the dashboard…');
    if (await waitForRestart(before, bootStartedAt)) {
      location.reload();
      return;
    }
    this.restarting.set('failed');
    this.toast.error("The dashboard didn't come back. Start it in a terminal; .claude/ledger/dashboard-restart.log says what happened.");
  }

  ngOnInit(): void {
    this.api.loadBoot().then(() => {
      const ws = this.api.workspace();
      if (!ws) { this.autoOpening.set(false); return; }
      // The team's favicon, and "<page> · <title> · <name>" titles (WorkspaceTitleStrategy).
      if (ws.favicon) document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute('href', ws.favicon);
      this.titles.refresh();
      if (!this.api.hosted()) this.pollUpdate();
      this.openSetup();
    });
    this.data.start();
  }

  /**
   * Load Get started for the sidebar count, and open it on a first visit to Home while required steps
   * are left (once per session). Before the server's first evaluation the boot has no count: wait for it.
   */
  private async openSetup(): Promise<void> {
    try {
      const boot = this.api.boot()?.onboarding;
      if (!boot?.enabled) return;
      const loading = this.data.loadOnboarding();
      if (boot.remaining === null) await loading;
      if (!this.router.navigated) await firstValueFrom(this.router.events.pipe(filter((e) => e instanceof NavigationEnd)));
      if (!shouldAutoOpen(onboardingNow(boot, this.data.onboarding()), this.router.url, !!sessionStorage.getItem(SETUP_OPENED))) return;
      sessionStorage.setItem(SETUP_OPENED, '1');
      await this.router.navigateByUrl('/setup');
    } finally { this.autoOpening.set(false); }
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

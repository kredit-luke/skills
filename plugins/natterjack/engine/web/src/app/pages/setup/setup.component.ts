import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { GithubLoginStatus, Job, OnboardingCheck, OnboardingResponse, OnboardingStep, ProfileInfo, RoleInfo } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { CommandsService } from '../../core/commands.service';
import { DataService } from '../../core/data.service';
import { allRequiredDone, currentStepId, focusReload, helpRequest } from '../../core/onboarding';
import { ToastService } from '../../core/toast.service';
import { copyText, relTime } from '../../core/util';
import { AtlassianConnectComponent } from '../../shared/atlassian-connect.component';
import { LogsService } from '../../shared/logs-dialog.component';
import { PageHeaderComponent } from '../../shared/page-header.component';

/** How long a step still `checking` (the MCP health check) waits before asking again. */
const CHECKING_POLL_MS = 4000;

/**
 * Get started: one checklist of what this person needs (role, sign-ins, the Atlassian secret, the
 * code, the toolchain, MCP servers, the team's own steps), each step's state from the check the
 * dashboard already has for it (server/src/onboarding.ts). The actions are the other pages' own
 * calls: /api/profile, the Machine page's install and sign-in flows, Clone missing / Download code,
 * Connect to Atlassian. "I'll finish later" stops it opening by itself; Settings reopens it.
 */
@Component({
  selector: 'dash-setup',
  imports: [PageHeaderComponent, RouterLink, AtlassianConnectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './setup.component.scss',
  templateUrl: './setup.component.html',
})
export class SetupComponent implements OnInit, OnDestroy {
  readonly api = inject(ApiService);
  readonly data = inject(DataService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly commands = inject(CommandsService);
  private readonly logs = inject(LogsService);

  readonly hosted = this.api.hosted;
  readonly o = this.data.onboarding;
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly steps = computed(() => this.o()?.steps || []);
  readonly current = computed(() => currentStepId(this.steps()));
  readonly finished = computed(() => allRequiredDone(this.steps()));
  private readonly byId = computed(() => new Map(this.steps().map((s) => [s.id, s])));
  /** Cards opened or closed by hand; the rest follow the rule (the current step open, the others shut). */
  readonly toggled = signal<Record<string, boolean>>({});
  readonly sub = computed(() => this.o()?.intro || 'A few things to set up before the dashboard can do everything for you. Each step checks itself, so you can come back to it any time.');
  readonly meta = computed(() => {
    const o = this.o();
    if (!o?.enabled) return '';
    return (o.remaining ? `${o.remaining} left · ` : 'All set · ') + 'checked ' + relTime(o.checkedAt);
  });
  /** The what-next card's pages, minus the ones this person's role hides. */
  private readonly hiddenPages = computed(() => new Set(this.api.boot()?.profile?.hiddenPages || []));
  readonly showAsk = computed(() => !this.hiddenPages().has('ask'));
  readonly showIssues = computed(() => !this.hiddenPages().has('issues'));

  /** The role step's choices (GET /api/profile), loaded when it's on the list and not done. */
  readonly roles = signal<RoleInfo[] | null>(null);
  readonly roleSaving = signal(false);
  readonly installing = signal<string | null>(null);
  readonly secretSaving = signal(false);
  readonly secretError = signal<string | null>(null);
  readonly ticking = signal<string | null>(null);
  readonly jobStarting = signal(false);
  /** Hosted Claude sign-in (as on the Machine page): the URL to open once started. */
  readonly signInUrl = signal<string | null>(null);
  readonly signingIn = signal(false);
  /** Hosted GitHub sign-in: the device code and page, polled until GitHub says yes. */
  readonly ghCode = signal<string | null>(null);
  readonly ghUrl = signal('https://github.com/login/device');
  readonly ghBusy = signal(false);
  private ghPoll: ReturnType<typeof setInterval> | null = null;
  private checkingPoll: ReturnType<typeof setTimeout> | null = null;
  /** An Install or Sign in button opened a terminal or a sign-in page: the next focus checks everything again. */
  private openedElsewhere = false;

  /** The latest Clone / Download job in main (the Repos page's too), for the Code step's progress. */
  readonly job = computed<Job | null>(() => this.data.jobs().find((j) => j.workspace === 'main' && /^(Clone|Download)\b/.test(j.label)) || null);
  readonly jobRunning = computed(() => this.job()?.status === 'running');

  constructor() {
    // A step still checking (the MCP health check runs once, in the background): ask again shortly.
    effect(() => {
      const checking = this.steps().some((s) => s.state === 'checking');
      untracked(() => {
        if (this.checkingPoll) { clearTimeout(this.checkingPoll); this.checkingPoll = null; }
        if (checking) this.checkingPoll = setTimeout(() => { this.checkingPoll = null; this.reload(false); }, CHECKING_POLL_MS);
      });
    });
    effect(() => {
      const role = this.steps().find((s) => s.kind === 'role');
      if (role && role.state !== 'done' && !untracked(this.roles)) {
        untracked(() => this.api.get<ProfileInfo>('/api/profile').then((p) => this.roles.set(p.roles), () => {}));
      }
    });
  }

  async ngOnInit(): Promise<void> {
    this.data.loadJobs();
    await this.reload(false);
    this.loaded.set(true);
  }

  ngOnDestroy(): void {
    this.stopGithubPoll();
    if (this.checkingPoll) clearTimeout(this.checkingPoll);
  }

  /** force: run the Machine checks and `claude auth status` again (Re-check, and coming back from a terminal). */
  async reload(force: boolean): Promise<void> {
    if (force) this.busy.set(true);
    await this.data.loadOnboarding(force);
    if (force) { this.busy.set(false); this.data.loadMachine(false); } // the sidebar's Machine count from the fresh report
  }

  private apply(r: OnboardingResponse): void { this.data.onboarding.set(r); }

  // ---------------------------------------------------------------- the cards

  isOpen(s: OnboardingStep): boolean { return this.toggled()[s.id] ?? s.id === this.current(); }
  toggle(s: OnboardingStep): void { this.toggled.update((t) => ({ ...t, [s.id]: !this.isOpen(s) })); }

  /** "Do Sign in to GitHub first": open that card and move focus to it. */
  goTo(id: string): void {
    this.toggled.update((t) => ({ ...t, [id]: true }));
    setTimeout(() => document.getElementById('step-h-' + id)?.focus());
  }

  labelOf(id: string): string { return this.byId().get(id)?.label || id; }
  stateLabel(s: OnboardingStep): string {
    if (s.state === 'done') return 'Done';
    if (s.state === 'blocked') return 'Waiting';
    if (s.state === 'checking') return 'Checking…';
    return s.optional ? 'Optional' : 'To do';
  }

  async copy(text: string): Promise<void> { if (await copyText(text)) this.toast.show('Copied'); }
  async copyRequest(s: OnboardingStep): Promise<void> {
    if (await copyText(helpRequest(s, this.api.workspace()?.name || ''))) this.toast.show('Copied: paste it to ' + (s.contact?.label || 'them'));
    else this.toast.error("Couldn't copy it.");
  }

  /** "I'll finish later": no auto-open and no Home banner (the sidebar item stays while steps are left). */
  async later(): Promise<void> {
    try { this.apply(await this.api.post<OnboardingResponse>('/api/onboarding/dismiss', { dismissed: true })); }
    catch (e) { this.toast.error((e as Error).message); return; }
    this.toast.show('Reopen it any time from the sidebar or Settings.');
    this.router.navigateByUrl('/');
  }

  // ---------------------------------------------------------------- role

  async pickRole(r: RoleInfo): Promise<void> {
    this.roleSaving.set(true);
    try {
      await this.api.post<ProfileInfo>('/api/profile', { role: r.id });
      // The nav and every page read the role at load (this page comes back with it done).
      location.reload();
    } catch (e) {
      this.toast.error((e as Error).message);
      this.roleSaving.set(false);
    }
  }

  // ---------------------------------------------------------------- Machine checks (claude, github, check, machine)

  /** Opens a terminal running the check's install or sign-in (local dashboards), as the Machine page's button does. */
  async install(c: OnboardingCheck): Promise<void> {
    this.installing.set(c.id);
    this.openedElsewhere = true;
    try {
      const r = await this.api.post<{ opened: boolean; command: string }>('/api/machine/install', { id: c.id });
      if (r.opened) this.toast.show('Opened a terminal running: ' + r.command + '. Come back here when it finishes.');
      else { await copyText(r.command); this.toast.error('Couldn\'t open a terminal; copied the command instead.'); }
    } catch (e) { this.toast.error((e as Error).message); }
    finally { setTimeout(() => this.installing.set(null), 3000); }
  }

  /** Hosted: start `claude auth login` on the server and show its sign-in URL. */
  async startSignIn(): Promise<void> {
    this.signingIn.set(true);
    this.openedElsewhere = true;
    try { this.signInUrl.set((await this.api.post<{ url: string }>('/api/claude/login', { action: 'start' })).url); }
    catch (e) { this.toast.error((e as Error).message); }
    finally { this.signingIn.set(false); }
  }

  /** Hosted: hand the code from the sign-in page to the waiting `claude auth login`. */
  async finishSignIn(input: HTMLInputElement): Promise<void> {
    const code = input.value;
    if (!code.trim() || this.signingIn()) return;
    this.signingIn.set(true);
    try {
      const r = await this.api.post<{ ok: boolean; message: string }>('/api/claude/login', { action: 'code', code });
      if (r.ok) {
        this.toast.show(r.message);
        this.signInUrl.set(null);
        // Ask's model list and the slash-command list were loaded signed out: load them again.
        this.data.loadAgents(true);
        this.commands.refresh();
        await this.reload(true);
      } else { this.toast.error(r.message); if (/start again/i.test(r.message)) this.signInUrl.set(null); }
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.signingIn.set(false); }
  }

  cancelSignIn(): void {
    this.signInUrl.set(null);
    this.api.post('/api/claude/login', { action: 'cancel' }).catch(() => {});
  }

  /** Hosted: start `gh auth login` on the server and show GitHub's one-time code. */
  async githubSignIn(): Promise<void> {
    this.ghBusy.set(true);
    this.openedElsewhere = true;
    try {
      const r = await this.api.post<GithubLoginStatus>('/api/github/login', { action: 'start' });
      this.ghCode.set(r.code || null);
      if (r.url) this.ghUrl.set(r.url);
      if (r.code) {
        if (await copyText(r.code)) this.toast.show('Code copied');
        else this.toast.error("Couldn't copy the code: copy it from the page.");
        this.startGithubPoll();
      }
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.ghBusy.set(false); }
  }

  private startGithubPoll(): void {
    this.stopGithubPoll();
    this.ghPoll = setInterval(async () => {
      let r: GithubLoginStatus;
      try { r = await this.api.post<GithubLoginStatus>('/api/github/login', { action: 'status' }); } catch { return; }
      if (r.state === 'done') { this.endGithub(); this.toast.show(r.message || 'Signed in to GitHub.'); await this.reload(true); }
      else if (r.state === 'failed') { this.endGithub(); this.toast.error(r.message || 'GitHub sign-in failed.'); await this.reload(true); }
      else if (r.state === 'idle') this.endGithub();
    }, 2000);
  }
  private stopGithubPoll(): void { if (this.ghPoll) clearInterval(this.ghPoll); this.ghPoll = null; }
  private endGithub(): void { this.stopGithubPoll(); this.ghCode.set(null); }

  cancelGithub(): void {
    this.endGithub();
    this.api.post('/api/github/login', { action: 'cancel' }).catch(() => {});
  }

  // ---------------------------------------------------------------- Atlassian secret

  /** Saved in the ledger (never sent back); the box is cleared whatever happens. */
  async saveSecret(input: HTMLInputElement): Promise<void> {
    const secret = input.value;
    input.value = '';
    if (!secret.trim()) { this.secretError.set('Paste the client secret.'); return; }
    this.secretSaving.set(true);
    this.secretError.set(null);
    try {
      this.apply(await this.api.post<OnboardingResponse>('/api/onboarding/atlassian-secret', { secret }));
      this.toast.show('Saved on this computer. Now connect to Atlassian.');
    } catch (e) { this.secretError.set((e as Error).message); }
    finally { this.secretSaving.set(false); }
  }

  // ---------------------------------------------------------------- code

  /** Clone missing (POST /api/repos/clone) or Download code (POST /api/snapshot/download): a job, its progress below. */
  async getCode(s: OnboardingStep): Promise<void> {
    this.jobStarting.set(true);
    try {
      const r = await this.api.post<{ job: Job }>(s.repos?.via === 'download' ? '/api/snapshot/download' : '/api/repos/clone', {});
      this.toast.show(r.job.label + '…');
      await this.data.loadJobs();
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.jobStarting.set(false); }
  }
  jobDot(j: Job): string { return j.status === 'running' ? 'running' : j.status === 'succeeded' ? 'succeeded' : j.status === 'interrupted' ? 'interrupted' : 'failed'; }
  openJob(j: Job): void { this.logs.open({ title: j.label + ' · ' + j.workspaceName, job: j.id }); }

  // ---------------------------------------------------------------- manual

  async tick(s: OnboardingStep, done: boolean): Promise<void> {
    this.ticking.set(s.id);
    try { this.apply(await this.api.post<OnboardingResponse>('/api/onboarding/tick', { id: s.id, done })); }
    catch (e) { this.toast.error((e as Error).message); }
    finally { this.ticking.set(null); }
  }

  /** Coming back to the tab: check again without making you click, everything when an install terminal or sign-in tab was opened. */
  @HostListener('window:focus')
  onFocus(): void {
    if (this.finished() || this.busy()) return;
    const how = focusReload(this.o(), Date.now(), this.openedElsewhere);
    if (!how) return;
    if (how === 'force') this.openedElsewhere = false;
    this.reload(how === 'force');
  }
}

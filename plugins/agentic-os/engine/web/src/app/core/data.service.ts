import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  DeckResponse, DocSite, Inbox, Job, JobsResponse, MachineReport, Overview, PresetStats,
  RunMeta, RunsResponse, Stack, StatusResponse,
} from '../../../../shared/api';
import { ApiService } from './api.service';
import { ToastService } from './toast.service';

/**
 * App-wide data that several pages and the sidebar share, polled on the same
 * intervals the old dashboard used. Page-specific data (issues, memory, git,
 * run detail) lives with its page.
 */
@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly deck = signal<DeckResponse | null>(null);
  readonly deckError = signal<string | null>(null);
  readonly runs = signal<RunMeta[]>([]);
  readonly stats = signal<Record<string, PresetStats>>({});
  readonly overview = signal<Overview | null>(null);
  readonly status = signal<StatusResponse | null>(null);
  readonly inbox = signal<Inbox | null>(null);
  readonly inboxError = signal<string | null>(null);
  readonly jobs = signal<Job[]>([]);
  readonly stacks = signal<Record<string, Stack>>({});
  /** App groups in display order, and the stack a workspace's Start stack starts (apps.json). */
  readonly appGroups = signal<{ id: string; label: string }[]>([]);
  readonly defaultStack = signal<string | null>(null);
  /** apps.json: null until loaded; false when there isn't one. */
  readonly appsConfigured = signal<boolean | null>(null);
  readonly appsError = signal<string | null>(null);
  readonly machine = signal<MachineReport | null>(null);
  readonly docSites = signal<DocSite[]>([]);
  readonly docsLoaded = signal(false);

  readonly runningCount = computed(() => this.runs().filter((r) => r.status === 'running').length);
  readonly waitingCount = computed(() => this.runs().filter((r) => r.status === 'waiting').length);
  readonly runningJobs = computed(() => this.jobs().filter((j) => j.status === 'running').length);
  readonly runsToday = computed(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const t = d.getTime();
    return this.runs().filter((r) => Date.parse(r.startedAt) >= t).length;
  });
  readonly mainWorkspace = computed(() => this.status()?.workspaces.find((w) => w.slug === 'main') || null);

  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadDeck();
    this.loadRuns();
    this.loadOverview();
    this.loadStatus();
    this.loadInbox(false);
    this.loadJobs();
    this.loadMachine(false);
    setInterval(() => this.loadJobs(), 2000);
    setInterval(() => this.loadRuns(), 3000);
    setInterval(() => this.loadOverview(), 5000);
    setInterval(() => this.loadStatus(), 5000);
    setInterval(() => this.loadDeck(), 30000);
    setInterval(() => this.loadInbox(false), 60000);
  }

  async loadDeck(): Promise<void> {
    try { this.deck.set(await this.api.get<DeckResponse>('/api/deck')); this.deckError.set(null); }
    catch (e) { this.deckError.set((e as Error).message); }
  }

  async loadRuns(): Promise<void> {
    try {
      const d = await this.api.get<RunsResponse>('/api/runs?limit=200');
      this.runs.set(d.runs.map(normaliseRun));
      this.stats.set(d.stats);
    } catch { /* server restarting */ }
  }

  /** Put a fresher copy of one run into the list (from a stream `meta` or a POST response). */
  upsertRun(run: RunMeta): void {
    const r = normaliseRun(run);
    const list = this.runs();
    const i = list.findIndex((x) => x.id === r.id);
    this.runs.set(i >= 0 ? list.map((x) => (x.id === r.id ? r : x)) : [r, ...list]);
  }

  async loadOverview(): Promise<void> {
    try { this.overview.set(await this.api.get<Overview>('/api/overview')); } catch { /* disconnected flag set by api */ }
  }

  async loadStatus(): Promise<void> {
    try { this.status.set(await this.api.get<StatusResponse>('/api/status')); } catch { /* ignore */ }
  }

  async loadInbox(force: boolean): Promise<void> {
    try { this.inbox.set(await this.api.get<Inbox>('/api/inbox' + (force ? '?force=1' : ''))); this.inboxError.set(null); }
    catch (e) { this.inboxError.set((e as Error).message); }
  }

  async loadJobs(): Promise<void> {
    try {
      const data = await this.api.get<JobsResponse>('/api/apps/jobs');
      const wasRunning = new Set(this.jobs().filter((j) => j.status === 'running').map((j) => j.id));
      this.jobs.set(data.jobs);
      this.stacks.set(data.stacks);
      this.appGroups.set(data.groups || []);
      this.defaultStack.set(data.defaultStack || null);
      this.appsConfigured.set(!!data.configured);
      this.appsError.set(data.error || null);
      for (const j of data.jobs) {
        if (wasRunning.has(j.id) && j.status !== 'running') {
          this.toast.show(j.label + (j.status === 'succeeded' ? ' · done' : ' · failed: ' + (j.error || '')), j.status !== 'succeeded');
          this.loadStatus();
          // Setup changes containers and installs; re-check the machine right away.
          if (j.label.startsWith('Setup')) this.loadMachine(true);
        }
      }
    } catch { /* ignore */ }
  }

  async loadMachine(force: boolean): Promise<void> {
    try {
      this.machine.set(await this.api.get<MachineReport>('/api/machine' + (force ? '?force=1' : '')));
      if (force) this.loadStatus(); // app cards show "Needs …" from this
    } catch (e) {
      if (force) this.toast.error((e as Error).message);
    }
  }

  async loadDocs(): Promise<void> {
    try { this.docSites.set((await this.api.get<{ sites: DocSite[] }>('/api/docs')).sites); this.docsLoaded.set(true); } catch { /* ignore */ }
  }

  /** Start/stop/restart/stop-all/setup for an app, stack or workspace. */
  async appAction(body: { action: string; workspace: string; app?: string; stack?: string }): Promise<void> {
    try {
      const res = await this.api.post<{ job: Job }>('/api/apps/action', body);
      this.toast.show(res.job.label + '…');
      await this.loadJobs();
      this.loadStatus();
    } catch (e) {
      this.toast.error((e as Error).message);
    }
  }
}

/** Older servers don't send the multi-turn fields; give them safe defaults. */
export function normaliseRun(r: RunMeta): RunMeta {
  return {
    ...r,
    planMode: !!r.planMode,
    flagged: !!r.flagged,
    turns: r.turns || 1,
    question: r.question || null,
    warning: r.warning || null,
    turnStartedAt: r.turnStartedAt || null,
  };
}

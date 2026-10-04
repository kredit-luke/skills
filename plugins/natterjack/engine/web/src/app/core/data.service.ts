import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  AgentInfo, ConnectionsResponse, DeckResponse, DocSite, DocsResponse, KnowledgeArea, Inbox, Job, JobsResponse, MachineReport, ModelsView, Overview, PresetStats,
  RunMeta, RunsResponse, Stack, StatusResponse,
} from '../../../../shared/api';
import { ApiService } from './api.service';
import { ToastService } from './toast.service';

/**
 * App-wide data that several pages and the sidebar share. The server pushes it on
 * one stream (/api/events) while the tab is visible; if the stream can't connect
 * this falls back to polling on the old intervals. The load* methods stay for
 * pages that want a refresh right after an action. Page-specific data (issues,
 * memory, git, run detail) lives with its page.
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
  /** The agent CLIs runs can use (Claude, Copilot, Codex): installed, signed in, models. Null until loaded. */
  readonly agents = signal<AgentInfo[] | null>(null);
  /** Local and team open models (Models page); null until the stream sends it. */
  readonly models = signal<ModelsView | null>(null);
  /** MCP servers (Connections page and its sidebar count). */
  readonly connections = signal<ConnectionsResponse | null>(null);
  readonly docSites = signal<DocSite[]>([]);
  /** docs.json areas (Knowledge page). */
  readonly docAreas = signal<KnowledgeArea[]>([]);
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
  private es: EventSource | null = null;
  private polls: ReturnType<typeof setInterval>[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadMachine(false);
    this.loadConnections({ wait: true });
    this.loadDocs(); // the sidebar's count of notes due for review
    this.loadAgents();
    if (typeof EventSource === 'undefined') { this.startPolling(); return; }
    // A hidden tab holds no stream: nothing to keep current, and the browser's few connections per host stay free.
    document.addEventListener('visibilitychange', () => (document.hidden ? this.disconnect() : this.connect()));
    if (!document.hidden) this.connect();
  }

  private connect(): void {
    if (this.es) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const es = new EventSource('/api/events');
    this.es = es;
    const on = <T>(event: string, apply: (d: T) => void) => es.addEventListener(event, (m) => {
      if (this.es !== es) return;
      this.api.connected.set(true);
      apply(JSON.parse((m as MessageEvent).data) as T);
    });
    on<JobsResponse>('jobs', (d) => this.applyJobs(d));
    on<RunsResponse>('runs', (d) => this.applyRuns(d));
    on<RunMeta>('run', (r) => this.upsertRun(r));
    on<Overview>('overview', (d) => this.overview.set(d));
    on<StatusResponse>('status', (d) => this.status.set(d));
    on<DeckResponse>('deck', (d) => { this.deck.set(d); this.deckError.set(null); });
    on<Inbox>('inbox', (d) => { this.inbox.set(d); this.inboxError.set(null); });
    on<ModelsView>('models', (d) => this.applyModels(d));
    es.onopen = () => { if (this.es === es) { this.api.connected.set(true); this.stopPolling(); } };
    es.onerror = () => {
      if (this.es !== es) return;
      this.api.connected.set(false);
      // Poll until the stream is back (onopen stops it): a stream that can't connect while
      // plain requests work, such as behind a proxy that buffers it, still gets data.
      this.startPolling();
      // CONNECTING: the browser retries on its own. CLOSED: it gave up; try again later.
      if (es.readyState !== EventSource.CLOSED) return;
      this.es = null;
      this.retry = setTimeout(() => { this.retry = null; if (!document.hidden) this.connect(); }, 10000);
    };
  }

  private disconnect(): void {
    if (this.es) { this.es.close(); this.es = null; }
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.stopPolling();
  }

  /** The intervals the dashboard polled on before the stream. */
  private startPolling(): void {
    if (this.polls.length) return;
    this.loadDeck(); this.loadRuns(); this.loadOverview(); this.loadStatus(); this.loadInbox(false); this.loadJobs();
    this.polls = [
      setInterval(() => this.loadJobs(), 2000),
      setInterval(() => this.loadRuns(), 3000),
      setInterval(() => this.loadOverview(), 5000),
      setInterval(() => this.loadStatus(), 5000),
      setInterval(() => this.loadDeck(), 30000),
      setInterval(() => this.loadInbox(false), 60000),
    ];
  }

  private stopPolling(): void {
    for (const t of this.polls) clearInterval(t);
    this.polls = [];
  }

  async loadDeck(): Promise<void> {
    try { this.deck.set(await this.api.get<DeckResponse>('/api/deck')); this.deckError.set(null); }
    catch (e) { this.deckError.set((e as Error).message); }
  }

  async loadRuns(): Promise<void> {
    try { this.applyRuns(await this.api.get<RunsResponse>('/api/runs?limit=200')); } catch { /* server restarting */ }
  }

  private applyRuns(d: RunsResponse): void {
    this.runs.set(d.runs.map(normaliseRun));
    this.stats.set(d.stats);
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
    try { this.applyJobs(await this.api.get<JobsResponse>('/api/apps/jobs')); } catch { /* ignore */ }
  }

  private applyJobs(data: JobsResponse): void {
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
        if (!this.es) this.loadStatus(); // the stream sends status after a job changes
        // Setup changes containers and installs; re-check the machine right away.
        if (j.label.startsWith('Setup')) this.loadMachine(true);
      }
    }
  }

  async loadMachine(force: boolean): Promise<void> {
    try {
      this.machine.set(await this.api.get<MachineReport>('/api/machine' + (force ? '?force=1' : '')));
      if (force) this.loadStatus(); // app cards show "Needs …" from this
    } catch (e) {
      if (force) this.toast.error((e as Error).message);
    }
  }

  /** wait: until the health check (`claude mcp list`, slow) is in; force: run a new one. */
  async loadConnections(opts: { wait?: boolean; force?: boolean } = {}): Promise<void> {
    const q = [opts.wait ? 'wait=1' : '', opts.force ? 'force=1' : ''].filter(Boolean).join('&');
    try {
      this.connections.set(await this.api.get<ConnectionsResponse>('/api/connections' + (q ? '?' + q : '')));
    } catch (e) {
      if (opts.force) this.toast.error((e as Error).message);
    }
  }

  async loadModels(force = false): Promise<void> {
    try { this.applyModels(await this.api.get<ModelsView>('/api/models' + (force ? '?force=1' : ''))); } catch { /* keep the last */ }
  }

  /** A model downloaded, deleted or reachable changes Claude's model list: reload the agents when the set changes. */
  private applyModels(d: ModelsView): void {
    const key = (m: ModelsView | null) => (m ? [...m.installed.map((x) => x.name + x.ready + x.tools), ...m.endpoints.flatMap((e) => e.models.map((x) => x.routeId)), m.ollama.running].join('|') : '');
    const changed = key(this.models()) !== key(d);
    this.models.set(d);
    if (changed) this.loadAgents();
  }

  async loadAgents(force = false): Promise<void> {
    try { this.agents.set((await this.api.get<{ agents: AgentInfo[] }>('/api/agents' + (force ? '?force=1' : ''))).agents); } catch { /* keep the last list */ }
  }

  async loadDocs(): Promise<void> {
    try {
      const r = await this.api.get<DocsResponse>('/api/docs');
      this.docSites.set(r.sites);
      this.docAreas.set(r.areas || []);
      this.docsLoaded.set(true);
    } catch { /* ignore */ }
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
    queued: r.queued || [],
    queueBlocked: r.queueBlocked || null,
    queueAutoSend: !!r.queueAutoSend,
    turnStartedAt: r.turnStartedAt || null,
  };
}

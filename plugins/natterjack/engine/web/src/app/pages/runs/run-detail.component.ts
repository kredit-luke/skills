import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { Continuation, IssueDetail, RunDetail, RunEvent, RunMeta, RunOutput, SendToHostedResponse, TerminalResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService, normaliseRun } from '../../core/data.service';
import { agentLabel, isRoutedModel } from '../../core/agents';
import { MdPipe } from '../../core/md.pipe';
import { SmallScreenService } from '../../core/small-screen';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { copyText, dur, lsGet, lsSet, relTime, tokens, usd } from '../../core/util';
import { buildThread, countSteps, isOpenModel, openModelSummary, stripAgents, stripSummary, type AgentCard, type ThreadItem } from '../../runs/thread';
import { RunEventCache, type RunEvents } from '../../runs/event-cache';
import { cancelBlockedReason, pendingLabel, pendingText, remoteAllows, remoteBanner, withListRemote } from '../../runs/remote';
import { runTicket } from '../../../../../shared/run-ticket';
import { runWorkspace } from '../../../../../shared/run-workspace';
import { BETWEEN_TURNS } from '../../../../../shared/send-to-hosted';
import { runStatus, toReview } from '../../shared/run-status';
import { RunComposerComponent } from './run-composer.component';
import { RunChangesComponent } from './run-changes.component';
import { RunOutputsComponent } from './run-outputs.component';
import { DiffViewComponent } from '../workspaces/diff-view.component';
import { editDiff, editStat } from '../../runs/edit-diff';
import { AttachmentListComponent } from '../../shared/attachment-list.component';
import { IssueSummaryComponent } from '../../shared/issue-summary.component';
import { WorkspaceAppsComponent } from '../../shared/workspace-apps.component';
import { LongTextComponent } from '../../shared/long-text.component';

type Tab = 'issue' | 'transcript' | 'changes' | 'apps';
/** A tracker lookup: the issue, or why it couldn't be loaded. */
type IssueLookup = { detail: IssueDetail } | { error: string };

const STICK_PX = 80;
/** run-detail.component.scss: the feed's min-height, and what --feed-max-h leaves below the composer. */
const FEED_MIN_PX = 220;
const FEED_SLACK_PX = 64;
/** The top block collapsed to its title line (localStorage), the same on every run. */
const HEADER_COLLAPSED_KEY = 'dash.run.headerCollapsed';
/** Statuses a run can be sent to the hosted dashboard from: between turns (as the server checks). */
const SENDABLE = new Set(BETWEEN_TURNS);
/** Shared by every run page, so it outlives leaving Activity. */
const eventCache = new RunEventCache();

/**
 * One run: header, agent strip, transcript tree and composer. Live via SSE on
 * /api/runs/:id/stream (the new server replays saved events then streams live
 * `event` + `meta` and stays open across turns; the old one closes with `done`),
 * with the backlog from GET /api/runs/:id and dedupe by uuid.
 */
@Component({
  selector: 'dash-run-detail',
  imports: [NgTemplateOutlet, RunComposerComponent, RunChangesComponent, RunOutputsComponent, DiffViewComponent, AttachmentListComponent,
    IssueSummaryComponent, WorkspaceAppsComponent, LongTextComponent, MdPipe, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './run-detail.component.scss',
  templateUrl: './run-detail.component.html',
})
export class RunDetailComponent implements OnDestroy {
  readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);
  private readonly small = inject(SmallScreenService).matches;

  readonly runId = input.required<string>();
  readonly run = signal<RunMeta | null>(null);
  readonly events = signal<RunEvent[]>([]);
  readonly cont = signal<Continuation | null>(null);
  /** Files in the run's outputs folder (GET /api/runs/:id), re-read when a turn starts or ends. */
  readonly outputs = signal<RunOutput[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly terminalCmd = signal<string | null>(null);
  /** Send to hosted is packing the run (git fetches each repo, so it can take a few seconds). */
  readonly sending = signal(false);
  readonly expanded = signal<Set<string>>(new Set());
  readonly now = signal(Date.now());
  /** Issue (its tracker ticket), Transcript, Changes (what the run changed in the code) or Apps (its workspace's). */
  readonly tab = signal<Tab>('transcript');
  readonly changedFiles = signal(0);
  /** Tracker lookups by ticket id, kept across runs so switching back is instant. */
  readonly issues = signal<Record<string, IssueLookup>>({});
  /** The title being edited, or null when not renaming. */
  readonly titleDraft = signal<string | null>(null);
  readonly renaming = signal(false);

  private readonly box = viewChild<ElementRef<HTMLElement>>('transcript');
  private readonly top = viewChild<ElementRef<HTMLElement>>('top');
  private readonly composer = viewChild(RunComposerComponent, { read: ElementRef });
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  private es: EventSource | null = null;
  /** This run's stream has connected at least once (its replay carries the events). */
  private streamOpened = false;
  /** The full events were fetched over plain GET: done at most once per run. */
  private eventsFetched = false;
  /** The open run's events: its entry in the cache, filled in place. */
  private cur: RunEvents = { events: [], seen: new Set(), next: 0, bytes: 0 };
  private contTimer: ReturnType<typeof setInterval> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private stick = true;
  private loadSeq = 0;
  /** The run and turn state the outputs were last read for. */
  private outputsKey = '';

  readonly active = computed(() => this.run()?.status === 'running');
  /**
   * What the page shows: the run, with a mirrored run's `enabled`, `pending` and `lastError` from
   * DataService's copy (runs/remote.ts withListRemote), so the page and its list row agree. Online
   * is the link's (`live`), never the run's own. A pod-local run is `run()`.
   */
  readonly current = computed(() => withListRemote(this.run(), this.data.remoteRuns()));
  /** A mirrored run's computer right now (DataService.remoteLive); null for a pod-local run. */
  readonly live = computed(() => this.data.remoteLive(this.current()));
  /**
   * Mirrored from a linked computer (hosted dashboard, RunMeta.remote): the pod has its meta and
   * events only, so everything but the commands (reply, queue, cancel, plan mode) and the run and
   * stream GETs is refused with 409 and hidden here. The issue lookup is the pod's own route, so it stays.
   */
  readonly mirrored = computed(() => !!this.run()?.remote);
  /** The line above a mirrored run. Reads the shared clock, so "offline" shows without a reload. */
  readonly banner = computed(() => {
    const r = this.current();
    return r?.remote ? remoteBanner(r, this.live(), this.data.now()) : null;
  });
  /** Why Cancel is disabled on a mirrored run (offline, Remote control off, a cancel already on its way); null when it isn't. */
  readonly cancelBlocked = computed(() => {
    const r = this.current();
    return r?.remote ? cancelBlockedReason(r, this.live()) : null;
  });
  /** Small screens: the meta line shows status, model and updated; the rest is behind Details. */
  readonly detailsOpen = signal(false);
  /** The top block shows only the title line and the tabs, so the feed gets the room (a big question in the composer). */
  readonly headerCollapsed = signal(lsGet(HEADER_COLLAPSED_KEY) === '1');
  readonly pendingText = pendingText;
  readonly pendingLabel = pendingLabel;
  /** A pending command being removed from the pod. */
  readonly removing = signal(false);
  /** A PR watch waiting for its next check: the clock ticks so the countdown moves. */
  readonly watching = computed(() => { const r = this.run(); return r?.status === 'succeeded' && !!r.watch && !r.watch.endedAt; });
  readonly st = computed(() => (this.run() ? runStatus(this.run()!) : null));
  /** Finished, unrated and recent: what keeps it under "To review" in Focus. */
  readonly review = computed(() => { const r = this.run(); return !!r && toReview(r); });
  readonly thread = computed(() => {
    const c = this.cont();
    const humans = c ? c.events.filter((e) => e.type === 'human').length : 0;
    const extra: RunEvent[] = c && c.events.length
      ? [{ type: 'divider', text: 'Continued in terminal · ' + humans + ' prompt' + (humans === 1 ? '' : 's') + (c.lastActivityAt ? ' · last activity ' + relTime(c.lastActivityAt) : '') }, ...c.events]
      : [];
    return buildThread([...this.events(), ...extra], { runActive: this.active() });
  });
  /** The subagent strip: collapsed to what's working, what failed and the last few once a run has many. */
  readonly stripOpen = signal(false);
  readonly strip = computed(() => {
    const agents = this.thread().agents;
    const { shown, hidden } = stripAgents(agents);
    return { agents: this.stripOpen() ? agents : shown, hidden, collapsible: hidden > 0, summary: stripSummary(agents), open: openModelSummary(agents) };
  });
  readonly isOpenModel = isOpenModel;
  readonly elapsed = computed(() => {
    const r = this.run();
    if (!r) return '';
    if (r.status === 'running') return dur(this.now() - Date.parse(r.turnStartedAt || r.startedAt));
    return dur(r.durationMs);
  });
  /** The run's workspace, live from the status poll (apps, ports, ticket id). */
  readonly ws = computed(() => { const r = this.run(); return r ? this.data.status()?.workspaces.find((w) => w.slug === r.workspace) || null : null; });
  readonly ticket = computed(() => { const r = this.run(); return r ? runTicket(r, this.ws()?._ticketId) : null; });
  /** Where the run actually worked: a run started in main that created a worktree belongs to that worktree. */
  readonly workWs = computed(() => runWorkspace(this.run(), this.data.status()?.workspaces || [],
    [...this.events(), ...(this.cont()?.events || [])], this.ticket()?.id));
  readonly appsBadge = computed(() => {
    const avail = (this.workWs()?.apps || []).filter((a) => a.available);
    return avail.length ? { text: avail.filter((a) => a.running).length + '/' + avail.length, up: avail.some((a) => a.running) } : null;
  });
  /** What the ticket strip and Issue tab show; null hides both (no ticket, or a guessed one the tracker doesn't know). */
  readonly issue = computed(() => {
    const t = this.ticket();
    if (!t) return null;
    const hit = this.issues()[t.id];
    if (hit && 'error' in hit && !t.sure) return null;
    return { id: t.id, url: (hit && 'detail' in hit && hit.detail.url) || this.api.issueUrl(t.id), loading: !hit, detail: hit && 'detail' in hit ? hit.detail : null, error: hit && 'error' in hit ? hit.error : null };
  });
  /** The tab actually shown: Issue/Apps fall back to Transcript on a run that has neither. */
  readonly view = computed<Tab>(() => {
    const t = this.tab();
    if (t === 'issue' && !this.issue()) return 'transcript';
    if (t === 'apps' && (!this.workWs() || this.api.hosted())) return 'transcript';
    if (t === 'changes' && this.mirrored()) return 'transcript';
    return t;
  });
  readonly ranAs = computed(() => {
    const r = this.run();
    return r && r.effectivePermissionMode && r.effectivePermissionMode !== (r.planMode ? 'plan' : r.permissionMode) ? r.effectivePermissionMode : null;
  });

  /**
   * A hidden tab holds no run stream: the browser allows about 6 connections per host
   * across all its tabs, and a new run's stream queues behind the held ones. Shown
   * again, the stream resumes after the last event it sent.
   */
  private readonly onVisibility = (): void => {
    if (document.hidden) this.closeStream();
    else if (!this.es) this.connect(this.runId());
  };

  /** Small screens: the page scrolls the transcript, so "at the bottom" is the page's (onScroll covers the box). */
  private readonly onWindowScroll = (): void => {
    if (!this.pageScrolls()) return;
    const doc = document.documentElement;
    this.stick = doc.scrollHeight - window.scrollY - window.innerHeight < STICK_PX;
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('scroll', this.onWindowScroll, { passive: true });
    effect(() => {
      const id = this.runId();
      untracked(() => this.load(id));
    });
    // Follow new output only when the reader is already at the bottom: of the transcript box, or on
    // small screens (no height cap) of the page, which then ends with the composer.
    effect(() => {
      this.thread();
      const el = this.box()?.nativeElement;
      if (!el || !this.stick) return;
      setTimeout(() => {
        if (getComputedStyle(el).overflowY !== 'visible') el.scrollTop = el.scrollHeight;
        else if (!el.hidden) window.scrollTo({ top: document.documentElement.scrollHeight });
      });
    });
    this.tick = setInterval(() => { if (this.active() || this.watching()) this.now.set(Date.now()); }, 1000);
    // A turn starting or ending (status, endedAt over the stream's meta): re-read the outputs folder,
    // so a file the last turn made shows without a reload. load() reads them for a newly opened run.
    effect(() => {
      const r = this.run();
      const key = r ? r.id + '|' + r.status + '|' + (r.endedAt || '') : '';
      untracked(() => {
        const prev = this.outputsKey;
        this.outputsKey = key;
        if (r && !r.remote && prev !== key && prev.startsWith(r.id + '|')) this.loadOutputs(r.id);
      });
    });
    effect(() => {
      const t = this.ticket();
      if (t) untracked(() => this.loadIssue(t.id));
    });
    // The sticky top block and the composer change height (prompt, notes, questions, an open strip):
    // their heights go to CSS, so the transcript box fits between them and nothing hides under the top.
    // The top only sticks (.fits) when that leaves the feed its minimum: in a short window, or on a
    // phone (the page scrolls the whole run), a stuck header would cover the transcript or the composer.
    effect((onCleanup) => {
      const top = this.top()?.nativeElement;
      const composer = this.composer()?.nativeElement as HTMLElement | undefined;
      const detail = top?.parentElement;
      if (!top || !detail) return;
      const set = () => {
        const topH = top.offsetHeight, composerH = composer?.offsetHeight ?? 0;
        detail.style.setProperty('--run-top-h', topH + 'px');
        detail.style.setProperty('--composer-h', composerH + 'px');
        detail.classList.toggle('fits', !this.small() && topH + composerH + FEED_SLACK_PX + FEED_MIN_PX <= window.innerHeight);
        // A shrinking box keeps its scrollTop and fires no scroll event: stay on the newest output.
        const box = this.box()?.nativeElement;
        if (box && this.stick && getComputedStyle(box).overflowY !== 'visible') box.scrollTop = box.scrollHeight;
      };
      set();
      const ro = new ResizeObserver(set);
      ro.observe(top);
      if (composer) ro.observe(composer);
      window.addEventListener('resize', set);
      onCleanup(() => { ro.disconnect(); window.removeEventListener('resize', set); });
    });
  }

  private async loadIssue(id: string): Promise<void> {
    if (this.issues()[id]) return;
    let hit: IssueLookup;
    try { hit = { detail: await this.api.get<IssueDetail>('/api/issues/issue?id=' + encodeURIComponent(id)) }; }
    catch (e) { hit = { error: (e as Error).message }; }
    this.issues.set({ ...this.issues(), [id]: hit });
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('scroll', this.onWindowScroll);
    this.closeStream();
    if (this.contTimer) clearInterval(this.contTimer);
    if (this.tick) clearInterval(this.tick);
  }

  // ------------------------------------------------------------ loading + live

  private async load(id: string): Promise<void> {
    this.stripOpen.set(false); // the detail component is reused across runs: each one starts collapsed
    this.detailsOpen.set(false);
    const seq = ++this.loadSeq;
    this.closeStream();
    if (this.contTimer) { clearInterval(this.contTimer); this.contTimer = null; }
    this.run.set(this.data.activityRuns().find((r) => r.id === id) || null);
    // A run opened recently shows its cached events now; its stream sends only the newer ones.
    this.cur = eventCache.open(id);
    this.events.set(this.cur.events);
    this.cont.set(null);
    this.outputs.set([]);
    this.loadError.set(null);
    this.terminalCmd.set(null);
    this.titleDraft.set(null);
    this.expanded.set(new Set());
    // A phone opens a run at its top (the page would otherwise jump to the composer); following starts
    // once the reader scrolls to the bottom.
    this.stick = !this.pageScrolls();
    this.streamOpened = false;
    this.eventsFetched = false;
    // The stream replays the saved events, so this GET only needs the run (a big run's events are megabytes).
    this.connect(id);
    try {
      const d = await this.api.get<RunDetail>('/api/runs/' + encodeURIComponent(id) + '?events=0');
      if (seq !== this.loadSeq) return;
      this.setRun(d.run);
      this.outputs.set(d.outputs || []);
    } catch (e) {
      if (seq === this.loadSeq) this.loadError.set((e as Error).message);
      return;
    }
    // A mirrored run has no terminal continuation on the pod (its /continuation is a 409).
    if (this.run()?.remote) return;
    this.contTimer = setInterval(() => this.pollContinuation(id), 3000);
    this.pollContinuation(id);
  }

  private connect(id: string): void {
    this.closeStream();
    if (document.hidden) return; // onVisibility connects when the tab is shown
    const cur = this.cur;
    // A browser retry sends Last-Event-ID itself; ?after covers a new connection to a run we already have events for.
    const es = new EventSource('/api/runs/' + encodeURIComponent(id) + '/stream' + (cur.next ? '?after=' + (cur.next - 1) : ''));
    this.es = es;
    es.addEventListener('event', (m) => {
      if (this.es !== es) return;
      const { data, lastEventId } = m as MessageEvent<string>;
      if (lastEventId !== '') cur.next = Math.max(cur.next, Number(lastEventId) + 1);
      eventCache.grow(id, data.length);
      this.addEvents([JSON.parse(data)]);
    });
    es.addEventListener('meta', (m) => { if (this.es === es) this.setRun(JSON.parse((m as MessageEvent).data)); });
    es.onopen = () => { if (this.es === es) this.streamOpened = true; };
    // Older server: the stream ends when the run's process does.
    es.addEventListener('done', (m) => {
      if (this.es !== es) return;
      try { const r = JSON.parse((m as MessageEvent).data); if (r) this.setRun(r); } catch { /* ignore */ }
      es.close();
      this.es = null;
      this.data.loadRuns();
    });
    es.onerror = () => {
      if (this.es !== es) return;
      // Never connected (the stream is blocked while plain requests work): the transcript would stay empty.
      if (!this.streamOpened) this.loadEvents(id);
      if (es.readyState !== EventSource.CLOSED) return; // the browser retries on its own (resuming after the last event id)
      this.es = null;
      if (this.active()) setTimeout(() => { if (!this.es && this.runId() === id) this.connect(id); }, 3000);
      else this.loadEvents(id); // a finished run won't be streamed again: fetch what the replay didn't send
    };
  }

  /** The run's events over plain GET, once per run: they can be megabytes, so not on every retry. */
  private async loadEvents(id: string): Promise<void> {
    if (this.eventsFetched) return;
    this.eventsFetched = true;
    try {
      const d = await this.api.get<RunDetail>('/api/runs/' + encodeURIComponent(id));
      if (this.runId() !== id) return;
      this.addEvents(d.events);
      // The GET's events and the stream's ids share one order: resume the stream after them.
      this.cur.next = Math.max(this.cur.next, d.events.length);
      eventCache.grow(id, JSON.stringify(d.events).length);
    } catch { /* the error state is set by load() */ }
  }

  private async loadOutputs(id: string): Promise<void> {
    try {
      const d = await this.api.get<RunDetail>('/api/runs/' + encodeURIComponent(id) + '?events=0');
      if (this.runId() === id) this.outputs.set(d.outputs || []);
    } catch { /* keep the last list */ }
  }

  private closeStream(): void {
    if (this.es) { this.es.close(); this.es = null; }
  }

  private setRun(r: RunMeta): void {
    const run = normaliseRun(r);
    this.run.set(run);
    this.data.upsertRun(run);
  }

  private addEvents(list: RunEvent[]): void {
    const fresh: RunEvent[] = [];
    for (const ev of list) {
      if (!ev) continue;
      const k = ev.uuid || (ev.type + ':' + JSON.stringify(ev).length + ':' + JSON.stringify(ev).slice(0, 160));
      if (this.cur.seen.has(k)) continue;
      this.cur.seen.add(k);
      fresh.push(ev);
    }
    if (!fresh.length) return;
    this.cur.events = [...this.cur.events, ...fresh];
    this.events.set(this.cur.events);
  }

  private async pollContinuation(id: string): Promise<void> {
    const r = this.run();
    if (!r || r.remote || r.status === 'running' || this.runId() !== id || document.hidden) return;
    try {
      const c = await this.api.get<Continuation>('/api/runs/' + encodeURIComponent(id) + '/continuation');
      if (this.runId() !== id) return;
      const prev = this.cont();
      if (!prev || prev.events.length !== c.events.length || prev.lastActivityAt !== c.lastActivityAt) this.cont.set(c);
    } catch { /* 409 while running */ }
  }

  onScroll(): void {
    const el = this.box()?.nativeElement;
    if (el) this.stick = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }

  /**
   * The transcript isn't a scroll container (small screens: no height cap), so the page scrolls it.
   * Before the transcript first renders, the same breakpoint as run-detail.component.scss.
   */
  private pageScrolls(): boolean {
    const el = this.box()?.nativeElement;
    if (el) return getComputedStyle(el).overflowY === 'visible';
    return untracked(this.small);
  }

  // ------------------------------------------------------------ view helpers

  isOpen(key: string): boolean { return this.expanded().has(key); }
  toggle(key: string): void {
    const s = new Set(this.expanded());
    if (s.has(key)) s.delete(key); else s.add(key);
    this.expanded.set(s);
  }

  /** Agent strip click: open the card (and its parents) and jump to it. scrollTop, not smooth scrolling. */
  jumpTo(card: AgentCard): void {
    const s = new Set(this.expanded());
    s.add('agent:' + card.id);
    for (const a of this.thread().agents) if (containsCard(a, card.id)) s.add('agent:' + a.id);
    this.expanded.set(s);
    setTimeout(() => {
      const box = this.box()?.nativeElement;
      const find = (id: string) => box?.querySelector<HTMLElement>(`[data-agent="${CSS.escape(id)}"]`) || null;
      // No card of its own in the transcript: the nearest pass of the same agent, so the click always lands somewhere.
      const sibling = card.agentId ? this.thread().agents.filter((a) => a.agentId === card.agentId && a.id !== card.id)
        .sort((a, b) => Math.abs(a.pass - card.pass) - Math.abs(b.pass - card.pass)).map((a) => find(a.id)).find(Boolean) : null;
      const el = find(card.id) || sibling;
      if (box && el) {
        this.stick = false;
        // Small screens: the transcript has no height cap and the page scrolls instead.
        if (getComputedStyle(box).overflowY === 'visible') el.scrollIntoView({ block: 'start' });
        else box.scrollTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8;
        if (el !== find(card.id)) this.toast.show(`Pass ${card.pass} isn't in the transcript; showing pass ${this.thread().agents.find((a) => find(a.id) === el)?.pass ?? '?'} of the same agent.`);
      } else {
        this.toast.show(`${card.agentType || 'This agent'}'s steps aren't in this transcript.`);
      }
    });
  }

  agentIcon(c: AgentCard): string {
    return c.status === 'completed' ? '✓' : c.status === 'failed' ? '✕' : c.status === 'stopped' ? '■' : '●';
  }
  agentStatus(c: AgentCard): string {
    return c.status === 'starting' ? 'starting' : c.status === 'running' ? (c.background ? 'running in background' : 'running') : c.status;
  }
  steps(c: AgentCard): number { return countSteps(c); }
  tok(n: number): string { return tokens(n); }
  d(ms: number | null): string { return dur(ms); }
  agentName(id: string | null | undefined): string { return agentLabel(id); }
  readonly isRouted = isRoutedModel;
  /** Where a Claude Code run's model ran: this computer's Ollama, a team endpoint, or Claude itself (the person's own sign-in). */
  backendOf(model: string | null | undefined): string {
    if (model?.startsWith('local/')) return 'Ollama on this computer';
    if (model?.startsWith('team/')) return 'team endpoint ' + model.split('/')[1];
    return 'Claude (your sign-in)';
  }
  money(n: number): string { return usd(n); }
  rel(t: string | null | undefined): string { return relTime(t); }
  /** "in 4:32" until the watch's next check, then "now" while the server runs it. */
  countdown(t: string): string {
    const left = Math.ceil((Date.parse(t) - this.now()) / 1000);
    if (!(left > 0)) return 'now';
    const m = Math.floor(left / 60), s = left % 60;
    return 'in ' + m + ':' + String(s).padStart(2, '0');
  }
  started(r: RunMeta): string { return new Date(r.startedAt).toLocaleString(); }
  trackItem(_: number, i: ThreadItem): string { return i.key; }

  // ------------------------------------------------------------ actions

  async cancel(): Promise<void> {
    const r = this.run();
    if (!r) return;
    if (r.remote) {
      // Mirrored: a 202 with the run, its cancel pending until the computer does it.
      try {
        const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + r.id + '/cancel');
        if (res.run) this.setRun(res.run);
        this.toast.show('Cancel sent to your computer');
      } catch (e) { this.toast.error((e as Error).message); }
      return;
    }
    try { await this.api.post('/api/runs/' + r.id + '/cancel'); this.toast.show(r.status === 'waiting' ? 'Cancelled' : 'Cancelling…'); this.data.loadRuns(); this.refreshMeta(); }
    catch (e) { this.toast.error((e as Error).message); }
  }

  /** On a mirrored run, a removable pending command: a queued message the computer hasn't been sent yet. */
  canRemovePending(id: string): boolean {
    const r = this.current();
    return !!r?.remote && remoteAllows(r, 'queue-remove', this.live(), id);
  }

  /** Take a queued message back before it reaches the computer (the pod drops it; works offline). */
  async removePending(id: string): Promise<void> {
    const r = this.run();
    if (!r || this.removing()) return;
    this.removing.set(true);
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + r.id + '/queue-remove', { id });
      if (res.run) this.setRun(res.run);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.removing.set(false); }
  }

  async terminal(): Promise<void> {
    const r = this.run();
    if (!r) return;
    try {
      const res = await this.api.post<TerminalResponse>('/api/runs/' + r.id + '/terminal');
      if (res.run) this.setRun(res.run);
      this.terminalCmd.set(res.command || 'claude --resume ' + r.sessionId);
      if (res.opened) this.toast.show('Opened a terminal on this conversation');
      else if (await copyText(res.command)) this.toast.show('Copied: ' + res.command);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  /** A Claude run between turns, on a local dashboard that has a hosted one (hosting.json `url`). */
  canSendToHosted(): boolean {
    const r = this.run();
    return !!r && !this.api.hosted() && !!this.api.boot()?.hostedUrl && (r.agent || 'claude') === 'claude'
      && SENDABLE.has(r.status) && !r.handoffPendingAt;
  }

  async sendToHosted(): Promise<void> {
    const r = this.run();
    if (!r) return;
    // Opened during the click: a tab opened after the wait would be blocked as a pop-up.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    this.sending.set(true);
    try {
      const res = await this.api.post<SendToHostedResponse>('/api/runs/' + r.id + '/send-to-hosted');
      if (res.run) this.setRun(res.run);
      if (tab) tab.location.href = res.url; else window.open(res.url, '_blank', 'noopener');
      this.toast.show(res.warnings.length ? res.warnings.join(' ') : 'Finish in the hosted dashboard tab');
      this.data.loadRuns();
    } catch (e) {
      tab?.close();
      this.toast.error((e as Error).message);
    } finally {
      this.sending.set(false);
    }
  }

  async cancelSend(): Promise<void> {
    const r = this.run();
    if (!r) return;
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + r.id + '/send-cancel');
      if (res.run) this.setRun(res.run);
      this.toast.show('Send cancelled: the run stays here');
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async copyResume(): Promise<void> {
    const r = this.run();
    if (!r) return;
    const cmd = resumeCommand(r);
    if (await copyText(cmd)) this.toast.show('Copied: ' + cmd); else this.toast.error('Couldn\'t copy; the command is ' + cmd);
  }
  resumeCmd(): string { const r = this.run(); return r ? resumeCommand(r) : ''; }

  toggleHeader(): void {
    const v = !this.headerCollapsed();
    this.headerCollapsed.set(v);
    lsSet(HEADER_COLLAPSED_KEY, v ? '1' : '0');
  }

  editTitle(): void {
    const r = this.run();
    if (!r) return;
    this.titleDraft.set(r.label);
    setTimeout(() => { const el = this.titleInput()?.nativeElement; el?.focus(); el?.select(); });
  }

  cancelTitle(): void { this.titleDraft.set(null); }

  async saveTitle(): Promise<void> {
    const r = this.run();
    const label = (this.titleDraft() || '').trim();
    if (!r || !label) return;
    if (label === r.label) { this.titleDraft.set(null); return; }
    this.renaming.set(true);
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + r.id + '/rename', { label });
      this.setRun(res.run);
      this.titleDraft.set(null);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.renaming.set(false); }
  }

  async verdict(v: 'good' | 'needed-fix'): Promise<void> {
    const r = this.run();
    if (!r) return;
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + r.id + '/verdict', { verdict: r.verdict === v ? null : v });
      this.setRun(res.run);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  readonly watchedPrs = computed(() => (this.run()?.watch?.prs || []).map((p) => p.repo + '#' + p.number).join(', '));

  async stopWatch(): Promise<void> {
    const r = this.run();
    if (!r) return;
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + r.id + '/watch-stop');
      this.setRun(res.run);
      this.toast.show('Stopped watching');
      this.data.loadRuns();
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async toggleFlag(): Promise<void> {
    const r = this.run();
    if (!r) return;
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + r.id + '/flag', { flagged: !r.flagged });
      this.setRun(res.run);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  /** After a reply or plan-mode change: take the new meta, make sure the stream is live. */
  onRunChanged(run: RunMeta): void {
    this.setRun(run);
    this.stick = true;
    if (!this.es) this.connect(run.id);
    this.data.loadRuns();
  }

  private async refreshMeta(): Promise<void> {
    const r = this.run();
    if (!r) return;
    try { const d = await this.api.get<RunDetail>('/api/runs/' + r.id); this.setRun(d.run); this.addEvents(d.events); } catch { /* ignore */ }
  }

  /** Edit/Write/MultiEdit/NotebookEdit: the change itself, as a diff (null for other tools). */
  toolDiff(name: string, input: Record<string, any>): string | null { return editDiff(name, input); }
  toolStat(name: string, input: Record<string, any>): string { return editStat(name, input); }
}

function containsCard(a: AgentCard, id: string): boolean {
  return a.items.some((i) => i.kind === 'agent' && (i.card.id === id || containsCard(i.card, id)));
}

function resumeCommand(r: RunMeta): string {
  const cwd = String(r.cwd || '');
  return (cwd ? 'cd "' + cwd + '"; ' : '') + 'claude --resume ' + r.sessionId;
}

import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { Continuation, IssueDetail, RunDetail, RunEvent, RunMeta, TerminalResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService, normaliseRun } from '../../core/data.service';
import { MdPipe } from '../../core/md.pipe';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { copyText, dur, relTime, tokens, usd } from '../../core/util';
import { buildThread, countSteps, stripAgents, stripSummary, type AgentCard, type ThreadItem } from '../../runs/thread';
import { runTicket } from '../../../../../shared/run-ticket';
import { runWorkspace } from '../../../../../shared/run-workspace';
import { runStatus, toReview } from '../../shared/run-status';
import { RunComposerComponent } from './run-composer.component';
import { RunChangesComponent } from './run-changes.component';
import { DiffViewComponent } from '../workspaces/diff-view.component';
import { editDiff, editStat } from '../../runs/edit-diff';
import { AttachmentListComponent } from '../../shared/attachment-list.component';
import { IssueSummaryComponent } from '../../shared/issue-summary.component';
import { WorkspaceAppsComponent } from '../../shared/workspace-apps.component';

type Tab = 'issue' | 'transcript' | 'changes' | 'apps';
/** A tracker lookup: the issue, or why it couldn't be loaded. */
type IssueLookup = { detail: IssueDetail } | { error: string };

const STICK_PX = 80;

/**
 * One run: header, agent strip, transcript tree and composer. Live via SSE on
 * /api/runs/:id/stream (the new server replays saved events then streams live
 * `event` + `meta` and stays open across turns; the old one closes with `done`),
 * with the backlog from GET /api/runs/:id and dedupe by uuid.
 */
@Component({
  selector: 'dash-run-detail',
  imports: [NgTemplateOutlet, RunComposerComponent, RunChangesComponent, DiffViewComponent, AttachmentListComponent,
    IssueSummaryComponent, WorkspaceAppsComponent, MdPipe, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './run-detail.component.scss',
  templateUrl: './run-detail.component.html',
})
export class RunDetailComponent implements OnDestroy {
  readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  readonly runId = input.required<string>();
  readonly run = signal<RunMeta | null>(null);
  readonly events = signal<RunEvent[]>([]);
  readonly cont = signal<Continuation | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly terminalCmd = signal<string | null>(null);
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
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  private es: EventSource | null = null;
  private seen = new Set<string>();
  private contTimer: ReturnType<typeof setInterval> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private stick = true;
  private loadSeq = 0;

  readonly active = computed(() => this.run()?.status === 'running');
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
    return { agents: this.stripOpen() ? agents : shown, hidden, collapsible: hidden > 0, summary: stripSummary(agents) };
  });
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
    if (t === 'apps' && !this.workWs()) return 'transcript';
    return t;
  });
  readonly ranAs = computed(() => {
    const r = this.run();
    return r && r.effectivePermissionMode && r.effectivePermissionMode !== (r.planMode ? 'plan' : r.permissionMode) ? r.effectivePermissionMode : null;
  });

  constructor() {
    effect(() => {
      const id = this.runId();
      untracked(() => this.load(id));
    });
    // Follow new output only when the reader is already at the bottom.
    effect(() => {
      this.thread();
      const el = this.box()?.nativeElement;
      if (el && this.stick) setTimeout(() => { el.scrollTop = el.scrollHeight; });
    });
    this.tick = setInterval(() => { if (this.active()) this.now.set(Date.now()); }, 1000);
    effect(() => {
      const t = this.ticket();
      if (t) untracked(() => this.loadIssue(t.id));
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
    this.closeStream();
    if (this.contTimer) clearInterval(this.contTimer);
    if (this.tick) clearInterval(this.tick);
  }

  // ------------------------------------------------------------ loading + live

  private async load(id: string): Promise<void> {
    this.stripOpen.set(false); // the detail component is reused across runs: each one starts collapsed
    const seq = ++this.loadSeq;
    this.closeStream();
    if (this.contTimer) { clearInterval(this.contTimer); this.contTimer = null; }
    this.run.set(this.data.runs().find((r) => r.id === id) || null);
    this.events.set([]);
    this.cont.set(null);
    this.loadError.set(null);
    this.terminalCmd.set(null);
    this.titleDraft.set(null);
    this.expanded.set(new Set());
    this.seen = new Set();
    this.stick = true;
    // The stream replays the saved events, so this GET only needs the run (a big run's events are megabytes).
    this.connect(id);
    try {
      const d = await this.api.get<RunDetail>('/api/runs/' + encodeURIComponent(id) + '?events=0');
      if (seq !== this.loadSeq) return;
      this.setRun(d.run);
    } catch (e) {
      if (seq === this.loadSeq) this.loadError.set((e as Error).message);
      return;
    }
    this.contTimer = setInterval(() => this.pollContinuation(id), 3000);
    this.pollContinuation(id);
  }

  private connect(id: string): void {
    this.closeStream();
    const es = new EventSource('/api/runs/' + encodeURIComponent(id) + '/stream');
    this.es = es;
    es.addEventListener('event', (m) => { if (this.es === es) this.addEvents([JSON.parse((m as MessageEvent).data)]); });
    es.addEventListener('meta', (m) => { if (this.es === es) this.setRun(JSON.parse((m as MessageEvent).data)); });
    // Older server: the stream ends when the run's process does.
    es.addEventListener('done', (m) => {
      if (this.es !== es) return;
      try { const r = JSON.parse((m as MessageEvent).data); if (r) this.setRun(r); } catch { /* ignore */ }
      es.close();
      this.es = null;
      this.data.loadRuns();
    });
    es.onerror = () => {
      if (this.es !== es || es.readyState !== EventSource.CLOSED) return; // the browser retries on its own (resuming after the last event id)
      this.es = null;
      if (this.active()) setTimeout(() => { if (!this.es && this.runId() === id) this.connect(id); }, 3000);
      else this.loadEvents(id); // a finished run won't be streamed again: fetch what the replay didn't send
    };
  }

  private async loadEvents(id: string): Promise<void> {
    try {
      const d = await this.api.get<RunDetail>('/api/runs/' + encodeURIComponent(id));
      if (this.runId() === id) this.addEvents(d.events);
    } catch { /* the error state is set by load() */ }
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
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      fresh.push(ev);
    }
    if (fresh.length) this.events.set([...this.events(), ...fresh]);
  }

  private async pollContinuation(id: string): Promise<void> {
    const r = this.run();
    if (!r || r.status === 'running' || this.runId() !== id) return;
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
        box.scrollTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8;
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
  money(n: number): string { return usd(n); }
  rel(t: string | null | undefined): string { return relTime(t); }
  started(r: RunMeta): string { return new Date(r.startedAt).toLocaleString(); }
  trackItem(_: number, i: ThreadItem): string { return i.key; }

  // ------------------------------------------------------------ actions

  async cancel(): Promise<void> {
    const r = this.run();
    if (!r) return;
    try { await this.api.post('/api/runs/' + r.id + '/cancel'); this.toast.show(r.status === 'waiting' ? 'Cancelled' : 'Cancelling…'); this.data.loadRuns(); this.refreshMeta(); }
    catch (e) { this.toast.error((e as Error).message); }
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

  async copyResume(): Promise<void> {
    const r = this.run();
    if (!r) return;
    const cmd = resumeCommand(r);
    if (await copyText(cmd)) this.toast.show('Copied: ' + cmd); else this.toast.error('Couldn\'t copy; the command is ' + cmd);
  }
  resumeCmd(): string { const r = this.run(); return r ? resumeCommand(r) : ''; }

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

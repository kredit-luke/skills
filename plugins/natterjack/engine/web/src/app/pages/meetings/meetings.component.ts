import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, afterNextRender, computed, effect, inject, signal, viewChild, viewChildren } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Meeting, MeetingPage, MeetingsStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { AtlassianConnectComponent } from '../../shared/atlassian-connect.component';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { MeetingDetailComponent } from './meeting-detail.component';
import { MeetingsConnectComponent } from './meetings-connect.component';
import { type TicketSummary, actionCounts, dateLabel, isHttpsUrl, isNotConnected, mergePages, summaryPreview, ticketSummary, timeLabel } from './meetings.util';

/** A meeting as a list row shows it. */
interface Row { m: Meeting; date: string; time: string; actions: { open: number; total: number } | null; preview: string; tickets: TicketSummary | null }

/**
 * The team's meetings from its meeting tool (.claude/dashboard/meetings.json): your meetings,
 * newest first, each with its summary, action items and who was there, and the tickets made
 * from it. Ask agent reads one and proposes tickets for its action items. The selected meeting is ?m=<id>, so links work.
 */
@Component({
  selector: 'dash-meetings',
  imports: [PageHeaderComponent, RouterLink, MeetingsConnectComponent, MeetingDetailComponent, AtlassianConnectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dash-page-header eyebrow="Company" title="Meetings" [sub]="sub()">
      @if (status()?.connected) {
        <button class="btn ghost sm" type="button" (click)="refresh()" [disabled]="refreshing()">{{ refreshing() ? 'Refreshing…' : 'Refresh' }}</button>
      }
    </dash-page-header>

    @if (error()) { <div class="warn-note">{{ error() }}</div> }
    @else if (!status()) { <div class="empty">Loading…</div> }
    @else if (!status()!.configured || !status()!.supported) {
      <div class="panel soon">
        <h2>Meetings aren't available</h2>
        <p>{{ status()!.message }}</p>
      </div>
    } @else if (!status()!.connected) {
      <dash-meetings-connect [status]="status()!" [note]="note()" (connected)="onConnected($event)" />
    } @else {
      <div class="conn-bar">
        <span>Connected to {{ label() }}@if (status()!.viewer) { as <b>{{ status()!.viewer }}</b>}@if (status()!.via === 'token') { with a personal access token}</span>
        <span aria-hidden="true">·</span>
        <button class="linkish" type="button" [disabled]="disconnecting()" (click)="disconnect()">{{ disconnecting() ? 'Disconnecting…' : 'Disconnect' }}</button>
      </div>
      <!-- Tickets made from a meeting are found in Jira as you: without a Jira connection there are none to show. -->
      <dash-atlassian-connect [forTickets]="true" inputId="meetings-atlassian-callback"
        lead="Connect to Atlassian to see the tickets made from these meetings, whoever made them." (connected)="refresh()" />

      <div class="layout">
        <nav #listNav class="panel list" aria-label="Meetings" tabindex="-1">
          @if (listErr() && !meetings().length) {
            <div class="pad"><div class="err-note">{{ listErr() }}</div> <button class="btn ghost sm" type="button" (click)="reload()">Try again</button></div>
          } @else if (!loaded()) {
            <div class="empty">Loading…</div>
          } @else if (!meetings().length) {
            <div class="empty">{{ label() }} has no meetings for you yet.</div>
          } @else {
            <!-- A failed Refresh keeps the list it had, and says so above it. -->
            @if (listErr()) { <div class="pad"><div class="err-note">{{ listErr() }}</div> <button class="btn ghost sm" type="button" (click)="reload()">Try again</button></div> }
            <ul>
              @for (r of rows(); track r.m.id) {
                <!-- The row link and the ticket links are siblings (no link inside a link); the li carries the selected look. -->
                <li [class.sel]="r.m.id === selectedId()">
                  <a #rowLink class="row" [class.with-tix]="!!r.tickets" [routerLink]="[]" [queryParams]="{ m: r.m.id }" queryParamsHandling="merge"
                    [attr.data-id]="r.m.id" [attr.aria-current]="r.m.id === selectedId() ? 'true' : null" (click)="picked(r.m.id, $event)">
                    <span class="top"><span class="ttl">{{ r.m.title }}</span><span class="when">{{ r.date }} {{ r.time }}</span></span>
                    <span class="meta">
                      @if (r.m.host) { <span>{{ r.m.host.name }}</span> · }
                      <span>{{ r.m.participantCount }} {{ r.m.participantCount === 1 ? 'person' : 'people' }}</span>
                      @if (r.actions; as a) { · <span [title]="a.open + ' open of ' + a.total + ' action items'">{{ a.open }}/{{ a.total }} actions open</span> }
                    </span>
                    @if (r.preview) { <span class="pv">{{ r.preview }}</span> }
                  </a>
                  @if (r.tickets; as s) {
                    <div class="tix" [title]="s.text">Tickets:
                      @for (t of s.shown; track t.key; let last = $last) {
                        @if (isHttpsUrl(t.url)) {
                          <a [href]="t.url" target="_blank" rel="noopener" [attr.aria-label]="t.key + (t.title ? ': ' + t.title : '') + ' (opens in a new tab)'">{{ t.key }}</a>
                        } @else { <span>{{ t.key }}</span> }@if (!last) {, }
                      }
                      @if (s.more) { <span role="img" [attr.aria-label]="s.moreText"> (+{{ s.more }})</span> }
                    </div>
                  }
                </li>
              }
            </ul>
            @if (moreErr()) { <div class="pad"><div class="err-note">{{ moreErr() }}</div></div> }
            @if (nextCursor()) {
              <div class="pad more"><button class="btn sm" type="button" [disabled]="loadingMore()" (click)="loadMore()">{{ loadingMore() ? 'Loading…' : 'Load more' }}</button></div>
            }
          }
        </nav>

        @if (selectedId(); as id) {
          <dash-meeting-detail [id]="id" [listed]="selected()" [label]="label()" (closed)="closeDetail()" (notConnected)="onNotConnected()" />
        } @else if (meetings().length) {
          <div class="panel pick"><div class="empty">Pick a meeting to see its summary, action items and who was there.</div></div>
        }
      </div>
    }
  `,
  styles: [`
    .soon { padding: 1.6rem 2rem; max-width: 760px; }
    .soon h2 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
    .soon p { margin: 0; color: var(--ink-soft); line-height: 1.5; }
    .conn-bar { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-soft); margin-bottom: 12px; }
    .conn-bar b { color: var(--ink); font-weight: 600; }
    .layout { display: grid; grid-template-columns: minmax(300px, 400px) minmax(0, 1fr); gap: 16px; align-items: start; }
    @media (max-width: 900px) { .layout { grid-template-columns: minmax(0, 1fr); } }
    .list { min-width: 0; }
    /* Focus lands here only from code (Close with no row to go back to). */
    .list:focus { outline: none; }
    .list ul { list-style: none; margin: 0; padding: 0; }
    .list li + li { border-top: 1px solid var(--line-soft); }
    .list li { border-left: 3px solid transparent; }
    /* Hovering the row link highlights it; hovering a ticket link doesn't. */
    .list li:has(> .row:hover), .list li.sel { background: var(--paper-2); }
    .list li.sel { border-left-color: var(--brand-700); }
    /* The global .row is a centered, rounded flex row: reset both for this stacked list row. */
    .row { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; padding: 12px 16px 12px 13px; border-radius: 0; text-align: left; text-decoration: none; color: inherit; }
    .row.with-tix { padding-bottom: 0; }
    .row:focus-visible { outline: none; box-shadow: var(--ring); }
    /* Its own top padding leaves room for the links' focus ring, which overflow: hidden would clip. */
    .tix { padding: 4px 16px 12px 13px; font-size: 11.5px; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tix a { font-family: var(--font-mono); }
    .tix a:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 3px; }
    .top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .ttl { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; color: var(--ink); line-height: 1.35; overflow-wrap: anywhere; }
    .when { flex-shrink: 0; font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); white-space: nowrap; }
    .meta { font-size: 11.5px; color: var(--ink-faint); overflow-wrap: anywhere; }
    .pv { display: block; min-width: 0; font-size: 12px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pad { padding: 10px 16px; }
    .more { border-top: 1px solid var(--line-soft); text-align: center; }
    .pick { padding: 1rem; }
  `],
})
export class MeetingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly query = toSignal(this.route.queryParamMap);
  private readonly detailView = viewChild(MeetingDetailComponent);
  /** The Connect to Atlassian bar: asked again after each list load, which may have found the sign-in expired. */
  private readonly atlassianBar = viewChild(AtlassianConnectComponent);
  private readonly rowLinks = viewChildren<ElementRef<HTMLAnchorElement>>('rowLink');
  private readonly listNav = viewChild<ElementRef<HTMLElement>>('listNav');
  /** A row was just picked while the layout is stacked: move focus to the detail once it shows. */
  private focusDetail = false;

  readonly status = signal<MeetingsStatus | null>(null);
  readonly error = signal<string | null>(null);
  /** The server's note after a disconnect: what's left to do in the tool by hand. */
  readonly note = signal<string | null>(null);
  readonly disconnecting = signal(false);

  readonly meetings = signal<Meeting[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly listErr = signal<string | null>(null);
  readonly isHttpsUrl = isHttpsUrl;
  readonly moreErr = signal<string | null>(null);
  /** Bumped on every reload, so a page that arrives late for an older list is dropped. */
  private gen = 0;
  /** The check onNotConnected started, while it's in flight. */
  private notConnectedCheck: Promise<void> | null = null;

  readonly label = computed(() => this.status()?.label || this.api.boot()?.meetings?.label || 'your meeting tool');
  readonly sub = computed(() => this.api.copy('meetingsSub', `Your meetings from ${this.label()}: summaries and action items. Ask an agent which action items should become tickets.`));
  readonly selectedId = computed(() => this.query()?.get('m') || null);
  /** The list, or the open meeting, is loading again: the page's Refresh button waits for both. */
  readonly refreshing = computed(() => this.loading() || !!this.detailView()?.refreshing());
  readonly selected = computed(() => this.meetings().find((m) => m.id === this.selectedId()) || null);
  readonly rows = computed<Row[]>(() => {
    const now = new Date();
    return this.meetings().map((m) => ({
      m, date: dateLabel(m.startedAt, now), time: timeLabel(m.startedAt), actions: actionCounts(m.actionItems), preview: summaryPreview(m.summary),
      tickets: ticketSummary(m.tickets),
    }));
  });

  constructor() {
    effect(() => {
      const d = this.detailView();
      if (!d || !this.selectedId() || !this.focusDetail) return;
      this.focusDetail = false;
      afterNextRender(() => d.focusHeading(), { injector: this.injector });
    });
  }

  ngOnInit(): void { this.loadStatus(); }

  async loadStatus(): Promise<void> {
    try {
      const st = await this.api.get<MeetingsStatus>('/api/meetings/status');
      this.error.set(null);
      this.setStatus(st);
    } catch (e) { this.error.set((e as Error).message); }
  }

  private setStatus(st: MeetingsStatus): void {
    const was = this.status()?.connected;
    this.status.set(st);
    if (st.connected && !was) { this.note.set(null); this.reload(); }
    if (!st.connected) this.clearList();
  }

  onConnected(st: MeetingsStatus | null): void {
    if (st) this.setStatus(st);
    else this.loadStatus();
  }

  /**
   * The token stopped working (401 from any call): ask the server where things stand, which shows
   * the connect panel. A Refresh can get a 401 from the list and the detail at once: the second
   * joins the check already in flight.
   */
  onNotConnected(): Promise<void> {
    return this.notConnectedCheck ??= this.checkConnection().finally(() => { this.notConnectedCheck = null; });
  }

  private async checkConnection(): Promise<void> {
    this.clearList();
    await this.loadStatus();
    // Still connected as far as the server knows: say so rather than retrying in a loop.
    if (this.status()?.connected) {
      this.loaded.set(true);
      this.listErr.set(`${this.label()} turned the saved sign-in away. Disconnect and connect again.`);
    }
  }

  private clearList(): void {
    this.gen++;
    this.meetings.set([]);
    this.nextCursor.set(null);
    this.loaded.set(false);
    this.loading.set(false);
    this.loadingMore.set(false);
    this.listErr.set(null);
    this.moreErr.set(null);
  }

  /**
   * Refresh: the first page again, and the open meeting (the detail loads only when its id
   * changes, so its summary, action items and tickets would stay as they were).
   */
  refresh(): void {
    this.reload();
    this.detailView()?.refresh();
  }

  /** The first page again. */
  async reload(): Promise<void> {
    const gen = ++this.gen;
    this.loading.set(true);
    this.loadingMore.set(false);
    this.listErr.set(null);
    this.moreErr.set(null);
    try {
      const page = await this.api.get<MeetingPage>('/api/meetings/list');
      if (gen !== this.gen) return;
      this.meetings.set(mergePages([], page.meetings));
      this.nextCursor.set(page.nextCursor);
      // The ticket lookup ran with the Atlassian sign-in: if that's gone, the bar offers to connect again.
      this.atlassianBar()?.refresh();
    } catch (e) {
      if (gen !== this.gen) return;
      if (isNotConnected(e)) { this.onNotConnected(); return; }
      this.listErr.set((e as Error).message);
    } finally {
      if (gen === this.gen) { this.loading.set(false); this.loaded.set(true); }
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore() || this.loading()) return;
    const gen = this.gen;
    this.loadingMore.set(true);
    this.moreErr.set(null);
    try {
      const page = await this.api.get<MeetingPage>('/api/meetings/list?cursor=' + encodeURIComponent(cursor));
      if (gen !== this.gen) return;
      this.meetings.set(mergePages(this.meetings(), page.meetings));
      this.nextCursor.set(page.nextCursor);
    } catch (e) {
      if (gen !== this.gen) return;
      if (isNotConnected(e)) { this.onNotConnected(); return; }
      this.moreErr.set((e as Error).message);
    } finally {
      if (gen === this.gen) this.loadingMore.set(false);
    }
  }

  select(id: string | null): void {
    this.router.navigate([], { queryParams: { m: id }, queryParamsHandling: 'merge' });
  }

  /**
   * A row was clicked (or Enter on it). When the list and the detail are stacked (narrow
   * screens), focus moves to the detail's heading, which is below the list. Side by side it
   * stays on the row, so the list can be walked with Tab; the detail's status line says when it loaded.
   */
  picked(id: string, e: MouseEvent): void {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (!matchMedia('(max-width: 900px)').matches) return;
    if (id === this.selectedId()) this.detailView()?.focusHeading();
    else this.focusDetail = true;
  }

  /**
   * Close the detail and put focus back on its row, so keyboard users carry on from where they
   * were. A meeting that isn't in the list (a ?m= link) goes back to the first row, or the list.
   */
  closeDetail(): void {
    const id = this.selectedId();
    this.focusDetail = false;
    const rows = this.rowLinks().map((r) => r.nativeElement);
    const target = rows.find((r) => r.dataset['id'] === id) || rows[0] || this.listNav()?.nativeElement;
    target?.focus();
    this.select(null);
  }

  async disconnect(): Promise<void> {
    const l = this.label();
    const ask = this.status()?.via === 'token'
      ? `Forget your ${l} personal access token? This dashboard stops using it, but ${l} keeps it working until you delete it in ${l}.`
      : `Disconnect ${l}? This dashboard forgets your ${l} sign-in, and the Meetings page asks you to connect again.`;
    if (!confirm(ask)) return;
    this.disconnecting.set(true);
    try {
      const r = await this.api.post<MeetingsStatus & { note?: string }>('/api/meetings/disconnect', {});
      this.note.set(r.note || null);
      this.setStatus(r);
      this.toast.show(`Disconnected from ${r.label}`);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.disconnecting.set(false); }
  }
}

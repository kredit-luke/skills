import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import type { Meeting, MeetingDetail, RunMeta } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { MdPipe } from '../../core/md.pipe';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { actionCounts, dateLabel, isHttpsUrl, isNotConnected, moreParticipants, statusOf, timeLabel } from './meetings.util';

/** One meeting: its summary, action items (read-only), the tickets made from it and who was there, with Open in <tool> and Ask agent. */
@Component({
  selector: 'dash-meeting-detail',
  imports: [MdPipe, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let m = detail() || listed();
    <article class="panel md-panel">
      <span class="vh" role="status">{{ liveText() }}</span>
      <div class="dh">
        <div class="grow">
          <h2 #heading tabindex="-1">{{ m?.title || 'Meeting' }}</h2>
          @if (m) {
            <div class="sub">{{ when(m) }}@if (m.host) { · hosted by {{ m.host.name }} } · {{ m.participantCount }} {{ m.participantCount === 1 ? 'person' : 'people' }}</div>
          }
        </div>
        <button class="btn ghost sm" type="button" (click)="closed.emit()" aria-label="Close meeting">Close</button>
      </div>

      @if (missing()) {
        <div class="body">
          <div class="warn-note">This meeting isn't in {{ label() }} any more, or you can't see it.</div>
          <button class="btn sm" type="button" (click)="closed.emit()">Back to the list</button>
        </div>
      } @else {
        <div class="acts">
          <button class="btn sm" type="button" [disabled]="opening()" (click)="openInTool()" [title]="'Opens the meeting in ' + label() + ' (creates a share link for it the first time)'">{{ opening() ? 'Opening…' : 'Open in ' + label() + ' ↗' }}</button>
          <button class="btn primary sm" type="button" [disabled]="asking()" (click)="ask()" title="An agent run that reads the meeting and the code, and proposes tickets for its action items. It creates nothing until you answer.">{{ asking() ? 'Starting…' : 'Ask agent' }}</button>
          @if (shareUrl(); as u) { <a class="share" [href]="u" target="_blank" rel="noopener">Your browser blocked the new window: open the meeting in {{ label() }} ↗</a> }
        </div>

        @if (error()) { <div class="body"><div class="err-note">{{ error() }}</div> <button class="btn ghost sm" type="button" (click)="load(id())">Try again</button></div> }

        <section class="body">
          <h3>Summary</h3>
          @if (m?.summary) { <div class="md" [innerHTML]="m!.summary | md | trustedHtml"></div> }
          @else if (!detail() && !error()) { <div class="empty">Loading…</div> }
          @else if (detail()) { <p class="none">{{ label() }} has no summary for this meeting.</p> }
        </section>

        <section class="body">
          <h3>Action items @if (counts(); as c) { <span class="n">{{ c.open }}/{{ c.total }} open</span> }</h3>
          @if (m?.actionItems?.length) {
            <ul class="items">
              @for (a of m!.actionItems!; track $index) {
                <li [class.done]="a.complete">
                  <span class="mark" aria-hidden="true">{{ a.complete ? '✓' : '○' }}</span>
                  <div class="grow">
                    <div class="txt"><span class="vh">{{ a.complete ? 'Done:' : 'Open:' }}</span> {{ a.text }}</div>
                    @if (a.description) { <div class="desc">{{ a.description }}</div> }
                    @if (a.suggestedOwner) { <div class="owner">{{ label() }} suggests: {{ a.suggestedOwner }}</div> }
                  </div>
                  <span class="tag" [class.good]="a.complete" aria-hidden="true">{{ a.complete ? 'Done' : 'Open' }}</span>
                </li>
              }
            </ul>
          } @else if (m?.actionItems) { <p class="none">No action items.</p> }
          @else if (detail()) { <p class="none">{{ label() }} sent no action items for this meeting.</p> }
        </section>

        @if (m?.tickets?.length) {
          <section class="body">
            <h3>Tickets <span class="n">{{ m!.tickets.length }}</span></h3>
            <ul class="tix">
              @for (t of m!.tickets; track t.key) {
                <li>
                  @if (isHttpsUrl(t.url)) { <a class="key" [href]="t.url" target="_blank" rel="noopener" [attr.aria-label]="t.key + ' (opens in a new tab)'">{{ t.key }} ↗</a> }
                  @else { <span class="key">{{ t.key }}</span> }
                  @if (t.title) { <span class="ttl">{{ t.title }}</span> }
                  @if (t.source === 'run') { <span class="tag" title="Reported by an Ask agent run on this dashboard; the tracker search hasn't found it (yet)">from a run</span> }
                </li>
              }
            </ul>
          </section>
        }

        @if (detail(); as d) {
          <section class="body">
            <h3>Participants <span class="n">{{ d.participantCount }}</span></h3>
            @if (d.participants.length) {
              <ul class="people">
                @for (p of d.participants; track p.id) { <li>{{ p.name }}@if (p.type === 'guest') { <span class="tag">guest</span> }</li> }
                @if (more(); as n) { <li class="more">and {{ n === 'more' ? 'more' : n + ' more' }}</li> }
              </ul>
            } @else { <p class="none">{{ label() }} didn't say who was there.</p> }
          </section>
        }
      }
    </article>
  `,
  styles: [`
    .md-panel { display: flex; flex-direction: column; }
    .dh { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px 10px; border-bottom: 1px solid var(--line-soft); }
    .grow { flex: 1; min-width: 0; }
    h2 { font-family: var(--font-display); font-size: 20px; font-weight: 800; letter-spacing: var(--ls-display); line-height: 1.25; margin: 0; overflow-wrap: anywhere; }
    .sub { font-size: 12.5px; color: var(--ink-faint); margin-top: 4px; }
    h2:focus { outline: none; }
    .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 18px; border-bottom: 1px solid var(--line-soft); }
    .body { padding: 12px 18px; }
    section + section { border-top: 1px dashed var(--line-soft); }
    h3 { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .14em; color: var(--ink-soft); font-weight: 500; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
    h3 .n { color: var(--brand-800); background: var(--purple-bg); border-radius: var(--r-pill); padding: 0 7px; letter-spacing: 0; text-transform: none; }
    .none { margin: 0; font-size: 13px; color: var(--ink-faint); }
    .items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .items li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; }
    .items li.done .txt { color: var(--ink-faint); text-decoration: line-through; }
    .mark { font-size: 13px; color: var(--ink-faint); line-height: 1.4; }
    .items li.done .mark { color: var(--ok-strong); }
    .txt { font-size: 13.5px; color: var(--ink); line-height: 1.4; overflow-wrap: anywhere; }
    .desc { font-size: 12.5px; color: var(--ink-soft); margin-top: 3px; line-height: 1.45; white-space: pre-line; overflow-wrap: anywhere; }
    .owner { font-size: 11.5px; color: var(--ink-faint); margin-top: 4px; }
    .people { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
    .people li { font-size: 12.5px; padding: 2px 9px; border: 1px solid var(--line); border-radius: var(--r-pill); color: var(--ink-soft); display: inline-flex; align-items: center; gap: 6px; }
    .people li.more { border-style: dashed; color: var(--ink-faint); }
    .share { font-size: 12.5px; }
    .tix { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .tix li { display: flex; align-items: baseline; gap: 8px; font-size: 13px; min-width: 0; }
    .tix .key { flex-shrink: 0; font-family: var(--font-mono); font-size: 12.5px; }
    .tix .ttl { flex: 1; min-width: 0; color: var(--ink-soft); overflow-wrap: anywhere; }
  `],
})
export class MeetingDetailComponent {
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly launch = inject(LaunchService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly id = input.required<string>();
  /** The meeting as the list has it, shown while the detail loads. */
  readonly listed = input<Meeting | null>(null);
  readonly label = input('the meeting tool');
  readonly closed = output<void>();
  /** A call came back 401: the stored token is gone or no longer works. */
  readonly notConnected = output<void>();

  readonly detail = signal<MeetingDetail | null>(null);
  readonly error = signal<string | null>(null);
  /** The tool says there's no such meeting (a stale ?m= link). */
  readonly missing = signal(false);
  readonly opening = signal(false);
  readonly asking = signal(false);
  /** The share link, shown as a plain link when the browser blocked the window Open in <tool> opened. */
  readonly shareUrl = signal<string | null>(null);
  readonly isHttpsUrl = isHttpsUrl;
  private seq = 0;
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  readonly counts = computed(() => actionCounts((this.detail() || this.listed())?.actionItems));
  readonly more = computed(() => { const d = this.detail(); return d ? moreParticipants(d) : null; });
  /** What a screen reader hears as the detail loads (the status line is always there; only its text changes). */
  readonly liveText = computed(() => this.error() || (this.missing() ? `This meeting isn't in ${this.label()} any more, or you can't see it.` : this.detail() ? 'Meeting loaded' : 'Loading meeting…'));

  constructor() {
    effect(() => { const id = this.id(); untracked(() => this.load(id)); });
    // Closed (or the page left): a load, Open or Ask still in flight is dropped like one for another meeting.
    inject(DestroyRef).onDestroy(() => this.seq++);
  }

  async load(id: string): Promise<void> {
    const seq = ++this.seq;
    this.detail.set(null);
    this.error.set(null);
    this.missing.set(false);
    this.shareUrl.set(null);
    // An Open or Ask still in flight belongs to the meeting before: its answer is dropped (see seq there).
    this.opening.set(false);
    this.asking.set(false);
    try {
      const d = await this.api.get<MeetingDetail>('/api/meetings/meeting?id=' + encodeURIComponent(id));
      if (seq === this.seq) this.detail.set(d);
    } catch (e) {
      if (seq !== this.seq) return;
      // A 401 sets the error too: if the server still says connected, the page stays and this says why.
      if (isNotConnected(e)) { this.error.set((e as Error).message); this.notConnected.emit(); }
      else if (statusOf(e) === 404) this.missing.set(true);
      else this.error.set((e as Error).message);
    }
  }

  /** Move focus to the meeting's title (the page does this when a row is picked and the detail sits below the list). */
  focusHeading(): void { this.heading().nativeElement.focus(); }

  when(m: Meeting): string {
    const d = dateLabel(m.startedAt);
    const t = timeLabel(m.startedAt);
    const end = timeLabel(m.endedAt);
    return d + (t ? ' ' + t + (end ? '–' + end : '') : '');
  }

  /**
   * Open the window now, while the click still counts as a user action (popup blockers allow
   * that), then point it at the share link once the tool has made one. If the browser blocked
   * the window, a second window.open after the wait would be blocked too: show the link instead.
   * If another meeting was opened meanwhile, the window still goes where it was asked to, but
   * nothing about this one (link, toast, button state) lands on the other.
   */
  async openInTool(): Promise<void> {
    if (this.opening()) return;
    const seq = this.seq;
    this.shareUrl.set(null);
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    this.opening.set(true);
    try {
      const r = await this.api.post<{ url: string | null }>('/api/meetings/share-link', { id: this.id() });
      const url = isHttpsUrl(r.url) ? r.url : null;
      if (!url) { w?.close(); if (seq === this.seq) this.toast.error(`${this.label()} has no link for this meeting.`); return; }
      if (w) w.location.href = url;
      else if (seq === this.seq) { this.shareUrl.set(url); this.toast.error('Your browser blocked the new window. Use the link next to the buttons.'); }
    } catch (e) {
      w?.close();
      if (seq !== this.seq) return;
      if (isNotConnected(e)) this.notConnected.emit();
      this.toast.error((e as Error).message);
    } finally { if (seq === this.seq) this.opening.set(false); }
  }

  /**
   * A run that reads the meeting and proposes tickets: the same start-and-follow as Explain on
   * the Issues page. Answered after another meeting was opened or the detail was closed (the person
   * may be on another page by then), the run is listed but not followed: a toast names the meeting
   * either way, started or failed.
   */
  async ask(): Promise<void> {
    if (this.asking()) return;
    const seq = this.seq;
    const title = (this.detail() || this.listed())?.title || 'the meeting';
    this.asking.set(true);
    try {
      const r = await this.api.post<{ run: RunMeta }>('/api/meetings/ask', { id: this.id(), agent: this.launch.agent() });
      this.data.upsertRun(r.run);
      if (seq === this.seq) this.router.navigate(['/runs', r.run.id]);
      else this.toast.show(`Started a run on ${title}`);
    } catch (e) {
      if (seq !== this.seq) { this.toast.error(`Couldn't start a run on ${title}: ${(e as Error).message}`); return; }
      if (isNotConnected(e)) this.notConnected.emit();
      this.toast.error((e as Error).message);
    } finally { if (seq === this.seq) this.asking.set(false); }
  }
}

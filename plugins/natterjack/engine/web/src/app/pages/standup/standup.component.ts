import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { StandupDraft, StandupItem, StandupResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { copyText, lsGet, lsSet, relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { type StandupPart, type StandupWindow, dateStart, itemTarget, localDay, sinceLabel, windowStart, withItems } from './standup.util';

const WINDOW_KEY = 'standup.window';

/**
 * "My updates": what you did since your last workday and what's next, from the tracker, the code
 * host, this dashboard's runs and the meeting tool (each only when the workspace has it), ending
 * with a standup draft to copy into Slack or Teams. Workdays are Monday to Friday in the browser's
 * time zone; the window can be changed. Nothing is posted anywhere.
 */
@Component({
  selector: 'dash-standup',
  imports: [PageHeaderComponent, RouterLink, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dash-page-header eyebrow="You" title="My updates" [sub]="api.copy('standupSub', 'What you did since your last workday and what\\'s next, with a standup draft to copy.')">
      @if (data()) { <span class="ty">{{ rel(data()!.fetchedAt) }}</span> }
      <button class="btn ghost sm" type="button" (click)="load(true)" [disabled]="loading()">{{ loading() ? 'Refreshing…' : 'Refresh' }}</button>
    </dash-page-header>

    <div class="bar">
      <div class="seg" role="group" aria-label="Window">
        @for (w of windows; track w.id) {
          <button type="button" [class.on]="!custom() && win() === w.id" [attr.aria-pressed]="!custom() && win() === w.id" (click)="pick(w.id)">{{ w.label }}</button>
        }
      </div>
      <label class="from">From <input type="date" [min]="earliest" [max]="today" [ngModel]="custom() || sinceDay()" (ngModelChange)="pickDate($event)" aria-label="Start of the window" /></label>
    </div>

    @if (error() && !data()) { <div class="warn-note">{{ error() }}</div> }
    @else if (!data()) { <div class="empty">Loading…</div> }
    @else {
      @if (error()) { <div class="warn-note">{{ error() }}</div> }
      @for (s of data()!.sources; track s.id) {
        @if (s.error) { <div class="warn-note"><b>{{ s.label }}:</b> {{ s.error }}</div> }
      }

      <div class="cols">
        @for (part of parts(); track part.id) {
          <section class="panel part" [class.block]="part.id === 'blockers'" [attr.aria-labelledby]="'part-' + part.id">
            <h2 [id]="'part-' + part.id">{{ part.title }}</h2>
            @if (!part.groups.length) { <div class="none">{{ part.empty }}</div> }
            @for (g of part.groups; track g.source.id) {
              <h3>{{ g.source.label }}</h3>
              <ul>
                @for (i of g.items; track $index) {
                  <li>
                    @switch (kindOf(i)) {
                      @case ('route') { <a class="ttl" [routerLink]="route(i)" [queryParams]="query(i)">{{ i.title }}</a> }
                      @case ('href') { <a class="ttl" [href]="href(i)" target="_blank" rel="noopener">{{ i.title }}</a> }
                      @default { <span class="ttl">{{ i.title }}</span> }
                    }
                    @if (i.detail) { <span class="det">{{ i.detail }}</span> }
                  </li>
                }
              </ul>
            }
          </section>
        }
      </div>

      <section class="panel draft" aria-labelledby="draft-h">
        <div class="draft-h">
          <h2 id="draft-h">Standup draft</h2>
          @if (draftAt()) { <span class="ty">written {{ rel(draftAt()!) }}</span> }
          <span class="sp"></span>
          @if (draftText()) {
            <button class="btn sm" type="button" (click)="copy()">Copy</button>
            <button class="btn ghost sm" type="button" (click)="writeDraft(true)" [disabled]="drafting()">{{ drafting() ? 'Writing…' : 'Write again' }}</button>
          } @else {
            <button class="btn sm" type="button" (click)="writeDraft(false)" [disabled]="drafting()">{{ drafting() ? 'Writing…' : 'Write draft' }}</button>
          }
        </div>
        @if (draftErr()) { <div class="err-note">{{ draftErr() }}</div> }
        @if (draftText()) {
          <textarea [ngModel]="draftText()" (ngModelChange)="edit($event)" rows="12" aria-label="Standup draft"></textarea>
          <div class="hint">Yesterday, Today and Blockers from the items above, written by a small model. Edit it here, then copy it into Slack or Teams.</div>
        } @else if (!drafting()) {
          <div class="hint">A few bullets each for Yesterday, Today and Blockers, written by a small model from the items above. It's kept for today; nothing is posted.</div>
        }
      </section>
    }
  `,
  styles: [`
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
    .from { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-soft); }
    .from input { font: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); }
    .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; margin-bottom: 16px; }
    .part { padding: 14px 16px; min-width: 0; }
    .part.block { border-top: 3px solid var(--amber, #d97706); }
    h2 { font-size: 15px; margin: 0 0 8px; }
    h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-faint); margin: 12px 0 4px; font-weight: 600; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; flex-direction: column; gap: 2px; padding: 6px 0; min-width: 0; }
    li + li { border-top: 1px solid var(--line-soft); }
    .ttl { font-size: 13.5px; font-weight: 600; color: var(--ink); line-height: 1.35; overflow-wrap: anywhere; text-decoration: none; }
    a.ttl:hover { text-decoration: underline; }
    .det { font-size: 12px; color: var(--ink-soft); overflow-wrap: anywhere; }
    .none { font-size: 13px; color: var(--ink-faint); font-style: italic; }
    .draft { padding: 14px 16px; }
    .draft-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .draft-h h2 { margin: 0; }
    .sp { flex: 1; }
    textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 1.5; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); resize: vertical; }
    .hint { font-size: 12px; color: var(--ink-faint); margin-top: 6px; }
  `],
})
export class StandupComponent implements OnInit {
  readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly windows: { id: StandupWindow; label: string }[] = [
    { id: 'today', label: 'Today' },
    { id: 'workday', label: 'Last workday' },
    { id: '2-workdays', label: 'Two workdays' },
    { id: 'week', label: 'A week' },
  ];
  readonly today = localDay(new Date());
  /** The server reads back a month at most. */
  readonly earliest = localDay(new Date(Date.now() - 30 * 86400000));

  readonly win = signal<StandupWindow>(this.savedWindow());
  /** A start date picked by hand (YYYY-MM-DD), or '' for the window above. */
  readonly custom = signal('');
  readonly data = signal<StandupResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly draftText = signal('');
  readonly draftAt = signal<string | null>(null);
  readonly drafting = signal(false);
  readonly draftErr = signal<string | null>(null);
  /** The window the draft on the page is for, and whether it was edited here (Refresh keeps an edited one). */
  private draftSince = '';
  private edited = false;
  /** Bumps on every load, so an older answer can't land over a newer window's. */
  private seq = 0;

  /** The window's start, local midnight. */
  readonly sinceDate = computed(() => (this.custom() && dateStart(this.custom())) || windowStart(new Date(), this.win()));
  readonly sinceDay = computed(() => localDay(this.sinceDate()));

  readonly parts = computed(() => {
    const sources = this.data()?.sources || [];
    const part = (id: StandupPart, title: string, empty: string) => ({ id, title, empty, groups: withItems(sources, id) });
    return [
      part('done', sinceLabel(this.sinceDate(), new Date()), 'Nothing yet.'),
      part('next', 'Today', 'Nothing assigned or waiting on you.'),
      part('blockers', 'Blockers', "Nothing's stuck."),
    ];
  });

  ngOnInit(): void { this.load(false); }

  pick(w: StandupWindow): void {
    this.win.set(w);
    this.custom.set('');
    lsSet(WINDOW_KEY, w);
    this.load(false);
  }

  pickDate(v: string): void {
    const d = dateStart(v);
    if (!d || d.getTime() > Date.now() || v < this.earliest) return;
    this.custom.set(v);
    this.load(false);
  }

  async load(force: boolean): Promise<void> {
    const n = ++this.seq;
    const since = this.sinceDate().toISOString();
    this.loading.set(true);
    try {
      const [d, saved] = await Promise.all([
        this.api.get<StandupResponse>(`/api/standup?since=${encodeURIComponent(since)}${force ? '&force=1' : ''}`),
        this.api.get<StandupDraft | null>(`/api/standup/draft?since=${encodeURIComponent(since)}&day=${localDay(new Date())}`).catch(() => null),
      ]);
      if (n !== this.seq) return;
      this.data.set(d);
      this.error.set(null);
      if (!this.edited || this.draftSince !== since) {
        this.draftText.set(saved ? saved.text : '');
        this.draftAt.set(saved ? saved.at : null);
        this.draftSince = since;
        this.edited = false;
      }
      this.draftErr.set(null);
    } catch (e) {
      if (n === this.seq) this.error.set((e as Error).message);
    } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }

  async writeDraft(force: boolean): Promise<void> {
    const n = this.seq;
    this.drafting.set(true);
    this.draftErr.set(null);
    try {
      const d = await this.api.post<StandupDraft>('/api/standup/draft', { since: this.sinceDate().toISOString(), day: localDay(new Date()), force });
      if (n !== this.seq) return;
      this.draftText.set(d.text);
      this.draftAt.set(d.at);
      this.draftSince = this.sinceDate().toISOString();
      this.edited = false;
    } catch (e) {
      if (n === this.seq) this.draftErr.set((e as Error).message);
    } finally {
      this.drafting.set(false);
    }
  }

  edit(text: string): void {
    this.draftText.set(text);
    this.edited = true;
  }

  async copy(): Promise<void> {
    if (await copyText(this.draftText())) this.toast.show('Copied the standup draft');
    else this.toast.error("Couldn't copy: the browser blocked the clipboard");
  }

  kindOf(i: StandupItem): 'route' | 'href' | null {
    const t = itemTarget(i);
    return !t ? null : 'href' in t ? 'href' : 'route';
  }
  route(i: StandupItem): string[] { const t = itemTarget(i); return t && 'route' in t ? t.route : []; }
  query(i: StandupItem): Record<string, string> | null { const t = itemTarget(i); return t && 'route' in t ? t.query : null; }
  href(i: StandupItem): string { const t = itemTarget(i); return t && 'href' in t ? t.href : ''; }
  rel(t: string | number): string { return relTime(t); }

  private savedWindow(): StandupWindow {
    const w = lsGet(WINDOW_KEY, 'workday');
    return (['today', 'workday', '2-workdays', 'week'] as string[]).includes(w) ? (w as StandupWindow) : 'workday';
  }
}

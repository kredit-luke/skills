import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ReviewList, ReviewPr, ReviewSummary } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { ReviewDetailComponent } from './review-detail.component';
import { ReviewGuideComponent } from './review-guide.component';
import { type ReviewFilter, authorsOf, filterPrs, needsSummary, newerSummary, prKey } from './reviews.util';

/** Summaries asked for at once from the list (the server makes two at a time anyway). */
const SUMMARY_PARALLEL = 2;
/** Rows whose summaries are asked for without being opened: the top of the filtered list. */
const SUMMARY_ROWS = 40;

/**
 * Open pull requests across the organizations the person can see on the code host, each with a
 * short summary of what it does, so other people's work can be reviewed from one place. The
 * open PR is ?repo=<owner/name>&n=<number>, so links work.
 */
@Component({
  selector: 'dash-reviews',
  imports: [PageHeaderComponent, RouterLink, FormsModule, ReviewDetailComponent, ReviewGuideComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dash-page-header eyebrow="Agents" title="Reviews" [sub]="api.copy('reviewsSub', 'Open pull requests across your organizations, each with a short summary of what it does.')">
      @if (list()) { <span class="ty">{{ meta() }}</span> }
      <button class="btn ghost sm" type="button" (click)="load(true)" [disabled]="loading()">{{ loading() ? 'Refreshing…' : 'Refresh' }}</button>
    </dash-page-header>

    @if (guiding(); as s) {
      <dash-review-guide [repo]="s.repo" [number]="s.n" (back)="closeGuide()" />
    } @else if (error() && !list()) { <div class="warn-note">{{ error() }}</div> }
    @else if (!list()) { <div class="empty">Loading…</div> }
    @else {
      @for (e of list()!.errors; track e) { <div class="warn-note">{{ e }}</div> }
      @if (list()!.truncated) { <div class="warn-note">There are more open PRs than one search returns: set <code>codeHost.orgs</code> in workspace.json to the organizations you review.</div> }

      <div class="bar">
        <div class="seg" role="group" aria-label="Which pull requests">
          @for (f of filters; track f.id) {
            <button type="button" [class.on]="filter() === f.id" [attr.aria-pressed]="filter() === f.id" (click)="filter.set(f.id)">{{ f.label }} <span class="n">{{ counts()[f.id] }}</span></button>
          }
        </div>
        @if (list()!.orgs.length > 1) {
          <select class="sel" [ngModel]="org()" (ngModelChange)="org.set($event)" aria-label="Organization">
            <option value="">All organizations</option>
            @for (o of list()!.orgs; track o) { <option [value]="o">{{ o }}</option> }
          </select>
        }
        @if (authors().length > 1) {
          <select class="sel" [ngModel]="author()" (ngModelChange)="author.set($event)" aria-label="Author">
            <option value="">All authors</option>
            @for (a of authors(); track a.login) { <option [value]="a.login">{{ a.login }} ({{ a.count }})</option> }
          </select>
        }
        <input class="q" type="search" placeholder="Filter by title, repo or author" aria-label="Filter pull requests" [ngModel]="text()" (ngModelChange)="text.set($event)" />
        <label class="chk"><input type="checkbox" [ngModel]="drafts()" (ngModelChange)="drafts.set($event)" /> Drafts</label>
      </div>

      <div class="layout">
        <nav class="panel list" aria-label="Pull requests">
          @if (!rows().length) {
            <div class="empty">{{ list()!.prs.length ? 'Nothing matches these filters.' : 'No open pull requests.' }}</div>
          } @else {
            <ul>
              @for (p of rows(); track key(p)) {
                <li [class.sel]="key(p) === selectedKey()">
                  <a class="row" [routerLink]="[]" [queryParams]="{ repo: p.repo, n: p.number }" queryParamsHandling="merge" [attr.aria-current]="key(p) === selectedKey() ? 'true' : null">
                    <span class="top">
                      <span class="ttl">{{ p.title }}</span>
                      <span class="when" [title]="p.updatedAt">{{ rel(p.updatedAt) }}</span>
                    </span>
                    <span class="meta">
                      <span class="mono">{{ p.repo }}#{{ p.number }}</span> · {{ p.author || 'unknown' }}
                      @if (p.requested) { <span class="tag review">Review requested</span> }
                      @if (p.mine) { <span class="tag">Yours</span> }
                      @if (p.isDraft) { <span class="tag">Draft</span> }
                      @if (p.authorIsBot) { <span class="tag agent">Bot</span> }
                    </span>
                    <span class="sum" [class.wait]="!summaryOf(p)">
                      @if (summaryOf(p); as s) { {{ s.text }} }
                      @else if (failed()[key(p)]) { Couldn't summarize: {{ failed()[key(p)] }} }
                      @else if (busy()[key(p)]) { Summarizing… }
                      @else { No summary yet. }
                    </span>
                  </a>
                </li>
              }
            </ul>
          }
        </nav>

        @if (selected(); as s) {
          <dash-review-detail [repo]="s.repo" [number]="s.n" [viewer]="list()!.viewer" (merged)="load(true)" [summary]="summaries()[s.repo + '#' + s.n] || null" (summarized)="onSummary(s.repo + '#' + s.n, $event)" (closed)="select(null)" />
        } @else if (rows().length) {
          <div class="panel pick"><div class="empty">Pick a pull request to see what changed, its checks and its reviews.</div></div>
        }
      </div>
    }
  `,
  styles: [`
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
    .seg .n { font-family: var(--font-mono); font-size: 11px; opacity: .75; margin-left: 2px; }
    .sel, .q { font: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); }
    .q { flex: 1; min-width: 180px; max-width: 360px; }
    .chk { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-soft); }
    .layout { display: grid; grid-template-columns: minmax(320px, 460px) minmax(0, 1fr); gap: 16px; align-items: start; }
    @media (max-width: 900px) { .layout { grid-template-columns: minmax(0, 1fr); } }
    .list { min-width: 0; }
    .list ul { list-style: none; margin: 0; padding: 0; }
    .list li + li { border-top: 1px solid var(--line-soft); }
    .list li { border-left: 3px solid transparent; }
    .list li:has(> .row:hover), .list li.sel { background: var(--paper-2); }
    .list li.sel { border-left-color: var(--brand-700); }
    .row { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; padding: 12px 16px 12px 13px; border-radius: 0; text-align: left; text-decoration: none; color: inherit; }
    .row:focus-visible { outline: none; box-shadow: var(--ring); }
    .top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .ttl { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; color: var(--ink); line-height: 1.35; overflow-wrap: anywhere; }
    .when { flex-shrink: 0; font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); white-space: nowrap; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ink-faint); overflow-wrap: anywhere; }
    .mono { font-family: var(--font-mono); }
    .sum { font-size: 12.5px; color: var(--ink-soft); line-height: 1.45; }
    .sum.wait { color: var(--ink-faint); font-style: italic; }
    .pick { padding: 1rem; }
  `],
})
export class ReviewsComponent implements OnInit {
  readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly query = toSignal(this.route.queryParamMap);

  readonly filters: { id: ReviewFilter; label: string }[] = [
    { id: 'requested', label: 'Requested from you' },
    { id: 'all', label: 'All' },
    { id: 'mine', label: 'Yours' },
  ];

  readonly list = signal<ReviewList | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly filter = signal<ReviewFilter>('all');
  readonly org = signal('');
  readonly author = signal('');
  readonly text = signal('');
  readonly drafts = signal(false);
  /** Summaries made on this page, by PR key (newer than the list's). */
  readonly summaries = signal<Record<string, ReviewSummary>>({});
  readonly busy = signal<Record<string, boolean>>({});
  readonly failed = signal<Record<string, string>>({});
  private pending: ReviewPr[] = [];
  private inFlight = 0;
  /** Asked once per PR activity (key@updatedAt) per page visit: a failure isn't retried in a loop, but a refreshed PR with new activity is asked again. */
  private asked = new Set<string>();

  readonly key = prKey;
  readonly selected = computed(() => {
    const repo = this.query()?.get('repo');
    const n = Number(this.query()?.get('n'));
    return repo && Number.isInteger(n) && n > 0 ? { repo, n } : null;
  });
  /** ?view=guide: the open PR's guided review, full width. */
  readonly guiding = computed(() => (this.query()?.get('view') === 'guide' ? this.selected() : null));
  readonly selectedKey = computed(() => { const s = this.selected(); return s ? `${s.repo}#${s.n}` : null; });

  readonly rows = computed(() => filterPrs(this.list()?.prs || [], { filter: this.filter(), org: this.org(), author: this.author(), text: this.text(), drafts: this.drafts() }));
  readonly counts = computed(() => {
    const base = { org: this.org(), author: this.author(), text: this.text(), drafts: this.drafts() };
    const prs = this.list()?.prs || [];
    return { requested: filterPrs(prs, { ...base, filter: 'requested' }).length, all: filterPrs(prs, { ...base, filter: 'all' }).length, mine: filterPrs(prs, { ...base, filter: 'mine' }).length };
  });
  /** Authors of the open PRs in the chosen organization (the one picked stays listed). */
  readonly authors = computed(() => {
    const org = this.org().toLowerCase();
    const list = authorsOf((this.list()?.prs || []).filter((p) => !org || p.repo.split('/')[0].toLowerCase() === org));
    const a = this.author();
    return a && !list.some((x) => x.login === a) ? [...list, { login: a, count: 0 }] : list;
  });
  readonly meta = computed(() => {
    const l = this.list();
    if (!l) return '';
    return `${l.prs.length} open across ${l.orgs.length === 1 ? l.orgs[0] : l.orgs.length + ' owners'} · ${relTime(l.fetchedAt)}`;
  });

  constructor() {
    // Ask for the summaries the visible rows don't have (or that may be for an older commit).
    effect(() => {
      const want = this.rows().slice(0, SUMMARY_ROWS).filter((p) => !this.asked.has(`${prKey(p)}@${p.updatedAt}`) && needsSummary(p, this.summaryOf(p)));
      if (!want.length) return;
      for (const p of want) this.asked.add(`${prKey(p)}@${p.updatedAt}`);
      this.pending.push(...want);
      this.pump();
    });
  }

  ngOnInit(): void { this.load(false); }

  async load(force: boolean): Promise<void> {
    this.loading.set(true);
    try {
      const l = await this.api.get<ReviewList>('/api/reviews' + (force ? '?force=1' : ''));
      this.list.set(l);
      this.error.set(null);
      // Land on what's waiting for you, when anything is.
      if (!force && l.prs.some((p) => p.requested)) this.filter.set('requested');
    } catch (e) { this.error.set((e as Error).message); }
    finally { this.loading.set(false); }
  }

  /** The newer of the summary made on this page and the one the (maybe refreshed) list has. */
  summaryOf(p: ReviewPr): ReviewSummary | null { return newerSummary(this.summaries()[prKey(p)], p.summary); }
  rel(t: string): string { return relTime(t); }

  onSummary(key: string, s: ReviewSummary): void {
    this.summaries.update((m) => ({ ...m, [key]: s }));
  }

  select(pr: { repo: string; number: number } | null): void {
    this.router.navigate([], { queryParams: { repo: pr?.repo ?? null, n: pr?.number ?? null }, queryParamsHandling: 'merge' });
  }

  closeGuide(): void {
    this.router.navigate([], { queryParams: { view: null }, queryParamsHandling: 'merge' });
  }

  private pump(): void {
    while (this.inFlight < SUMMARY_PARALLEL && this.pending.length) {
      const p = this.pending.shift()!;
      const k = prKey(p);
      this.inFlight++;
      this.busy.update((m) => ({ ...m, [k]: true }));
      this.api.post<ReviewSummary>('/api/reviews/summary', { repo: p.repo, number: p.number })
        .then((s) => this.onSummary(k, s))
        .catch((e) => this.failed.update((m) => ({ ...m, [k]: (e as Error).message })))
        .finally(() => {
          this.inFlight--;
          this.busy.update((m) => { const { [k]: _, ...rest } = m; return rest; });
          this.pump();
        });
    }
  }
}

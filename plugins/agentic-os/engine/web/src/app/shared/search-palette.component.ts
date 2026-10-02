import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import type { ExternalDocHit, SearchDoc, SearchResponse, SearchResult, SearchStats } from '../../../../shared/api';
import { ApiService } from '../core/api.service';
import { DataService } from '../core/data.service';
import { LaunchService } from '../core/launch.service';
import { siteEditLaunch } from '../core/site-edit';
import { markDom, markTerms, mdSlug, renderMd, inlineMd } from '../core/markdown';
import { SearchService } from '../core/search.service';
import { ToastService } from '../core/toast.service';
import { TrustedHtmlPipe } from '../core/trusted-html.pipe';
import { relTime, vscodeUrl } from '../core/util';
import { DocsPreviewService } from '../core/docs-preview.service';
import { askPrompt } from './ask-prompt';

const SOURCE_TABS: [string, string][] = [['', 'All'], ['skill', 'Skills'], ['memory', 'Memory'], ['guide', 'Guides'], ['doc', 'Docs'], ['issue', 'Issues'], ['agent', 'Agents'], ['run', 'Activity']];

interface Action { act: string; label: string; href?: string }

/** Workspace search without running Claude (Ctrl+K). */
@Component({
  selector: 'dash-search-palette',
  imports: [TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './search-palette.component.scss',
  template: `
    @if (req()) {
      <div class="modal search-modal" (mousedown)="onBackdrop($event)">
        <div class="modal-card search-card" role="dialog" aria-label="Search the workspace">
          <div class="search-bar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input #q [value]="query()" placeholder="Search skills, memory, guides, docs, issues, runs…" autocomplete="off" spellcheck="false"
              (input)="onInput($any($event.target).value)" (keydown)="onKey($event)">
            <button class="btn sm" type="button" (click)="ask(null)" title="Start a Claude run with this question (Shift+Enter)">Ask Claude</button>
          </div>
          @if (data() || site()) {
            <div class="search-filters">
              @if (site()) {
                <button type="button" class="on site-chip" (click)="clearSite()">{{ siteName() || site() }} ✕</button><span class="sep"></span>
              }
              @for (t of tabs(); track t.key) {
                <button type="button" [class.on]="source() === t.key" (click)="setSource(t.key)">{{ t.label }} <span>{{ t.n }}</span></button>
              }
            </div>
          }
          <div class="search-body">
            <div class="search-results" role="listbox" #list>
              @if (!data()) {
                <div class="sr-empty"><b>Search the workspace without running Claude.</b>
                  @if (stats(); as s) { <p>{{ s.docs }} documents indexed: {{ statsLine() }}.</p> }
                  @if (examples().length) { <p>Try @for (x of examples(); track x; let last = $last) { <code>{{ x }}</code>{{ last ? '.' : ', ' }} }</p> }
                  <p>Nothing useful? <b>Ask Claude</b> (Shift+Enter) starts a read-only run with your question and the best matches as starting points.</p></div>
              } @else if (!data()!.results.length) {
                <div class="sr-empty"><b>No matches for “{{ data()!.query }}”.</b><p>Press Shift+Enter to ask Claude instead.</p></div>
              } @else {
                @for (r of data()!.results; track r.id; let i = $index) {
                  <div class="sr-item" [class.active]="i === index()" role="option" (click)="select(i)">
                    <div class="l1"><span [class]="'src src-' + r.source">{{ r.sourceLabel }}</span><span class="t" [innerHTML]="mark(r.title) | trustedHtml"></span></div>
                    @if (r.section) { <div class="sec" [innerHTML]="'§ ' + mark(r.section) | trustedHtml"></div> }
                    @else if (r.subtitle && r.source !== 'skill') { <div class="sec">{{ r.subtitle }}</div> }
                    <div class="snip" [innerHTML]="mark(r.snippet) | trustedHtml"></div>
                  </div>
                }
                @if (data()!.total > data()!.results.length) { <div class="hint">Showing {{ data()!.results.length }} of {{ data()!.total }}.</div> }
              }
              @for (g of external(); track g.site) {
                <div class="hint ext-h">In {{ g.name }}</div>
                @for (h of g.hits; track h.id) {
                  <div class="sr-item" role="option" (click)="openExternal(g.site, h.id)" [title]="'Open in the Docs page (' + g.name + ')'">
                    <div class="l1"><span class="src src-doc">{{ g.name }}</span><span class="t">{{ h.title }}</span></div>
                    <div class="sec">{{ h.spaceName || h.space }}</div>
                  </div>
                }
              }
            </div>
            <div class="search-preview">
              @if (current(); as r) {
                <div class="pv-h">
                  <div class="pv-meta">{{ r.sourceLabel }} · {{ r.source === 'issue' ? r.subtitle : r.rel }}@if (r.updatedAt) { · updated {{ rel(r.updatedAt) }} }</div>
                  <h3>{{ r.title }}</h3>
                  @if (r.subtitle && r.source !== 'issue' && r.source !== 'doc') { <div class="pv-sub">{{ r.subtitle }}</div> }
                  @for (w of r.extra['issues'] || []; track w) { <div class="pv-warn" [innerHTML]="inline(w) | trustedHtml"></div> }
                  <div class="pv-acts">
                    @for (a of actions(); track a.act + a.label; let i = $index) {
                      @if (a.href) {
                        <a class="btn sm" [class.primary]="i === 0" [href]="a.href" target="_blank" rel="noopener">{{ a.label }}</a>
                      } @else {
                        <button type="button" class="btn sm" [class.primary]="i === 0" [class.danger]="a.act === 'mem-delete'" (click)="act(a.act, $event)">{{ armed() && a.act === 'mem-delete' ? 'Click again to delete' : a.label }}</button>
                      }
                    }
                  </div>
                </div>
                <div class="pv-body md" #pv [innerHTML]="previewHtml() | trustedHtml"></div>
              }
            </div>
          </div>
          <div class="search-foot">↑↓ move · Enter {{ primaryLabel() }} · Shift+Enter ask Claude · Esc close{{ data() ? ' · ' + data()!.total + ' result' + (data()!.total === 1 ? '' : 's') + ' in ' + data()!.took + 'ms' : '' }}</div>
        </div>
      </div>
    }
  `,
})
export class SearchPaletteComponent {
  private readonly search = inject(SearchService);
  readonly api = inject(ApiService);
  private readonly dataSvc = inject(DataService);
  private readonly launch = inject(LaunchService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly docsPreview = inject(DocsPreviewService);

  readonly req = this.search.request;
  readonly query = signal('');
  readonly source = signal('');
  readonly site = signal('');
  readonly siteName = signal('');
  readonly data = signal<SearchResponse | null>(null);
  readonly stats = signal<SearchStats | null>(null);
  /** Example queries for the empty state (workspace.json copy.searchExamples). */
  readonly examples = computed(() => this.api.copy<string[]>('searchExamples', ['worktree ports', 'how to deploy', 'test data']));
  readonly index = signal(0);
  readonly docs = signal<Record<string, SearchDoc | null>>({});
  readonly armed = signal(false);
  readonly external = signal<{ site: string; name: string; hits: ExternalDocHit[] }[]>([]);
  private seq = 0;
  private extSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private extTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly qInput = viewChild<ElementRef<HTMLInputElement>>('q');
  private readonly pv = viewChild<ElementRef<HTMLElement>>('pv');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  readonly current = computed<SearchResult | null>(() => this.data()?.results[this.index()] || null);
  readonly currentDoc = computed(() => { const r = this.current(); return r ? this.docs()[r.id] : undefined; });
  readonly actions = computed(() => { const r = this.current(); return r ? this.resultActions(r, this.currentDoc() || null) : []; });
  readonly primaryLabel = computed(() => (this.actions()[0]?.label || 'open').toLowerCase());
  readonly tabs = computed(() => {
    const counts = (this.data()?.counts || {}) as Record<string, number>;
    const all = Object.values(counts).reduce((n, x) => n + (x || 0), 0);
    return SOURCE_TABS
      .map(([key, label]) => ({ key, label, n: key ? counts[key] || 0 : all }))
      .filter((t) => !t.key || t.n || this.source() === t.key);
  });
  readonly statsLine = computed(() => {
    const s = this.stats();
    if (!s) return '';
    return Object.entries(s.bySource).map(([k, n]) => `${n} ${((s.sources as any)[k]?.label || k).toLowerCase()}${n === 1 ? '' : 's'}`).join(', ');
  });
  readonly previewHtml = computed(() => {
    const r = this.current();
    if (!r) return '';
    if (r.format === 'none') {
      const labels = (r.extra['labels'] || []) as string[];
      return '<p>' + markTerms(r.subtitle) + '</p>' + (labels.length ? '<p>' + labels.map((l) => '<span class="tag">' + markTerms(l) + '</span>').join(' ') + '</p>' : '');
    }
    const d = this.currentDoc();
    if (d === undefined) return '<div class="empty">Loading…</div>';
    if (d === null) return '<div class="empty">Couldn\'t load this document.</div>';
    return renderMd(d.content);
  });

  constructor() {
    // Only re-runs when the palette is (re)opened; everything else is read untracked.
    effect(() => {
      const r = this.req();
      if (!r) return;
      untracked(() => {
        this.source.set(r.source || '');
        this.site.set(r.site || '');
        this.siteName.set(r.siteName || '');
        if (r.q != null) this.query.set(r.q);
        this.armed.set(false);
        setTimeout(() => { const el = this.qInput()?.nativeElement; el?.focus(); el?.select(); });
        this.run();
        if (!this.stats()) this.api.get<SearchStats>('/api/search/stats').then((s) => this.stats.set(s)).catch(() => {});
      });
    });
    // After the preview renders: highlight terms and jump to the matched section.
    effect(() => {
      const html = this.previewHtml();
      const r = this.current();
      const el = this.pv()?.nativeElement;
      if (!el || !r || !html) return;
      setTimeout(() => {
        markDom(el, this.data()?.terms);
        let target: HTMLElement | null = r.section ? el.querySelector<HTMLElement>(`[data-sec="${CSS.escape(mdSlug(r.section))}"]`) : null;
        if (target) target.classList.add('hit');
        target = target || el.querySelector<HTMLElement>('mark');
        el.scrollTop = target ? Math.max(0, target.offsetTop - el.offsetTop - 16) : 0;
      });
    });
  }

/** Close on a press on the backdrop itself. Returns nothing: a `false` from a template handler would preventDefault every press inside the dialog. */
  onBackdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.close(); }
  close(): void { this.search.close(); }
  rel(t: string): string { return relTime(t); }
  inline(s: string): string { return inlineMd(s); }
  mark(s: string): string { return markTerms(s, this.data()?.terms); }

  onInput(v: string): void {
    this.query.set(v);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 110);
    // External docs (Confluence, …) are a network call: wait for a pause in typing.
    if (this.extTimer) clearTimeout(this.extTimer);
    this.extTimer = setTimeout(() => this.runExternal(), 450);
  }

  /** A few hits from each connected external docs source; shown under the local results. */
  async runExternal(): Promise<void> {
    const q = this.query().trim();
    const seq = ++this.extSeq;
    if (q.length < 3 || this.site()) { this.external.set([]); return; }
    try {
      const r = await this.api.get<{ groups: { site: string; name: string; hits: ExternalDocHit[] }[] }>('/api/docs/external/search-all?q=' + encodeURIComponent(q));
      if (seq === this.extSeq) this.external.set(r.groups);
    } catch { if (seq === this.extSeq) this.external.set([]); }
  }

  openExternal(site: string, id: string): void {
    this.close();
    this.router.navigate(['/docs', site], { queryParams: { q: this.query().trim() || null, page: id } });
  }

  async run(): Promise<void> {
    const q = this.query().trim();
    const seq = ++this.seq;
    if (!q && !this.site()) { this.data.set(null); return; }
    try {
      const d = await this.api.get<SearchResponse>('/api/search?limit=60&q=' + encodeURIComponent(q) +
        (this.source() ? '&source=' + encodeURIComponent(this.source()) : '') + (this.site() ? '&site=' + encodeURIComponent(this.site()) : ''));
      if (seq !== this.seq) return;
      this.data.set(d);
      this.index.set(0);
      this.armed.set(false);
      this.loadDoc();
    } catch (e) {
      if (seq === this.seq) this.toast.error((e as Error).message);
    }
  }

  setSource(s: string): void { this.source.set(s); this.run(); this.qInput()?.nativeElement.focus(); }
  clearSite(): void { this.site.set(''); this.siteName.set(''); this.run(); this.qInput()?.nativeElement.focus(); }

  select(i: number): void {
    const n = this.data()?.results.length || 0;
    if (!n) return;
    this.index.set((i + n) % n);
    this.armed.set(false);
    this.loadDoc();
    setTimeout(() => this.list()?.nativeElement.querySelector('.sr-item.active')?.scrollIntoView({ block: 'nearest' }));
  }

  private async loadDoc(): Promise<void> {
    const r = this.current();
    if (!r || r.format === 'none' || this.docs()[r.id] !== undefined) return;
    let d: SearchDoc | null = null;
    try { d = await this.api.get<SearchDoc>('/api/search/doc?id=' + encodeURIComponent(r.id)); } catch { d = null; }
    this.docs.set({ ...this.docs(), [r.id]: d });
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.select(this.index() + (e.key === 'ArrowDown' ? 1 : -1)); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); this.ask(null); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const a = this.actions()[0];
      if (!a) return;
      if (a.href) window.open(a.href, '_blank', 'noopener');
      else this.act(a.act);
    }
  }

  private implementable(r: SearchResult): boolean {
    const cfg = this.dataSvc.deck()?.issues;
    return r.source === 'issue' && r.extra['state'] === 'Todo' && !!cfg && (cfg.implementTeams || []).includes(r.extra['team']);
  }

  /** Buttons for a result; the first is the Enter action. */
  resultActions(r: SearchResult, doc: SearchDoc | null): Action[] {
    const a: Action[] = [];
    const file = doc && doc.file ? vscodeUrl(doc.file) : null;
    if (r.source === 'skill') a.push({ act: 'run-skill', label: 'Run /' + r.extra['skill'] });
    if (r.source === 'doc') a.push({ act: 'read', label: 'Read in Docs' });
    if (r.source === 'doc' && r.extra['live']) a.push({ act: 'live', label: 'Open live page', href: r.extra['live'] + (r.anchor ? '#' + r.anchor : '') });
    if (r.source === 'issue') a.push({ act: 'link', label: 'Open in ' + this.api.trackerLabel(), href: r.url || undefined });
    if (r.source === 'issue' && this.implementable(r)) a.push({ act: 'implement', label: 'Implement' });
    if (r.source === 'issue') a.push({ act: 'explain', label: 'Explain' });
    if (r.source === 'run') a.push({ act: 'open-run', label: 'Open run' });
    if (r.source === 'doc' && r.extra['kind'] === 'site') a.push({ act: 'preview', label: 'Preview local' });
    if (file) a.push({ act: 'link', label: 'Open in VS Code', href: file });
    if (r.ref) a.push({ act: 'ask', label: 'Ask Claude about this' });
    if (r.source === 'doc') a.push({ act: 'changes', label: 'Make edits' });
    if (r.source === 'memory') a.push({ act: 'mem-delete', label: 'Delete memory' });
    return a;
  }

  async ask(primary: SearchResult | null): Promise<void> {
    // Typed faster than the debounce: point Claude at matches for what's in the box now.
    if (!primary && this.query().trim() !== (this.data()?.query || '').trim()) {
      if (this.timer) clearTimeout(this.timer);
      await this.run();
    }
    const prompt = askPrompt(this.query(), this.data()?.results || [], primary);
    if (!prompt.trim()) { this.qInput()?.nativeElement.focus(); return; }
    this.close();
    this.launch.open({ prompt, title: 'Ask Claude', focusPrompt: true, planMode: true, trigger: 'ask' });
  }

  async act(act: string, ev?: Event): Promise<void> {
    const r = this.current();
    if (!r) return;
    switch (act) {
      case 'run-skill': this.close(); this.launch.open({ prompt: '/' + r.extra['skill'] + ' ', focusPrompt: true }); return;
      case 'ask': return this.ask(r);
      case 'implement': this.close(); this.launch.open({ presetId: this.dataSvc.deck()?.issues.implementPreset || 'implement', prefill: { ticket: r.extra['ticket'] } }); return;
      case 'explain':
        try {
          const res = await this.api.post<{ run: { id: string } }>('/api/issues/explain', { ticket: r.extra['ticket'] });
          this.close();
          this.dataSvc.loadRuns();
          this.router.navigate(['/runs', res.run.id]);
        } catch (e) { this.toast.error((e as Error).message); }
        return;
      case 'open-run': this.close(); this.router.navigate(['/runs', r.extra['runId']]); return;
      case 'read': this.close(); this.router.navigate(['/docs', r.extra['site']], { queryParams: { page: r.id } }); return;
      case 'preview': this.docsPreview.open(r.extra['site'], r.extra['pagePath'], r.anchor); return;
      case 'changes':
        this.close();
        this.launch.open(siteEditLaunch(r.rel.split('/')[0], r.extra['siteName'], r.rel.split('/').slice(1).join('/')));
        return;
      case 'mem-delete':
        if (!this.armed()) { this.armed.set(true); setTimeout(() => this.armed.set(false), 4000); return; }
        try {
          await this.api.post('/api/memory/delete', { file: r.extra['memoryFile'] });
          this.toast.show('Deleted memory ' + r.extra['memoryFile']);
          this.armed.set(false);
          const docs = { ...this.docs() }; delete docs[r.id]; this.docs.set(docs);
          this.run();
        } catch (e) { this.toast.error((e as Error).message); }
        return;
    }
    void ev;
  }
}

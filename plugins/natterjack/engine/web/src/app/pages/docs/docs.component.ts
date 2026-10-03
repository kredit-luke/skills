import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { DocPage, DocPagesResponse, DocSite, SearchDoc } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { mdSlug, renderMd } from '../../core/markdown';
import { siteEditLaunch } from '../../core/site-edit';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { vscodeUrl } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { ExternalDocsComponent } from './external-docs.component';
import { byArea, reach } from './knowledge.util';
import { NotesViewComponent } from './notes-view.component';

type View = 'page' | 'text';

/**
 * Knowledge (once Docs): the sources in .claude/dashboard/docs.json, grouped by area
 * (Company, Customers, Finance, ...). Sites and notes in the workspace are read from
 * your working copy; stores are business notes in the team's bucket, edited here;
 * external ones (Confluence, Notion, ...) open where they live, and Claude reaches
 * them through their MCP connector (the Connections page says whether it can).
 * Route: /knowledge, /knowledge/:site, ?note=<rel> (notes) or ?page=<doc id> (sites).
 */
@Component({
  selector: 'dash-docs',
  imports: [PageHeaderComponent, RouterLink, TrustedHtmlPipe, ExternalDocsComponent, NotesViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './docs.component.scss',
  template: `
    <dash-page-header eyebrow="Company" title="Knowledge" [sub]="api.copy('knowledgeSub', api.copy('docsSub', 'What the business knows, by area: notes in your own storage, docs in the repos, and the tools where the rest lives. Claude reads all of it.'))" />

    @if (!siteKey()) {
      @for (g of groups(); track g.area?.key || '_other') {
        <section class="area">
          @if (groups().length > 1 || g.area) {
            <div class="area-h">
              <h2>{{ g.area?.label || 'Other sources' }}</h2>
              @if (g.area?.owner) { <span class="ty">owner: {{ g.area!.owner }}</span> }
              @if (g.area?.reviewEvery) { <span class="ty">reviewed every {{ g.area!.reviewEvery }} days</span> }
              @if (staleIn(g.sites)) { <span class="tag amber">{{ staleIn(g.sites) }} due for review</span> }
              @if (g.area?.description) { <span class="ty desc">{{ g.area!.description }}</span> }
            </div>
          }
          <div class="sites">
            @for (s of g.sites; track s.key) {
              @if (s.kind === 'external') {
                <div class="site-card ext">
                  @if (s.searchable) { <a class="n" [routerLink]="['/knowledge', s.key]">{{ s.name }}</a> }
                  @else { <a class="n" [href]="s.url" target="_blank" rel="noopener">{{ s.name }} ↗</a> }
                  <span class="ty">{{ s.type }} · {{ host(s.url) }}@if (s.searchable) { · <a [href]="s.url" target="_blank" rel="noopener">open ↗</a> }</span>
                  @if (s.description) { <span class="ty">{{ s.description }}</span> }
                  @switch (reach(s)) {
                    @case ('ok') { <span class="reach ok" [title]="'Through ' + s.connection">✓ Claude can reach it</span> }
                    @case ('bad') { <a class="reach bad" routerLink="/connections" [title]="s.connection + ' is not working for you'">! Claude can't reach it: fix on Connections</a> }
                    @case ('checking') { <span class="reach">Checking Claude's access…</span> }
                  }
                  <button class="btn ghost sm" type="button" (click)="askExternal(s)" title="A read-only Claude run that looks this up through the {{ s.type }} connector">Ask Claude</button>
                </div>
              } @else {
                <a class="site-card" [class.off]="!s.available && s.kind !== 'store'" [routerLink]="['/knowledge', s.key]">
                  <span class="n">{{ s.name }}</span>
                  <span class="ty">{{ s.docs }} {{ s.kind === 'site' ? 'page' : 'note' }}{{ s.docs === 1 ? '' : 's' }} · {{ s.kind === 'site' ? host(s.live) : s.kind === 'store' ? s.type : 'in ' + s.repo }}</span>
                  @if (s.description) { <span class="ty">{{ s.description }}</span> }
                  @if (s.kind === 'store' && s.store && !s.store.connected) { <span class="tag amber">connect to read</span> }
                  @if (s.stale) { <span class="tag amber">{{ s.stale }} due for review</span> }
                  @if (!s.available && s.kind !== 'store') { <span class="ty">not cloned</span> }
                </a>
              }
            }
            @if (!g.sites.length) { <div class="empty sm">Nothing in this area yet.</div> }
          </div>
        </section>
      } @empty {
        @if (data.docsLoaded()) {
          <div class="empty md tight"><p>No knowledge sources yet. Add them in <code>.claude/dashboard/docs.json</code>: notes in your team's storage (S3, Google Cloud Storage, Azure), a folder of Markdown or a docs site in a repo, or a link to Confluence, Notion or a wiki.</p></div>
        } @else { <div class="empty">Loading…</div> }
      }
    } @else if (site()?.kind === 'notes' || site()?.kind === 'store') {
      <dash-notes-view [site]="site()!" />
    } @else if (site()?.kind === 'external') {
      @if (site()!.searchable) { <dash-external-docs [site]="site()!" /> }
      @else { <div class="empty">{{ site()!.name }} can't be searched from here yet. <a [href]="site()!.url" target="_blank" rel="noopener">Open it ↗</a></div> }
    } @else {
      <div class="docs-layout">
        <aside class="panel side">
          <div class="site-tabs">
            @for (s of localSites(); track s.key) {
              <a [routerLink]="['/knowledge', s.key]" [class.on]="s.key === siteKey()">{{ s.name }}</a>
            }
          </div>
          <input class="filter" placeholder="Filter pages…" [value]="q()" (input)="q.set($any($event.target).value)" autocomplete="off">
          <div class="pages">
            @for (p of filteredPages(); track p.id) {
              <a class="pg" [class.on]="p.id === current()?.id" [routerLink]="['/knowledge', siteKey()]" [queryParams]="{ page: p.id }">
                <span class="t">{{ p.title }}</span><span class="r">{{ p.rel }}</span>
              </a>
            } @empty { <div class="empty">{{ pagesError() || (pages() ? 'No pages.' : 'Loading…') }}</div> }
          </div>
        </aside>

        <section class="panel reader">
          @if (current(); as p) {
            <div class="reader-h">
              <div class="meta">{{ site()?.name }} · {{ p.rel }}</div>
              <h2>{{ p.title }}</h2>
              <div class="acts">
                @if (p.format === 'html' && !api.hosted()) {
                  <span class="seg">
                    <button type="button" [class.on]="view() === 'page'" (click)="setView('page')">Page</button>
                    <button type="button" [class.on]="view() === 'text'" (click)="setView('text')">Text</button>
                  </span>
                }
                @if (p.live) { <a class="btn sm" [href]="p.live" target="_blank" rel="noopener">Live page ↗</a> }
                @if (doc()?.file && !api.hosted()) { <a class="btn ghost sm" [href]="vscode(doc()!.file!)">Open in VS Code</a> }
                <button class="btn ghost sm" (click)="ask(p)">Ask Claude about this</button>
                <button class="btn ghost sm" (click)="changes()" title="Start a Claude run that edits this repo (it pulls the latest main first)">Make edits</button>
              </div>
              @if (shown() === 'text' && p.sections.length > 2) {
                <div class="toc">@for (s of p.sections; track $index) { <button type="button" (click)="jump(s)">{{ s }}</button> }</div>
              }
            </div>
            @if (p.format === 'html' && shown() === 'page') {
              @if (frameUrl()) { <iframe class="frame" [src]="frameUrl()" [title]="p.title"></iframe> }
              @else { <div class="empty">{{ frameError() || 'Starting the local preview…' }}</div> }
            } @else {
              <div class="body md" #body [innerHTML]="html() | trustedHtml"></div>
            }
          } @else {
            <div class="empty" style="padding:3rem">{{ pages()?.pages?.length ? 'Pick a page.' : '' }}</div>
          }
        </section>
      </div>
    }
  `,
})
export class DocsComponent implements OnInit {
  readonly data = inject(DataService);
  readonly api = inject(ApiService);
  private readonly launch = inject(LaunchService);
  private readonly toast = inject(ToastService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly bodyEl = viewChild<ElementRef<HTMLElement>>('body');

  private readonly params = toSignal(this.route.paramMap);
  private readonly query = toSignal(this.route.queryParamMap);
  readonly siteKey = computed(() => this.params()?.get('site') || '');
  readonly pageId = computed(() => this.query()?.get('page') || '');

  readonly pages = signal<DocPagesResponse | null>(null);
  readonly pagesError = signal<string | null>(null);
  readonly doc = signal<SearchDoc | null>(null);
  readonly q = signal('');
  readonly view = signal<View>('page');
  /** What's shown: the chosen view, except hosted, where there's no local preview server to frame. */
  readonly shown = computed<View>(() => (this.api.hosted() ? 'text' : this.view()));
  readonly frameUrl = signal<SafeResourceUrl | null>(null);
  readonly frameError = signal<string | null>(null);
  private previewBase: Record<string, string> = {};

  /** Docs sites in the workspace (the static-site view's tabs). */
  readonly localSites = computed(() => this.data.docSites().filter((s) => s.kind === 'site'));
  readonly groups = computed(() => byArea(this.data.docSites(), this.data.docAreas()));
  readonly site = computed(() => this.data.docSites().find((s) => s.key === this.siteKey()) || this.pages()?.site || null);
  readonly filteredPages = computed(() => {
    const q = this.q().trim().toLowerCase();
    const list = this.pages()?.pages || [];
    return q ? list.filter((p) => (p.title + ' ' + p.rel + ' ' + p.sections.join(' ')).toLowerCase().includes(q)) : list;
  });
  readonly current = computed<DocPage | null>(() => {
    const list = this.pages()?.pages || [];
    return list.find((p) => p.id === this.pageId()) || list[0] || null;
  });
  readonly html = computed(() => renderMd(this.doc()?.content || ''));

  constructor() {
    // Site changed: load its page list.
    effect(() => {
      const key = this.siteKey();
      this.pages.set(null);
      this.pagesError.set(null);
      this.q.set('');
      // Only static sites use the page list here (external ones are searched, notes have their own view).
      const kind = this.data.docSites().find((s) => s.key === key)?.kind;
      if (!key || (kind && kind !== 'site')) return;
      this.api.get<DocPagesResponse>('/api/docs/pages?site=' + encodeURIComponent(key))
        .then((r) => { if (this.siteKey() === key) this.pages.set(r); })
        .catch((e) => this.pagesError.set((e as Error).message));
    });
    // Page changed: load its text, and point the frame at it.
    effect(() => {
      const p = this.current();
      this.doc.set(null);
      this.frameUrl.set(null);
      this.frameError.set(null);
      if (!p) return;
      this.api.get<SearchDoc>('/api/search/doc?id=' + encodeURIComponent(p.id))
        .then((d) => { if (this.current()?.id === p.id) this.doc.set(d); })
        .catch(() => {});
      if (p.format === 'html' && untracked(this.shown) === 'page') this.showFrame(p);
    });
  }

  ngOnInit(): void {
    if (!this.data.docSites().length) this.data.loadDocs();
    try { const v = localStorage.getItem('dash.docs.view'); if (v === 'text' || v === 'page') this.view.set(v); } catch {}
  }

  setView(v: View): void {
    this.view.set(v);
    try { localStorage.setItem('dash.docs.view', v); } catch {}
    const p = this.current();
    if (p && this.shown() === 'page') this.showFrame(p);
  }

  /** HTML pages render as the real page, served by the site's local preview server. */
  private async showFrame(p: DocPage): Promise<void> {
    const key = this.siteKey();
    try {
      let base = this.previewBase[key];
      if (!base) {
        const r = await this.api.post<{ url: string }>('/api/docs/preview', { site: key });
        // Only ever frame the dashboard's own localhost preview servers.
        if (!/^http:\/\/localhost:\d+\/$/.test(r.url)) throw new Error('Unexpected preview address.');
        base = this.previewBase[key] = r.url;
      }
      if (this.current()?.id !== p.id) return;
      this.frameUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(base + p.pagePath));
    } catch (e) {
      this.frameError.set((e as Error).message + ' Showing the text instead.');
      this.view.set('text');
    }
  }

  jump(section: string): void {
    const body = this.bodyEl()?.nativeElement;
    const el = body?.querySelector<HTMLElement>(`[data-sec="${CSS.escape(mdSlug(section))}"]`);
    if (body && el) body.scrollTop = el.offsetTop - body.offsetTop - 8;
  }

  ask(p: DocPage): void {
    const site = this.site();
    this.launch.open({
      title: 'Ask Claude',
      planMode: true,
      focusPrompt: true,
      trigger: 'ask',
      prompt: `About ${site?.repo || ''}/${p.rel} ("${p.title}"): `,
    });
  }

  /** An external source: a plan-mode run that uses the service's MCP connector. */
  askExternal(s: DocSite): void {
    this.launch.open({
      title: 'Ask Claude · ' + s.name,
      planMode: true,
      focusPrompt: true,
      trigger: 'ask',
      // A searchable source: "Use <source>" is ticked, which tells Claude how to reach it.
      ...(s.searchable ? { docSources: [s.key], prompt: '' } : { prompt: `Using the ${s.type} connector, look in ${s.name} (${s.url}): ` }),
    });
  }

  changes(): void {
    const s = this.site();
    if (!s || !s.repo) return;
    this.launch.open(siteEditLaunch(s.repo, s.name, this.current()?.rel));
  }

  reach(s: DocSite) { return reach(s, this.data.connections()); }
  staleIn(sites: DocSite[]): number { return sites.reduce((n, s) => n + (s.stale || 0), 0); }

  host(url: string | null): string { return url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : ''; }
  vscode(p: string): string { return vscodeUrl(p); }
}

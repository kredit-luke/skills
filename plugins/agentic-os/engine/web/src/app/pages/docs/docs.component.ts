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

type View = 'page' | 'text';

/**
 * Docs: the sources in .claude/dashboard/docs.json. Sites and notes in the
 * workspace are read from your working copy; external ones (Confluence, Notion,
 * ...) open where they live, and Ask Claude reaches them through their MCP connector.
 * Route: /docs, /docs/:site, /docs/:site?page=<doc id>.
 */
@Component({
  selector: 'dash-docs',
  imports: [PageHeaderComponent, RouterLink, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './docs.component.scss',
  template: `
    <dash-page-header eyebrow="Company" title="Docs" [sub]="api.copy('docsSub', 'Documentation in the workspace, read from your local copy of each repo (published sites link to their live version), and docs that live elsewhere.')" />

    @if (!siteKey()) {
      <div class="sites">
        @for (s of data.docSites(); track s.key) {
          @if (s.kind === 'external') {
            <div class="site-card ext">
              <a class="n" [href]="s.url" target="_blank" rel="noopener">{{ s.name }} ↗</a>
              <span class="ty">{{ s.type }} · {{ host(s.url) }}</span>
              @if (s.description) { <span class="ty">{{ s.description }}</span> }
              <button class="btn ghost sm" type="button" (click)="askExternal(s)" title="A read-only Claude run that looks this up through the {{ s.type }} connector">Ask Claude</button>
            </div>
          } @else {
            <a class="site-card" [class.off]="!s.available" [routerLink]="['/docs', s.key]">
              <span class="n">{{ s.name }}</span>
              <span class="ty">{{ s.docs }} page{{ s.docs === 1 ? '' : 's' }} · {{ s.kind === 'site' ? host(s.live) : 'internal notes' }}</span>
              @if (!s.available) { <span class="ty">not cloned</span> }
            </a>
          }
        } @empty {
          @if (data.docsLoaded()) {
            <div class="empty md tight"><p>No docs sources yet. Add them in <code>.claude/dashboard/docs.json</code>: a static-site repo, a folder of Markdown, or a link to Confluence, Notion or a wiki.</p></div>
          } @else { <div class="empty">Loading…</div> }
        }
      </div>
    } @else {
      <div class="docs-layout">
        <aside class="panel side">
          <div class="site-tabs">
            @for (s of localSites(); track s.key) {
              <a [routerLink]="['/docs', s.key]" [class.on]="s.key === siteKey()">{{ s.name }}</a>
            }
          </div>
          <input class="filter" placeholder="Filter pages…" [value]="q()" (input)="q.set($any($event.target).value)" autocomplete="off">
          <div class="pages">
            @for (p of filteredPages(); track p.id) {
              <a class="pg" [class.on]="p.id === current()?.id" [routerLink]="['/docs', siteKey()]" [queryParams]="{ page: p.id }">
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
                @if (p.format === 'html') {
                  <span class="seg">
                    <button type="button" [class.on]="view() === 'page'" (click)="setView('page')">Page</button>
                    <button type="button" [class.on]="view() === 'text'" (click)="setView('text')">Text</button>
                  </span>
                }
                @if (p.live) { <a class="btn sm" [href]="p.live" target="_blank" rel="noopener">Live page ↗</a> }
                @if (doc()?.file) { <a class="btn ghost sm" [href]="vscode(doc()!.file!)">Open in VS Code</a> }
                <button class="btn ghost sm" (click)="ask(p)">Ask Claude about this</button>
                <button class="btn ghost sm" (click)="changes()" title="Start a Claude run that edits this repo (it pulls the latest main first)">Make edits</button>
              </div>
              @if (view() === 'text' && p.sections.length > 2) {
                <div class="toc">@for (s of p.sections; track $index) { <button type="button" (click)="jump(s)">{{ s }}</button> }</div>
              }
            </div>
            @if (p.format === 'html' && view() === 'page') {
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
  readonly frameUrl = signal<SafeResourceUrl | null>(null);
  readonly frameError = signal<string | null>(null);
  private previewBase: Record<string, string> = {};

  /** Sources with a folder in the workspace (the ones this page can read). */
  readonly localSites = computed(() => this.data.docSites().filter((s) => s.kind !== 'external'));
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
      if (!key) return;
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
      if (p.format === 'html' && untracked(this.view) === 'page') this.showFrame(p);
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
    if (p && v === 'page') this.showFrame(p);
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
      prompt: `Using the ${s.type} connector, look in ${s.name} (${s.url}): `,
    });
  }

  changes(): void {
    const s = this.site();
    if (!s || !s.repo) return;
    this.launch.open(siteEditLaunch(s.repo, s.name, this.current()?.rel));
  }

  host(url: string | null): string { return url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : ''; }
  vscode(p: string): string { return vscodeUrl(p); }
}

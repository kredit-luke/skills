import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { DocSite, ExternalDocHit, ExternalDocPage, ExternalDocsStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { LaunchService } from '../../core/launch.service';
import { MdPipe } from '../../core/md.pipe';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { relTime } from '../../core/util';
import { KeyFieldsComponent } from '../../shared/key-fields.component';

/**
 * An external docs source with a provider adapter (Confluence, …): search it and read
 * pages here, with the viewer's own key. The query and the open page live in the URL
 * (?q=, ?page=), so Back returns to the results. Page HTML goes through Angular's
 * sanitizer ([innerHTML] without a bypass): scripts, handlers and frames are dropped.
 */
@Component({
  selector: 'dash-external-docs',
  imports: [MdPipe, TrustedHtmlPipe, KeyFieldsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './docs.component.scss',
  styles: [`
    .connect { padding: 1.25rem 1.5rem; max-width: 640px; }
    .connect ol { margin: 0.5rem 0 1rem 1.1rem; }
    .connect form { display: flex; gap: 0.5rem; }
    .connect input { flex: 1; }
    .search-box { padding: 10px; border-bottom: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 6px; }
    .hit { display: flex; flex-direction: column; gap: 2px; padding: 8px 9px; border-radius: 8px; cursor: pointer; border: 0; background: none; text-align: left; font: inherit; color: inherit; width: 100%; }
    .hit:hover { background: var(--paper-2); }
    .hit.on { background: var(--blue-bg); }
    .hit .t { font-size: 13px; font-weight: 600; }
    .hit .sp { font-size: 11px; color: var(--text-faint); }
    .hit .ex { font-size: 12px; color: var(--ink-soft); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .hit .ex mark { background: var(--warn-bg, #fff3c4); color: inherit; padding: 0 1px; }
    .crumbs { display: flex; flex-wrap: wrap; gap: 4px; font-size: 11.5px; color: var(--ink-soft); margin-bottom: 2px; }
    .crumbs button { border: 0; background: none; padding: 0; color: var(--link); cursor: pointer; font: inherit; }
    .labels { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .labels span { font-size: 11px; padding: 1px 8px; border-radius: var(--r-pill); background: var(--paper-2); color: var(--ink-soft); }
    .ext-body :is(img) { max-width: 100%; height: auto; }
    .ext-body :is(table) { border-collapse: collapse; }
    .forget { align-self: flex-start; margin-bottom: 8px; }
    .ext-body :is(td, th) { border: 1px solid var(--line); padding: 4px 8px; vertical-align: top; }
  `],
  template: `
    @let st = status();
    @if (!st) {
      <div class="empty">{{ statusError() || 'Loading…' }}</div>
    } @else if (!st.connected) {
      <div class="panel connect">
        @if (st.help; as help) {
          <h2>{{ help.title }}</h2>
          <ol>@for (s of help.steps; track $index) { <li class="md tight" [innerHTML]="s | md | trustedHtml"></li> }</ol>
          @if (help.needsKey) {
            <form (submit)="$event.preventDefault(); connect()">
              <dash-key-fields [fields]="help.keyFields" [placeholder]="help.placeholder" [(value)]="key" />
              <button class="btn primary" type="submit" [disabled]="busy() || !key().trim()">Connect</button>
            </form>
          }
        }
        <div class="form-err">{{ connectError() }}</div>
      </div>
    } @else {
      <div class="docs-layout">
        <aside class="panel side">
          @if (st.provider === 'confluence' && st.removable) {
            <button class="btn ghost sm forget" type="button" (click)="forgetAtlassian()" title="Remove your saved Atlassian API key (used by the Docs and Issues pages) so you can connect a different one">Disconnect Atlassian</button>
          }
          <div class="search-box">
            <input placeholder="Search {{ st.name }}…" [value]="q()" (input)="onQuery($any($event.target).value)" autocomplete="off">
            @if (st.spaces.length > 1) {
              <select (change)="onSpace($any($event.target).value)">
                <option value="" [selected]="!space()">All spaces</option>
                @for (s of st.spaces; track s.key) { <option [value]="s.key" [selected]="s.key === space()">{{ s.name }}</option> }
              </select>
            }
          </div>
          <div class="pages">
            @for (h of hits(); track h.id) {
              <button type="button" class="hit" [class.on]="h.id === pageId()" (click)="open(h.id)">
                <span class="t">{{ h.title }}</span>
                <span class="sp">{{ h.spaceName || h.space }}{{ h.updatedAt ? ' · ' + ago(h.updatedAt) : '' }}</span>
                @if (h.excerpt.length) { <span class="ex">@for (part of h.excerpt; track $index) { @if (part.hl) { <mark>{{ part.text }}</mark> } @else { {{ part.text }} } }</span> }
              </button>
            } @empty { <div class="empty">{{ searchError() || (searching() ? 'Searching…' : q().trim() ? 'No pages match.' : 'No pages.') }}</div> }
          </div>
        </aside>

        <section class="panel reader">
          @if (page(); as p) {
            <div class="reader-h">
              @if (p.ancestors.length) {
                <div class="crumbs">@for (a of p.ancestors; track a.id) { <button type="button" (click)="open(a.id)">{{ a.title }}</button><span>›</span> }</div>
              }
              <div class="meta">{{ p.spaceName || p.space }}{{ p.updatedAt ? ' · updated ' + ago(p.updatedAt) : '' }}{{ p.updatedBy ? ' by ' + p.updatedBy : '' }}</div>
              <h2>{{ p.title }}</h2>
              @if (p.labels.length) { <div class="labels">@for (l of p.labels; track l) { <span>{{ l }}</span> }</div> }
              <div class="acts">
                <a class="btn sm" [href]="p.url" target="_blank" rel="noopener">Open in {{ st.label }} ↗</a>
                <button class="btn ghost sm" type="button" (click)="ask(p)">Ask Claude about this page</button>
              </div>
            </div>
            <div class="body md ext-body" [innerHTML]="p.html"></div>
          } @else {
            <div class="empty" style="padding:3rem">{{ pageError() || (pageId() ? 'Loading…' : 'Pick a page.') }}</div>
          }
        </section>
      </div>
    }
  `,
})
export class ExternalDocsComponent {
  readonly site = input.required<DocSite>();
  private readonly api = inject(ApiService);
  private readonly launch = inject(LaunchService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly query = toSignal(this.route.queryParamMap);

  readonly status = signal<ExternalDocsStatus | null>(null);
  readonly statusError = signal<string | null>(null);
  readonly key = signal('');
  readonly busy = signal(false);
  readonly connectError = signal<string | null>(null);

  /** The typed query (the URL follows it after a pause). */
  readonly q = signal(this.route.snapshot.queryParamMap.get('q') || '');
  readonly space = computed(() => this.query()?.get('space') || '');
  readonly pageId = computed(() => this.query()?.get('page') || '');
  readonly hits = signal<ExternalDocHit[]>([]);
  readonly searching = signal(false);
  readonly searchError = signal<string | null>(null);
  readonly page = signal<ExternalDocPage | null>(null);
  readonly pageError = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor() {
    effect(() => { const s = this.site(); untracked(() => this.loadStatus(s.key)); });
    // Search follows the URL's q and space.
    effect(() => {
      const st = this.status();
      const q = this.query()?.get('q') || '';
      const space = this.space();
      if (st?.connected) untracked(() => this.search(q, space));
    });
    effect(() => {
      const id = this.pageId();
      const st = this.status();
      if (st?.connected) untracked(() => this.loadPage(id));
    });
  }

  private async loadStatus(site: string): Promise<void> {
    this.status.set(null);
    this.statusError.set(null);
    try { this.status.set(await this.api.get<ExternalDocsStatus>('/api/docs/external?site=' + encodeURIComponent(site))); }
    catch (e) { this.statusError.set((e as Error).message); }
  }

  async connect(): Promise<void> {
    this.busy.set(true);
    this.connectError.set(null);
    try {
      this.status.set(await this.api.post<ExternalDocsStatus>('/api/docs/external/connect', { site: this.site().key, key: this.key().trim() }));
      this.key.set('');
    } catch (e) { this.connectError.set((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async forgetAtlassian(): Promise<void> {
    if (!confirm("Remove your saved Atlassian API key? The Docs and Issues pages stop using it until you connect a key again. (Claude's own Atlassian connector isn't affected.)")) return;
    try {
      const r = await this.api.post<{ envKeys: string[] }>('/api/atlassian/disconnect', {});
      this.toast.show(r.envKeys.length ? `Saved key removed. ${r.envKeys.join(', ')} is still set in your environment.` : 'Atlassian key removed');
      await this.loadStatus(this.site().key);
    } catch (e) { this.toast.show((e as Error).message); }
  }

  onQuery(v: string): void {
    this.q.set(v);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.nav({ q: v.trim() || null }), 300);
  }
  onSpace(v: string): void { this.nav({ space: v || null }); }
  open(id: string): void { this.nav({ page: id }, false); }

  private nav(params: Record<string, string | null>, replace = true): void {
    this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge', replaceUrl: replace });
  }

  private async search(q: string, space: string): Promise<void> {
    const seq = ++this.seq;
    this.searching.set(true);
    this.searchError.set(null);
    try {
      const url = `/api/docs/external/search?site=${encodeURIComponent(this.site().key)}&q=${encodeURIComponent(q)}${space ? '&spaces=' + encodeURIComponent(space) : ''}`;
      const r = await this.api.get<{ hits: ExternalDocHit[] }>(url);
      if (seq === this.seq) this.hits.set(r.hits);
    } catch (e) {
      if (seq === this.seq) { this.hits.set([]); this.searchError.set((e as Error).message); }
    } finally {
      if (seq === this.seq) this.searching.set(false);
    }
  }

  private async loadPage(id: string): Promise<void> {
    this.pageError.set(null);
    if (!id) { this.page.set(null); return; }
    if (this.page()?.id === id) return;
    this.page.set(null);
    try {
      const p = await this.api.get<ExternalDocPage>(`/api/docs/external/page?site=${encodeURIComponent(this.site().key)}&id=${encodeURIComponent(id)}`);
      if (this.pageId() === id) this.page.set(p);
    } catch (e) { this.pageError.set((e as Error).message); }
  }

  ask(p: ExternalDocPage): void {
    const s = this.site();
    this.launch.open({
      title: 'Ask Claude · ' + s.name,
      planMode: true,
      focusPrompt: true,
      trigger: 'ask',
      docSources: [s.key],
      docPage: p.id,
      prompt: `About the ${s.name} page "${p.title}" (${p.url}): `,
    });
  }

  ago(iso: string): string { const t = Date.parse(iso); return Number.isFinite(t) ? relTime(t) : ''; }
}

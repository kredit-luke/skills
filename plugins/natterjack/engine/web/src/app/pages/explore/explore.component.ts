import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import type { ExploreEntry, ExploreFile, ExploreListResponse, ExploreSaveRequest, ExploreSaveResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ancestors, baseName, dirOf, joinRel, languageOf, previewOf, rawUrl } from '../../core/explore-paths';
import { renderMd } from '../../core/markdown';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { bytes, vscodeUrl } from '../../core/util';
import { CodeEditorComponent, type EditorDoc } from '../../shared/code-editor.component';
import { PageHeaderComponent } from '../../shared/page-header.component';

type Tab = 'code' | 'preview';
interface Row { entry: ExploreEntry; path: string; depth: number }

/**
 * Explore: browse the workspace, read files with syntax highlighting, preview
 * markdown / HTML / images, and edit text files in place.
 * Route: /explore?path=<workspace-relative file>.
 */
@Component({
  selector: 'dash-explore',
  imports: [PageHeaderComponent, TrustedHtmlPipe, CodeEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './explore.component.scss',
  template: `
    <dash-page-header eyebrow="Workspace" title="Explore" sub="Browse, read and edit the files in your workspace." />

    <div class="ex-layout">
      <aside class="panel side">
        <input class="filter" placeholder="Filter open folders…" [value]="q()" (input)="q.set($any($event.target).value)" autocomplete="off">
        <div class="tree" role="tree">
          @for (r of rows(); track r.path) {
            <button type="button" class="row" role="treeitem" [class.on]="r.path === filePath()" [class.heavy]="r.entry.heavy"
                    [style.padding-left.px]="8 + r.depth * 14" [title]="r.path" (click)="pick(r)">
              @if (r.entry.kind === 'dir') {
                <span class="tw">{{ expanded().has(r.path) ? '▾' : '▸' }}</span><span class="ic dir">▣</span>
              } @else {
                <span class="tw"></span><span class="ic">·</span>
              }
              <span class="nm">{{ q() ? r.path : r.entry.name }}</span>
              @if (r.entry.link) { <span class="tag">link</span> }
              @if (loadingDirs().has(r.path)) { <span class="tag">…</span> }
            </button>
          } @empty { <div class="empty">{{ treeError() || (q() ? 'Nothing in the open folders matches.' : 'Loading…') }}</div> }
        </div>
      </aside>

      <section class="panel reader">
        @if (filePath()) {
          <div class="reader-h">
            <div class="crumbs">
              <button type="button" (click)="reveal('')">workspace</button>
              @for (c of crumbs(); track c.path) { <span>/</span><button type="button" (click)="reveal(c.path)">{{ c.name }}</button> }
            </div>
            <div class="acts">
              @if (preview()) {
                <span class="seg">
                  <button type="button" [class.on]="tab() === 'code'" [disabled]="!hasText()" (click)="tab.set('code')">Code</button>
                  <button type="button" [class.on]="tab() === 'preview'" (click)="tab.set('preview')">Preview</button>
                </span>
              }
              @if (canEdit()) {
                @if (!editing()) {
                  <button class="btn sm" (click)="startEdit()">Edit</button>
                } @else {
                  <button class="btn sm" [disabled]="!dirty() || saving()" (click)="saveFile()" title="Ctrl+S">{{ saving() ? 'Saving…' : 'Save' }}</button>
                  <button class="btn ghost sm" [disabled]="saving()" (click)="stopEdit()">{{ dirty() ? 'Discard changes' : 'Done' }}</button>
                }
              }
              @if (file(); as f) { <a class="btn ghost sm" [href]="vscode(f.abs)">Open in VS Code</a> }
              <button class="btn ghost sm" (click)="reload()" [disabled]="saving()">Reload</button>
            </div>
          </div>

          @if (conflict()) {
            <div class="warn-note conflict">
              This file changed on disk since you opened it.
              <button class="btn sm" (click)="reload()">Load the disk version</button>
              <button class="btn ghost sm" (click)="saveFile(true)">Overwrite it with mine</button>
            </div>
          }

          <div class="body">
            @if (fileError()) {
              <div class="empty">{{ fileError() }}</div>
            } @else if (!file()) {
              <div class="empty">Loading…</div>
            } @else if (tab() === 'preview' && preview() === 'markdown') {
              <div class="md mdv" (click)="mdClick($event)" [innerHTML]="mdHtml() | trustedHtml"></div>
            } @else if (tab() === 'preview' && preview() === 'html') {
              @if (dirty()) { <div class="hint">The preview shows the saved file. Save to see your edits.</div> }
              <iframe class="frame" [src]="frameUrl()" sandbox="allow-scripts allow-forms allow-popups" [title]="fileName()"></iframe>
            } @else if (tab() === 'preview' && preview() === 'image') {
              <div class="img"><img [src]="imgUrl()" [alt]="fileName()"></div>
            } @else if (hasText()) {
              <dash-code-editor class="code" [doc]="doc()!" [readOnly]="!editing()" (changed)="buffer.set($event)" (save)="saveFile()" />
            } @else {
              <div class="empty">{{ file()!.readOnlyReason }} ({{ size(file()!.size) }})</div>
            }
          </div>

          @if (file(); as f) {
            <div class="status">
              <span>{{ size(f.size) }}</span>
              @if (hasText()) {
                <button type="button" class="eol" [disabled]="!editing()" (click)="toggleEol()"
                        [title]="editing() ? 'Line endings used when saving. Click to switch.' : 'Line endings. Edit to change them.'">{{ saveEol().toUpperCase() }}</button>
                <span>{{ f.bom ? 'UTF-8 with BOM' : 'UTF-8' }}</span>
                @if (f.eol === 'mixed') { <span class="warn">Mixed line endings. Saving makes them all {{ saveEol().toUpperCase() }}.</span> }
                @else if (f.eol !== 'none' && saveEol() !== f.eol) { <span class="warn">Saving converts {{ f.eol.toUpperCase() }} to {{ saveEol().toUpperCase() }}.</span> }
              }
              @if (f.readOnlyReason && f.content !== null) { <span class="warn">{{ f.readOnlyReason }}</span> }
              @if (dirty()) { <span class="dirty">● Unsaved changes</span> }
            </div>
          }
        } @else {
          <div class="empty" style="padding:3rem">Pick a file on the left.</div>
        }
      </section>
    </div>
  `,
})
export class ExploreComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly query = toSignal(this.route.queryParamMap);
  readonly filePath = computed(() => this.query()?.get('path') || '');

  // Tree: folder path → its entries, and which folders are open.
  readonly children = signal<Map<string, ExploreEntry[]>>(new Map());
  readonly expanded = signal<Set<string>>(new Set(['']));
  readonly loadingDirs = signal<Set<string>>(new Set());
  readonly treeError = signal<string | null>(null);
  readonly q = signal('');

  readonly file = signal<ExploreFile | null>(null);
  readonly fileError = signal<string | null>(null);
  readonly doc = signal<EditorDoc | null>(null);
  readonly buffer = signal('');
  readonly editing = signal(false);
  readonly saving = signal(false);
  readonly conflict = signal(false);
  readonly saveEol = signal<'lf' | 'crlf'>('lf');
  readonly tab = signal<Tab>('code');
  private loads = 0;

  readonly rows = computed<Row[]>(() => {
    const kids = this.children(), open = this.expanded(), q = this.q().trim().toLowerCase();
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of kids.get(dir) || []) {
        const p = dir ? dir + '/' + entry.name : entry.name;
        if (!q || entry.name.toLowerCase().includes(q)) out.push({ entry, path: p, depth: q ? 0 : depth });
        if (entry.kind === 'dir' && open.has(p)) walk(p, depth + 1);
      }
    };
    walk('', 0);
    return out;
  });

  readonly fileName = computed(() => baseName(this.filePath()));
  readonly crumbs = computed(() => {
    const parts = this.filePath().split('/');
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  });
  readonly preview = computed(() => previewOf(this.filePath()));
  readonly hasText = computed(() => this.file()?.content != null);
  readonly canEdit = computed(() => { const f = this.file(); return !!f && f.content != null && !f.readOnlyReason; });
  /** Unsaved: the text differs from the file, or its line endings were switched. */
  readonly dirty = computed(() => this.editing() && (this.buffer() !== (this.file()?.content ?? '') || this.saveEol() !== this.file()?.saveEol));
  readonly mdHtml = computed(() => {
    const dir = dirOf(this.filePath());
    return renderMd(this.editing() ? this.buffer() : this.file()?.content, {
      image: (src) => { const p = joinRel(dir, src); return p == null ? null : rawUrl(p); },
      link: (href) => { const p = joinRel(dir, href); return p == null ? null : '/explore?path=' + encodeURIComponent(p); },
    });
  });
  readonly imgUrl = computed(() => rawUrl(this.filePath()) + '?v=' + (this.file()?.mtimeMs || 0));
  readonly frameUrl = computed<SafeResourceUrl>(() =>
    // rawUrl only ever points at this server's sandboxed raw route.
    this.sanitizer.bypassSecurityTrustResourceUrl(rawUrl(this.filePath()) + '?v=' + (this.file()?.mtimeMs || 0)));

  constructor() {
    this.loadDir('');
    effect(() => {
      const p = this.filePath();
      untracked(() => {
        for (const a of ancestors(p)) this.openDir(a);
        this.loadFile(p);
      });
    });
  }

  // ---------------------------------------------------------------- tree

  pick(r: Row): void {
    if (r.entry.kind === 'file') { this.router.navigate(['/explore'], { queryParams: { path: r.path } }); return; }
    if (this.expanded().has(r.path)) this.expanded.update((s) => { const n = new Set(s); n.delete(r.path); return n; });
    else this.openDir(r.path);
  }

  /** Open a folder (and the ones above it) in the tree. */
  reveal(p: string): void {
    this.q.set('');
    for (const a of [...ancestors(p), p]) this.openDir(a);
  }

  private openDir(p: string): void {
    if (!p) return;
    this.expanded.update((s) => new Set(s).add(p));
    if (!this.children().has(p)) this.loadDir(p);
  }

  private async loadDir(p: string): Promise<void> {
    this.loadingDirs.update((s) => new Set(s).add(p));
    try {
      const r = await this.api.get<ExploreListResponse>('/api/explore/list?path=' + encodeURIComponent(p));
      this.children.update((m) => new Map(m).set(p, r.entries));
      this.treeError.set(null);
    } catch (e) {
      if (!p) this.treeError.set((e as Error).message);
      else this.toast.show((e as Error).message, true);
      this.expanded.update((s) => { const n = new Set(s); n.delete(p); return n; });
    } finally {
      this.loadingDirs.update((s) => { const n = new Set(s); n.delete(p); return n; });
    }
  }

  // ---------------------------------------------------------------- file

  private async loadFile(p: string): Promise<void> {
    const n = ++this.loads;
    this.file.set(null);
    this.fileError.set(null);
    this.doc.set(null);
    this.editing.set(false);
    this.conflict.set(false);
    if (!p) return;
    try {
      const f = await this.api.get<ExploreFile>('/api/explore/file?path=' + encodeURIComponent(p));
      if (n !== this.loads) return;
      this.show(f);
      this.tab.set(this.preview() && (this.preview() !== 'html' || f.content == null) ? 'preview' : 'code');
    } catch (e) {
      if (n === this.loads) this.fileError.set((e as Error).message);
    }
  }

  private show(f: ExploreFile): void {
    this.file.set(f);
    this.buffer.set(f.content ?? '');
    this.saveEol.set(f.saveEol);
    this.conflict.set(false);
    if (f.content != null) this.doc.set({ key: f.path + '@' + f.mtimeMs + '#' + this.loads, text: f.content, lang: languageOf(f.path) });
  }

  reload(): void {
    if (this.dirty() && !confirm('Discard your unsaved changes and load the file from disk?')) return;
    this.loadFile(this.filePath());
  }

  startEdit(): void {
    this.editing.set(true);
    this.tab.set('code');
  }

  stopEdit(): void {
    if (this.dirty() && !confirm('Discard your unsaved changes?')) return;
    const f = this.file();
    this.editing.set(false);
    this.conflict.set(false);
    if (f) { this.loads++; this.show(f); } // back to the saved text
  }

  toggleEol(): void {
    if (this.editing()) this.saveEol.update((e) => (e === 'lf' ? 'crlf' : 'lf'));
  }

  async saveFile(force = false): Promise<void> {
    const f = this.file();
    if (!f || !this.editing() || this.saving() || (!this.dirty() && !force)) return;
    this.saving.set(true);
    const content = this.buffer();
    const body: ExploreSaveRequest = { path: f.path, content, eol: this.saveEol(), bom: f.bom, baseMtimeMs: f.mtimeMs, force };
    try {
      const r = await this.api.post<ExploreSaveResponse>('/api/explore/save', body);
      // Keep the editor (and its undo history) as is; only the saved baseline moves.
      this.file.set({ ...f, content, size: r.size, mtimeMs: r.mtimeMs, eol: content.includes('\n') ? r.eol : 'none', saveEol: r.eol });
      this.conflict.set(false);
      this.toast.show('Saved ' + baseName(f.path));
    } catch (e) {
      if ((e as { status?: number }).status === 409) this.conflict.set(true);
      else this.toast.show((e as Error).message, true);
    } finally {
      this.saving.set(false);
    }
  }

  /** Relative links in a markdown preview open in Explore without reloading the app. */
  mdClick(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a[data-rel]') as HTMLAnchorElement | null;
    if (!a || ev.ctrlKey || ev.metaKey || ev.button !== 0) return;
    const p = new URL(a.href).searchParams.get('path');
    if (p == null) return;
    ev.preventDefault();
    this.router.navigate(['/explore'], { queryParams: { path: p } });
  }

  /** Used by the route's canDeactivate guard (also on switching files). */
  canLeave(): boolean {
    return !this.dirty() || confirm('You have unsaved changes. Leave without saving?');
  }

  @HostListener('window:beforeunload', ['$event'])
  beforeUnload(ev: BeforeUnloadEvent): void {
    if (this.dirty()) ev.preventDefault();
  }

  size(n: number): string { return bytes(n); }
  vscode(p: string): string { return vscodeUrl(p); }
}

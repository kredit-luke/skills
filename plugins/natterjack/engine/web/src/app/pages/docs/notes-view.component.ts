import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { DocSite, KnowledgeNote, KnowledgeNoteText, KnowledgeNotesResponse, KnowledgeStoreStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { inlineMd, renderMd } from '../../core/markdown';
import { siteEditLaunch } from '../../core/site-edit';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { vscodeUrl } from '../../core/util';
import { CodeEditorComponent } from '../../shared/code-editor.component';
import { ago, buildTree, filterNotes, joinNote, relFromDocId, resolveWiki, type TreeFolder } from './knowledge.util';

/**
 * One Markdown source on the Knowledge page, read like an Obsidian vault: a folder
 * tree, [[wikilinks]] that open the note, owner / reviewed / tags from frontmatter,
 * backlinks, and freshness against the area's review interval. A store (business notes
 * in the team's bucket) is also edited here: new, edit, rename, delete, each guarded
 * so nobody overwrites someone else's newer change. Route: /knowledge/:site?note=<rel>.
 */
@Component({
  selector: 'dash-notes-view',
  imports: [NgTemplateOutlet, TrustedHtmlPipe, CodeEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './notes-view.component.scss',
  template: `
    @let st = list()?.store;
    @if (site().kind === 'store' && st && !st.connected) {
      <div class="panel connect">
        @if (st.help; as h) {
          <h3>{{ h.title }}</h3>
          <ol>@for (s of h.steps; track $index) { <li [innerHTML]="inline(s) | trustedHtml"></li> }</ol>
          @if (h.needsKey && api.hosted()) {
            <p class="hint">Your admin connects this in the dashboard's deployment (the <code>KNOWLEDGE_{{ envKey() }}_KEY</code> secret), so nobody has to paste a key. Ask them to set it.</p>
          } @else if (h.needsKey) {
            <div class="row">
              <input #key type="password" autocomplete="off" spellcheck="false" [placeholder]="h.placeholder" aria-label="Access key" (keydown.enter)="connect(key.value)">
              <button class="btn primary sm" [disabled]="busy()" (click)="connect(key.value)">{{ busy() ? 'Connecting…' : 'Connect' }}</button>
            </div>
          }
        }
        @if (st.error) { <div class="warn-note">{{ st.error }}</div> }
      </div>
    }
    <div class="docs-layout">
      <aside class="panel side">
        @if (st && st.connected) {
          <div class="sync">
            <span>{{ st.syncing ? 'Syncing…' : 'Synced ' + ago(st.syncedAt) }}</span>
            <button class="btn ghost sm" [disabled]="st.syncing || busy()" (click)="sync()">Sync now</button>
            <button class="btn primary sm" (click)="startNew('')">New note</button>
          </div>
          @if (st.error) { <div class="warn-note sm">{{ st.error }}</div> }
        }
        @if (newName() !== null) {
          <div class="newrow">
            <input #nn [value]="newName()" placeholder="Folder/Note name" aria-label="New note name" autocomplete="off" (keydown.enter)="createNote(nn.value)" (keydown.escape)="newName.set(null)">
            <button class="btn primary sm" [disabled]="busy()" (click)="createNote(nn.value)">Create</button>
          </div>
        }
        <input class="filter" placeholder="Filter notes…" [value]="q()" (input)="q.set($any($event.target).value)" autocomplete="off">
        @if (topTags().length || dueCount()) {
          <div class="tags">
            @if (dueCount()) { <button type="button" class="tag amber" [class.on]="staleOnly()" (click)="staleOnly.set(!staleOnly())">due for review · {{ dueCount() }}</button> }
            @for (t of topTags(); track t[0]) { <button type="button" class="tag" [class.on]="tag() === t[0]" (click)="tag.set(tag() === t[0] ? null : t[0])">#{{ t[0] }}</button> }
          </div>
        }
        <div class="pages">
          @if (!list()) { <div class="empty">{{ error() || 'Loading…' }}</div> }
          @else if (filtering()) {
            @for (n of filtered(); track n.rel) { <ng-container *ngTemplateOutlet="row; context: { $implicit: n, path: true }" /> }
            @empty { <div class="empty">Nothing matches.</div> }
          } @else {
            <ng-container *ngTemplateOutlet="folder; context: { $implicit: tree() }" />
            @if (!list()!.notes.length) { <div class="empty">{{ site().kind === 'store' ? (st?.connected ? 'No notes yet: start one with New note.' : 'Connect to see the notes.') : 'No notes.' }}</div> }
          }
        </div>
        @if (st && st.connected) {
          <div class="side-foot">
            <label class="chk" title="Adds the local copy to additionalDirectories in your .claude/settings.local.json, so Claude sessions you start in this workspace can read it. Dashboard runs get it from 'Use {{ site().name }}'.">
              <input type="checkbox" [checked]="st.claudeAccess" (change)="claudeAccess($any($event.target).checked)"> My Claude sessions can read it
            </label>
            @if (st.keySource === 'file') { <button class="btn ghost sm" (click)="disconnect()">Disconnect</button> }
          </div>
        }
      </aside>

      <section class="panel reader">
        @if (current(); as n) {
          <div class="reader-h">
            <div class="meta">{{ site().name }} · {{ n.rel }}@if (n.updatedAt) { · changed {{ ago(n.updatedAt) }} }</div>
            @if (renaming()) {
              <div class="newrow"><input #rn [value]="n.rel" aria-label="New name" (keydown.enter)="rename(rn.value)" (keydown.escape)="renaming.set(false)"><button class="btn primary sm" [disabled]="busy()" (click)="rename(rn.value)">Rename</button><button class="btn ghost sm" (click)="renaming.set(false)">Cancel</button></div>
            } @else { <h2>{{ n.title }}</h2> }
            <div class="chips">
              @if (n.owner) { <span class="tag">owner: {{ n.owner }}</span> }
              @if (n.stale) { <span class="tag amber" [title]="'Last reviewed ' + (n.since || '') ">review due since {{ n.dueAt }}</span> }
              @else if (n.reviewed) { <span class="tag good">reviewed {{ n.reviewed }}</span> }
              @for (t of n.tags; track t) { <button type="button" class="tag" (click)="tag.set(t)">#{{ t }}</button> }
            </div>
            <div class="acts">
              @if (editing()) {
                <button class="btn primary sm" [disabled]="busy()" (click)="save()">{{ busy() ? 'Saving…' : 'Save' }}</button>
                <button class="btn ghost sm" (click)="cancelEdit()">Cancel</button>
                @if (conflict()) { <span class="warn-note sm">{{ conflict() }} <button class="btn ghost sm" (click)="reloadTheirs()">Load their version</button></span> }
              } @else {
                @if (text()?.editable) { <button class="btn primary sm" (click)="edit()">Edit</button> }
                @if (site().kind !== 'site') { <button class="btn ghost sm" [disabled]="busy()" (click)="markReviewed()" title="Sets reviewed: today in the note's frontmatter">Mark reviewed</button> }
                <button class="btn ghost sm" (click)="ask(n)">Ask Claude about this</button>
                @if (site().kind === 'store') {
                  <button class="btn ghost sm" (click)="renaming.set(true)">Rename</button>
                  <button class="btn danger sm" [disabled]="busy()" (click)="remove()">{{ armed() ? 'Click again to delete' : 'Delete' }}</button>
                } @else {
                  @if (text()?.file && !api.hosted()) { <a class="btn ghost sm" [href]="vscode(text()!.file)">Open in VS Code</a> }
                  <button class="btn ghost sm" (click)="changes()" title="Start a Claude run that edits this repo">Make edits</button>
                }
              }
            </div>
          </div>
          @if (editing()) {
            <dash-code-editor class="editor" [doc]="{ key: n.rel + '#' + editKey(), text: buffer(), lang: 'markdown' }" [readOnly]="false" [wrap]="true" (changed)="buffer.set($event)" (save)="save()" />
          } @else {
            <div class="body md" (click)="onBodyClick($event)" [innerHTML]="html() | trustedHtml"></div>
            @if (n.backlinks.length || n.unresolved.length) {
              <div class="links">
                @if (n.backlinks.length) {
                  <div><b>Linked from</b> @for (b of n.backlinks; track b) { <button type="button" class="lnk" (click)="open(b)">{{ titleOf(b) }}</button> }</div>
                }
                @if (n.unresolved.length) {
                  <div><b>Links to notes that don't exist yet</b> @for (u of n.unresolved; track u) {
                    @if (text()?.editable) { <button type="button" class="lnk missing" (click)="startNew(u)" title="Create it">{{ u }}</button> } @else { <span class="lnk missing">{{ u }}</span> }
                  }</div>
                }
              </div>
            }
          }
        } @else {
          <div class="empty" style="padding:3rem">{{ list()?.notes?.length ? 'Pick a note.' : '' }}</div>
        }
      </section>
    </div>

    <ng-template #folder let-f>
      @for (sub of f.folders; track sub.path) {
        <button type="button" class="fold" (click)="toggle(sub.path)"><span class="arrow" [class.open]="!closed().has(sub.path)">&#9654;</span>{{ sub.name }}</button>
        @if (!closed().has(sub.path)) { <div class="indent"><ng-container *ngTemplateOutlet="folder; context: { $implicit: sub }" /></div> }
      }
      @for (n of f.notes; track n.rel) { <ng-container *ngTemplateOutlet="row; context: { $implicit: n, path: false }" /> }
    </ng-template>
    <ng-template #row let-n let-path="path">
      <button type="button" class="pg" [class.on]="n.rel === current()?.rel" (click)="open(n.rel)">
        <span class="t">{{ n.title }}@if (n.stale) { <span class="dot" title="Review due"></span> }</span>
        @if (path) { <span class="r">{{ n.rel }}</span> }
      </button>
    </ng-template>
  `,
})
export class NotesViewComponent {
  readonly site = input.required<DocSite>();
  readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly launch = inject(LaunchService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly query = toSignal(this.route.queryParamMap);

  readonly list = signal<KnowledgeNotesResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly text = signal<KnowledgeNoteText | null>(null);
  readonly q = signal('');
  readonly tag = signal<string | null>(null);
  readonly staleOnly = signal(false);
  readonly closed = signal<Set<string>>(new Set());
  readonly busy = signal(false);
  readonly editing = signal(false);
  readonly editKey = signal(0);
  readonly buffer = signal('');
  readonly conflict = signal<string | null>(null);
  readonly newName = signal<string | null>(null);
  readonly renaming = signal(false);
  readonly armed = signal(false);
  private poll: ReturnType<typeof setTimeout> | null = null;

  readonly tree = computed<TreeFolder>(() => buildTree(this.list()?.notes || []));
  readonly filtering = computed(() => !!this.q().trim() || !!this.tag() || this.staleOnly());
  readonly filtered = computed(() => filterNotes(this.list()?.notes || [], this.q(), this.tag(), this.staleOnly()));
  readonly topTags = computed(() => Object.entries(this.list()?.tags || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14));
  readonly dueCount = computed(() => (this.list()?.notes || []).filter((n) => n.stale).length);
  private readonly rels = computed(() => (this.list()?.notes || []).map((n) => n.rel));
  /** The note in the address (?note=, or a search result's ?page=), else the vault's README / index, else the first. */
  readonly current = computed<KnowledgeNote | null>(() => {
    const notes = this.list()?.notes || [];
    const qp = this.query();
    const want = qp?.get('note') || (qp?.get('page') ? relFromDocId(qp.get('page')!, this.site()) : null);
    return notes.find((n) => n.rel === want)
      || (!want ? notes.find((n) => /^(readme|index|home)\.md$/i.test(n.rel)) || notes[0] : null)
      || null;
  });
  readonly html = computed(() => {
    const t = this.text();
    const n = this.current();
    if (!t || !n || t.rel !== n.rel) return '';
    const key = this.site().key;
    return renderMd(t.text, {
      image: (src) => { const rel = joinNote(n.rel, src); return rel ? `/api/knowledge/image?source=${encodeURIComponent(key)}&rel=${encodeURIComponent(rel)}` : null; },
      link: (href) => { const rel = joinNote(n.rel, href); return rel && this.rels().includes(rel) ? this.noteHref(rel) : null; },
      wiki: (target) => { const rel = resolveWiki(target, n.rel, this.rels()); return rel ? this.noteHref(rel) : null; },
    });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => { if (this.poll) clearTimeout(this.poll); });
    effect(() => {
      const key = this.site().key;
      untracked(() => { this.list.set(null); this.q.set(''); this.tag.set(null); this.staleOnly.set(false); this.load(key); });
    });
    // The note changed: load its text (and leave edit mode).
    effect(() => {
      const n = this.current();
      untracked(() => {
        this.editing.set(false);
        this.renaming.set(false);
        this.conflict.set(null);
        if (!n) { this.text.set(null); return; }
        if (this.text()?.rel === n.rel) return;
        this.loadText(n.rel);
      });
    });
  }

  private async load(key = this.site().key): Promise<void> {
    if (this.poll) { clearTimeout(this.poll); this.poll = null; }
    try {
      const r = await this.api.get<KnowledgeNotesResponse>('/api/knowledge/notes?source=' + encodeURIComponent(key));
      if (this.site().key !== key) return;
      this.list.set(r);
      this.error.set(null);
      // A store syncing in the background: look again shortly.
      if (r.store?.connected && (r.store.syncing || !r.store.syncedAt)) this.poll = setTimeout(() => this.load(key), 2500);
    } catch (e) { this.error.set((e as Error).message); }
  }

  private async loadText(rel: string): Promise<void> {
    try {
      const t = await this.api.get<KnowledgeNoteText>(`/api/knowledge/note?source=${encodeURIComponent(this.site().key)}&rel=${encodeURIComponent(rel)}`);
      if (this.current()?.rel === rel) this.text.set(t);
    } catch (e) { this.text.set(null); this.toast.error((e as Error).message); }
  }

  envKey(): string { return this.site().key.toUpperCase().replace(/[^A-Z0-9]/g, '_'); }

  noteHref(rel: string): string { return `/knowledge/${encodeURIComponent(this.site().key)}?note=${encodeURIComponent(rel)}`; }
  open(rel: string): void { this.router.navigate(['/knowledge', this.site().key], { queryParams: { note: rel } }); }
  titleOf(rel: string): string { return this.list()?.notes.find((n) => n.rel === rel)?.title || rel; }
  toggle(path: string): void { const s = new Set(this.closed()); if (s.has(path)) s.delete(path); else s.add(path); this.closed.set(s); }
  ago(iso: string | null): string { return ago(iso); }
  inline(s: string): string { return inlineMd(s); }
  vscode(p: string): string { return vscodeUrl(p); }

  /** Links to other notes open in the page; a missing [[note]] offers to create it. */
  onBodyClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    const a = el.closest('a') as HTMLAnchorElement | null;
    if (a && a.getAttribute('href')?.startsWith('/knowledge/')) {
      e.preventDefault();
      const u = new URL(a.href, location.origin);
      const rel = u.searchParams.get('note');
      if (rel) this.open(rel);
      return;
    }
    const miss = el.closest('.wl-missing');
    if (miss && this.text()?.editable) this.startNew(miss.textContent || '');
  }

  // ---------------------------------------------------------------- store: connect and sync

  private setStore(st: KnowledgeStoreStatus): void {
    const l = this.list();
    if (l) this.list.set({ ...l, store: st });
  }

  async connect(key: string): Promise<void> {
    if (!key.trim()) return;
    this.busy.set(true);
    try {
      this.setStore(await this.api.post<KnowledgeStoreStatus>('/api/knowledge/connect', { source: this.site().key, key }));
      this.toast.show('Connected to ' + this.site().name);
      await this.load();
      this.data.loadDocs();
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async disconnect(): Promise<void> {
    try { this.setStore(await this.api.post<KnowledgeStoreStatus>('/api/knowledge/disconnect', { source: this.site().key })); }
    catch (e) { this.toast.error((e as Error).message); }
  }

  async sync(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.post<KnowledgeStoreStatus>('/api/knowledge/sync', { source: this.site().key });
      await this.load();
      const cur = this.current();
      if (cur && !this.editing()) this.loadText(cur.rel);
      this.data.loadDocs();
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async claudeAccess(on: boolean): Promise<void> {
    try {
      this.setStore(await this.api.post<KnowledgeStoreStatus>('/api/knowledge/claude-access', { source: this.site().key, on }));
      this.toast.show(on ? 'Claude sessions you start in this workspace can read it.' : 'Claude sessions no longer get it.');
    } catch (e) { this.toast.error((e as Error).message); }
  }

  // ---------------------------------------------------------------- edits

  edit(): void {
    this.buffer.set(this.text()?.text || '');
    this.editKey.update((k) => k + 1);
    this.conflict.set(null);
    this.editing.set(true);
  }
  cancelEdit(): void { this.editing.set(false); this.conflict.set(null); }

  async save(): Promise<void> {
    const t = this.text();
    if (!t || this.busy()) return;
    this.busy.set(true);
    try {
      const r = await this.api.post<{ rel: string; etag: string }>('/api/knowledge/save', { source: this.site().key, rel: t.rel, text: this.buffer(), etag: t.etag });
      this.text.set({ ...t, text: this.buffer(), etag: r.etag });
      this.editing.set(false);
      this.toast.show('Saved');
      await this.load();
    } catch (e) {
      const msg = (e as Error).message;
      if (/changed by someone else/.test(msg)) this.conflict.set(msg + ' Copy your text before loading theirs.');
      else this.toast.error(msg);
    } finally { this.busy.set(false); }
  }

  /** After a conflict: their version, in the editor. */
  async reloadTheirs(): Promise<void> {
    await this.sync();
    const rel = this.current()?.rel;
    if (!rel) return;
    await this.loadText(rel);
    this.edit();
  }

  startNew(name: string): void { this.newName.set(name); }

  async createNote(name: string): Promise<void> {
    const rel = name.trim().replace(/\.md$/i, '');
    if (!rel) return;
    this.busy.set(true);
    try {
      const title = rel.split('/').pop()!;
      const r = await this.api.post<{ rel: string; etag: string }>('/api/knowledge/save', { source: this.site().key, rel, text: `# ${title}\n\n`, etag: null });
      this.newName.set(null);
      await this.load();
      this.open(r.rel);
      setTimeout(() => this.edit(), 300);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async rename(to: string): Promise<void> {
    const t = this.text();
    if (!t || !to.trim() || to.trim() === t.rel) { this.renaming.set(false); return; }
    this.busy.set(true);
    try {
      const r = await this.api.post<{ rel: string; etag: string }>('/api/knowledge/rename', { source: this.site().key, from: t.rel, to: to.trim(), etag: t.etag });
      this.renaming.set(false);
      await this.load();
      this.open(r.rel);
      this.toast.show('Renamed. Links to it by its old name need updating.');
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busy.set(false); }
  }

  /** Two clicks: the first arms the button for a few seconds. */
  async remove(): Promise<void> {
    if (!this.armed()) { this.armed.set(true); setTimeout(() => this.armed.set(false), 4000); return; }
    const t = this.text();
    if (!t) return;
    this.busy.set(true);
    try {
      await this.api.post('/api/knowledge/delete', { source: this.site().key, rel: t.rel, etag: t.etag });
      this.armed.set(false);
      this.toast.show('Deleted ' + t.rel);
      this.router.navigate(['/knowledge', this.site().key]);
      await this.load();
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busy.set(false); }
  }

  async markReviewed(): Promise<void> {
    const n = this.current();
    if (!n) return;
    this.busy.set(true);
    try {
      await this.api.post('/api/knowledge/reviewed', { source: this.site().key, rel: n.rel });
      this.toast.show('Marked reviewed today');
      await this.load();
      await this.loadText(n.rel);
      this.data.loadDocs();
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.busy.set(false); }
  }

  // ---------------------------------------------------------------- Claude

  ask(n: KnowledgeNote): void {
    const s = this.site();
    if (s.kind === 'store') {
      this.launch.open({ title: 'Ask Claude · ' + s.name, planMode: true, focusPrompt: true, trigger: 'ask', docSources: [s.key], prompt: `About the note "${n.title}" (files/${n.rel}): ` });
    } else {
      this.launch.open({ title: 'Ask Claude', planMode: true, focusPrompt: true, trigger: 'ask', prompt: `About ${s.repo || ''}/${n.rel} ("${n.title}"): ` });
    }
  }

  changes(): void {
    const s = this.site();
    if (s.repo) this.launch.open(siteEditLaunch(s.repo, s.name, this.current()?.rel));
  }
}

import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LinkSaveRequest, LinkScope, LinkTile, LinksResponse, RepoReadme } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { LaunchService } from '../../core/launch.service';
import { renderMd } from '../../core/markdown';
import { siteEditLaunch } from '../../core/site-edit';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { vscodeUrl } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';

const NEW_CATEGORY = '__new__';

/** The edit form's state. `original` is the tile being edited (null when adding). */
interface LinkForm {
  original: LinkTile | null;
  scope: LinkScope;
  category: string;
  newCategory: string;
  newCategoryDescription: string;
  title: string;
  icon: string;
  description: string;
  multi: boolean;
  url: string;
  links: { label: string; url: string }[];
  repo: string;
  edit: boolean;
}

/**
 * Everything the team opens day to day, in tiles. Team tiles are in
 * .claude/dashboard/links.json (committed); "just me" tiles in
 * .claude/ledger/links.local.json. Add / Edit here writes either file.
 */
@Component({
  selector: 'dash-links',
  imports: [PageHeaderComponent, RouterLink, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './links.component.scss',
  template: `
    <dash-page-header eyebrow="Company" title="Links" [sub]="api.copy('linksSub', 'Every app, environment, tool and vendor portal the team uses, in one place. Add your own with Add link: for the team, or just for you.')">
      <input class="filter" placeholder="Filter links…" [value]="q()" (input)="q.set($any($event.target).value)" autocomplete="off" spellcheck="false">
      <button type="button" class="btn primary sm" (click)="add()">Add link</button>
    </dash-page-header>

    @if (error()) { <div class="warn-note">{{ error() }}</div> }
    @if (!data()) { <div class="empty">Loading…</div> }
    @for (c of shown(); track c.title) {
      <section class="cat">
        <div class="group-title">{{ c.title }}</div>
        @if (c.description) { <p class="cat-d">{{ c.description }}</p> }
        <div class="tiles">
          @for (t of c.tiles; track t.scope + ':' + t.ref.category + ':' + t.ref.index) {
            <div class="tile-wrap">
              @if (t.url && !t.readme && !t.editable) {
                @if (internal(t.url)) {
                  <a class="tile link" [routerLink]="t.url">
                    <span class="ic">{{ t.icon }}</span>
                    <span class="body"><span class="t">{{ t.title }}</span><span class="d">{{ t.description }}</span></span>
                  </a>
                } @else {
                  <a class="tile link" [href]="t.url" target="_blank" rel="noopener">
                    <span class="ic">{{ t.icon }}</span>
                    <span class="body"><span class="t">{{ t.title }} <span class="ext">↗</span></span><span class="d">{{ t.description }}</span></span>
                  </a>
                }
              } @else {
                <div class="tile">
                  <span class="ic">{{ t.icon }}</span>
                  <span class="body">
                    <span class="t">{{ t.title }}</span>
                    <span class="d">{{ t.description }}</span>
                    <span class="btns">
                      @if (t.url) { <a class="btn sm" [href]="t.url" target="_blank" rel="noopener">Open ↗</a> }
                      @for (l of t.links; track l.url) {
                        @if (internal(l.url)) { <a class="btn sm" [routerLink]="l.url">{{ l.label }}</a> }
                        @else { <a class="btn sm" [href]="l.url" target="_blank" rel="noopener">{{ l.label }} ↗</a> }
                      }
                      @if (t.readme) {
                        <button type="button" class="btn ghost sm" (click)="info(t)" [title]="'Read ' + t.repo + '/' + t.readme">Info</button>
                      }
                      @if (t.editable) {
                        <button type="button" class="btn primary sm" (click)="edit(t)"
                                [title]="'Start a Claude run that edits the ' + t.repo + ' repo (it pulls the latest main first)'">Make edits</button>
                      }
                    </span>
                  </span>
                </div>
              }
              @if (t.scope === 'personal') { <span class="mine" title="Only on this machine (.claude/ledger/links.local.json)">just me</span> }
              <button type="button" class="tile-edit" (click)="editTile(t)" [title]="'Edit ' + t.title" [attr.aria-label]="'Edit ' + t.title">✎</button>
            </div>
          }
        </div>
      </section>
    } @empty {
      @if (data()) {
        <div class="empty">{{ q() ? 'No links match “' + q() + '”.' : 'No links yet. Add the team’s apps, environments and tools with Add link.' }}</div>
      }
    }

    @if (readme(); as r) {
      <div class="modal" (mousedown)="onBackdrop($event)">
        <div class="modal-card wide" (keydown.escape)="closeInfo()" tabindex="-1" #card>
          <div class="panel-h">
            <h2>{{ r.tile.icon }} {{ r.tile.title }}</h2>
            @if (r.doc) {
              <span class="rm-file">{{ r.doc.file }}</span>
              <a class="btn ghost sm" [href]="vscode(r.doc.path)">Open in VS Code</a>
            }
            <button type="button" class="btn ghost sm" (click)="closeInfo()">Close</button>
          </div>
          <div class="rm-body">
            @if (r.error) { <div class="warn-note">{{ r.error }}</div> }
            @else if (!r.doc) { <div class="empty">Loading…</div> }
            @else { <div class="md" [innerHTML]="readmeHtml() | trustedHtml"></div> }
          </div>
        </div>
      </div>
    }

    @if (form(); as f) {
      <div class="modal" (mousedown)="onFormBackdrop($event)">
        <form class="modal-card link-form" (submit)="$event.preventDefault(); save()" (keydown.escape)="closeForm()">
          <h3>{{ f.original ? 'Edit link' : 'Add link' }}</h3>
          <div class="desc">A tile on this page. Links can go to any https:// address or a dashboard page (like /docs).</div>
          <div class="form">
            <div class="full scope-row" role="group" aria-label="Save for">
              <span class="lbl">Save for</span>
              <span class="seg">
                <button type="button" [class.on]="f.scope === 'team'" (click)="patch({ scope: 'team' })">The team</button>
                <button type="button" [class.on]="f.scope === 'personal'" (click)="patch({ scope: 'personal' })">Just me</button>
              </span>
              <span class="hint">{{ f.scope === 'team'
                ? 'Saved to .claude/dashboard/links.json. Commit it so everyone gets it.'
                : 'Saved on this machine only (.claude/ledger/links.local.json, never committed).' }}</span>
            </div>
            <label>Title
              <input [value]="f.title" (input)="patch({ title: $any($event.target).value })" maxlength="80" autocomplete="off" data-first="1">
            </label>
            <label>Icon (one emoji)
              <input [value]="f.icon" (input)="patch({ icon: $any($event.target).value })" maxlength="8" placeholder="🔗" autocomplete="off">
            </label>
            <label class="full">Description
              <input [value]="f.description" (input)="patch({ description: $any($event.target).value })" maxlength="300" autocomplete="off">
            </label>
            <label [class.full]="f.category !== newCategory">Category
              <select (change)="patch({ category: $any($event.target).value })">
                @for (c of categories(); track c) { <option [value]="c" [selected]="c === f.category">{{ c }}</option> }
                <option [value]="newCategory" [selected]="f.category === newCategory">New category…</option>
              </select>
            </label>
            @if (f.category === newCategory) {
              <label>New category
                <input [value]="f.newCategory" (input)="patch({ newCategory: $any($event.target).value })" maxlength="60" autocomplete="off">
              </label>
            }
            <label class="chk full"><input type="checkbox" [checked]="f.multi" (change)="setMulti($any($event.target).checked)"> Several links (e.g. Production and Staging)</label>
            @if (!f.multi) {
              <label class="full">Link
                <input [value]="f.url" (input)="patch({ url: $any($event.target).value })" placeholder="https://…" autocomplete="off" spellcheck="false">
              </label>
            } @else {
              @for (l of f.links; track $index; let i = $index) {
                <div class="full link-row">
                  <input [value]="l.label" (input)="setLink(i, 'label', $any($event.target).value)" placeholder="Label (Production)" maxlength="40" autocomplete="off">
                  <input [value]="l.url" (input)="setLink(i, 'url', $any($event.target).value)" placeholder="https://…" autocomplete="off" spellcheck="false">
                  <button type="button" class="btn ghost sm" (click)="removeLink(i)" [disabled]="f.links.length === 1" title="Remove">✕</button>
                </div>
              }
              @if (f.links.length < 10) { <div class="full"><button type="button" class="btn ghost sm" (click)="addLinkRow()">+ Add a link</button></div> }
            }
            <label>Repo (optional)
              <input [value]="f.repo" (input)="patch({ repo: $any($event.target).value })" placeholder="workspace folder" autocomplete="off" spellcheck="false">
            </label>
            <label class="chk" [title]="'Adds a Make edits button that starts a Claude run in that repo'">
              <input type="checkbox" [checked]="f.edit" [disabled]="!f.repo" (change)="patch({ edit: $any($event.target).checked })"> Make edits button
            </label>
            <div class="full hint">A repo adds Info (its README from your local clone); Make edits starts a Claude run in it.</div>
          </div>
          <div class="form-foot">
            <span class="form-err">{{ formErr() }}</span>
            <span class="foot-btns">
              @if (f.original) {
                <button type="button" class="btn danger sm" (click)="remove()" [disabled]="saving()">{{ armed() ? 'Click again to delete' : 'Delete' }}</button>
              }
              <button type="button" class="btn ghost" (click)="closeForm()">Cancel</button>
              <button class="btn primary" type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save' }}</button>
            </span>
          </div>
        </form>
      </div>
    }
  `,
})
export class LinksComponent implements OnInit {
  readonly api = inject(ApiService);
  private readonly launch = inject(LaunchService);
  private readonly toast = inject(ToastService);
  readonly data = signal<LinksResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly q = signal('');
  /** The Info dialog: the tile, then its README once loaded (or why it couldn't be). */
  readonly readme = signal<{ tile: LinkTile; doc: RepoReadme | null; error: string | null } | null>(null);
  readonly readmeHtml = computed(() => renderMd(this.readme()?.doc?.markdown));
  private readonly card = viewChild<ElementRef<HTMLElement>>('card');

  readonly form = signal<LinkForm | null>(null);
  readonly formErr = signal('');
  readonly saving = signal(false);
  readonly armed = signal(false);
  readonly newCategory = NEW_CATEGORY;
  readonly categories = computed(() => (this.data()?.categories || []).map((c) => c.title));

  readonly shown = computed(() => {
    const q = this.q().trim().toLowerCase();
    const cats = this.data()?.categories || [];
    if (!q) return cats;
    const hit = (t: LinkTile) => [t.title, t.description, ...t.links.map((l) => l.label + ' ' + l.url), t.url || ''].join(' ').toLowerCase().includes(q);
    return cats
      .map((c) => ({ ...c, tiles: c.title.toLowerCase().includes(q) ? c.tiles : c.tiles.filter(hit) }))
      .filter((c) => c.tiles.length);
  });

  async ngOnInit(): Promise<void> {
    try {
      const d = await this.api.get<LinksResponse>('/api/links');
      this.data.set(d);
      this.error.set(d.error || null);
    } catch (e) {
      this.error.set((e as Error).message);
      this.data.set({ categories: [], files: { team: '', personal: '' } });
    }
  }

  /** Make edits: a Claude run in the site's repo, starting from the latest main. */
  edit(t: LinkTile): void { if (t.repo) this.launch.open(siteEditLaunch(t.repo, t.title)); }

  /** Info: the repo's README, read from the local clone. */
  async info(t: LinkTile): Promise<void> {
    if (!t.repo) return;
    this.readme.set({ tile: t, doc: null, error: null });
    setTimeout(() => this.card()?.nativeElement.focus());
    try {
      const doc = await this.api.get<RepoReadme>('/api/readme?repo=' + encodeURIComponent(t.repo));
      if (this.readme()?.tile === t) this.readme.set({ tile: t, doc, error: null });
    } catch (e) {
      if (this.readme()?.tile === t) this.readme.set({ tile: t, doc: null, error: (e as Error).message });
    }
  }

  closeInfo(): void { this.readme.set(null); }
  /** Close on a press on the backdrop itself. Returns nothing: a `false` from a template handler would preventDefault every press inside the dialog. */
  onBackdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.closeInfo(); }
  vscode(p: string): string { return vscodeUrl(p); }

  /** Dashboard paths (/docs/…) route in-app; everything else opens a new tab. */
  internal(url: string): boolean { return url.startsWith('/'); }

  // ------------------------------------------------------------ add / edit

  add(): void {
    this.openForm({
      original: null, scope: 'team', category: this.categories()[0] || NEW_CATEGORY, newCategory: '', newCategoryDescription: '',
      title: '', icon: '', description: '', multi: false, url: '', links: [{ label: '', url: '' }], repo: '', edit: false,
    });
  }

  editTile(t: LinkTile): void {
    this.openForm({
      original: t, scope: t.scope, category: t.ref.category, newCategory: '', newCategoryDescription: '',
      title: t.title, icon: t.icon, description: t.description,
      multi: t.links.length > 0, url: t.url || '', links: t.links.length ? t.links.map((l) => ({ ...l })) : [{ label: '', url: '' }],
      repo: t.raw.repo || '', edit: t.raw.edit,
    });
  }

  private openForm(f: LinkForm): void {
    this.formErr.set('');
    this.armed.set(false);
    this.form.set(f);
    setTimeout(() => document.querySelector<HTMLInputElement>('.link-form [data-first]')?.focus());
  }

  patch(p: Partial<LinkForm>): void {
    const f = this.form();
    if (!f) return;
    const next = { ...f, ...p };
    if (!next.repo) next.edit = false;
    this.form.set(next);
  }

  setMulti(on: boolean): void {
    const f = this.form();
    if (!f) return;
    // Carry the single link over as the first row (and back), so switching loses nothing.
    if (on && f.url && !f.links.some((l) => l.url)) this.patch({ multi: true, links: [{ label: 'Open', url: f.url }] });
    else if (!on && !f.url) this.patch({ multi: false, url: f.links.find((l) => l.url)?.url || '' });
    else this.patch({ multi: on });
  }

  setLink(i: number, key: 'label' | 'url', value: string): void {
    const f = this.form();
    if (!f) return;
    this.patch({ links: f.links.map((l, k) => (k === i ? { ...l, [key]: value } : l)) });
  }
  addLinkRow(): void { const f = this.form(); if (f) this.patch({ links: [...f.links, { label: '', url: '' }] }); }
  removeLink(i: number): void { const f = this.form(); if (f) this.patch({ links: f.links.filter((_, k) => k !== i) }); }

  closeForm(): void { this.form.set(null); }
  /** Returns nothing on purpose (see onBackdrop). */
  onFormBackdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.closeForm(); }

  async save(): Promise<void> {
    const f = this.form();
    if (!f) return;
    const category = f.category === NEW_CATEGORY ? f.newCategory.trim() : f.category;
    if (!f.title.trim()) { this.formErr.set('Give it a title.'); return; }
    if (!category) { this.formErr.set('Name the new category.'); return; }
    const body: LinkSaveRequest = {
      scope: f.scope,
      category,
      tile: {
        title: f.title.trim(),
        description: f.description.trim() || undefined,
        icon: f.icon.trim() || undefined,
        url: f.multi ? undefined : f.url.trim() || undefined,
        links: f.multi ? f.links.filter((l) => l.label.trim() || l.url.trim()).map((l) => ({ label: l.label.trim(), url: l.url.trim() })) : undefined,
        repo: f.repo.trim() || undefined,
        edit: !!f.repo.trim() && f.edit,
      },
      original: f.original ? { ref: f.original.ref, title: f.original.title } : undefined,
    };
    this.saving.set(true);
    this.formErr.set('');
    try {
      const d = await this.api.post<LinksResponse>('/api/links/save', body);
      this.data.set(d);
      this.form.set(null);
      this.toast.show(f.scope === 'team' ? 'Saved to links.json. Commit it to share it with the team.' : 'Saved (just for you).');
    } catch (e) {
      this.formErr.set((e as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  /** Delete takes two clicks (the first arms it for a few seconds). */
  async remove(): Promise<void> {
    const f = this.form();
    if (!f || !f.original) return;
    if (!this.armed()) {
      this.armed.set(true);
      setTimeout(() => this.armed.set(false), 4000);
      return;
    }
    this.saving.set(true);
    try {
      const d = await this.api.post<LinksResponse>('/api/links/delete', { ref: f.original.ref, title: f.original.title });
      this.data.set(d);
      this.form.set(null);
      this.toast.show(f.original.scope === 'team' ? 'Removed from links.json. Commit it to share the change.' : 'Removed.');
    } catch (e) {
      this.formErr.set((e as Error).message);
    } finally {
      this.saving.set(false);
      this.armed.set(false);
    }
  }
}

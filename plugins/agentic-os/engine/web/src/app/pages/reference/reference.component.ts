import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DocSite, ReferenceResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { LaunchService } from '../../core/launch.service';
import { mdSlug, renderMd } from '../../core/markdown';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { relTime, vscodeUrl } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';

/**
 * The team's quick reference, read live from the doc .claude/dashboard/reference.json
 * names: the facts people look up most (pulled out by its groups), then the whole
 * doc. Edit the doc; this page follows.
 */
@Component({
  selector: 'dash-reference',
  imports: [PageHeaderComponent, RouterLink, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './reference.component.scss',
  template: `
    <dash-page-header eyebrow="Company" title="Reference" [sub]="sub()">
      @if (ref()?.available) {
        <a class="btn ghost sm" [href]="vscode(ref()!.file)">Open in VS Code</a>
        <button class="btn ghost sm" (click)="changes()">Make changes</button>
        @if (docsKey(); as k) { <a class="btn ghost sm" [routerLink]="['/docs', k]">All {{ repo() }} notes</a> }
      }
    </dash-page-header>

    @if (error()) { <div class="warn-note">{{ error() }}</div> }
    @else if (!ref()) { <div class="empty">Loading…</div> }
    @else if (!ref()!.configured) {
      <div class="panel"><div class="empty md tight" style="padding:2rem">
        <p>No reference doc is set up. Point <code>file</code> in <code>.claude/dashboard/reference.json</code> at a Markdown doc in the workspace (for example your infrastructure notes: hosts, IPs, environments), then reload.</p>
        <p>Add <code>groups</code> there to pull quick facts out of its tables; without them the page just shows the doc.</p>
      </div></div>
    } @else if (!ref()!.available) {
      <div class="panel"><div class="empty" style="padding:2rem"><code>{{ ref()!.rel }}</code> isn't in the workspace, so there's nothing to show. Is its repo cloned?</div></div>
    } @else {
      <div class="facts">
        @for (g of ref()!.groups; track g.title) {
          <div class="panel fact">
            <div class="panel-h"><h2>{{ g.title }}</h2><button class="btn ghost sm" (click)="jump(g.section)">In the doc ↓</button></div>
            <table>
              @for (r of g.rows; track $index) {
                <tr>
                  <th>{{ r.label }}</th>
                  <td><code class="val" title="Click to copy" (click)="copy(r.value)">{{ r.value }}</code>@if (r.note) { <div class="note">{{ r.note }}</div> }</td>
                </tr>
              }
            </table>
          </div>
        }
      </div>

      <div class="panel doc">
        <div class="panel-h"><h2>{{ ref()!.rel }}</h2><span class="ty">edited {{ rel(ref()!.updatedAt) }}</span></div>
        <div class="toc">@for (s of sections(); track s) { <button type="button" (click)="jump(slug(s))">{{ s }}</button> }</div>
        <div class="md body" #body [innerHTML]="html() | trustedHtml"></div>
      </div>
    }
  `,
})
export class ReferenceComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly launch = inject(LaunchService);
  private readonly bodyEl = viewChild<ElementRef<HTMLElement>>('body');

  readonly ref = signal<ReferenceResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly html = computed(() => renderMd(this.ref()?.markdown || ''));
  /** The doc's ## headings, for the jump list. */
  readonly sections = computed(() => [...(this.ref()?.markdown || '').matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]));
  readonly sub = computed(() => {
    const r = this.ref();
    const when = r?.lastUpdated ? ` Doc last updated ${r.lastUpdated}.` : '';
    const what = this.api.copy('referenceSub', r?.title ? `${r.title}, read live from ${r.rel}.` : "Quick facts from the team's reference doc, read live.");
    return `${what}${when} Click a value to copy it.`;
  });
  /** The doc's repo (its first folder), and the Docs source for that folder if there is one. */
  readonly repo = computed(() => (this.ref()?.rel || '').split('/')[0] || null);
  readonly docsKey = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try { this.ref.set(await this.api.get<ReferenceResponse>('/api/reference')); }
    catch (e) { this.error.set((e as Error).message); }
    try {
      const { sites } = await this.api.get<{ sites: DocSite[] }>('/api/docs');
      this.docsKey.set(sites.find((s) => s.repo && s.repo === this.repo())?.key || null);
    } catch { /* no docs link */ }
  }

  /** Scroll the page to a heading of the rendered doc (by its slug). */
  jump(slug: string): void {
    const el = this.bodyEl()?.nativeElement.querySelector<HTMLElement>(`[data-sec="${CSS.escape(slug)}"]`);
    if (!el) return;
    // Direct jump (smooth scrolling stalls in background tabs).
    window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 24 });
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 1600);
  }

  async copy(v: string): Promise<void> {
    try { await navigator.clipboard.writeText(v); this.toast.show('Copied ' + v); } catch { /* clipboard blocked */ }
  }

  changes(): void {
    const rel = this.ref()?.rel || '';
    const repo = this.repo() || '';
    this.launch.open({ title: 'Make changes · ' + repo, workspace: 'main', focusPrompt: true, prompt: `Working in repo ${repo} (${rel.slice(repo.length + 1)}): ` });
  }

  slug(s: string): string { return mdSlug(s); }
  rel(t: string | null): string { return t ? relTime(t) : ''; }
  vscode(p: string | null): string { return p ? vscodeUrl(p) : ''; }
}

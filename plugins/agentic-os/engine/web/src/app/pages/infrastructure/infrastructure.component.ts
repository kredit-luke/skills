import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DocSite, InfrastructureResponse } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { LaunchService } from '../../core/launch.service';
import { mdSlug, renderMd } from '../../core/markdown';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { relTime, vscodeUrl } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';

/** What "Ask Claude to fill it in" asks for: an infrastructure-only doc and the config that points at it. */
const POPULATE_PROMPT = `Fill in the dashboard's Infrastructure page. Write a Markdown doc about our infrastructure in this workspace (for example docs/infrastructure.md) from what you can read: infrastructure code (Terraform, Helm, CloudFormation, Pulumi, Kubernetes manifests), cloud CLIs I'm signed in to, and existing docs. Cover infrastructure only, a ## section with a table for each of: Accounts and projects, Environments, Public URLs, Databases, Egress IPs, Allowed inbound, DNS. Never write secrets (passwords, keys, tokens, connection strings); list what you couldn't find at the end. Then point "file" in .claude/dashboard/infrastructure.json at the doc and add "groups" that pull the quick facts out of its tables (the agentic-os plugin's references/config.md describes them).`;

/**
 * The team's infrastructure, read live from the doc .claude/dashboard/infrastructure.json
 * names (reference.json in older workspaces): the facts people look up most (pulled out
 * by its groups), then the whole doc. Edit the doc; this page follows. With no doc yet,
 * it says what belongs here and who can fill it in.
 */
@Component({
  selector: 'dash-infrastructure',
  imports: [PageHeaderComponent, RouterLink, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './infrastructure.component.scss',
  template: `
    <dash-page-header eyebrow="Company" title="Infrastructure" [sub]="sub()">
      @if (ref()?.available) {
        <a class="btn ghost sm" [href]="vscode(ref()!.file)">Open in VS Code</a>
        <button class="btn ghost sm" (click)="changes()">Make changes</button>
        @if (docsKey(); as k) { <a class="btn ghost sm" [routerLink]="['/docs', k]">All {{ repo() }} notes</a> }
      }
    </dash-page-header>

    @if (error()) { <div class="warn-note">{{ error() }}</div> }
    @else if (!ref()) { <div class="empty">Loading…</div> }
    @else if (!ref()!.available) {
      <div class="panel none">
        <h2>No infrastructure info yet</h2>
        <p>This page puts your team's infrastructure in one place: cloud accounts and projects, environments, public URLs,
          databases, egress IPs and firewall rules, each value one click to copy. It reads them from a Markdown doc in this workspace.</p>
        @if (ref()!.configured) {
          <p><code>{{ ref()!.rel }}</code> is the doc set up for it, but it isn't in the workspace. Is its repo cloned?</p>
        } @else {
          <p>Nobody has written that doc for this workspace yet, so there's nothing to show.</p>
        }
        <div class="hint">
          <b>How to fill it in:</b> ask someone on your team with infrastructure access (your cloud console, or the repo with your
          Terraform, Helm or other infrastructure code) to ask Claude to fill in this page. Claude writes the doc from what it can see,
          leaves out secrets, and points <code>.claude/dashboard/infrastructure.json</code> at it.
        </div>
        <div class="acts">
          <button class="btn primary sm" type="button" (click)="populate()">I have access: ask Claude to fill it in</button>
          <button class="btn ghost sm" type="button" (click)="copyRequest()">Copy the request for a teammate</button>
        </div>
      </div>
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
export class InfrastructureComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly launch = inject(LaunchService);
  private readonly bodyEl = viewChild<ElementRef<HTMLElement>>('body');

  readonly ref = signal<InfrastructureResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly html = computed(() => renderMd(this.ref()?.markdown || ''));
  /** The doc's ## headings, for the jump list. */
  readonly sections = computed(() => [...(this.ref()?.markdown || '').matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]));
  readonly sub = computed(() => {
    const r = this.ref();
    const when = r?.lastUpdated ? ` Doc last updated ${r.lastUpdated}.` : '';
    const fallback = r?.available && r.title ? `${r.title}, read live from ${r.rel}.` : "Your team's infrastructure, read live from a doc in the workspace.";
    const what = this.api.copy('infrastructureSub', this.api.copy('referenceSub', fallback));
    return r?.available ? `${what}${when} Click a value to copy it.` : what;
  });
  /** The doc's repo (its first folder), and the Docs source for that folder if there is one. */
  readonly repo = computed(() => (this.ref()?.rel || '').split('/')[0] || null);
  readonly docsKey = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try { this.ref.set(await this.api.get<InfrastructureResponse>('/api/infrastructure')); }
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

  populate(): void {
    this.launch.open({ title: 'Fill in the Infrastructure page', workspace: 'main', prompt: POPULATE_PROMPT, focusPrompt: true });
  }

  async copyRequest(): Promise<void> {
    try { await navigator.clipboard.writeText(POPULATE_PROMPT); this.toast.show('Copied: send it to a teammate with infrastructure access'); }
    catch { this.toast.error("Couldn't copy: the browser blocked the clipboard"); }
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

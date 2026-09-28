import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import type { AppStatus, GitInfo, WorkspaceStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { relTime, vscodeUrl } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { WorkspaceAppsComponent } from '../../shared/workspace-apps.component';
import { DiffViewComponent } from './diff-view.component';

const SRC_LABEL: Record<string, string> = { committed: 'committed', modified: 'committed + uncommitted', untracked: 'untracked', uncommitted: 'uncommitted' };

@Component({
  selector: 'dash-workspaces',
  imports: [PageHeaderComponent, WorkspaceAppsComponent, DiffViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './workspaces.component.scss',
  templateUrl: './workspaces.component.html',
})
export class WorkspacesComponent implements OnInit {
  readonly data = inject(DataService);
  readonly api = inject(ApiService);

  readonly openWs = signal<Set<string>>(new Set());
  readonly openRepos = signal<Set<string>>(new Set());
  readonly git = signal<Record<string, GitInfo | null | 'loading'>>({});
  readonly diffs = signal<Record<string, string | null>>({});
  readonly shot = signal<{ slug: string; i: number } | null>(null);

  readonly workspaces = computed(() => this.data.status()?.workspaces || []);
  readonly summary = computed(() => {
    let running = 0, stopped = 0, wt = 0;
    for (const w of this.workspaces()) {
      if (w.slug !== 'main') wt++;
      for (const a of w.apps) { if (a.running) running++; else stopped++; }
    }
    return { running, stopped, wt };
  });

  ngOnInit(): void { this.data.loadStatus(); }

  avail(w: WorkspaceStatus): AppStatus[] { return w.apps.filter((a) => a.available); }
  countLabel(w: WorkspaceStatus): string { const a = this.avail(w); return a.filter((x) => x.running).length + '/' + a.length + ' running'; }
  anyBusy(w: WorkspaceStatus): boolean { return this.avail(w).some((a) => !!a.busy); }
  anyUp(w: WorkspaceStatus): boolean { return this.avail(w).some((a) => a.running); }
  /** The default stack (apps.json defaultStack), for Start stack. */
  readonly stack = computed(() => { const id = this.data.defaultStack(); return id ? { id, ...this.data.stacks()[id] } : null; });
  platformDown(w: WorkspaceStatus): boolean {
    const s = this.stack();
    const p = s ? this.avail(w).filter((a) => (s.apps || []).includes(a.key)) : [];
    return p.length > 0 && p.some((a) => !a.running);
  }
  vscode(p: string | undefined): string { return vscodeUrl(p); }
  rel(t: number): string { return relTime(t); }
  srcLabel(s: string | undefined): string { return SRC_LABEL[s || 'uncommitted'] || s || ''; }
  repoDirs(info: GitInfo): string[] { return Object.keys(info.repos).sort(); }
  shotUrl(slug: string, name: string): string { return '/screenshots/' + encodeURIComponent(slug) + '/' + encodeURIComponent(name); }
  asGit(v: GitInfo | null | 'loading' | undefined): GitInfo | null { return v && v !== 'loading' ? v : null; }

  startStack(slug: string): void { const s = this.stack(); if (s) this.data.appAction({ action: 'start', workspace: slug, stack: s.id }); }
  stopAll(slug: string): void { this.data.appAction({ action: 'stop-all', workspace: slug }); }

  async toggleWs(slug: string): Promise<void> {
    const s = new Set(this.openWs());
    if (s.has(slug)) { s.delete(slug); this.openWs.set(s); return; }
    s.add(slug);
    this.openWs.set(s);
    if (this.git()[slug] === undefined) {
      this.git.set({ ...this.git(), [slug]: 'loading' });
      let info: GitInfo | null = null;
      try { info = await this.api.get<GitInfo>('/api/git?workspace=' + encodeURIComponent(slug)); } catch { info = null; }
      this.git.set({ ...this.git(), [slug]: info });
    }
  }

  toggleRepo(key: string): void {
    const s = new Set(this.openRepos());
    if (s.has(key)) s.delete(key); else s.add(key);
    this.openRepos.set(s);
  }

  async toggleDiff(slug: string, repo: string, file: string): Promise<void> {
    const key = slug + '::' + repo + '::' + file;
    const d = { ...this.diffs() };
    if (key in d) { delete d[key]; this.diffs.set(d); return; }
    d[key] = null;
    this.diffs.set(d);
    let diff = '';
    try { diff = (await this.api.get<{ diff: string }>('/api/diff?workspace=' + encodeURIComponent(slug) + '&repo=' + encodeURIComponent(repo) + '&file=' + encodeURIComponent(file))).diff || ''; } catch { diff = ''; }
    if (key in this.diffs()) this.diffs.set({ ...this.diffs(), [key]: diff });
  }
  diffKey(slug: string, repo: string, file: string): string { return slug + '::' + repo + '::' + file; }
  hasDiff(key: string): boolean { return key in this.diffs(); }

  // ---- screenshot lightbox
  shots(slug: string): { name: string; mtime: number }[] {
    return (this.workspaces().find((w) => w.slug === slug)?.screenshots || []).slice(0, 24);
  }
  current(): { url: string; name: string; pos: string } | null {
    const s = this.shot();
    if (!s) return null;
    const list = this.shots(s.slug);
    const x = list[s.i];
    return x ? { url: this.shotUrl(s.slug, x.name), name: x.name, pos: s.i + 1 + ' / ' + list.length } : null;
  }
  step(delta: number): void {
    const s = this.shot();
    if (!s) return;
    const n = this.shots(s.slug).length;
    if (n) this.shot.set({ slug: s.slug, i: (s.i + delta + n) % n });
  }
  /** Close the lightbox on a click on its backdrop (returns nothing: a false would preventDefault). */
  closeShotOnBackdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.shot.set(null); }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (!this.shot()) return;
    if (e.key === 'Escape') this.shot.set(null);
    else if (e.key === 'ArrowRight') this.step(1);
    else if (e.key === 'ArrowLeft') this.step(-1);
  }
}

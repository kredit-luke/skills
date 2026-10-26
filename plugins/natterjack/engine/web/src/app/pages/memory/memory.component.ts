import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import type { MemoryItem, MemoryList } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { LaunchService } from '../../core/launch.service';
import { inlineMd, renderMd } from '../../core/markdown';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { relTime, vscodeUrl } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { FIX_BATCH, fixPrompt } from './fix-prompt';

@Component({
  selector: 'dash-memory',
  imports: [PageHeaderComponent, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './memory.component.scss',
  template: `
    <dash-page-header eyebrow="Memory" title="Claude's memory" [sub]="'What Claude has remembered about this workspace. MEMORY.md is the index every session loads.'">
      <label class="chk"><input type="checkbox" [checked]="issuesOnly()" (change)="issuesOnly.set($any($event.target).checked)"> Needs a look only</label>
      <button class="btn ghost sm" (click)="load()">Refresh</button>
    </dash-page-header>

    <div class="panel">
      <div class="panel-h"><h2>Memories <span class="n">{{ list()?.memories?.length || 0 }}</span></h2>
        @if (flagged().length) {
          <span class="tag amber">{{ flagged().length }} need a look</span>
          <button class="btn ghost sm" style="margin-left:auto" (click)="fixAll()"
            title="One run that checks the flagged memories against the workspace and updates, deletes or indexes them">{{ flagged().length > batch ? 'Ask Claude to fix ' + batch + ' of ' + flagged().length : 'Ask Claude to fix all' }}</button>
        }</div>
      <div class="panel-b">
        @if (error()) { <div class="empty">{{ error() }}</div> }
        @else if (!list()) { <div class="empty">Loading…</div> }
        @else if (!list()!.exists) { <div class="empty">No memory folder yet for this workspace.</div> }
        @else {
          @if (list()!.orphanIndexLines.length) {
            <div class="warn-note" style="margin:6px">MEMORY.md lists {{ list()!.orphanIndexLines.length }} file(s) that don't exist: {{ list()!.orphanIndexLines.join(' ') }}
              <button class="btn ghost sm" [disabled]="pruning()" (click)="pruneIndex()">Remove {{ list()!.orphanIndexLines.length === 1 ? 'this line' : 'these lines' }}</button></div>
          }
          @for (m of shown(); track m.file) {
            <div class="mem" [class.flagged]="m.issues.length">
              <div class="mem-h" (click)="toggle(m.file)">
                <span class="arrow" [class.open]="open().has(m.file)">&#9654;</span>
                <div class="main">
                  <div class="title">{{ m.name }} @if (m.type) { <span class="tag">{{ m.type }}</span> } @if (m.issues.length) { <span class="tag bad">needs a look</span> }</div>
                  <div class="sub">{{ m.description }}</div>
                </div>
                <div class="right">{{ rel(m.updatedAt) }}</div>
              </div>
              @if (m.issues.length) {
                <div class="mem-issues">
                  <div class="list">@for (t of m.issues; track t) { <div [innerHTML]="inline(t) | trustedHtml"></div> }</div>
                  <button class="btn ghost sm" (click)="fix([m])">Ask Claude to fix</button>
                </div>
              }
              @if (open().has(m.file)) {
                <div class="mem-body">
                  <div class="md" [innerHTML]="md(m.body) | trustedHtml"></div>
                  <div class="mem-acts">
                    <a class="btn ghost sm" [href]="vscode(list()!.dir + '/' + m.file)">Open in VS Code</a>
                    <button class="btn danger sm" [disabled]="deleting() === m.file" (click)="remove(m.file)">{{ armed() === m.file ? 'Click again to delete' : 'Delete' }}</button>
                  </div>
                </div>
              }
            </div>
          } @empty { <div class="empty">{{ issuesOnly() ? 'Nothing flagged.' : 'No memories yet.' }}</div> }
        }
      </div>
      <div class="hint">Flagged memories mention files that are gone, or aren't in the index. Written by Claude during sessions: "Ask Claude to fix" starts a run that checks a flagged memory against the workspace and updates or deletes it.</div>
    </div>
  `,
})
export class MemoryComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly launch = inject(LaunchService);
  readonly batch = FIX_BATCH;
  readonly list = signal<MemoryList | null>(null);
  readonly error = signal<string | null>(null);
  readonly issuesOnly = signal(false);
  readonly open = signal<Set<string>>(new Set());
  readonly armed = signal<string | null>(null);
  readonly deleting = signal<string | null>(null);
  readonly pruning = signal(false);
  readonly flagged = computed(() => (this.list()?.memories || []).filter((m) => m.issues.length));
  readonly shown = computed(() => {
    const ms = this.list()?.memories || [];
    return this.issuesOnly() ? ms.filter((m) => m.issues.length) : ms;
  });

  ngOnInit(): void { this.load(); }

  async load(): Promise<void> {
    try { this.list.set(await this.api.get<MemoryList>('/api/memory')); this.error.set(null); }
    catch (e) { this.error.set((e as Error).message); }
  }
  toggle(file: string): void {
    const s = new Set(this.open());
    if (s.has(file)) s.delete(file); else s.add(file);
    this.open.set(s);
  }
  rel(t: string): string { return relTime(t); }
  md(s: string): string { return renderMd(s); }
  inline(s: string): string { return inlineMd(s); }
  vscode(p: string): string { return vscodeUrl(p); }

  /** Opens the launch dialog on a run that fixes these memories. */
  fix(ms: MemoryItem[]): void {
    this.launch.open({
      title: ms.length === 1 ? 'Fix memory · ' + ms[0].name : `Fix ${ms.length} memories`,
      trigger: 'memory',
      prompt: fixPrompt(this.list()!.dir, ms),
    });
  }
  fixAll(): void { this.fix(this.flagged().slice(0, FIX_BATCH)); }

  async pruneIndex(): Promise<void> {
    this.pruning.set(true);
    try {
      const r = await this.api.post<{ removed: number }>('/api/memory/prune-index', {});
      this.toast.show(`Removed ${r.removed} line(s) from MEMORY.md`);
      await this.load();
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.pruning.set(false); }
  }

  /** Two clicks: the first arms the button for a few seconds. */
  async remove(file: string): Promise<void> {
    if (this.armed() !== file) {
      this.armed.set(file);
      setTimeout(() => { if (this.armed() === file) this.armed.set(null); }, 4000);
      return;
    }
    this.deleting.set(file);
    try {
      await this.api.post('/api/memory/delete', { file });
      this.toast.show('Deleted memory ' + file);
      this.armed.set(null);
      await this.load();
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.deleting.set(null); }
  }
}

import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { RunChanges, RunChangeScope, RunChangedFile } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { vscodeUrl } from '../../core/util';
import { DiffViewComponent } from '../workspaces/diff-view.component';

const STATUS_LABEL: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '??': 'new' };

/**
 * The run's Changes tab: every repo it changed (including a worktree it created),
 * files with +/−, commits it made, and each file's diff. Refreshes every few
 * seconds while the run is working.
 */
@Component({
  selector: 'dash-run-changes',
  imports: [DiffViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './run-changes.component.scss',
  template: `
    <div class="changes">
      <div class="ch-h">
        <span>@if (data(); as d) { <b>{{ fileCount() }}</b> file{{ fileCount() === 1 ? '' : 's' }} changed in <b>{{ d.scopes.length }}</b> repo{{ d.scopes.length === 1 ? '' : 's' }} } @else { Checking the repos… }</span>
        @if (data() && !data()!.hasBaseline) { <span class="tag" title="This run started before snapshots were recorded, so each repo is compared with main">compared with main</span> }
        <span class="grow"></span>
        @if (running()) { <span class="live"><span class="spin"></span> updating while Claude works</span> }
        <button class="btn ghost sm" (click)="load(true)" [disabled]="busy()">Refresh</button>
      </div>
      @if (error()) { <div class="empty">{{ error() }}</div> }
      @for (s of data()?.scopes || []; track s.path) {
        <div class="scope">
          <div class="sc-h">
            <b class="repo">{{ s.repo }}</b>
            <span class="tag">{{ s.branch }}</span>
            <span class="base" [title]="s.baseKind === 'run-start' ? 'Compared with a snapshot taken when the run started, so edits that were already there are left out' : 'No snapshot for this repo (a worktree the run created, or an older run): compared with where the branch left main'">{{ s.baseLabel }}</span>
            <span class="grow"></span>
            <span class="tot">@if (totals(s); as t) { <span class="add">+{{ t.adds }}</span> <span class="del">−{{ t.dels }}</span> }</span>
            <a class="btn ghost sm" [href]="vscode(s.path)">VS Code</a>
          </div>
          @if (s.commits.length) {
            <div class="commits">@for (c of s.commits; track c.hash) { <div><code>{{ c.hash }}</code> {{ c.message }}</div> }</div>
          }
          @for (f of s.files; track f.file) {
            <div class="file" [class.open]="isOpen(s, f)" (click)="toggle(s, f)">
              <span class="st" [class]="'st s-' + stClass(f.status)" [title]="label(f.status)">{{ f.status }}</span>
              <span class="fp">{{ f.file }}</span>
              <span class="grow"></span>
              @if (f.adds !== null) { <span class="add">+{{ f.adds }}</span> }
              @if (f.dels) { <span class="del">−{{ f.dels }}</span> }
              <a class="vs" [href]="vscode(s.path + '/' + f.file)" (click)="$event.stopPropagation()" title="Open in VS Code">↗</a>
            </div>
            @if (isOpen(s, f)) { <dash-diff [diff]="diffs()[key(s, f)] ?? null" /> }
          } @empty {
            <div class="empty">No file changes in this repo{{ s.commits.length ? ' beyond its commits' : '' }}.</div>
          }
        </div>
      } @empty {
        @if (data()) { <div class="empty">{{ running() ? 'No code changes yet.' : 'This run didn\\'t change any files.' }}</div> }
      }
    </div>
  `,
})
export class RunChangesComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  readonly runId = input.required<string>();
  readonly running = input(false);
  /** The Changes tab is the one showing. Hidden, it still refreshes (the tab label's count), just slower. */
  readonly shown = input(true);
  /** Number of changed files, for the tab label. */
  readonly count = output<number>();

  readonly data = signal<RunChanges | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly open = signal<Set<string>>(new Set());
  readonly diffs = signal<Record<string, string>>({});
  readonly fileCount = computed(() => (this.data()?.scopes || []).reduce((a, s) => a + s.files.length, 0));
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // New run: reset and load. While it's running, refresh every 5 s while shown and
    // every 30 s while hidden (each refresh re-reads the run's events and runs git per repo).
    effect(() => {
      const id = this.runId();
      const running = this.running();
      const shown = this.shown();
      untracked(() => {
        if (this.loadedFor !== id) { this.data.set(null); this.open.set(new Set()); this.diffs.set({}); this.loadedFor = id; }
        this.load();
      });
      if (this.timer) clearInterval(this.timer);
      this.timer = running ? setInterval(() => this.load(), shown ? 5000 : 30000) : null;
    });
    effect(() => this.count.emit(this.fileCount()));
  }
  private loadedFor = '';

  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async load(force = false): Promise<void> {
    const id = this.runId();
    if (force) this.busy.set(true);
    try {
      const d = await this.api.get<RunChanges>(`/api/runs/${encodeURIComponent(id)}/changes${force ? '?force=1' : ''}`);
      if (this.runId() !== id) return;
      this.data.set(d);
      this.error.set(null);
      // Keep open diffs current.
      for (const k of this.open()) this.fetchDiff(k);
    } catch (e) { this.error.set((e as Error).message); }
    finally { this.busy.set(false); }
  }

  key(s: RunChangeScope, f: RunChangedFile): string { return s.path + '\u0000' + f.file; }
  isOpen(s: RunChangeScope, f: RunChangedFile): boolean { return this.open().has(this.key(s, f)); }
  toggle(s: RunChangeScope, f: RunChangedFile): void {
    const k = this.key(s, f);
    const o = new Set(this.open());
    if (o.has(k)) o.delete(k); else { o.add(k); this.fetchDiff(k); }
    this.open.set(o);
  }
  private async fetchDiff(k: string): Promise<void> {
    const [repo, file] = k.split('\u0000');
    try {
      const r = await this.api.get<{ diff: string }>(`/api/runs/${encodeURIComponent(this.runId())}/diff?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(file)}`);
      if (this.diffs()[k] !== r.diff) this.diffs.set({ ...this.diffs(), [k]: r.diff });
    } catch { this.diffs.set({ ...this.diffs(), [k]: '' }); }
  }

  totals(s: RunChangeScope): { adds: number; dels: number } | null {
    if (!s.files.length) return null;
    return s.files.reduce((a, f) => ({ adds: a.adds + (f.adds || 0), dels: a.dels + (f.dels || 0) }), { adds: 0, dels: 0 });
  }
  label(st: string): string { return STATUS_LABEL[st] || st; }
  stClass(st: string): string { return st === '??' ? 'new' : st.toLowerCase(); }
  vscode(p: string): string { return vscodeUrl(p); }
}

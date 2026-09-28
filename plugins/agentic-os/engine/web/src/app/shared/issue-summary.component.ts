import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import type { IssueDetail } from '../../../../shared/api';
import { renderMd } from '../core/markdown';
import { TrustedHtmlPipe } from '../core/trusted-html.pipe';

/** A tracker issue's title, facts, labels, branch and description (Issues side panel + run Issue tab). */
@Component({
  selector: 'dash-issue-summary',
  imports: [TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 10px; }
    h2 { font-family: var(--font-display); font-size: 21px; font-weight: 800; letter-spacing: var(--ls-display); line-height: 1.25; }
    .facts { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12.5px; color: var(--ink-soft); }
    .labels { display: flex; flex-wrap: wrap; gap: 4px; }
    .lbl { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px 2px 7px; border-radius: var(--r-pill); border: 1px solid var(--line); color: var(--ink-soft); background: #fff; }
    .lbl i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    .branch { font-size: 12px; color: var(--ink-soft); } .branch code { font-family: var(--mono); user-select: all; }
    .desc { border-top: 1px solid var(--line-soft); padding-top: 10px; }
  `],
  template: `
    @let d = detail();
    <h2>{{ d.title }}</h2>
    <div class="facts">
      <span><b>{{ d.state }}</b></span><span>{{ d.team }}</span>
      @if (d.priorityLabel) { <span>{{ d.priorityLabel }}</span> }
      <span>{{ d.assignee || 'Unassigned' }}</span>
      @if (d.project) { <span>{{ d.project }}</span> }
      @if (d.cycle) { <span>{{ d.cycle }}</span> }
      @if (worktree()) { <span class="tag routine">worktree</span> }
    </div>
    @if (d.labels.length) { <div class="labels">@for (l of d.labels; track l.name) { <span class="lbl"><i [style.background]="l.color"></i>{{ l.name }}</span> }</div> }
    @if (d.branchName) { <div class="branch">branch <code>{{ d.branchName }}</code></div> }
    <div class="md desc" [innerHTML]="descHtml() | trustedHtml"></div>
    @if (!d.description) { <div class="empty">No description.</div> }
    @if (long()) { <button class="linkish" (click)="open.set(!open())">{{ open() ? 'Show less' : 'Show all' }}</button> }
  `,
})
export class IssueSummaryComponent {
  readonly detail = input.required<IssueDetail>();
  readonly worktree = input(false);
  /** Clamp the description to this many characters behind "Show all" (null = show it all). */
  readonly clamp = input<number | null>(null);
  readonly open = signal(false);

  readonly long = computed(() => { const c = this.clamp(); return c != null && (this.detail().description || '').length > c; });
  readonly descHtml = computed(() => {
    const text = this.detail().description || '';
    const c = this.clamp();
    return renderMd(!this.long() || this.open() || c == null ? text : text.slice(0, c) + '…');
  });

  constructor() {
    // Collapse again when a different issue is shown.
    effect(() => { this.detail().id; this.open.set(false); });
  }
}

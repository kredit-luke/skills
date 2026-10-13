import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { RunOutput } from '../../../../../shared/api';
import { bytes, relTime } from '../../core/util';

const OPENABLE = /\.(pdf|png|jpe?g|gif|webp)$/i;

/** Files the run made in its outputs folder: each downloads; PDFs and images also open in a tab. */
@Component({
  selector: 'dash-run-outputs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (files().length) {
      <div class="ro">
        <span class="lbl" title="Files this run made for you (its outputs folder)">Files</span>
        @for (f of files(); track f.name) {
          <span class="chip" [title]="f.name + ' · ' + size(f.size) + ' · ' + rel(f.modifiedAt)">
            <a [href]="url(f)" [attr.download]="base(f)">{{ icon(f) }} {{ f.name }} <span class="sz">{{ size(f.size) }}</span></a>
            @if (openable(f)) { <a class="open" [href]="url(f)" target="_blank" rel="noopener" title="Open in a new tab" [attr.aria-label]="'Open ' + f.name + ' in a new tab'">↗</a> }
          </span>
        }
      </div>
    }
  `,
  styles: [`
    .ro { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
    .lbl { font-size: 11px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: .04em; margin-right: 2px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; border: 1px solid var(--line); background: #fff; border-radius: 7px; padding: 3px 8px; }
    .chip:hover { border-color: var(--brand-700); }
    .chip a { color: var(--ink); text-decoration: none; }
    .chip a.open { color: var(--ink-faint); }
    .chip a.open:hover { color: var(--brand-700); }
    .sz { color: var(--ink-faint); font-size: 11px; }
  `],
})
export class RunOutputsComponent {
  readonly runId = input.required<string>();
  readonly files = input<RunOutput[]>([]);

  url(f: RunOutput): string { return '/api/runs/' + encodeURIComponent(this.runId()) + '/outputs/' + f.name.split('/').map(encodeURIComponent).join('/'); }
  base(f: RunOutput): string { return f.name.split('/').pop() || f.name; }
  openable(f: RunOutput): boolean { return OPENABLE.test(f.name); }
  icon(f: RunOutput): string { return /\.pdf$/i.test(f.name) ? '📕' : '📄'; }
  size(n: number): string { return bytes(n); }
  rel(t: string): string { return relTime(t); }
}

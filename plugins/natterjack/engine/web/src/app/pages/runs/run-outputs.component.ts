import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { RunOutput } from '../../../../../shared/api';
import { bytes, relTime } from '../../core/util';

const OPENABLE = /\.(pdf|png|jpe?g|gif|webp)$/i;

/** The run page's Files tab: what the run made in its outputs folder. Each downloads; PDFs and images also open in a tab. */
@Component({
  selector: 'dash-run-outputs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ro">
      <p class="hint">Files this run made for you (its outputs folder).</p>
      <ul>
        @for (f of files(); track f.name) {
          <li>
            <span class="ic" aria-hidden="true">{{ icon(f) }}</span>
            <a class="nm" [href]="url(f)" [attr.download]="base(f)" [title]="'Download ' + f.name">{{ f.name }}</a>
            <span class="meta">{{ size(f.size) }} · {{ rel(f.modifiedAt) }}</span>
            <span class="acts">
              @if (openable(f)) { <a class="btn sm ghost" [href]="url(f)" target="_blank" rel="noopener" [attr.aria-label]="'Open ' + f.name + ' in a new tab'">Open ↗</a> }
              <a class="btn sm" [href]="url(f)" [attr.download]="base(f)" [attr.aria-label]="'Download ' + f.name">Download</a>
            </span>
          </li>
        }
      </ul>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ro { padding: 1rem 1.1rem; }
    .hint { margin: 0 0 10px; font-size: 12px; color: var(--ink-faint); }
    ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    li { display: flex; align-items: center; gap: 10px; padding: 8px 12px; font-size: 13px; min-width: 0; }
    li + li { border-top: 1px solid var(--line); }
    .nm { color: var(--ink); text-decoration: none; overflow-wrap: anywhere; min-width: 0; }
    .nm:hover { color: var(--brand-700); text-decoration: underline; }
    .meta { color: var(--ink-faint); font-size: 12px; white-space: nowrap; }
    .acts { margin-left: auto; display: flex; gap: 6px; flex: none; }
    @media (max-width: 640px) { li { flex-wrap: wrap; } .acts { margin-left: 0; } }
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

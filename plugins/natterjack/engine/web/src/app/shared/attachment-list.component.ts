import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Attachment } from '../../../../shared/api';
import { bytes } from '../core/util';

/** Files that were sent with a prompt or reply: image thumbnails, other files as chips. Click opens them. */
@Component({
  selector: 'dash-attachment-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (files().length) {
      <div class="al" [class.dark]="dark()">
        @for (f of files(); track f.id) {
          @if (removed()) {
            <span class="chip gone" title="Deleted: attachments are removed a while after a run is done (Settings)">{{ f.name }}</span>
          } @else if (f.kind === 'image') {
            <a class="thumb" [href]="url(f)" target="_blank" rel="noopener" [title]="f.name + ' · ' + size(f.size)"><img [src]="url(f)" [alt]="f.name" loading="lazy"></a>
          } @else {
            <a class="chip" [href]="url(f)" target="_blank" rel="noopener" [title]="f.path">{{ f.kind === 'pdf' ? '📕' : '📄' }} {{ f.name }} <span class="sz">{{ size(f.size) }}</span></a>
          }
        }
        @if (removed()) { <span class="note">files deleted after the run was done</span> }
      </div>
    }
  `,
  styles: [`
    .al { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
    .thumb img { display: block; max-width: 180px; max-height: 120px; border-radius: 6px; border: 1px solid var(--line); background: #fff; }
    .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 7px; padding: 3px 8px; text-decoration: none; }
    .chip:hover { border-color: var(--brand-700); }
    .chip.gone { color: var(--ink-faint); text-decoration: line-through; }
    .sz { color: var(--ink-faint); font-size: 11px; }
    .note { font-size: 11px; color: var(--ink-faint); }
    .dark .note { color: var(--on-brand-soft); }
  `],
})
export class AttachmentListComponent {
  readonly runId = input.required<string>();
  readonly files = input<Attachment[]>([]);
  readonly removed = input(false);
  /** On the navy reply bubble. */
  readonly dark = input(false);

  url(f: Attachment): string { return '/api/runs/' + encodeURIComponent(this.runId()) + '/files/' + encodeURIComponent(f.file); }
  size(n: number): string { return bytes(n); }
}

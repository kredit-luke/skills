import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input } from '@angular/core';
import { esc } from '../../core/util';

declare const Diff2HtmlUI: any;
let loading: Promise<void> | null = null;

/** diff2html from the CDN (as before), loaded on first use. */
function loadDiff2Html(): Promise<void> {
  if (typeof Diff2HtmlUI !== 'undefined') return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/diff2html@3/bundles/js/diff2html-ui.min.js';
      s.onload = () => resolve();
      s.onerror = () => { loading = null; reject(new Error('diff2html failed to load')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/**
 * Renders one file's unified diff. diff2html's own file list is off: its #anchor
 * links would be swallowed by the router (handoff trap #14).
 */
@Component({
  selector: 'dash-diff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
  host: { class: 'diff-container' },
})
export class DiffViewComponent {
  private readonly el = inject(ElementRef<HTMLElement>);
  readonly diff = input<string | null>(null);

  constructor() {
    effect(() => {
      const diff = this.diff();
      const host = this.el.nativeElement as HTMLElement;
      if (diff === null) { host.innerHTML = '<div class="diff-empty">Loading diff…</div>'; return; }
      if (!diff) { host.innerHTML = '<div class="diff-empty">No diff (untracked or binary file)</div>'; return; }
      loadDiff2Html().then(() => {
        host.innerHTML = '';
        new Diff2HtmlUI(host, diff, { drawFileList: false, matching: 'lines', outputFormat: 'line-by-line', highlight: true }).draw();
      }).catch(() => {
        host.innerHTML = '<pre class="raw">' + esc(diff) + '</pre>';
      });
    });
  }
}

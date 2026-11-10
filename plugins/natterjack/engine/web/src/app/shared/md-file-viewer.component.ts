import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { MdPipe } from '../core/md.pipe';
import { TrustedHtmlPipe } from '../core/trusted-html.pipe';
import { vscodeUrl } from '../core/util';

/** What to open: a markdown file a run named, or a Factory ticket's plan. */
export type MdFileSource = { kind: 'run'; runId: string; path: string } | { kind: 'factory'; ticket: string };

/** A markdown file (a plan, a HANDOFF.md, a PRD) read in a dialog: rendered or as markdown, with a link to open it in VS Code. */
@Component({
  selector: 'dash-md-file-viewer',
  imports: [MdPipe, TrustedHtmlPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal" (mousedown)="onBackdrop($event)">
      <div #card class="modal-card wide mfv" role="dialog" aria-modal="true" [attr.aria-label]="title()" tabindex="-1" (keydown.escape)="closed.emit()" (keydown.tab)="trap($event)">
        <div class="head">
          <h3>{{ title() }}</h3>
          <button type="button" class="btn sm ghost x" (click)="closed.emit()" aria-label="Close">✕</button>
        </div>
        <div class="bar">
          @if (file(); as f) { <span class="mono path" [title]="f.path">{{ f.path }}</span> }
          <span class="acts">
            @if (file(); as f) {
              <span class="seg" role="group" aria-label="Show the file as">
                <button type="button" [class.on]="!raw()" [attr.aria-pressed]="!raw()" (click)="raw.set(false)">Preview</button>
                <button type="button" [class.on]="raw()" [attr.aria-pressed]="raw()" (click)="raw.set(true)">Markdown</button>
              </span>
              @if (!hosted()) { <a class="btn sm ghost" [href]="vscode(f.path)" title="Open it in VS Code">Open in VS Code</a> }
            }
            @if (source(); as s) {
              @if (s.kind === 'factory') { <a class="btn sm ghost" [routerLink]="['/factory']" [queryParams]="{ view: 'tickets', ticket: s.ticket }" (click)="closed.emit()">On the Factory page</a> }
            }
          </span>
        </div>
        <div class="body">
          @if (error(); as e) { <p class="err">{{ e }}</p> }
          @else if (file(); as f) {
            @if (raw()) { <pre class="raw">{{ f.text }}</pre> }
            @else { <div class="md" [innerHTML]="f.text | md | trustedHtml"></div> }
          }
          @else { <p class="hint">Loading…</p> }
        </div>
      </div>
    </div>
  `,
  styles: [`
    .mfv { display: flex; flex-direction: column; max-height: 88vh; overflow: hidden; }
    .head { display: flex; align-items: flex-start; gap: 8px; }
    .head h3 { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .x { margin: 10px 12px 0 0; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 0 1.2rem 10px; border-bottom: 1px solid var(--line-soft); }
    .path { font-size: 11.5px; color: var(--ink-faint); overflow-wrap: anywhere; min-width: 0; flex: 1 1 260px; }
    .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: auto; }
    .acts .seg { padding: 2px; }
    .acts .seg button { padding: 2px 10px; font-size: 11.5px; }
    .body { overflow: auto; padding: 1rem 1.2rem 1.2rem; }
    .raw { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
    .err { color: var(--danger, #b42318); margin: 0; }
    .hint { color: var(--ink-faint); margin: 0; }
  `],
})
export class MdFileViewerComponent {
  private readonly api = inject(ApiService);
  readonly source = input.required<MdFileSource>();
  readonly closed = output<void>();
  readonly file = signal<{ path: string; text: string } | null>(null);
  readonly error = signal<string | null>(null);
  readonly raw = signal(false);
  readonly title = signal('');
  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  /** What had focus when the viewer opened (the path or button that opened it): focus goes back there on close. */
  private readonly opener = document.activeElement as HTMLElement | null;

  constructor() {
    effect(() => { void this.load(this.source()); });
    effect(() => this.card()?.nativeElement.focus());
    inject(DestroyRef).onDestroy(() => { if (this.opener?.isConnected) this.opener.focus(); });
  }

  /** Tab and Shift+Tab stay inside the dialog: past the last control to the first, and back. */
  trap(e: Event): void {
    const card = this.card()?.nativeElement;
    if (!card) return;
    const items = [...card.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], back = (e as KeyboardEvent).shiftKey;
    const at = document.activeElement;
    if (back && (at === first || at === card)) { e.preventDefault(); last.focus(); }
    else if (!back && at === last) { e.preventDefault(); first.focus(); }
  }

  private async load(s: MdFileSource): Promise<void> {
    this.file.set(null); this.error.set(null); this.raw.set(false);
    this.title.set(s.kind === 'factory' ? `${s.ticket}'s plan` : s.path.split(/[\\/]/).pop() || s.path);
    const url = s.kind === 'factory'
      ? `/api/factory/plan?ticket=${encodeURIComponent(s.ticket)}`
      : `/api/runs/${encodeURIComponent(s.runId)}/md-file?path=${encodeURIComponent(s.path)}`;
    try {
      const f = await this.api.get<{ path: string; text: string }>(url);
      if (this.source() === s) this.file.set(f);
    } catch (e) {
      if (this.source() === s) this.error.set(`Couldn't open it: ${(e as Error).message}`);
    }
  }

  vscode(p: string): string { return vscodeUrl(p); }
  hosted(): boolean { return this.api.hosted(); }

  onBackdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.closed.emit(); }
}

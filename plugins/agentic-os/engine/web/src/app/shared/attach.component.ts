import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, input, signal } from '@angular/core';
import type { StagedAttachment } from '../../../../shared/api';
import { ApiService } from '../core/api.service';
import { bytes, pastedName } from '../core/util';

const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024;

interface Pending {
  key: number;
  name: string;
  size: number;
  /** A local preview for images, before and after the upload. */
  preview: string | null;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
  staged?: StagedAttachment;
}

/**
 * Files for a prompt or reply: a 📎 button, plus paste and drag-and-drop that the host
 * wires up with (paste)="att.paste($event)" (dragover)="att.dragOver($event)" (drop)="att.drop($event)"
 * on its form. Each file uploads as soon as it's added; ids() are what the launch or
 * reply sends. Handlers return nothing (a `false` from a template handler would preventDefault).
 */
@Component({
  selector: 'dash-attach',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="att" [class.compact]="compact()">
      @for (f of files(); track f.key) {
        <span class="chip" [class.err]="f.status === 'error'" [title]="f.error || f.name + ' · ' + size(f.size)">
          @if (f.preview) { <img [src]="f.preview" alt=""> } @else { <span class="ic">📄</span> }
          <span class="nm">{{ f.name }}</span>
          @if (f.status === 'uploading') { <span class="spin"></span> }
          @else if (f.status === 'error') { <span class="bad">failed</span> }
          <button type="button" class="x" (click)="remove(f.key)" [attr.aria-label]="'Remove ' + f.name">✕</button>
        </span>
      }
      <button type="button" class="btn ghost sm add" (click)="picker.click()" [disabled]="files().length >= max"
        title="Attach screenshots, PDFs, logs or other files (or paste a screenshot, or drop files here)">📎 Attach</button>
      @if (!files().length && !compact()) { <span class="hint">or paste a screenshot / drop files</span> }
      <input #picker type="file" multiple hidden (change)="picked($event)">
    </div>
  `,
  styles: [`
    .att { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip { display: inline-flex; align-items: center; gap: 6px; max-width: 260px; border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 3px 4px 3px 4px; font-size: 12px; }
    .chip.err { border-color: rgba(239,68,68,0.5); }
    .chip img { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; }
    .chip .ic { width: 28px; text-align: center; }
    .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .bad { color: var(--red); font-size: 11px; }
    .x { border: 0; background: transparent; cursor: pointer; color: var(--ink-faint); font-size: 11px; padding: 2px 5px; }
    .x:hover { color: var(--red); }
    .hint { font-size: 11.5px; color: var(--ink-faint); }
  `],
})
export class AttachComponent implements OnDestroy {
  private readonly api = inject(ApiService);
  /** Smaller, for the reply box. */
  readonly compact = input(false);
  readonly max = MAX_FILES;
  readonly files = signal<Pending[]>([]);
  readonly uploading = computed(() => this.files().some((f) => f.status === 'uploading'));
  readonly failed = computed(() => this.files().some((f) => f.status === 'error'));
  private seq = 0;

  /** Ids of the uploaded files, for the launch or reply request. */
  ids(): string[] {
    return this.files().filter((f) => f.status === 'ready' && f.staged).map((f) => f.staged!.id);
  }

  clear(): void {
    for (const f of this.files()) if (f.preview) URL.revokeObjectURL(f.preview);
    this.files.set([]);
  }

  remove(key: number): void {
    const f = this.files().find((x) => x.key === key);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    this.files.set(this.files().filter((x) => x.key !== key));
  }

  size(n: number): string { return bytes(n); }

  picked(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.add(Array.from(input.files || []));
    input.value = '';
  }

  /** Paste: take any files on the clipboard (a screenshot); plain text pastes as usual. */
  paste(e: ClipboardEvent): void {
    const items = Array.from(e.clipboardData?.items || []).filter((i) => i.kind === 'file');
    if (!items.length) return;
    e.preventDefault();
    const files = items.map((i) => i.getAsFile()).filter((f): f is File => !!f)
      .map((f) => (f.type.startsWith('image/') && (!f.name || /^image\.\w+$/i.test(f.name)) ? new File([f], pastedName(f.type), { type: f.type }) : f));
    this.add(files);
  }

  dragOver(e: DragEvent): void {
    if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
  }

  drop(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    this.add(files);
  }

  add(list: File[]): void {
    const room = MAX_FILES - this.files().length;
    for (const file of list.slice(0, Math.max(0, room))) {
      const key = ++this.seq;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      const tooBig = file.size > MAX_BYTES;
      this.files.set([...this.files(), {
        key, name: file.name || 'file', size: file.size, preview,
        status: tooBig ? 'error' : 'uploading', error: tooBig ? 'Files can be up to 20 MB.' : undefined,
      }]);
      if (!tooBig) this.upload(key, file);
    }
  }

  private async upload(key: number, file: File): Promise<void> {
    try {
      const staged = await this.api.upload<StagedAttachment>('/api/attachments?name=' + encodeURIComponent(file.name || 'file'), file);
      this.patch(key, { status: 'ready', staged, name: staged.name });
    } catch (e) {
      this.patch(key, { status: 'error', error: (e as Error).message });
    }
  }

  private patch(key: number, p: Partial<Pending>): void {
    this.files.set(this.files().map((f) => (f.key === key ? { ...f, ...p } : f)));
  }

  ngOnDestroy(): void { this.clear(); }
}

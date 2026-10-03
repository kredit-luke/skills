import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, output, untracked, viewChild } from '@angular/core';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { ExploreLang } from '../core/explore-paths';

/** A document to show. The editor resets (fresh undo history) only when `key` changes. */
export interface EditorDoc { key: string; text: string; lang: ExploreLang }

type CM = typeof import('./code-editor.cm');

/**
 * CodeMirror 6 viewer/editor. CodeMirror (and each language) loads on first use,
 * so it only weighs on the pages that show code. The document is always LF;
 * line endings are the caller's business (see server/src/explore.ts).
 */
@Component({
  selector: 'dash-code-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="cm-host" #host></div>`,
  styles: [`:host { display: block; min-height: 0; } .cm-host { height: 100%; }`],
})
export class CodeEditorComponent {
  readonly doc = input.required<EditorDoc>();
  readonly readOnly = input(true);
  /** The full text after each edit. */
  readonly changed = output<string>();
  /** Ctrl/Cmd+S. */
  readonly save = output<void>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private cm: CM | null = null;
  private view: EditorView | null = null;
  private key = '';

  constructor() {
    inject(DestroyRef).onDestroy(() => this.view?.destroy());
    effect(() => {
      const doc = this.doc();
      const ro = untracked(this.readOnly);
      if (doc.key !== this.key) this.load(doc, ro);
    });
    effect(() => {
      const ro = this.readOnly();
      if (this.view && this.cm) this.view.dispatch({ effects: this.cm.readOnly.reconfigure(this.cm.readOnlyExt(ro)) });
    });
  }

  private async load(doc: EditorDoc, ro: boolean): Promise<void> {
    this.key = doc.key;
    this.cm ??= await import('./code-editor.cm');
    const lang: Extension = await this.cm.language(doc.lang).catch(() => []);
    if (this.key !== doc.key) return; // a newer document arrived while loading
    const state = this.cm.createState(doc.text, lang, this.readOnly(), {
      changed: (text) => this.changed.emit(text),
      save: () => this.save.emit(),
    });
    if (this.view) this.view.setState(state);
    else this.view = new this.cm.EditorView({ state, parent: this.host().nativeElement });
  }
}

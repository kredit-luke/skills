import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, model, output, signal, viewChild } from '@angular/core';
import type { CommandInfo } from '../../../../shared/api';
import { CommandsService } from '../core/commands.service';
import { esc } from '../core/util';
import { TrustedHtmlPipe } from '../core/trusted-html.pipe';

/**
 * A text input (or textarea) with slash-command autocomplete: typing "/" lists
 * matching skills and commands; ↑↓ move, Tab/Enter pick, Esc closes. Once a
 * command is picked its argument hint stays visible underneath.
 */
@Component({
  selector: 'dash-slash-input',
  imports: [TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ac-wrap">
      @if (multiline()) {
        <textarea #box [rows]="rows()" [value]="value()" [placeholder]="placeholder()" [readOnly]="readonly()"
          autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" [attr.aria-expanded]="open()"
          (input)="onInput($event)" (keydown)="onKey($event)" (focus)="onFocus()" (blur)="onBlur()"></textarea>
      } @else {
        <input #box [value]="value()" [placeholder]="placeholder()" autocomplete="off" spellcheck="false"
          role="combobox" aria-autocomplete="list" [attr.aria-expanded]="open()"
          (input)="onInput($event)" (keydown)="onKey($event)" (focus)="onFocus()" (blur)="onBlur()">
      }
      @if (open()) {
        <div class="ac-list" role="listbox" (mousedown)="$event.preventDefault()">
          @if (loadingCmds()) {
            <div class="ac-empty">Loading commands…</div>
          } @else if (!items().length) {
            <div class="ac-empty">No matching command. It'll run as a plain prompt.</div>
          } @else {
            @for (c of items(); track c.name; let i = $index) {
              <div class="ac-item" [class.active]="i === index()" role="option" [attr.aria-selected]="i === index()" (mousedown)="accept(i)">
                <div class="l1"><span class="nm" [innerHTML]="'/' + hl(c.name) | trustedHtml"></span>
                  <span class="ah">{{ c.argumentHint }}</span><span class="tag">{{ c.source }}</span></div>
                @if (c.description) { <div class="ds">{{ c.description }}</div> }
              </div>
            }
            <div class="ac-foot">↑↓ to move · Tab or Enter to pick · Esc to close</div>
          }
        </div>
      }
    </div>
    @if (hint(); as h) {
      <div class="ac-hint"><b>/{{ h.name }}</b> {{ h.argumentHint }}@if (h.source === 'built-in') { · built-in }</div>
    }
  `,
  styles: [`:host { display: block; min-width: 0; } input { width: 100%; } .ac-hint { padding: 6px 2px 0; }`],
})
export class SlashInputComponent {
  private readonly cmds = inject(CommandsService);
  readonly value = model('');
  readonly placeholder = input('');
  readonly multiline = input(false);
  readonly rows = input(4);
  readonly readonly = input(false);
  /** Enter with the list closed (single-line mode only). */
  readonly submitted = output<void>();

  private readonly box = viewChild<ElementRef<HTMLInputElement | HTMLTextAreaElement>>('box');
  readonly open = signal(false);
  readonly index = signal(0);
  readonly query = computed(() => {
    const m = /^\/(\S*)$/.exec(this.value());
    return m ? m[1].toLowerCase() : null;
  });
  readonly loadingCmds = computed(() => this.cmds.commands() === null);
  readonly items = computed<CommandInfo[]>(() => {
    const q = this.query();
    return q === null ? [] : this.cmds.match(q);
  });
  readonly hint = computed(() => {
    const m = /^\/(\S+)\s/.exec(this.value());
    return m ? this.cmds.find(m[1]) || null : null;
  });

  focus(): void {
    const el = this.box()?.nativeElement;
    if (!el) return;
    el.focus();
    const n = el.value.length;
    el.setSelectionRange(n, n);
  }

  hl(name: string): string {
    const q = this.query() || '';
    const i = q ? name.toLowerCase().indexOf(q) : -1;
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
  }

  onInput(e: Event): void {
    this.value.set((e.target as HTMLInputElement).value);
    this.refresh();
  }

  onFocus(): void {
    this.cmds.load();
    this.refresh();
  }

  onBlur(): void {
    setTimeout(() => this.open.set(false), 120);
  }

  private refresh(): void {
    if (this.readonly()) return;
    if (this.query() === null) { this.open.set(false); return; }
    this.cmds.load();
    this.index.set(0);
    this.open.set(true);
  }

  onKey(e: KeyboardEvent): void {
    const items = this.items();
    if (this.open() && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.index.set((this.index() + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.accept(this.index()); return; }
    }
    if (e.key === 'Escape' && this.open()) { e.stopPropagation(); this.open.set(false); return; }
    if (e.key === 'Enter' && !this.multiline()) { e.preventDefault(); this.open.set(false); this.submitted.emit(); }
  }

  accept(i: number): void {
    const c = this.items()[i];
    if (!c) return;
    this.value.set('/' + c.name + ' ');
    this.open.set(false);
    setTimeout(() => this.focus());
  }
}

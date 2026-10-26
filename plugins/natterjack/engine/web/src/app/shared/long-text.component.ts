import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';
import { FOLDED_CHARS, longTextSize } from '../core/long-text';

/**
 * Plain text that folds when it's long (a pasted page of HTML, a log): the first part,
 * fading out, and "Show all". Inherits white-space and colour from where it sits.
 */
@Component({
  selector: 'dash-long-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lt" [class.folded]="folded()">{{ shown() }}</div>
    @if (size()) {
      <button type="button" class="lt-more" [attr.aria-expanded]="open()" (click)="open.set(!open())">{{ open() ? 'Show less' : 'Show all · ' + size() }}</button>
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .lt.folded { max-height: 14em; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent); mask-image: linear-gradient(to bottom, #000 60%, transparent); }
    .lt-more { display: block; background: none; border: 0; padding: 4px 0 0; font: inherit; font-size: 12px; color: inherit; opacity: .85; text-decoration: underline; cursor: pointer; white-space: normal; }
    .lt-more:hover { opacity: 1; }
  `],
})
export class LongTextComponent {
  readonly text = input('');
  /** Folded again whenever the text changes: the component is reused across runs (transcript keys restart per run). */
  readonly open = linkedSignal({ source: this.text, computation: () => false });
  readonly size = computed(() => longTextSize(this.text()));
  readonly folded = computed(() => !!this.size() && !this.open());
  readonly shown = computed(() => (this.folded() ? this.text().slice(0, FOLDED_CHARS) : this.text()));
}

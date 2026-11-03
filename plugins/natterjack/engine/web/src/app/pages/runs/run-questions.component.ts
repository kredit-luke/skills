import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { QuestionHost } from './question-dock';

/**
 * The questions Claude asked, as option buttons with "Other…" and Send answers. The answers live in
 * the host (the run's composer), so this renders the same under the transcript or docked in the
 * Activity page's left column (question-dock.ts). `docked` lays the options out for the wider column.
 */
@Component({
  selector: 'dash-run-questions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './run-questions.component.scss',
  host: { '[class.docked]': 'docked()' },
  template: `
    @let h = host();
    <div class="questions">
      @for (q of h.questions(); track $index; let qi = $index) {
        <div class="q">
          @if (q.header) { <div class="q-h">{{ q.header }}</div> }
          <div class="q-t">{{ q.question }}</div>
          <div class="opts">
            @for (o of q.options; track o.label) {
              <button type="button" class="opt" [class.on]="h.picked(qi, o.label)" [disabled]="h.locked()" (click)="h.pick(qi, o.label, !!q.multiSelect)" [title]="o.description || ''">
                <span class="ol">{{ o.label }}</span>@if (o.description) { <span class="od">{{ o.description }}</span> }
              </button>
            }
            <button type="button" class="opt" [class.on]="h.isOpen(qi)" [disabled]="h.locked()" (click)="h.toggleOther(qi, !!q.multiSelect)" title="Type your own answer">
              <span class="ol">Other…</span><span class="od">Type your own answer.</span>
            </button>
          </div>
          @if (h.isOpen(qi)) {
            <input class="q-other" [id]="'q-other-' + qi" type="text" [value]="h.notes()[qi] || ''" [disabled]="h.locked()"
              (input)="h.setNote(qi, $any($event.target).value)" (keydown.enter)="h.onOtherEnter($any($event))"
              [placeholder]="q.multiSelect ? 'Add your own answer…' : 'Your answer…'" />
          }
          @if (q.multiSelect) { <div class="q-note">Pick any that apply.</div> }
        </div>
      }
      @if (!h.single() || h.isOpen(0)) {
        <div class="q-send">
          @if (docked()) { <span class="q-extra">Anything typed in the reply box goes with your answers.</span> }
          <button class="btn primary sm" type="button" [disabled]="h.locked() || !h.anyPicked()" (click)="h.sendPicks()">Send answers</button>
        </div>
      }
    </div>
  `,
})
export class RunQuestionsComponent {
  readonly host = input.required<QuestionHost>();
  readonly docked = input(false);
}

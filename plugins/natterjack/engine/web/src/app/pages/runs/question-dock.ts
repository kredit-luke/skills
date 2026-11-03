import { DestroyRef, Injectable, inject, signal, type Signal } from '@angular/core';
import type { Question, RunMeta } from '../../../../../shared/api';

/**
 * Where the Activity page has two columns (runs.component.scss). The `@media (min-width: 1101px)`
 * blocks there use the same value: change them together.
 */
export const TWO_COLUMNS = '(min-width: 1101px)';

/** What the questions panel needs from whoever holds the answers (the run's composer). */
export interface QuestionHost {
  readonly run: Signal<RunMeta>;
  readonly questions: Signal<Question[]>;
  readonly notes: Signal<Record<number, string>>;
  readonly single: Signal<boolean>;
  readonly anyPicked: Signal<boolean>;
  /** Busy sending, or the run can't take an answer now (composerAction). */
  readonly locked: Signal<boolean>;
  picked(qi: number, label: string): boolean;
  isOpen(qi: number): boolean;
  pick(qi: number, label: string, multi: boolean): void;
  toggleOther(qi: number, multi: boolean): void;
  setNote(qi: number, value: string): void;
  onOtherEnter(e: KeyboardEvent): void;
  sendPicks(): void;
}

/**
 * The Activity page's questions dock: with two columns, the open run's questions show in the left
 * column (in place of History) instead of under the transcript, so the transcript keeps the room.
 * Provided by RunsComponent; the composer registers itself while it has questions to show. The
 * answers stay in the composer, so a reply typed there still goes with the picks.
 */
@Injectable()
export class QuestionDock {
  private readonly mq = typeof matchMedia === 'function' ? matchMedia(TWO_COLUMNS) : null;
  /** The page has two columns (follows resizes). */
  readonly wide = signal(this.mq?.matches ?? true);
  /** The composer whose questions are docked, or null. */
  readonly host = signal<QuestionHost | null>(null);

  constructor() {
    const on = (e: MediaQueryListEvent) => this.wide.set(e.matches);
    this.mq?.addEventListener('change', on);
    inject(DestroyRef).onDestroy(() => this.mq?.removeEventListener('change', on));
  }
}

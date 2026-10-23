import { Injectable, signal } from '@angular/core';

/**
 * The phone layout's breakpoint. The `@media (max-width: 600px)` blocks in the SCSS use the same
 * value (SCSS can't import it): change them together.
 */
export const SMALL_SCREEN = '(max-width: 600px)';

/** Whether the window is phone-sized, as a signal that follows resizes and rotation. */
@Injectable({ providedIn: 'root' })
export class SmallScreenService {
  private readonly mq = typeof matchMedia === 'function' ? matchMedia(SMALL_SCREEN) : null;
  readonly matches = signal(this.mq?.matches ?? false);

  constructor() {
    // Root-level, so the listener lasts as long as the app and needs no cleanup.
    this.mq?.addEventListener('change', (e) => this.matches.set(e.matches));
  }
}

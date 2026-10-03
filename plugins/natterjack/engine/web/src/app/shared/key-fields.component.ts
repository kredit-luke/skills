import { ChangeDetectionStrategy, Component, effect, input, model, signal } from '@angular/core';

/**
 * The key box on a Connect card. For an "email + API token" key (Atlassian) it's two fields, so the
 * email isn't hidden as a password, and `value` is "email:token" once both are filled in.
 * Otherwise it's the one password field. Clearing `value` (after a connect) clears both fields.
 */
@Component({
  selector: 'dash-key-fields',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (fields() === 'email-token') {
      <input type="email" placeholder="you@company.com" aria-label="Email" [value]="email()" (input)="email.set($any($event.target).value); combine()" autocomplete="username" spellcheck="false">
      <input type="password" placeholder="API token" aria-label="API token" [value]="token()" (input)="token.set($any($event.target).value); combine()" autocomplete="off" spellcheck="false">
    } @else {
      <input type="password" [placeholder]="placeholder()" [value]="value()" (input)="value.set($any($event.target).value)" autocomplete="off" spellcheck="false">
    }
  `,
})
export class KeyFieldsComponent {
  readonly fields = input<'email-token' | undefined>(undefined);
  readonly placeholder = input('');
  readonly value = model('');
  readonly email = signal('');
  readonly token = signal('');
  /** The last value this component set, so only a change from the page (a cleared key) resets the fields. */
  private mine = '';

  constructor() {
    effect(() => {
      const v = this.value();
      if (v !== this.mine && !v) { this.email.set(''); this.token.set(''); }
      this.mine = v;
    });
  }

  combine(): void {
    const e = this.email().trim(), t = this.token().trim();
    this.mine = e && t ? `${e}:${t}` : '';
    this.value.set(this.mine);
  }
}

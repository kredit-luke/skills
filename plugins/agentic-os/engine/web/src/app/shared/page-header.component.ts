import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Page header: green accent rule + eyebrow, title, one-line subtitle; actions projected on the right. */
@Component({
  selector: 'dash-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-h">
      <div class="titles">
        <div class="eyebrow">{{ eyebrow() }}</div>
        <h1>{{ title() }}</h1>
        @if (sub()) { <div class="sub">{{ sub() }}</div> }
      </div>
      <div class="acts"><ng-content /></div>
    </header>
  `,
})
export class PageHeaderComponent {
  readonly eyebrow = input('Workspace');
  readonly title = input.required<string>();
  readonly sub = input('');
}

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import type { RunOutput } from '../../../../../shared/api';
import { relTime } from '../../core/util';
import { changeMapLabel, changeMapUrl } from '../../runs/change-map';

/**
 * The run page's Map tab: a change map the run made (the change-map skill writes <name>.change-map.html
 * to the run's outputs), framed from the server's sandboxed route. The page is self-contained: the
 * happy path, its branches, what each added line is for, and the code no flow explains.
 */
@Component({
  selector: 'dash-run-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (current(); as m) {
      <div class="bar">
        @if (maps().length > 1) {
          <label>Map
            <select [value]="m.name" (change)="pick($any($event.target).value)">
              @for (x of maps(); track x.name) { <option [value]="x.name">{{ label(x.name) }}</option> }
            </select>
          </label>
        } @else {
          <b>{{ label(m.name) }}</b>
        }
        <span class="meta">{{ rel(m.modifiedAt) }}</span>
        <a class="btn sm ghost" [href]="raw()" target="_blank" rel="noopener">Open in a new tab ↗</a>
      </div>
      <iframe [src]="frame()" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" [title]="'Change map: ' + label(m.name)"></iframe>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; background: var(--paper); }
    .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; flex-wrap: wrap; }
    .bar label { display: inline-flex; align-items: center; gap: 6px; }
    .meta { color: var(--ink-faint); font-size: 12px; }
    .bar a { margin-left: auto; }
    iframe { display: block; width: 100%; height: var(--feed-max-h, 75vh); min-height: 420px; border: 0; background: var(--paper); }
    @media (max-width: 760px) { iframe { height: 80vh; } }
  `],
})
export class RunMapComponent {
  private readonly sanitizer = inject(DomSanitizer);
  readonly runId = input.required<string>();
  /** The run's change maps, newest first (changeMaps). */
  readonly maps = input<RunOutput[]>([]);
  private readonly picked = signal<string | null>(null);

  readonly current = computed(() => {
    const list = this.maps();
    return list.find((m) => m.name === this.picked()) ?? list[0] ?? null;
  });
  readonly raw = computed(() => { const m = this.current(); return m ? changeMapUrl(this.runId(), m) : ''; });
  // changeMapUrl only ever points at this server's sandboxed change-map route.
  readonly frame = computed<SafeResourceUrl>(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.raw()));

  pick(name: string): void { this.picked.set(name); }
  label(name: string): string { return changeMapLabel(name); }
  rel(t: string): string { return relTime(t); }
}

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { Limits, Settings, SettingKey } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { bytes } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';

type LimitKey = Exclude<SettingKey, 'model' | 'effort'>;

interface NumberRow { key: LimitKey; label: string; help: string; min: number; max: number; unit: string }

/**
 * Your own settings, saved in .claude/ledger/settings.json on this machine (not committed),
 * on top of the team's .claude/dashboard/deck.json. Each change saves right away.
 */
@Component({
  selector: 'dash-settings',
  imports: [PageHeaderComponent, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './settings.component.scss',
  template: `
    <dash-page-header eyebrow="Workspace" title="Settings"
      sub="Yours only: saved on this machine in .claude/ledger/settings.json. Anything you don't change follows the team's .claude/dashboard/deck.json." />

    @if (error()) { <div class="warn-note">{{ error() }}</div> }
    @if (s(); as s) {
      <div class="panel">
        <div class="panel-h"><h2>Runs</h2></div>
        <div class="rows">
          @for (row of numberRows.slice(0, 3); track row.key) {
            <ng-container *ngTemplateOutlet="num; context: { $implicit: row }" />
          }
          <div class="row">
            <div class="lbl">
              <div class="t">Per-run cost cap</div>
              <div class="h">Stop a run when its API-equivalent cost passes its budget (Implement $40, the other skill cards $2–8, $5 otherwise). On a subscription nothing is billed and the cap only stops runs that are working fine, so it's off by default. Turn it on if you run Claude on an API key.</div>
            </div>
            <div class="ctl">
              <label class="chk"><input type="checkbox" [checked]="s.effective.limits.runBudget" [disabled]="saving()" (change)="saveLimit('runBudget', $any($event.target).checked)"> {{ s.effective.limits.runBudget ? 'On' : 'Off' }}</label>
              <ng-container *ngTemplateOutlet="teamNote; context: { $implicit: 'runBudget', team: s.team.limits.runBudget ? 'on' : 'off' }" />
            </div>
          </div>
          <div class="row">
            <div class="lbl">
              <div class="t">Default model</div>
              <div class="h">What every run starts on: the run dialog, Ask, Explain, Implement, skill cards and routines. You can still pick another in the dialog for one run.</div>
            </div>
            <div class="ctl">
              <select [disabled]="saving()" (change)="saveDefault('model', $any($event.target).value)">
                @for (m of modelOptions(); track m) { <option [value]="m" [selected]="m === s.effective.defaults.model">{{ m }}</option> }
              </select>
              <ng-container *ngTemplateOutlet="teamNote; context: { $implicit: 'model', team: s.team.defaults.model }" />
            </div>
          </div>
          <div class="row">
            <div class="lbl">
              <div class="t">Default effort</div>
              <div class="h">How hard Claude thinks by default. Higher is slower and uses more of your plan.</div>
            </div>
            <div class="ctl">
              <select [disabled]="saving()" (change)="saveDefault('effort', $any($event.target).value)">
                @for (e of s.options.efforts; track e) { <option [value]="e" [selected]="e === s.effective.defaults.effort">{{ e }}</option> }
              </select>
              <ng-container *ngTemplateOutlet="teamNote; context: { $implicit: 'effort', team: s.team.defaults.effort }" />
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-h"><h2>Attachments</h2><span class="ty">{{ size(s.attachments.bytes) }} in {{ s.attachments.runs }} run{{ s.attachments.runs === 1 ? '' : 's' }}</span></div>
        <div class="rows">
          <ng-container *ngTemplateOutlet="num; context: { $implicit: numberRows[3] }" />
        </div>
      </div>
    } @else if (!error()) {
      <div class="empty">Loading…</div>
    }

    <ng-template #num let-row>
      <div class="row">
        <div class="lbl"><div class="t">{{ row.label }}</div><div class="h">{{ row.help }}</div></div>
        <div class="ctl">
          <span class="numw"><input type="number" [min]="row.min" [max]="row.max" step="1" [value]="limit(row.key)" [disabled]="saving()"
            (change)="saveNumber(row, $any($event.target))"> <span class="unit">{{ row.unit }}</span></span>
          <ng-container *ngTemplateOutlet="teamNote; context: { $implicit: row.key, team: teamLimit(row.key) + ' ' + row.unit }" />
        </div>
      </div>
    </ng-template>

    <ng-template #teamNote let-key let-team="team">
      @if (overridden(key)) {
        <span class="team">Team default: {{ team }} · <button type="button" class="linkish" [disabled]="saving()" (click)="reset(key)">Reset</button></span>
      } @else {
        <span class="team">Team default</span>
      }
    </ng-template>
  `,
})
export class SettingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  readonly s = signal<Settings | null>(null);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  /** The allowed aliases, plus whatever is in effect if it's a full model id. */
  readonly modelOptions = computed(() => {
    const s = this.s();
    if (!s) return [];
    const m = s.effective.defaults.model;
    return s.options.models.includes(m) ? s.options.models : [m, ...s.options.models];
  });

  readonly numberRows: NumberRow[] = [
    { key: 'maxConcurrentRuns', label: 'Runs at once', min: 1, max: 10, unit: 'runs',
      help: 'How many runs can be working at the same time. Runs waiting on your answer don\'t count. Past this, a new run or a reply is refused until one finishes; routines that come due are skipped.' },
    { key: 'pauseAtSessionPct', label: 'Pause at session usage', min: 10, max: 100, unit: '%',
      help: 'New runs and replies are refused once your current 5-hour session reaches this much of your plan. Runs already working carry on.' },
    { key: 'pauseAtWeeklyPct', label: 'Pause at weekly usage', min: 10, max: 100, unit: '%',
      help: 'The same, for your weekly limit.' },
    { key: 'keepAttachmentsDays', label: 'Keep attachments for', min: 0, max: 365, unit: 'days',
      help: 'Files you attach to a run are deleted this long after it\'s done (not running, not waiting on you). 0 keeps them forever. Checked every 6 hours, and right away when you change this.' },
  ];

  ngOnInit(): void { this.load(); }

  async load(): Promise<void> {
    try { this.s.set(await this.api.get<Settings>('/api/settings')); this.error.set(null); }
    catch (e) { this.error.set((e as Error).message); }
  }

  limit(key: LimitKey): number { return (this.s()!.effective.limits as unknown as Record<string, number>)[key]; }
  teamLimit(key: LimitKey): number { return (this.s()!.team.limits as unknown as Record<string, number>)[key]; }
  overridden(key: SettingKey): boolean {
    const mine = this.s()?.mine;
    if (!mine) return false;
    return key === 'model' || key === 'effort' ? key in (mine.defaults || {}) : key in (mine.limits || {});
  }
  size(n: number): string { return bytes(n); }

  saveNumber(row: NumberRow, el: HTMLInputElement): void {
    const v = Number(el.value);
    if (!Number.isInteger(v) || v < row.min || v > row.max) {
      this.toast.error(`${row.label}: a whole number from ${row.min} to ${row.max}.`);
      el.value = String(this.limit(row.key));
      return;
    }
    this.saveLimit(row.key, v);
  }

  saveLimit(key: LimitKey, value: Limits[LimitKey] | null): void { this.save({ limits: { [key]: value } }); }
  saveDefault(key: 'model' | 'effort', value: string | null): void { this.save({ defaults: { [key]: value } }); }

  reset(key: SettingKey): void {
    if (key === 'model' || key === 'effort') this.saveDefault(key, null);
    else this.saveLimit(key, null);
  }

  private async save(patch: { limits?: Record<string, unknown>; defaults?: Record<string, unknown> }): Promise<void> {
    this.saving.set(true);
    try {
      this.s.set(await this.api.post<Settings>('/api/settings', patch));
      this.toast.show('Saved');
      this.data.loadDeck(); // the run dialog and Home read limits and defaults from the deck
    } catch (e) {
      this.toast.error((e as Error).message);
      this.load();
    } finally {
      this.saving.set(false);
    }
  }
}

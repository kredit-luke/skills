import { ChangeDetectionStrategy, Component, computed, effect, inject, model, untracked } from '@angular/core';
import type { AgentId } from '../../../../shared/api';
import { defaultsFor, effortsFor, modelsFor, usableAgents } from '../core/agents';
import { DataService } from '../core/data.service';
import { LaunchService } from '../core/launch.service';

/**
 * Agent, Model and Effort for a run (launch dialog, Ask). The Agent select shows only when
 * more than one agent CLI is installed and signed in here; picking one swaps in its models
 * and efforts and starts on its defaults. The host is display: contents, so the selects sit
 * in the parent form's grid like its other fields.
 */
@Component({
  selector: 'dash-agent-fields',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [':host { display: contents; }'],
  template: `
    @if (usable().length > 1) {
      <label>Agent
        <select (change)="pickAgent($any($event.target).value)" aria-label="Agent">
          @for (a of usable(); track a.id) { <option [value]="a.id" [selected]="a.id === agent()">{{ a.label }}</option> }
        </select>
      </label>
    }
    <label>Model
      <select (change)="pickModel($any($event.target).value)">
        @if (!modelId()) { <option value="" selected>Default</option> }
        @for (m of models(); track m.id) { <option [value]="m.id" [selected]="m.id === modelId()">{{ m.label }}</option> }
      </select>
    </label>
    <label>Effort
      <select (change)="effort.set($any($event.target).value); touched.set(true)">
        <option value="" [selected]="!effort()">Default</option>
        @for (e of efforts(); track e) { <option [value]="e" [selected]="e === effort()">{{ e }}</option> }
      </select>
    </label>
  `,
})
export class AgentFieldsComponent {
  private readonly data = inject(DataService);
  private readonly launch = inject(LaunchService);
  readonly agent = model<AgentId>('claude');
  readonly modelId = model('');
  readonly effort = model('');
  /** The person changed model or effort by hand (callers may keep it across agent changes). */
  readonly touched = model(false);

  readonly usable = computed(() => usableAgents(this.data.agents()));
  private readonly info = computed(() => (this.data.agents() || []).find((a) => a.id === this.agent()) || null);
  readonly models = computed(() => modelsFor(this.info(), this.data.deck()?.options?.models || []));
  readonly efforts = computed(() => effortsFor(this.info(), this.modelId(), this.data.deck()?.options?.efforts || []));

  constructor() {
    // An effort the new model doesn't take goes back to the default.
    effect(() => {
      const list = this.efforts();
      untracked(() => { if (this.effort() && list.length && !list.includes(this.effort())) this.effort.set(''); });
    });
  }

  pickAgent(id: string): void {
    const info = (this.data.agents() || []).find((a) => a.id === id) || null;
    this.agent.set(id as AgentId);
    const d = defaultsFor(info, { model: this.launch.model(), effort: this.launch.effort() });
    this.modelId.set(d.model);
    this.effort.set(d.effort);
    this.launch.rememberAgent(id as AgentId);
  }

  pickModel(id: string): void {
    this.modelId.set(id);
    this.touched.set(true);
  }
}

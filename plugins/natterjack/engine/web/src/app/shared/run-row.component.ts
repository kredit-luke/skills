import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { RunMeta } from '../../../../shared/api';
import { agentLabel } from '../core/agents';
import { dur, relTime } from '../core/util';
import { runStatus, toReview } from './run-status';

@Component({
  selector: 'dash-run-row',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let r = run();
    <a class="row" [class.selected]="selected()" [routerLink]="['/runs', r.id]" [queryParamsHandling]="keepQuery() ? 'preserve' : ''">
      <span [class]="'sdot ' + st().dot" [title]="st().label"></span>
      <div class="main">
        <div class="title">{{ r.label }}
          @if (r.flagged) { <span class="tag amber" title="You flagged this run as needing you">⚑ needs me</span> }
          @if (r.status === 'waiting') { <span class="tag amber">needs answer</span> }
          @if (review()) { <span class="tag review" title="Finished and not rated yet: open it and mark it Good or Needed fix (it leaves Focus after a day anyway)">to review</span> }
          @if (r.watch && !r.watch.endedAt) { <span class="tag routine" [title]="'Watching ' + watchedPrs() + ': the dashboard resumes this run when they change'">watching</span> }
          @if (r.warning) { <span class="tag amber" [title]="r.warning">bg stopped</span> }
          @if (r.trigger && r.trigger.startsWith('routine:')) { <span class="tag routine">routine</span> }
          @if (r.agent && r.agent !== 'claude') { <span class="tag agent" [title]="'Run by ' + agentName()">{{ agentName() }}</span> }
          @if (r.planMode) { <span class="tag" title="Read-only">plan</span> }
          @if (r.status === 'handedOff' || r.continuedAt) { <span class="tag routine" title="Continued in a terminal">terminal</span> }
          @if (r.verdict === 'good') { <span class="tag good">good</span> }
          @if (r.verdict === 'needed-fix') { <span class="tag bad">needed fix</span> }
        </div>
        <div class="sub">{{ r.workspace !== 'main' ? r.workspace + ' · ' : '' }}{{ sub() }}</div>
      </div>
      <div class="right">
        @if (r.status === 'running') { {{ elapsed() }}<br>{{ r.resolvedModel || r.model || '' }} }
        @else { {{ ago() }}<br>{{ duration() }} }
      </div>
    </a>
  `,
})
export class RunRowComponent {
  readonly run = input.required<RunMeta>();
  readonly selected = input(false);
  /** Keep the page's query params (e.g. the Runs status filter) when opening a run. */
  readonly keepQuery = input(false);
  readonly st = computed(() => runStatus(this.run()));
  readonly review = computed(() => toReview(this.run()));
  readonly agentName = computed(() => agentLabel(this.run().agent));
  readonly sub = computed(() => {
    const r = this.run();
    if (r.status === 'running') return (r.lastActivity || 'starting…') + ' · ' + (r.toolCalls || 0) + ' tool calls';
    if (r.status === 'waiting' && r.question && r.question[0]) return 'Asks: ' + r.question[0].question;
    if (r.status === 'succeeded') return (r.resultText || '').split('\n')[0];
    return (r.error || r.status || '').split('\n')[0];
  });
  readonly watchedPrs = computed(() => (this.run().watch?.prs || []).map((p) => p.repo.split('/').pop() + '#' + p.number).join(', '));
  readonly elapsed = computed(() => dur(Date.now() - Date.parse(this.run().turnStartedAt || this.run().startedAt)));
  readonly ago = computed(() => relTime(this.run().endedAt || this.run().startedAt));
  readonly duration = computed(() => dur(this.run().durationMs));
}

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { RunMeta } from '../../../../shared/api';
import { agentLabel } from '../core/agents';
import { DataService } from '../core/data.service';
import { dur, relTime } from '../core/util';
import { remoteTag } from '../runs/remote';
import { runStatus, toReview } from './run-status';

@Component({
  selector: 'dash-run-row',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Small screens (600px = SMALL_SCREEN in core/small-screen.ts): the right-hand column goes, when it
  // ran moves to the start of the sub line, and the tags wrap on their own line under the title
  // (which keeps its ellipsis). Wider, the title and its tags share one cut-off line.
  styles: [`
    .sub-when { display: none; }
    @media (max-width: 600px) {
      .row .right { display: none; }
      .sub-when { display: inline; }
      .row .title { white-space: normal; overflow: visible; }
      .title .lbl { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .title .tags { display: flex; flex-wrap: wrap; gap: 3px 4px; margin-top: 3px; }
      .title .tags:empty { display: none; }
    }
  `],
  template: `
    @let r = run();
    <a class="row" [class.selected]="selected()" [routerLink]="['/runs', r.id]" [queryParamsHandling]="keepQuery() ? 'preserve' : ''">
      @if (r.flagged) { <span class="sflag" [title]="'Flagged as needing you · ' + st().label">⚑</span> }
      @else { <span [class]="'sdot ' + st().dot" [title]="st().label"></span> }
      <div class="main">
        <div class="title"><span class="lbl">{{ r.label }} </span><span class="tags">
          @if (r.flagged) { <span class="tag amber" title="You flagged this run as needing you">⚑ needs me</span> }
          @if (needsAnswer()) { <span class="tag amber">needs answer</span> }
          @if (review()) { <span class="tag review" title="Finished and not rated yet: open it and mark it Good or Needed fix (it leaves Focus after a day anyway)">to review</span> }
          @if (r.watch && !r.watch.endedAt) { <span class="tag routine" [title]="'Watching ' + watchedPrs() + ': the dashboard resumes this run when they change'">watching</span> }
          @if (r.warning) { <span class="tag amber" [title]="r.warning">bg stopped</span> }
          @if (r.trigger && r.trigger.startsWith('routine:')) { <span class="tag routine">routine</span> }
          @if (r.agent && r.agent !== 'claude') { <span class="tag agent" [title]="'Run by ' + agentName()">{{ agentName() }}</span> }
          @if (r.planMode) { <span class="tag" title="Read-only">plan</span> }
          @if (r.status === 'handedOff' && r.handedOffTo === 'hosted') { <span class="tag routine" title="Moved to the hosted dashboard">hosted</span> }
          @else if (r.status === 'handedOff' || r.continuedAt) { <span class="tag routine" title="Continued in a terminal">terminal</span> }
          @if (r.remote; as rm) {
            <span class="tag routine" [title]="'Runs on ' + rm.label + ', linked to this dashboard (Remote control)'">on {{ rm.label }}</span>
            @if (remoteTag(); as t) { <span class="tag amber" [title]="t.title">{{ t.text }}</span> }
          }
          @if (r.movedFrom) { <span class="tag routine" [title]="'Moved here from ' + r.movedFrom.cwd">moved here</span> }
          @if (r.verdict === 'good') { <span class="tag good">good</span> }
          @if (r.verdict === 'needed-fix') { <span class="tag bad">needed fix</span> }
        </span></div>
        <div class="sub"><span class="sub-when">{{ r.status === 'running' ? elapsed() : ago() }} · </span>{{ r.workspace !== 'main' ? r.workspace + ' · ' : '' }}{{ sub() }}</div>
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

  private readonly data = inject(DataService);
  /**
   * A mirrored run's "remote control off" / "offline" tag, from its link (DataService.remoteLive,
   * which reads the shared clock), so "offline" appears without a reload.
   */
  readonly remoteTag = computed(() => remoteTag(this.data.remoteLive(this.run()), this.data.now()));
  /** DataService.needsAnswer: a mirrored waiting run on a link with Remote control off shows only "remote control off". */
  readonly needsAnswer = computed(() => this.data.needsAnswer(this.run()));
}

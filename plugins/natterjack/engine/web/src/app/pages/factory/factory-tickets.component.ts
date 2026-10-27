import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { FactoryItem, FactoryItemStep, FactoryStepState, FactoryStepStatus } from '../../../../../shared/api';
import { relTime } from '../../core/util';
import { checkMark, duration, specLevel } from './factory.util';

const STEP_MARK: Record<FactoryStepState, string> = { done: '✓', running: '●', failed: '✕', waiting: '!', skipped: '–', pending: '○' };
const STEP_WORD: Record<FactoryStepState, string> = { done: 'Done', running: 'Under way', failed: 'Failed', waiting: 'Waiting', skipped: 'Skipped', pending: 'Not reached' };
const ROW_MARK: Record<FactoryStepStatus, string> = { done: '✓', running: '●', failed: '✕', pending: '○', skipped: '–' };
const STATE: Record<FactoryItem['state'], { label: string; cls: string }> = {
  moving: { label: 'Working', cls: 'good' }, waiting: { label: 'Waiting', cls: 'amber' }, failing: { label: 'Failing', cls: 'bad' },
  idle: { label: 'Idle', cls: '' }, done: { label: 'Done', cls: 'good' },
};

/**
 * The Factory's Tickets view: a row per work item with its whole pipeline as a track, and on
 * demand every step's times, per-repo rows (with the pipeline's notes) and gate decisions.
 */
@Component({
  selector: 'dash-factory-tickets',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="items">
      @for (it of items(); track it.ticket) {
        <li class="item" [class]="'item s-' + it.state">
          <div class="head">
            <button class="exp" type="button" (click)="toggle(it.ticket)" [attr.aria-expanded]="open().has(it.ticket)" [attr.aria-label]="(open().has(it.ticket) ? 'Hide' : 'Show') + ' details for ' + it.ticket">{{ open().has(it.ticket) ? '▾' : '▸' }}</button>
            @if (it.url) { <a class="tk" [href]="it.url" target="_blank" rel="noopener">{{ it.ticket }}</a> } @else { <span class="tk">{{ it.ticket }}</span> }
            <span class="ttl">{{ it.title || '' }}</span>
            <span class="tag" [class]="state(it).cls">{{ state(it).label }}</span>
            @if (it.reason) { <span class="why">{{ it.reason }}</span> }
            @if (it.spec; as sp) {
              <button class="spec tag" type="button" [class]="'spec tag ' + level(sp.level).cls" (click)="toggle(it.ticket)" [title]="'Spec readiness ' + sp.score + '/100: ' + level(sp.level).label + '. Ready at ' + sp.readyAt + '.'">Spec {{ sp.score }} · {{ level(sp.level).label }}</button>
            }
          </div>
          <div class="meta">
            @if (it.agent) { <span>{{ it.agent }}{{ it.model ? ' · ' + it.model : '' }}</span> }
            <span [title]="it.startedAt">started {{ rel(it.startedAt) }}</span>
            <span>{{ it.mode }}</span>
            @if (it.costUsd || it.budgetUsd) { <span [class.over]="it.budgetUsd != null && it.costUsd > it.budgetUsd">\${{ it.costUsd.toFixed(2) }}{{ it.budgetUsd != null ? ' of $' + it.budgetUsd : '' }}</span> }
            @if (it.risk; as r) { <span class="risk" [class]="'risk ' + r.level" [title]="r.rationale || ''">{{ r.level }} risk</span> }
            @for (p of it.prs; track p.url) { <a [href]="p.url" target="_blank" rel="noopener">{{ p.repo || 'PR' }}{{ p.number ? ' #' + p.number : '' }}{{ p.state === 'merged' ? ' (merged)' : '' }}</a> }
            @if (it.runIds.length) { <a [routerLink]="['/runs', it.runIds[0]]">Latest run</a> }
          </div>
          <ol class="track" [attr.aria-label]="it.ticket + ' pipeline'">
            @for (s of it.steps; track s.id) {
              <li class="step" [class]="'step st-' + s.state" [class.gate]="s.kind === 'gate'" [class.cur]="s.current" [title]="tip(s)">
                <span class="mk" aria-hidden="true">{{ mark(s.state) }}</span>{{ s.label }}
                @if (took(s); as d) { <span class="dur">{{ d }}</span> }
              </li>
            }
          </ol>
          @if (it.error) { <p class="err-note">Stopped: {{ it.error }}</p> }

          @if (open().has(it.ticket)) {
            <div class="details">
              <dl>
                @if (it.branch) { <dt>Branch</dt><dd class="mono">{{ it.branch }}</dd> }
                @if (it.workroot) { <dt>Works in</dt><dd class="mono">{{ it.workroot }}</dd> }
                @if (it.plan) { <dt>Plan</dt><dd class="mono">{{ it.plan }}</dd> }
                @if (it.repos.length) { <dt>Repos</dt><dd>@for (r of it.repos; track r.repo) { <span class="repo" [class]="'repo st-' + r.status">{{ r.repo }} {{ rowMark(r.status) }}</span> }</dd> }
                @if (it.runIds.length > 1) { <dt>Runs</dt><dd>@for (id of it.runIds; track id; let i = $index) { <a [routerLink]="['/runs', id]">{{ i === 0 ? 'latest' : '#' + (it.runIds.length - i) }}</a>{{ $last ? '' : ' · ' }} }</dd> }
              </dl>
              @if (it.spec; as sp) {
                <section class="specd">
                  <h3>Spec readiness <span class="tag" [class]="level(sp.level).cls">{{ sp.score }}/100 · {{ level(sp.level).label }}</span>
                    <span class="faint">ready at {{ sp.readyAt }}, needs work from {{ sp.needsWorkAt }}{{ sp.minScore != null ? ', unattended runs need ' + sp.minScore : '' }} · scored {{ rel(sp.at) }}</span></h3>
                  <ul>
                    @for (c of sp.checks; track c.id) {
                      @if (c.weight) {
                        <li><span class="mk" [class.st-done]="c.score >= 1" [class.st-waiting]="c.score > 0 && c.score < 1" [class.st-failed]="!c.score">{{ cmark(c.score) }}</span>
                          <b>{{ c.label }}</b> <span>{{ c.finding }}</span>
                          @if (c.override; as o) { <span class="faint">(the agent changed this from {{ cmark(o.from) }}: {{ o.reason }})</span> }
                        </li>
                      }
                    }
                  </ul>
                </section>
              }
              <table>
                <thead><tr><th>Step</th><th>State</th><th>Started</th><th>Took</th><th>What happened</th></tr></thead>
                <tbody>
                  @for (s of it.steps; track s.id) {
                    @if (s.state !== 'pending' || s.current) {
                      <tr [class.cur]="s.current">
                        <td>{{ s.label }}</td>
                        <td><span class="mk" [class]="'mk st-' + s.state">{{ mark(s.state) }}</span> {{ word(s.state) }}</td>
                        <td class="faint" [title]="s.startedAt || ''">{{ s.startedAt ? rel(s.startedAt) : '' }}</td>
                        <td class="faint">{{ took(s) }}</td>
                        <td>
                          @for (r of s.repos; track $index) {
                            <div class="line"><span class="mk" [class]="'mk st-' + r.status">{{ rowMark(r.status) }}</span> @if (r.repo) { <b>{{ r.repo }}</b> } @if (r.agent) { <span class="faint">{{ r.agent }}</span> } @if (r.note) { — {{ r.note }} }</div>
                          }
                          @for (d of s.decisions; track $index) {
                            <div class="line">{{ d.decision }}@if (d.by) { by <b>{{ d.by }}</b> } @if (d.mode) { <span class="faint">({{ d.mode }})</span> } <span class="faint" [title]="d.at">{{ rel(d.at) }}</span>@if (d.risk) { · <span class="risk" [class]="'risk ' + d.risk">{{ d.risk }} risk</span> }@if (d.rationale) { — {{ d.rationale }} }</div>
                          }
                          @if (!s.repos.length && !s.decisions.length && s.state === 'skipped') { <span class="faint">Not reported; a later step was.</span> }
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
          }
        </li>
      }
    </ul>
  `,
  styles: [`
    .items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .item { background: #fff; border: 1px solid var(--line-soft); border-left: 3px solid var(--line); border-radius: 10px; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .item.s-moving { border-left-color: var(--green); }
    .item.s-waiting { border-left-color: var(--yellow); }
    .item.s-failing { border-left-color: var(--red); }
    .head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .exp { border: 0; background: transparent; cursor: pointer; font-size: 13px; color: var(--ink-soft); padding: 2px 4px; }
    .tk { font-family: var(--font-mono); font-weight: 600; font-size: 13px; }
    .ttl { font-size: 14px; color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
    .why { font-size: 12.5px; color: var(--ink-soft); font-style: italic; }
    .meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ink-faint); padding-left: 26px; }
    .meta .over { color: var(--red); }
    .track { list-style: none; margin: 0; padding: 0 0 0 26px; display: flex; flex-wrap: wrap; gap: 4px; }
    .step { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; padding: 3px 8px; border-radius: 999px; background: var(--paper-2); color: var(--ink-faint); border: 1px solid transparent; white-space: nowrap; }
    .step.gate { border: 1px dashed var(--line); background: transparent; }
    .step.st-done { color: var(--green); }
    .step.st-running { color: var(--brand-700); background: var(--paper-2); font-weight: 600; }
    .step.st-failed { color: var(--red); background: var(--red-bg); }
    .step.st-waiting { color: var(--yellow); background: var(--yellow-bg); font-weight: 600; }
    .step.st-skipped { opacity: .55; text-decoration: line-through; }
    .step.cur { border-color: currentColor; border-style: solid; }
    .dur { font-family: var(--font-mono); font-size: 10.5px; opacity: .8; }
    .details { padding-left: 26px; display: flex; flex-direction: column; gap: 10px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; font-size: 12.5px; }
    dt { color: var(--ink-faint); }
    dd { margin: 0; overflow-wrap: anywhere; }
    .mono { font-family: var(--font-mono); font-size: 12px; }
    .repo { font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: 5px; background: var(--paper-2); margin-right: 4px; }
    .repo.st-done { color: var(--green); }
    .repo.st-failed { color: var(--red); }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint); font-weight: 600; padding: 4px 8px; }
    td { padding: 6px 8px; border-top: 1px solid var(--line-soft); vertical-align: top; }
    tr.cur td { background: var(--paper-2); }
    td:first-child { white-space: nowrap; font-weight: 600; }
    .faint { color: var(--ink-faint); }
    .spec.tag { cursor: pointer; border: 0; font: inherit; font-size: 10.5px; }
    .specd h3 { margin: 0 0 6px; font-size: 12.5px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
    .specd h3 .faint { font-weight: 400; font-size: 12px; }
    .specd ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; }
    .specd li { display: flex; flex-wrap: wrap; gap: 0 6px; align-items: baseline; }
    .line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 5px; }
    .line + .line { margin-top: 3px; }
    .mk.st-done { color: var(--green); }
    .mk.st-failed { color: var(--red); }
    .mk.st-running { color: var(--brand-700); }
    .mk.st-waiting { color: var(--yellow); }
    .risk { text-transform: uppercase; font-size: 10px; font-family: var(--font-mono); padding: 0 5px; border-radius: 4px; background: var(--paper-2); }
    .risk.high { background: var(--red-bg); color: var(--red); }
    .risk.medium { background: var(--yellow-bg); color: var(--yellow); }
    .risk.low { color: var(--green); }
    @media (max-width: 700px) { .meta, .track, .details { padding-left: 0; } table { display: block; overflow-x: auto; } }
  `],
})
export class FactoryTicketsComponent {
  readonly items = input.required<FactoryItem[]>();
  readonly open = signal<Set<string>>(new Set());
  /** A clock for steps still going (the board only changes when something is reported). */
  private readonly now = signal(Date.now());

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  toggle(ticket: string): void {
    this.open.update((s) => { const n = new Set(s); n.has(ticket) ? n.delete(ticket) : n.add(ticket); return n; });
  }

  state(it: FactoryItem) { return STATE[it.state]; }
  mark(s: FactoryStepState): string { return STEP_MARK[s]; }
  word(s: FactoryStepState): string { return STEP_WORD[s]; }
  rowMark(s: FactoryStepStatus): string { return ROW_MARK[s]; }
  level = specLevel;
  cmark = checkMark;
  rel(t: string): string { return relTime(t); }
  took(s: FactoryItemStep): string {
    if (s.state === 'pending' || s.state === 'skipped') return '';
    const d = duration(s.startedAt, s.endedAt, this.now());
    // A decision made the moment it was asked for has no wait worth showing.
    return d === '0s' ? '' : d;
  }
  tip(s: FactoryItemStep): string {
    const t = this.took(s);
    return `${s.label}: ${STEP_WORD[s.state].toLowerCase()}${t ? ` (${t})` : ''}${s.current ? ', current step' : ''}`;
  }
}

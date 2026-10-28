import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  AgentId, FactoryConfig, FactoryConfigState, FactoryGateId, FactoryGateMode, FactoryNoticeEvent, FactoryPreset, FactoryScanner, FactoryStageId, MergeMethod, Severity, SpecCheckId,
} from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { GATE_IDS, matchingPreset, numOrNull, pipelineSteps, splitLines, splitList, withPreset } from './factory.util';

const GATE_HELP: Record<FactoryGateId, string> = {
  spec: 'Before any planning: is this the right ticket, and is it clear enough?',
  plan: 'After planning, before code: is this the right approach?',
  prePr: 'Before opening the PR: is the work done and checked?',
  merge: 'Before merging.',
};

/**
 * Settings → Factory: the team's policy for agent work, in .claude/dashboard/factory.json
 * (committed with the workspace, so changes to it get reviewed). Edits are a draft until Save.
 */
@Component({
  selector: 'dash-factory-settings',
  imports: [PageHeaderComponent, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dash-page-header eyebrow="Agents" title="Factory policy"
      sub="The team's rules for agent work, from ticket to merged PR. Saved in .claude/dashboard/factory.json: commit it so changes get reviewed.">
      <a class="btn ghost sm" routerLink="/factory">Board</a>
    </dash-page-header>

    @if (loadErr()) { <div class="warn-note">{{ loadErr() }}</div> }
    @if (state(); as st) {
      @if (st.error) { <div class="warn-note">factory.json can't be read: {{ st.error }}. Saving replaces it.</div> }
      @if (!st.canEdit) { <div class="warn-note">Changing the factory needs full access; yours is read-only (Settings → Access).</div> }
    }

    @if (draft(); as c) {
      <fieldset [disabled]="!state()?.canEdit || saving()">
        <div class="panel">
          <div class="panel-h"><h2>Factory</h2>
            <label class="chk"><input type="checkbox" [ngModel]="c.enabled" (ngModelChange)="set('enabled', $event)" /> On</label>
          </div>
          <div class="body">
            <p class="h">Off: nothing picks up tickets for the factory, and the board only shows work already reported to it.</p>
            <div class="presets" role="radiogroup" aria-label="Preset">
              @for (p of presetList(); track p.id) {
                <button type="button" class="preset" [class.on]="c.preset === p.id" role="radio" [attr.aria-checked]="c.preset === p.id" (click)="applyPreset(p.id)">
                  <b>{{ p.label }}</b><span>{{ p.description }}</span>
                </button>
              }
              <div class="preset ro" [class.on]="c.preset === 'custom'"><b>Custom</b><span>Your own mix; any change to gates, mode or the Approver lands here.</span></div>
            </div>
            <label class="field">Mode
              <select [ngModel]="c.mode" (ngModelChange)="set('mode', $event)">
                <option value="interactive">Interactive: gates ask a person</option>
                <option value="autonomous">Autonomous: decide, and record each decision on the ticket</option>
              </select>
            </label>
            <div class="flow" aria-label="The board's columns">
              <span class="col">Queued</span>
              @for (s of steps(); track $index) {
                <span class="arrow">→</span><span class="col" [class.gate]="s.kind === 'gate'">{{ s.kind === 'gate' ? gateLabel(s.id) : stageLabel(s.id) }}</span>
              }
              <span class="arrow">→</span><span class="col">Done</span>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Intake and limits</h2></div>
          <div class="body grid">
            <label class="field">Tracker states it takes
              <input [ngModel]="c.intake.states.join(', ')" (ngModelChange)="setList('states', $event)" [ngModelOptions]="{ updateOn: 'blur' }" placeholder="e.g. Ready" />
              <span class="h">Empty: only tickets sent to the factory by hand.</span>
            </label>
            <label class="field">Labels it takes
              <input [ngModel]="c.intake.labels.join(', ')" (ngModelChange)="setList('labels', $event)" [ngModelOptions]="{ updateOn: 'blur' }" placeholder="e.g. factory" />
            </label>
            <label class="chk"><input type="checkbox" [ngModel]="c.intake.unassigned" (ngModelChange)="setIntake('unassigned', $event)" [disabled]="!c.intake.states.length && !c.intake.labels.length" /> Unassigned tickets too (each is assigned to whoever's dashboard takes it, before it starts)</label>
            <span class="h">Each person's dashboard takes the tickets assigned to them on the tracker.</span>
            <label class="chk"><input type="checkbox" [ngModel]="c.intake.auto" (ngModelChange)="setIntake('auto', $event)" [disabled]="!c.intake.states.length && !c.intake.labels.length" /> Pull them in on its own, every
              <input class="mins" type="number" min="5" max="1440" [ngModel]="c.intake.everyMinutes" (ngModelChange)="setIntake('everyMinutes', +$event)" [disabled]="!c.intake.auto" aria-label="Minutes between pulls" /> minutes, while the dashboard runs</label>
            <label class="field">Items at once (WIP)
              <input type="number" min="1" max="50" [ngModel]="c.limits.wip" (ngModelChange)="setLimit('wip', $event)" />
            </label>
            <label class="field">Budget per item (USD)
              <input type="number" min="0" step="1" [ngModel]="c.limits.itemBudgetUsd" (ngModelChange)="setLimit('itemBudgetUsd', $event)" placeholder="No limit" />
            </label>
            <label class="field">Budget per day (USD)
              <input type="number" min="0" step="1" [ngModel]="c.limits.dayBudgetUsd" (ngModelChange)="setLimit('dayBudgetUsd', $event)" placeholder="No limit" />
            </label>
            <label class="field">Agent hours per item
              <input type="number" min="0" step="0.5" [ngModel]="c.limits.itemHours" (ngModelChange)="setLimit('itemHours', $event)" placeholder="No limit" />
            </label>
          </div>
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Pipeline</h2></div>
          <table class="stages">
            <thead><tr><th>Stage</th><th>On</th><th>Agent</th><th>Model</th></tr></thead>
            <tbody>
              @for (s of c.stages; track s.id) {
                <tr [class.off]="!s.on">
                  <td>{{ stageLabel(s.id) }}<div class="h">{{ stageHelp[s.id] }}</div></td>
                  <td><input type="checkbox" [ngModel]="s.on" (ngModelChange)="setStage(s.id, 'on', $event)" [disabled]="s.id === 'build'" [attr.aria-label]="stageLabel(s.id) + ' on'" /></td>
                  <td>
                    <select [ngModel]="s.agent || ''" (ngModelChange)="setStage(s.id, 'agent', $event || null)" [attr.aria-label]="stageLabel(s.id) + ' agent'">
                      <option value="">The item's agent</option>
                      <option value="claude">Claude Code</option>
                      <option value="copilot">Copilot</option>
                      <option value="codex">Codex</option>
                    </select>
                  </td>
                  <td><input [ngModel]="s.model || ''" (ngModelChange)="setStage(s.id, 'model', $event || null)" placeholder="Default" [attr.aria-label]="stageLabel(s.id) + ' model'" /></td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Security stage</h2></div>
          <div class="body">
            <label class="chk"><input type="checkbox" [ngModel]="c.security.agentReview" (ngModelChange)="setSecurity('agentReview', $event)" /> An agent reviews the diff for security problems</label>
            <label class="chk"><input type="checkbox" [ngModel]="c.security.secretScan" (ngModelChange)="setSecurity('secretScan', $event)" /> Scan the diff for secrets (gitleaks, when installed)</label>
            <label class="field narrow">Fail the stage at
              <select [ngModel]="c.security.failOn" (ngModelChange)="setSecurity('failOn', $event)">
                @for (s of severities; track s) { <option [value]="s">{{ s }} or worse</option> }
              </select>
            </label>
            <h3>Scanners</h3>
            <p class="h">Each runs in the repos that have its file at their root (empty: every repo).</p>
            <table class="scanners">
              <thead><tr><th>Name</th><th>Command</th><th>Only where</th><th>Fails at</th><th></th></tr></thead>
              <tbody>
                @for (s of c.security.scanners; track $index; let i = $index) {
                  <tr>
                    <td><input [ngModel]="s.name" (ngModelChange)="setScanner(i, 'name', $event)" aria-label="Scanner name" /></td>
                    <td><input class="mono" [ngModel]="s.command" (ngModelChange)="setScanner(i, 'command', $event)" aria-label="Scanner command" /></td>
                    <td><input class="mono" [ngModel]="s.when || ''" (ngModelChange)="setScanner(i, 'when', $event || null)" placeholder="Every repo" aria-label="Only in repos with this file" /></td>
                    <td><select [ngModel]="s.failOn" (ngModelChange)="setScanner(i, 'failOn', $event)" aria-label="Fails at">@for (v of severities; track v) { <option [value]="v">{{ v }}</option> }</select></td>
                    <td><button class="btn ghost sm" type="button" (click)="removeScanner(i)" aria-label="Remove scanner">Remove</button></td>
                  </tr>
                }
              </tbody>
            </table>
            <div class="adds">
              @for (s of missingSuggested(); track s.command) {
                <button class="btn sm" type="button" (click)="addScanner(s)">+ {{ s.name }}</button>
              }
              <button class="btn ghost sm" type="button" (click)="addScanner(null)">+ Another scanner</button>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Gates</h2></div>
          <div class="rows">
            @for (g of gateIds; track g) {
              <div class="row">
                <div><div class="t">{{ gateLabel(g) }}</div><div class="h">{{ gateHelp[g] }}</div></div>
                <select [ngModel]="c.gates[g]" (ngModelChange)="setGate(g, $event)" [attr.aria-label]="gateLabel(g)">
                  <option value="human">A person decides</option>
                  <option value="approver">The Approver decides</option>
                  <option value="auto">Passes when its checks pass</option>
                  <option value="off">No gate</option>
                </select>
              </div>
            }
          </div>
          <div class="body grid">
            <label class="field">Required checks
              <textarea rows="2" [ngModel]="c.requiredChecks.join('\\n')" (ngModelChange)="setChecks($event)" [ngModelOptions]="{ updateOn: 'blur' }" placeholder="CI check names or commands, one per line"></textarea>
              <span class="h">Must be green before a gate can pass.</span>
            </label>
            <label class="field">Review bots that count
              <input [ngModel]="c.reviewers.bots.join(', ')" (ngModelChange)="setBots($event)" [ngModelOptions]="{ updateOn: 'blur' }" placeholder="e.g. copilot-pull-request-reviewer" />
              <label class="chk"><input type="checkbox" [ngModel]="c.reviewers.pipeline" (ngModelChange)="setReviewers('pipeline', $event)" /> The pipeline's reviewer agent counts</label>
              <label class="chk"><input type="checkbox" [ngModel]="c.reviewers.noUnresolved" (ngModelChange)="setReviewers('noUnresolved', $event)" /> Only with no unresolved threads</label>
            </label>
          </div>
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Spec readiness</h2><span class="ty">the spec gate</span></div>
          <div class="body">
            <p class="h">When an agent session reads a ticket, it scores how ready the ticket is to start on (0-100), from what any good spec has, under whatever headings your team uses. The levels and weights are yours.</p>
            <div class="grid3">
              <label class="field">Ready at <input type="number" min="1" max="100" [ngModel]="c.spec.readyAt" (ngModelChange)="setSpec('readyAt', $event)" /></label>
              <label class="field">Needs work from <input type="number" min="0" max="100" [ngModel]="c.spec.needsWorkAt" (ngModelChange)="setSpec('needsWorkAt', $event)" /></label>
              <label class="field">Unattended runs need <input type="number" min="0" max="100" [ngModel]="c.spec.minScore" (ngModelChange)="setSpec('minScore', $event)" placeholder="Advice only" /></label>
            </div>
            <p class="h">Below "Needs work from" is Not ready. With a minimum for unattended runs, an autonomous run below it stops and says on the ticket what's missing.</p>
            <table class="weights">
              <thead><tr><th>Check</th><th>Looks for</th><th>Weight</th></tr></thead>
              <tbody>
                @for (k of specChecks(); track k.id) {
                  <tr [class.off]="weight(k.id) === 0">
                    <td>{{ k.label }}</td><td class="h">{{ k.help }}</td>
                    <td><input type="number" min="0" max="100" [ngModel]="c.spec.weights[k.id] ?? null" (ngModelChange)="setWeight(k.id, $event)" [placeholder]="'' + k.weight" [attr.aria-label]="k.label + ' weight'" /></td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="h">Weights are relative (0 turns a check off; empty keeps the default).</p>
          </div>
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Approver</h2><span class="ty">{{ c.approver.enabled && c.approver.enforce ? 'decides its gates' : 'advisory' }}</span></div>
          <div class="body">
            <p class="h">An agent that rates each change's risk so people spend time on the risky ones. The risk rules below come first (any match means not low risk); then it judges the rest, conservatively. Leave it advisory until its calls match yours: each ticket shows what it would have done.</p>
            <label class="chk"><input type="checkbox" [ngModel]="c.approver.enabled" (ngModelChange)="setApprover('enabled', $event)" /> On</label>
            <label class="chk"><input type="checkbox" [ngModel]="c.approver.enforce" (ngModelChange)="setApprover('enforce', $event)" [disabled]="!c.approver.enabled" /> Let it decide the gates set to the Approver (approve, and merge as below)</label>
            <div class="grid">
              <label class="field">Acts as (code-host account)
                <input type="text" placeholder="e.g. acme-approver-bot" [ngModel]="c.approver.identity || ''" (ngModelChange)="setApprover('identity', $event.trim() || null)" [ngModelOptions]="{ updateOn: 'blur' }" />
                <span class="faint">It refuses to act as anyone else, and never approves a PR this account wrote.</span>
              </label>
              <label class="field">Always high risk (paths)
                <textarea rows="3" class="mono" [ngModel]="c.approver.highRiskPaths.join('\\n')" (ngModelChange)="setRiskPaths($event)" [ngModelOptions]="{ updateOn: 'blur' }"></textarea>
              </label>
              <label class="field">Always high risk (ticket labels)
                <textarea rows="2" [ngModel]="c.approver.highRiskLabels.join('\\n')" (ngModelChange)="setRiskLabels($event)" [ngModelOptions]="{ updateOn: 'blur' }"></textarea>
              </label>
              <div class="grid3">
                <label class="field">Max files <input type="number" min="1" [ngModel]="c.approver.maxFiles" (ngModelChange)="setApprover('maxFiles', +$event)" /></label>
                <label class="field">Max lines <input type="number" min="1" [ngModel]="c.approver.maxLines" (ngModelChange)="setApprover('maxLines', +$event)" /></label>
                <label class="field">Max repos <input type="number" min="1" [ngModel]="c.approver.maxRepos" (ngModelChange)="setApprover('maxRepos', +$event)" /></label>
              </div>
              <label class="field">When it approves
                <select [ngModel]="c.approver.mergeAction" (ngModelChange)="setApprover('mergeAction', $event)">
                  <option value="none">Approve only; a person merges</option>
                  <option value="auto-merge">Turn on auto-merge</option>
                  <option value="merge">Merge now</option>
                </select>
              </label>
              <label class="field">Merge method
                <select [ngModel]="c.approver.mergeMethod" (ngModelChange)="setApprover('mergeMethod', $event)">
                  <option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option>
                </select>
              </label>
              <label class="field">Send to a person anyway (%)
                <input type="number" min="0" max="100" [ngModel]="c.approver.samplingPct" (ngModelChange)="setApprover('samplingPct', +$event)" />
              </label>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Notifications</h2></div>
          <div class="body">
            <p class="h">When a ticket needs someone: a gate waiting on a person, a stage that failed twice, a budget reached, a ticket stopped (and, if you ask, PRs merged).</p>
            <label class="chk"><input type="checkbox" [ngModel]="c.notifications.inbox" (ngModelChange)="setInboxNotices($event)" /> On Home → Needs you</label>
            @for (w of c.notifications.webhooks; track $index; let i = $index) {
              <div class="hook">
                <input type="text" class="mono" placeholder="$FACTORY_WEBHOOK (an env variable on each machine), or https://…" [ngModel]="w.env ? '$' + w.env : (w.url || '')" (ngModelChange)="setHook(i, $event)" [ngModelOptions]="{ updateOn: 'blur' }" aria-label="Webhook address, or an environment variable that holds it" />
                <div class="evs">
                  @for (e of noticeEvents; track e.id) {
                    <label class="chk"><input type="checkbox" [ngModel]="w.events.includes(e.id)" (ngModelChange)="toggleHookEvent(i, e.id, $event)" /> {{ e.label }}</label>
                  }
                  <button class="linkish" type="button" (click)="removeHook(i)">Remove</button>
                </div>
              </div>
            }
            <button class="btn sm" type="button" (click)="addHook()" [disabled]="c.notifications.webhooks.length >= 10">Add a webhook</button>
            <span class="h">Each new one is posted as JSON with a <code>text</code> (Slack-compatible), once, from the dashboard of whoever's machine runs it. A webhook's address is a secret and this policy is committed: name an environment variable (<code>$NAME</code>) set on each machine instead.</span>
          </div>
        </div>
      </fieldset>

      <div class="savebar">
        @if (saveErr()) { <span class="err-note">{{ saveErr() }}</span> }
        @else if (dirty()) { <span class="faint">Unsaved changes</span> }
        @else if (state()?.exists) { <span class="faint">Saved in factory.json</span> }
        @else { <span class="faint">No factory.json yet: these are the defaults.</span> }
        <button class="btn ghost sm" type="button" (click)="discard()" [disabled]="!dirty() || saving()">Discard</button>
        <button class="btn primary sm" type="button" (click)="save()" [disabled]="!dirty() || saving() || !state()?.canEdit">{{ saving() ? 'Saving…' : 'Save' }}</button>
      </div>
    }
  `,
  styles: [`
    :host { display: block; max-width: 960px; padding-bottom: 72px; }
    fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
    .panel { margin-bottom: 16px; }
    .panel-h { display: flex; align-items: center; gap: 12px; }
    .panel-h .chk { margin-left: auto; }
    .body { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px 20px; }
    .grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; font-weight: 600; color: var(--ink-soft); }
    .field.narrow { max-width: 240px; }
    .field input, .field select, .field textarea, td input, td select, .row select { font: inherit; font-size: 13px; font-weight: 400; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); min-width: 0; }
    .chk { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink); font-weight: 400; }
    .h { font-size: 12px; color: var(--ink-faint); font-weight: 400; line-height: 1.45; margin: 0; }
    h3 { margin: 6px 0 0; font-size: 13px; }
    .mono { font-family: var(--font-mono); }
    .faint { color: var(--ink-faint); font-size: 12.5px; }
    .presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
    .preset { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: #fff; font: inherit; cursor: pointer; }
    .preset.ro { cursor: default; border-style: dashed; }
    .preset b { font-size: 13.5px; color: var(--ink); }
    .preset span { font-size: 12px; color: var(--ink-soft); line-height: 1.4; }
    .preset.on { border-color: var(--brand-700); box-shadow: inset 0 0 0 1px var(--brand-700); }
    .flow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 12px; }
    .flow .col { padding: 2px 8px; border-radius: 6px; background: var(--paper-2); color: var(--ink-soft); }
    .flow .col.gate { background: var(--yellow-bg); color: var(--yellow); }
    .flow .arrow { color: var(--ink-faint); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint); font-weight: 600; padding: 6px 8px; }
    td { padding: 6px 8px; border-top: 1px solid var(--line-soft); vertical-align: top; }
    .stages td:first-child { width: 45%; }
    tr.off td:first-child { color: var(--ink-faint); }
    .scanners td input { width: 100%; box-sizing: border-box; }
    .adds { display: flex; flex-wrap: wrap; gap: 6px; }
    .weights td input { width: 80px; }
    .rows { display: flex; flex-direction: column; }
    .row { display: grid; grid-template-columns: 1fr 240px; gap: 8px 24px; padding: 12px 16px; border-bottom: 1px solid var(--line-soft); align-items: start; }
    .t { font-weight: 600; font-size: 14px; color: var(--ink); }
    @media (max-width: 700px) { .row { grid-template-columns: 1fr; } .grid3 { grid-template-columns: 1fr; } .stages td:first-child { width: auto; } }
    .savebar { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 10px 16px; background: var(--paper); border-top: 1px solid var(--line); }
  `],
})
export class FactorySettingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly state = signal<FactoryConfigState | null>(null);
  readonly draft = signal<FactoryConfig | null>(null);
  readonly loadErr = signal<string | null>(null);
  readonly saveErr = signal<string | null>(null);
  readonly saving = signal(false);

  readonly gateIds = GATE_IDS;
  readonly gateHelp = GATE_HELP;
  readonly severities: Severity[] = ['critical', 'high', 'medium', 'low'];
  readonly stageHelp: Record<FactoryStageId, string> = {
    align: 'Interview the requester when a ticket is vague.',
    plan: 'Research the code and write the plan.',
    build: 'Write the code, test first where it applies.',
    review: 'An adversarial review of each repo that changed.',
    security: 'Scanners and an agent security review of the diff.',
    qa: 'Drive the app in a browser for UI changes.',
    guide: 'Write the guided review for the people who review the PR.',
    pr: 'Commit and open the PRs.',
    approve: 'The Approver rates the risk.',
    merge: 'Merge once the merge gate passes.',
  };

  readonly dirty = computed(() => {
    const s = this.state();
    const d = this.draft();
    return !!s && !!d && JSON.stringify(s.config) !== JSON.stringify(d);
  });
  readonly steps = computed(() => (this.draft() ? pipelineSteps(this.draft()!) : []));
  readonly presetList = computed(() => Object.entries(this.state()?.presets || {}).map(([id, p]) => ({ id: id as Exclude<FactoryPreset, 'custom'>, label: p.label, description: p.description })));
  readonly specChecks = computed(() => this.state()?.specChecks || []);
  readonly missingSuggested = computed(() => {
    const have = new Set((this.draft()?.security.scanners || []).map((s) => s.command));
    return (this.state()?.suggestedScanners || []).filter((s) => !have.has(s.command));
  });

  ngOnInit(): void { this.load(); }

  async load(): Promise<void> {
    try {
      const s = await this.api.get<FactoryConfigState>('/api/factory/config');
      this.state.set(s);
      this.draft.set(structuredClone(s.config));
      this.loadErr.set(null);
    } catch (e) { this.loadErr.set((e as Error).message); }
  }

  stageLabel(id: FactoryStageId): string { return this.state()?.stageLabels[id] || id; }
  gateLabel(id: FactoryGateId): string { return this.state()?.gateLabels[id] || id; }

  /** Applies a change to the draft and works out which preset it now matches. */
  private edit(fn: (c: FactoryConfig) => void): void {
    const c = this.draft();
    if (!c) return;
    const next = structuredClone(c);
    fn(next);
    next.preset = matchingPreset(next, this.state()?.presets || {});
    this.draft.set(next);
    this.saveErr.set(null);
  }

  applyPreset(id: Exclude<FactoryPreset, 'custom'>): void {
    const c = this.draft();
    if (c) this.draft.set(withPreset(c, id, this.state()!.presets));
  }

  set(key: 'enabled' | 'mode', v: any): void { this.edit((c) => { (c as any)[key] = v; }); }
  setList(key: 'states' | 'labels', text: string): void { this.edit((c) => { c.intake[key] = splitList(text); }); }
  setIntake(key: 'auto' | 'everyMinutes' | 'unassigned', v: boolean | number): void { this.edit((c) => { (c.intake as any)[key] = v; }); }
  setLimit(key: keyof FactoryConfig['limits'], v: unknown): void {
    this.edit((c) => { if (key === 'wip') c.limits.wip = Math.max(1, Math.round(numOrNull(v) ?? 1)); else c.limits[key] = numOrNull(v); });
  }
  setStage(id: FactoryStageId, key: 'on' | 'agent' | 'model', v: any): void {
    this.edit((c) => { const s = c.stages.find((x) => x.id === id); if (s) (s as any)[key] = key === 'agent' ? (v as AgentId | null) : v; });
  }
  setSecurity(key: 'agentReview' | 'secretScan' | 'failOn', v: any): void { this.edit((c) => { (c.security as any)[key] = v; }); }
  setScanner(i: number, key: keyof FactoryScanner, v: any): void { this.edit((c) => { (c.security.scanners[i] as any)[key] = v as Severity; }); }
  addScanner(s: FactoryScanner | null): void { this.edit((c) => { c.security.scanners.push(s ? { ...s } : { name: '', command: '', when: null, failOn: 'high' }); }); }
  removeScanner(i: number): void { this.edit((c) => { c.security.scanners.splice(i, 1); }); }
  setGate(id: FactoryGateId, v: FactoryGateMode): void { this.edit((c) => { c.gates[id] = v; }); }
  setChecks(text: string): void { this.edit((c) => { c.requiredChecks = splitLines(text); }); }
  setBots(text: string): void { this.edit((c) => { c.reviewers.bots = splitList(text); }); }
  setReviewers(key: 'pipeline' | 'noUnresolved', v: boolean): void { this.edit((c) => { c.reviewers[key] = v; }); }
  setRiskPaths(text: string): void { this.edit((c) => { c.approver.highRiskPaths = splitLines(text); }); }
  readonly noticeEvents: { id: FactoryNoticeEvent; label: string }[] = [
    { id: 'gate-waiting', label: 'Gate waiting' }, { id: 'stage-failed', label: 'Stage failed twice' }, { id: 'budget', label: 'Budget reached' },
    { id: 'stopped', label: 'Stopped' }, { id: 'merged', label: 'Merged' },
  ];
  setInboxNotices(on: boolean): void { this.edit((c) => { c.notifications.inbox = on; }); }
  addHook(): void { this.edit((c) => { c.notifications.webhooks.push({ url: null, env: 'FACTORY_WEBHOOK', events: ['gate-waiting', 'stage-failed', 'budget', 'stopped'] }); }); }
  removeHook(i: number): void { this.edit((c) => { c.notifications.webhooks.splice(i, 1); }); }
  /** "$NAME": the address is in that environment variable on each machine; else the address itself. */
  setHook(i: number, v: string): void {
    const t = v.trim();
    this.edit((c) => { const w = c.notifications.webhooks[i]; if (t.startsWith('$')) { w.env = t.slice(1); w.url = null; } else { w.url = t; w.env = null; } });
  }
  toggleHookEvent(i: number, e: FactoryNoticeEvent, on: boolean): void {
    this.edit((c) => { const w = c.notifications.webhooks[i]; w.events = on ? [...new Set([...w.events, e])] : w.events.filter((x) => x !== e); });
  }
  setRiskLabels(text: string): void { this.edit((c) => { c.approver.highRiskLabels = splitLines(text); }); }
  setApprover(key: keyof FactoryConfig['approver'], v: any): void {
    this.edit((c) => { (c.approver as any)[key] = key === 'mergeMethod' ? (v as MergeMethod) : v; });
  }

  setSpec(key: 'readyAt' | 'needsWorkAt' | 'minScore', v: unknown): void {
    this.edit((c) => {
      const n = numOrNull(v);
      if (key === 'minScore') c.spec.minScore = n == null ? null : Math.round(Math.min(Math.max(n, 0), 100));
      else c.spec[key] = Math.round(Math.min(Math.max(n ?? 0, 0), 100));
    });
  }
  setWeight(id: SpecCheckId, v: unknown): void {
    this.edit((c) => { const n = numOrNull(v); if (n == null) delete c.spec.weights[id]; else c.spec.weights[id] = Math.round(Math.min(Math.max(n, 0), 100)); });
  }
  /** A check's weight: the team's, else the default. */
  weight(id: SpecCheckId): number {
    const w = this.draft()?.spec.weights[id];
    return w ?? this.specChecks().find((k) => k.id === id)?.weight ?? 0;
  }

  discard(): void {
    const s = this.state();
    if (s) this.draft.set(structuredClone(s.config));
    this.saveErr.set(null);
  }

  async save(): Promise<void> {
    const s = this.state();
    const d = this.draft();
    if (!s || !d) return;
    this.saving.set(true);
    this.saveErr.set(null);
    try {
      // Blank scanner rows are dropped by the server; send what's typed.
      const saved = await this.api.post<FactoryConfigState>('/api/factory/config', { config: d, mtimeMs: s.mtimeMs });
      this.state.set(saved);
      this.draft.set(structuredClone(saved.config));
      this.toast.show('Factory policy saved. Commit .claude/dashboard/factory.json so the team gets it.');
    } catch (e) {
      this.saveErr.set((e as Error).message);
    } finally {
      this.saving.set(false);
    }
  }
}

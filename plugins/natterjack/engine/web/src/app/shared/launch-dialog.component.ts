import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import type { AgentId, LaunchRequest, Preset, RunMeta } from '../../../../shared/api';
import { defaultsFor } from '../core/agents';
import { ApiService } from '../core/api.service';
import { DataService } from '../core/data.service';
import { LaunchService, type LaunchOptions } from '../core/launch.service';
import { ToastService } from '../core/toast.service';
import { AgentFieldsComponent } from './agent-fields.component';
import { AttachComponent } from './attach.component';
import { SlashInputComponent } from './slash-input.component';

const PERM_LABELS: Record<string, string> = {
  auto: 'auto (classifier decides)', acceptEdits: 'acceptEdits', dontAsk: 'dontAsk (allowlist only)', plan: 'plan (read-only)',
};

/** The one dialog every "start a run" button goes through. */
@Component({
  selector: 'dash-launch-dialog',
  imports: [SlashInputComponent, AttachComponent, AgentFieldsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (req(); as r) {
      <div class="modal" (mousedown)="onBackdrop($event)">
        <form class="modal-card" (submit)="$event.preventDefault(); submit()" (keydown.escape)="close()"
          (paste)="att.paste($event)" (dragover)="att.dragOver($event)" (drop)="att.drop($event)">
          <h3>{{ r.title || preset()?.label || 'Ad-hoc run' }}</h3>
          <div class="desc">{{ preset() ? (preset()!.description || '') : 'Runs headless in the chosen workspace with the settings below. You can reply to it afterwards.' }}</div>
          <div class="form">
            @for (a of preset()?.args || []; track a.name; let first = $first) {
              <label class="full">{{ a.label || a.name }}
                <input [value]="args()[a.name] || ''" [placeholder]="a.placeholder || ''" autocomplete="off"
                  (input)="setArg(a.name, $any($event.target).value)" [attr.data-first]="first ? '1' : null">
              </label>
            }
            @for (o of preset()?.options || []; track o.name) {
              <label class="chk full opt" [title]="o.hint || ''">
                <input type="checkbox" [checked]="!!opts()[o.name]" (change)="setOpt(o.name, $any($event.target).checked)"> {{ o.label }}
                @if (o.hint) { <span class="opt-hint">{{ o.hint }}</span> }
              </label>
            }
            <label class="full">Workspace
              <select [value]="ws()" (change)="ws.set($any($event.target).value)">
                @for (w of deck()?.workspaces || []; track w.slug) {
                  <option [value]="w.slug" [selected]="w.slug === ws()">{{ w.name }}{{ w.ticketId ? ' (' + w.ticketId + ')' : '' }}</option>
                }
              </select>
            </label>
            <dash-agent-fields [(agent)]="agent" [(modelId)]="model" [(effort)]="effort" [(touched)]="touched" />
            @if (agent() === 'claude') {
            <label>Permissions
              <select (change)="perm.set($any($event.target).value)" [disabled]="planMode()">
                @for (p of permModes(); track p) { <option [value]="p" [selected]="p === perm()">{{ permLabel(p) }}</option> }
              </select>
            </label>
            }
            @if (capOn() && agent() === 'claude') {
              <label title="Claude stops when the run's API-equivalent cost passes this. On a subscription nothing is billed. Turn the cap off in Settings.">Runaway cap (API $)
                <input type="number" min="0.5" max="100" step="0.5" [value]="budget()" (input)="budget.set(+$any($event.target).value)">
              </label>
            }
            <label class="chk full" title="Claude can read and answer but not change anything. You can switch it off from the run page later.">
              <input type="checkbox" [checked]="planMode()" (change)="planMode.set($any($event.target).checked)"> Plan mode (read-only) — switch off later from the run if it needs to make changes
            </label>
            @for (s of docSources(); track s.key) {
              <label class="chk full" [title]="'Tells Claude to search ' + s.name + ' through its connector and cite the pages it uses'">
                <input type="checkbox" [checked]="useDocs().has(s.key)" (change)="toggleDocs(s.key, $any($event.target).checked)"> Use {{ s.name }}
              </label>
            }
            <label class="full">Prompt
              <dash-slash-input #promptBox [multiline]="true" [rows]="5" [readonly]="!!preset()" [value]="promptText()" (valueChange)="prompt.set($event)" />
            </label>
            <div class="full"><dash-attach #att /></div>
            <div class="warn-note full">Runs headless. Anything that would need your approval is denied, but Claude can ask you questions and you can reply from the run page. Draws on your subscription usage.</div>
          </div>
          <div class="form-foot">
            <span class="form-err">{{ error() }}</span>
            <span style="display:flex;gap:0.4rem">
              <button class="btn ghost" type="button" (click)="close()">Cancel</button>
              <button class="btn primary" type="submit" [disabled]="busy() || att.uploading()">Launch</button>
            </span>
          </div>
        </form>
      </div>
    }
  `,
})
export class LaunchDialogComponent {
  private readonly launch = inject(LaunchService);
  private readonly data = inject(DataService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly req = this.launch.request;
  readonly deck = this.data.deck;
  readonly preset = computed<Preset | null>(() => {
    const r = this.req();
    return (r && r.presetId && this.deck()?.presets.find((p) => p.id === r.presetId)) || null;
  });
  readonly permModes = computed(() => this.deck()?.options.permissionModes || ['auto', 'acceptEdits', 'dontAsk', 'plan']);
  /** The per-run cap only exists when it's turned on in Settings. */
  readonly capOn = computed(() => !!this.deck()?.limits?.runBudget);
  private readonly att = viewChild<AttachComponent>('att');

  readonly args = signal<Record<string, string>>({});
  readonly opts = signal<Record<string, boolean>>({});
  readonly ws = signal('main');
  readonly agent = signal<AgentId>('claude');
  readonly model = signal('');
  readonly effort = signal('');
  readonly perm = signal('auto');
  readonly budget = signal(5);
  readonly planMode = signal(false);
  /** Searchable docs sources (Confluence, …) a run can be told to use. */
  readonly docSources = computed(() => this.data.docSites().filter((s) => s.searchable));
  readonly useDocs = signal<ReadonlySet<string>>(new Set());
  readonly prompt = signal('');
  readonly touched = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);
  private readonly promptBox = viewChild<SlashInputComponent>('promptBox');

  /** Preset prompt with its {args} filled in as you type them. */
  readonly promptText = computed(() => {
    const p = this.preset();
    if (!p) return this.prompt();
    let text = p.prompt;
    for (const a of p.args || []) text = text.split('{' + a.name + '}').join(this.args()[a.name] || '{' + a.name + '}');
    for (const o of p.options || []) if (this.opts()[o.name] && o.append) text += o.append;
    return text;
  });

  constructor() {
    // Re-initialise the fields each time the dialog opens.
    // Only when the dialog opens: a deck refresh must not reset what you've typed.
    effect(() => {
      const r = this.req();
      if (r) untracked(() => this.init(r));
    });
  }

  private init(r: LaunchOptions): void {
    {
      const p = r.presetId ? this.data.deck()?.presets.find((x) => x.id === r.presetId) : null;
      this.args.set({ ...(r.prefill || {}) });
      this.opts.set(Object.fromEntries((p?.options || []).map((o) => [o.name, r.options?.[o.name] ?? !!o.default])));
      this.ws.set(r.workspace || (p && p.workspace) || 'main');
      // The agent picked last (or the caller's / preset's), and its default model/effort unless one is set; a change here is for this run only.
      const agent = (r.agent || (p as any)?.agent || this.launch.agent()) as AgentId;
      this.agent.set(agent);
      const d = defaultsFor((this.data.agents() || []).find((a) => a.id === agent) || null, { model: this.launch.model(), effort: this.launch.effort() });
      this.model.set(r.model || (p && p.model) || d.model);
      this.effort.set(r.effort || (p && p.effort) || d.effort);
      this.perm.set((p && p.permissionMode) || 'auto');
      this.budget.set((p && p.budgetUsd) || 5);
      this.planMode.set(!!r.planMode);
      this.useDocs.set(new Set(r.docSources || []));
      if (!this.data.docSites().length) this.data.loadDocs();
      this.prompt.set(r.prompt || '');
      this.touched.set(false);
      this.error.set('');
      this.busy.set(false);
      this.att()?.clear();
      setTimeout(() => {
        const first = document.querySelector<HTMLInputElement>('dash-launch-dialog [data-first]');
        if (r.focusPrompt || (!p && !first)) this.promptBox()?.focus();
        else if (r.prefill) document.querySelector<HTMLButtonElement>('dash-launch-dialog button[type=submit]')?.focus();
        else first?.focus();
      }, 30);
    }
  }

  permLabel(p: string): string { return PERM_LABELS[p] || p; }
  setArg(name: string, v: string): void { this.args.set({ ...this.args(), [name]: v }); }
  setOpt(name: string, on: boolean): void { this.opts.set({ ...this.opts(), [name]: on }); }
  toggleDocs(key: string, on: boolean): void { const s = new Set(this.useDocs()); if (on) s.add(key); else s.delete(key); this.useDocs.set(s); }
/** Close on a press on the backdrop itself. Returns nothing: a `false` from a template handler would preventDefault every press inside the dialog. */
  onBackdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.close(); }
  close(): void { this.launch.close(); }

  async submit(): Promise<void> {
    const r = this.req();
    if (!r) return;
    const p = this.preset();
    const body: LaunchRequest = {
      workspace: this.ws(),
      agent: this.agent(),
      model: this.model(),
      effort: this.effort() as LaunchRequest['effort'],
      permissionMode: this.perm() as LaunchRequest['permissionMode'],
      planMode: this.planMode(),
      trigger: r.trigger,
      attachments: this.att()?.ids() || [],
    };
    const docs = [...this.useDocs()].filter((k) => this.docSources().some((s) => s.key === k));
    if (docs.length) { body.docSources = docs; if (r.docPage && docs.length === 1) body.docPage = r.docPage; }
    if (this.capOn() && this.agent() === 'claude') body.budgetUsd = Number(this.budget()) || 5;
    if (this.att()?.uploading()) { this.error.set('Wait for the files to finish uploading.'); return; }
    if (p) {
      body.presetId = p.id;
      body.args = Object.fromEntries(Object.entries(this.args()).map(([k, v]) => [k, v.trim()]));
      body.options = { ...this.opts() };
    } else {
      body.prompt = this.prompt();
      if (!body.prompt.trim()) { this.error.set('Prompt is empty.'); return; }
    }
    this.busy.set(true);
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs', body);
      this.close();
      this.toast.show('Started: ' + res.run.label);
      this.data.upsertRun(res.run);
      this.data.loadRuns();
      this.router.navigate(['/runs', res.run.id]);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}

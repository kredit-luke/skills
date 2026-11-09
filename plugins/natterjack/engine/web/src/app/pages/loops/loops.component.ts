import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { RoutineInput, RoutineView, RoutinesResponse, RunMeta } from '../../../../../shared/api';
import { DAY_KEYS } from '../../../../../shared/loops';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { type RoutineDraft, blankDraft, draftFrom, draftToInput, lastSummary, watchKindLabel, watchWhat, watching } from './loops.util';

/**
 * Loops: everything that wakes Claude by itself. Routines start a run on a schedule (the
 * team's from deck.json, your own from .claude/ledger/routines.json); run loops are runs
 * that watch something (a <<WATCH>> block: PRs, an interval, a command) and resume when
 * it's time. ?new=1 opens the form, ?fromRun=<id> fills it from a run (Make this a routine).
 */
@Component({
  selector: 'dash-loops',
  imports: [FormsModule, PageHeaderComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './loops.component.scss',
  template: `
    <dash-page-header eyebrow="Agents" title="Loops"
      sub="What wakes Claude by itself: routines start a run on a schedule, and run loops resume a run when what it watches changes or its interval comes round." />

    <div class="panel">
      <div class="panel-h">
        <h2>Routines</h2>
        @if (!draft()) { <button class="btn sm primary" (click)="openNew()">New routine</button> }
      </div>
      @if (draft(); as d) {
        <form class="form routine-form" (ngSubmit)="save()">
          <label class="full">Name
            <input name="label" [(ngModel)]="d.label" placeholder="Morning brief" maxlength="80" />
          </label>
          <div class="full field">
            <span class="fl">What it runs</span>
            <div class="seg">
              <button type="button" [class.on]="d.what === 'prompt'" (click)="d.what = 'prompt'; touch()">A prompt</button>
              <button type="button" [class.on]="d.what === 'preset'" (click)="d.what = 'preset'; touch()" [disabled]="!presets().length">A skill card</button>
            </div>
          </div>
          @if (d.what === 'prompt') {
            <label class="full">Prompt
              <textarea name="prompt" rows="4" [(ngModel)]="d.prompt" placeholder="What each run does, in full: Claude starts with only this."></textarea>
            </label>
          } @else {
            <label>Skill card
              <select name="preset" [(ngModel)]="d.preset" (ngModelChange)="touch()">
                <option value="" disabled>Pick one</option>
                @for (p of presets(); track p.id) { <option [value]="p.id">{{ p.label }}</option> }
              </select>
            </label>
            @for (a of presetArgs(); track a.name) {
              <label>{{ a.label || a.name }}
                <input [name]="'arg-' + a.name" [(ngModel)]="d.args[a.name]" [placeholder]="a.placeholder || ''" />
              </label>
            }
          }
          <div class="full field">
            <span class="fl">When</span>
            <div class="seg">
              <button type="button" [class.on]="d.when === 'at'" (click)="d.when = 'at'; touch()">At a time</button>
              <button type="button" [class.on]="d.when === 'every'" (click)="d.when = 'every'; touch()">On an interval</button>
            </div>
          </div>
          @if (d.when === 'at') {
            <label>Time <input type="time" name="at" [(ngModel)]="d.at" required /></label>
          } @else {
            <label>Every <input name="every" [(ngModel)]="d.every" placeholder="2h, 30m" required /></label>
            <div class="field">
              <label class="chk"><input type="checkbox" name="between" [(ngModel)]="d.between" /> Only between</label>
              @if (d.between) {
                <span class="window"><input type="time" name="from" [(ngModel)]="d.from" /> – <input type="time" name="to" [(ngModel)]="d.to" /></span>
              }
            </div>
          }
          <label [class.full]="d.when === 'every'">Days
            <select name="days" [(ngModel)]="d.days" (ngModelChange)="touch()">
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekends">Weekends</option>
              <option value="custom">Pick days</option>
            </select>
          </label>
          @if (d.days === 'custom') {
            <div class="full days">
              @for (k of dayKeys; track k) {
                <label class="chk"><input type="checkbox" [checked]="d.custom.includes(k)" (change)="toggleDay(k)" /> {{ k }}</label>
              }
            </div>
          }
          <label>Each time
            <select name="mode" [(ngModel)]="d.mode">
              <option value="fresh">Start a new run</option>
              <option value="continue">Continue the last run</option>
            </select>
          </label>
          <label>Workspace
            <select name="workspace" [(ngModel)]="d.workspace">
              @for (w of workspaces(); track w.slug) { <option [value]="w.slug">{{ w.name }}</option> }
            </select>
          </label>
          <label>Model
            <select name="model" [(ngModel)]="d.model">
              <option value="">Default ({{ data.deck()?.defaults?.model }})</option>
              @for (m of models(); track m) { <option [value]="m">{{ m }}</option> }
            </select>
          </label>
          <label>Effort
            <select name="effort" [(ngModel)]="d.effort">
              <option value="">Default ({{ data.deck()?.defaults?.effort }})</option>
              @for (e of efforts(); track e) { <option [value]="e">{{ e }}</option> }
            </select>
          </label>
          @if (d.when === 'at') {
            <label>Catch up within (minutes)
              <input type="number" name="catchUp" min="0" max="1440" [(ngModel)]="d.catchUp" placeholder="10" />
            </label>
          }
          <p class="full note">
            A run that's still working or waiting on your answer when the next one is due makes that one skip.
            @if (d.when === 'at') { If the dashboard was off or asleep at the time, it runs when it's back, within the catch-up time. }
            @else { A slot missed while the dashboard was off or asleep runs once when it's back. }
          </p>
          <div class="full form-foot">
            <span class="form-err">{{ formError() }}</span>
            <span class="acts">
              <button type="button" class="btn sm ghost" (click)="cancel()">Cancel</button>
              <button type="submit" class="btn sm primary" [disabled]="saving()">{{ d.id ? 'Save' : 'Create routine' }}</button>
            </span>
          </div>
        </form>
      }
      <div class="rows">
        @for (r of routines(); track r.id) {
          <div class="routine-row" [class.off]="!r.enabled">
            <div class="main">
              <div class="t">
                {{ r.label || r.id }}
                <span class="tag" [class.routine]="r.source === 'team'">{{ r.source === 'team' ? 'team' : 'yours' }}</span>
                @if (r.mode === 'continue') { <span class="tag">continues</span> }
                @if (r.overridden) { <span class="tag amber">{{ r.enabled ? 'on for you' : 'off for you' }}</span> }
              </div>
              <div class="h">
                {{ r.schedule }}
                @if (r.enabled && r.nextAt) { · next {{ rel(r.nextAt) }} }
                @if (!r.enabled) { · off }
                · {{ r.preset ? 'skill card ' + r.preset : clip(r.prompt) }}
              </div>
              @if (r.problem) { <div class="h bad">Can't run: {{ r.problem }}</div> }
              @if (lastOf(r); as l) {
                <div class="h" [class.bad]="l.bad">
                  Last: {{ l.text }} {{ rel(r.last!.skipped && l.bad ? r.last!.skippedAt : r.last!.firedAt) }}
                  @if (r.last!.runId) { · <a [routerLink]="['/runs', r.last!.runId]">open the run</a> }
                </div>
              }
            </div>
            <div class="acts">
              <button class="btn sm" (click)="runNow(r)" [disabled]="!!r.problem || busy() === r.id">Run now</button>
              <button class="btn sm" (click)="setEnabled(r, !r.enabled)" [disabled]="busy() === r.id">{{ r.enabled ? 'Turn off' : 'Turn on' }}</button>
              @if (r.source === 'personal') {
                <button class="btn sm ghost" (click)="edit(r)">Edit</button>
                <button class="btn sm ghost danger" (click)="remove(r)" [disabled]="busy() === r.id">Delete</button>
              }
            </div>
          </div>
        } @empty {
          @if (data.routines() !== null) {
            <div class="empty">No routines yet. Create one here, ask Claude in any run to set one up, or use <b>Make this a routine</b> on a run's page.</div>
          } @else { <div class="empty">Loading…</div> }
        }
      </div>
      <div class="hint">Team routines are in <code>.claude/dashboard/deck.json</code> (<code>routines</code>); switching one off here only changes it for you. Yours are in <code>.claude/ledger/routines.json</code> on this machine.</div>
    </div>

    <div class="panel">
      <div class="panel-h"><h2>Run loops</h2></div>
      <div class="rows">
        @for (r of loops(); track r.id) {
          @let w = r.watch!;
          <div class="routine-row">
            <div class="main">
              <div class="t">
                <a [routerLink]="['/runs', r.id]">{{ r.label }}</a>
                <span class="tag">{{ kind(r) }}</span>
                @if (w.approval === 'pending') { <span class="tag amber">needs approval</span> }
              </div>
              <div class="h">{{ what(r) }}</div>
              @if (w.kind === 'check') { <div class="h mono cmd">{{ w.command }}</div> }
              <div class="h">
                @if (w.approval === 'pending') { Nothing runs until you approve the command. }
                @else if (r.status !== 'succeeded') { Paused while the run is {{ r.status === 'running' ? 'working' : r.status }}. }
                @else { Next {{ rel(w.nextCheckAt) }}. }
                @if (w.wakes) { Woken {{ w.wakes }}×. }
                @if (w.quiet) { {{ w.quiet }} quiet in a row. }
                @if (w.lastChange) { Last: {{ w.lastChange }} {{ rel(w.lastChangeAt) }}. }
                Ends {{ rel(w.expiresAt) }}.
              </div>
              @if (w.error) { <div class="h bad">{{ w.error }}</div> }
            </div>
            @if (!r.remote) {
              <div class="acts">
                @if (w.approval === 'pending') { <button class="btn sm primary" (click)="approve(r)" [disabled]="busy() === r.id">Approve</button> }
                <button class="btn sm" (click)="stopLoop(r)" [disabled]="busy() === r.id">Stop</button>
              </div>
            }
          </div>
        } @empty {
          <div class="empty">No run is watching anything. Ask Claude in a run to keep an eye on something (a PR, a deploy, a queue) or to repeat a task (<code>/loop 30m …</code>), and it shows here.</div>
        }
      </div>
    </div>
  `,
})
export class LoopsComponent implements OnInit {
  readonly data = inject(DataService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly dayKeys = DAY_KEYS;
  readonly draft = signal<RoutineDraft | null>(null);
  /** Bumped when the draft changes in a way the template branches on (it's edited in place). */
  private readonly version = signal(0);
  readonly formError = signal('');
  readonly saving = signal(false);
  readonly busy = signal<string | null>(null);

  readonly routines = computed(() => this.data.routines() || []);
  /**
   * Every run with a watch on: the routines topic's list (all of them, however old), each
   * replaced by its fresher copy from the runs feed when that has it, plus mirrored runs.
   */
  readonly loops = computed(() => {
    const byId = new Map(this.data.loopRuns().map((r) => [r.id, r]));
    for (const r of this.data.activityRuns()) if (byId.has(r.id) || watching(r)) byId.set(r.id, r);
    return [...byId.values()].filter(watching);
  });
  readonly presets = computed(() => this.data.deck()?.presets || []);
  readonly workspaces = computed(() => this.data.deck()?.workspaces || [{ slug: 'main', name: 'main' }]);
  readonly models = computed(() => this.data.deck()?.options?.models || []);
  readonly efforts = computed(() => this.data.deck()?.options?.efforts || []);
  readonly presetArgs = computed(() => {
    this.version();
    const d = this.draft();
    return d ? this.presets().find((p) => p.id === d.preset)?.args || [] : [];
  });

  ngOnInit(): void {
    this.data.loadRoutines();
    if (!this.data.deck()) this.data.loadDeck();
    const q = this.route.snapshot.queryParamMap;
    const fromRun = q.get('fromRun');
    if (fromRun) void this.fillFromRun(fromRun);
    else if (q.get('new')) this.openNew();
  }

  rel(t: string | null | undefined): string { return relTime(t); }
  clip(s: string | undefined): string { const t = (s || '').split('\n')[0]; return t.length > 90 ? t.slice(0, 90) + '…' : t; }
  lastOf(r: RoutineView) { return lastSummary(r); }
  kind(r: RunMeta): string { return watchKindLabel(r.watch!); }
  what(r: RunMeta): string { return watchWhat(r.watch!); }
  touch(): void { this.version.update((n) => n + 1); this.draft.set({ ...this.draft()! }); }

  openNew(): void {
    this.formError.set('');
    this.draft.set(blankDraft());
  }

  edit(r: RoutineView): void {
    this.formError.set('');
    this.draft.set(draftFrom(r));
  }

  cancel(): void {
    this.draft.set(null);
    this.formError.set('');
    if (this.route.snapshot.queryParamMap.keys.length) void this.router.navigate([], { queryParams: {} });
  }

  toggleDay(k: string): void {
    const d = this.draft()!;
    d.custom = d.custom.includes(k) ? d.custom.filter((x) => x !== k) : [...d.custom, k];
    this.touch();
  }

  /** Make this a routine: the run's first prompt, folder, model and effort, every weekday at 09:00 to start with. */
  private async fillFromRun(id: string): Promise<void> {
    let run = this.data.activityRuns().find((r) => r.id === id);
    if (!run) { try { run = (await this.api.get<{ run: RunMeta }>('/api/runs/' + id + '?events=0')).run; } catch { /* below */ } }
    if (!run) { this.toast.error('That run is gone.'); this.openNew(); return; }
    // A skill card's run repeats its prompt as it was filled in.
    this.draft.set(draftFrom({ label: run.label, prompt: run.prompt, workspace: run.workspace, model: run.model || undefined, effort: run.effort || undefined, at: '09:00', days: 'weekdays' }));
  }

  async save(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    this.formError.set('');
    this.saving.set(true);
    try {
      const routine: RoutineInput = draftToInput(d, this.presets());
      const res = await this.api.post<RoutinesResponse & { routine: { id: string } }>('/api/routines', { routine });
      this.data.applyRoutines(res);
      this.toast.show(d.id ? 'Routine saved' : 'Routine created');
      this.cancel();
    } catch (e) {
      this.formError.set((e as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  private async act(id: string, path: string, body: unknown, done: string): Promise<void> {
    this.busy.set(id);
    try {
      const res = await this.api.post<RoutinesResponse & { last?: { ok: boolean; runId?: string | null; error?: string | null } }>(path, body);
      this.data.applyRoutines(res);
      // Run now answers 200 with ok: false when nothing started (its runId is then the previous run's).
      if (res.last && !res.last.ok) { this.toast.error(`Didn't start: ${res.last.error || 'unknown error'}`); return; }
      this.toast.show(done);
      if (res.last?.runId) void this.router.navigate(['/runs', res.last.runId]);
    } catch (e) {
      this.toast.error((e as Error).message);
    } finally {
      this.busy.set(null);
    }
  }

  runNow(r: RoutineView): Promise<void> { return this.act(r.id, `/api/routines/${r.id}/run`, {}, `Started ${r.label || r.id}`); }
  setEnabled(r: RoutineView, on: boolean): Promise<void> {
    return this.act(r.id, `/api/routines/${r.id}/enabled`, { on }, on ? 'Turned on' : r.source === 'team' ? 'Turned off for you' : 'Turned off');
  }
  remove(r: RoutineView): Promise<void> {
    if (!confirm(`Delete the routine "${r.label || r.id}"? Its past runs stay.`)) return Promise.resolve();
    return this.act(r.id, `/api/routines/${r.id}/delete`, {}, 'Routine deleted');
  }

  private async runAction(r: RunMeta, action: 'watch-stop' | 'watch-approve', done: string): Promise<void> {
    this.busy.set(r.id);
    try {
      // Approve names the command shown here: the server refuses if a turn replaced it since.
      const body = action === 'watch-approve' ? { startedAt: r.watch?.startedAt, command: r.watch?.command } : undefined;
      await this.api.post<{ run: RunMeta }>(`/api/runs/${r.id}/${action}`, body);
      this.toast.show(done);
      this.data.loadRuns();
      this.data.loadRoutines();
    } catch (e) {
      this.toast.error((e as Error).message);
    } finally {
      this.busy.set(null);
    }
  }

  approve(r: RunMeta): Promise<void> { return this.runAction(r, 'watch-approve', 'Approved: the check runs now'); }
  stopLoop(r: RunMeta): Promise<void> { return this.runAction(r, 'watch-stop', 'Stopped'); }
}

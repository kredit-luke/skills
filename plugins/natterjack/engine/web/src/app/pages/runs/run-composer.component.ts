import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import type { Question, QueuedMessage, RunMeta } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { answerText } from '../../runs/answer';
import { AttachComponent } from '../../shared/attach.component';
import { agentLabel, isRoutedModel, modelsFor } from '../../core/agents';
import { DataService } from '../../core/data.service';
import { SlashInputComponent } from '../../shared/slash-input.component';

const REPLYABLE = new Set(['waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']);
/** Your last auto-send choice (localStorage), the default for the next queue. */
const AUTO_SEND_KEY = 'dash.queueAutoSend';

/**
 * Bottom of a run: questions Claude asked (option buttons), a free-text reply box,
 * and the plan-mode bar. Replies resume the same session as a new turn. While Claude
 * works, what you type is queued (as in the CLI): it goes out when the turn ends, and
 * can be edited or removed until then.
 */
@Component({
  selector: 'dash-run-composer',
  imports: [AttachComponent, SlashInputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './run-composer.component.scss',
  template: `
    @let r = run();
    @if (r.status === 'handedOff') {
      <div class="composer ro">
        <div class="note">Continued in a terminal, so the dashboard is read-only for this run. What happens there shows up above.</div>
        <code class="cmd">claude --resume {{ r.sessionId }}</code>
      </div>
    } @else {
      <div class="composer">
        @if (questions().length && r.status === 'waiting') {
          <div class="questions">
            @for (q of questions(); track $index; let qi = $index) {
              <div class="q">
                @if (q.header) { <div class="q-h">{{ q.header }}</div> }
                <div class="q-t">{{ q.question }}</div>
                <div class="opts">
                  @for (o of q.options; track o.label) {
                    <button type="button" class="opt" [class.on]="picked(qi, o.label)" [disabled]="busy()" (click)="pick(qi, o.label, !!q.multiSelect)" [title]="o.description || ''">
                      <span class="ol">{{ o.label }}</span>@if (o.description) { <span class="od">{{ o.description }}</span> }
                    </button>
                  }
                  <button type="button" class="opt" [class.on]="isOpen(qi)" [disabled]="busy()" (click)="toggleOther(qi, !!q.multiSelect)" title="Type your own answer">
                    <span class="ol">Other…</span><span class="od">Type your own answer.</span>
                  </button>
                </div>
                @if (isOpen(qi)) {
                  <input class="q-other" [id]="'q-other-' + qi" type="text" [value]="notes()[qi] || ''" [disabled]="busy()"
                    (input)="setNote(qi, $any($event.target).value)" (keydown.enter)="onOtherEnter($any($event))"
                    [placeholder]="q.multiSelect ? 'Add your own answer…' : 'Your answer…'" />
                }
                @if (q.multiSelect) { <div class="q-note">Pick any that apply.</div> }
              </div>
            }
            @if (!single() || isOpen(0)) {
              <div class="q-send"><button class="btn primary sm" type="button" [disabled]="busy() || !anyPicked()" (click)="sendPicks()">Send answers</button></div>
            }
          </div>
        }

        <div class="plan-bar" [class.on]="r.planMode">
          @if (r.planMode) {
            <span><b>Plan mode</b> — read-only. {{ who() }} can look but not change anything.</span>
            <button class="btn sm" type="button" [disabled]="busy() || r.status === 'running'" (click)="setPlan(false)">Turn off plan mode</button>
          } @else {
            <span class="muted">{{ who() }} can make changes in {{ r.workspace }}.</span>
            <button class="linkish" type="button" [disabled]="busy() || r.status === 'running'" (click)="setPlan(true)">Turn on plan mode</button>
          }
        </div>

        @if (queued().length) {
          <div class="queue" [class.held]="held()">
            <div class="queue-h">
              @if (r.status === 'running') {
                <span><b>Queued</b> · sent when {{ who() }} finishes this turn</span>
              } @else if (r.queueBlocked) {
                <span><b>Queued, not sent:</b> {{ r.queueBlocked }}</span>
              } @else if (r.status === 'waiting') {
                <span><b>Queued</b> · held while {{ who() }} waits for your answer</span>
              } @else {
                <span><b>Queued</b> · held because the turn was {{ r.status }}</span>
              }
              <label class="auto" title="Send the queue even if Claude ends the turn with a question. It goes first, with a note asking Claude to ask its question again afterwards, so you can walk away without Claude deciding for you.">
                <input type="checkbox" [checked]="!!r.queueAutoSend" [disabled]="busy()" (change)="setAutoSend($any($event.target).checked)" /> Auto-send
              </label>
              @if (held()) {
                <button class="btn primary sm" type="button" [disabled]="busy()" (click)="sendQueued()" title="Send the queued messages as your reply">Send now</button>
              }
            </div>
            @for (q of queued(); track q.id) {
              <div class="queue-item">
                @if (editing() === q.id) {
                  <textarea rows="2" [id]="'q-edit-' + q.id" [value]="draft()" (input)="draft.set($any($event.target).value)" (keydown)="onEditKey($event, q)" [disabled]="busy()"></textarea>
                  <div class="queue-acts">
                    <button class="btn primary sm" type="button" [disabled]="busy()" (click)="saveEdit(q)">Save</button>
                    <button class="linkish" type="button" (click)="editing.set(null)">Cancel</button>
                  </div>
                } @else {
                  <div class="queue-t">{{ q.text }}</div>
                  <div class="queue-acts">
                    <button class="linkish" type="button" [disabled]="busy()" (click)="startEdit(q)">Edit</button>
                    <button class="linkish" type="button" [disabled]="busy()" (click)="removeQueued(q)">Remove</button>
                  </div>
                }
              </div>
            }
          </div>
        }

        @if (r.status === 'running') {
          <div class="note working"><span class="spin"></span> {{ who() }} is working… Type ahead to queue a message for when it's done, or cancel the turn to interrupt.</div>
          <form class="reply" (submit)="$event.preventDefault(); queue()">
            <dash-slash-input [multiline]="true" [rows]="2" [above]="true" [value]="text()" (valueChange)="text.set($event)" (keys)="onKey($event)"
              placeholder="Queue a message for when this turn ends, or type / for skills…" [disabled]="busy()" />
            <button class="btn primary" type="submit" [disabled]="busy() || !text().trim()">{{ busy() ? 'Queueing…' : 'Queue' }}</button>
          </form>
          <div class="hint">Enter to queue · ↑ in an empty box edits the last queued message. Queued messages go out together as your next reply.</div>
        } @else if (canReply()) {
          <form class="reply" (submit)="$event.preventDefault(); send()"
            (paste)="att.paste($event)" (dragover)="att.dragOver($event)" (drop)="att.drop($event)">
            <dash-slash-input [multiline]="true" [rows]="2" [above]="true" [value]="text()" (valueChange)="text.set($event)" (keys)="onKey($event)"
              [placeholder]="r.status === 'waiting' ? 'Answer in your own words…' : 'Reply to continue this conversation, or type / for skills…'" [disabled]="busy()" />
            <button class="btn primary" type="submit" [disabled]="busy() || att.uploading() || (!text().trim() && !att.ids().length)">{{ busy() ? 'Sending…' : 'Send' }}</button>
          </form>
          <dash-attach #att [compact]="true" />
          @if (!r.agent || r.agent === 'claude') {
            <div class="next-model">
              @if (isRouted(r.model) && nextModel() === r.model) {
                <button class="btn sm" type="button" [disabled]="busy()" (click)="nextModel.set('opus')" title="Send your next reply to Opus, on your Claude sign-in. The conversation so far carries over.">Continue with Opus</button>
              }
              <label>Next reply on
                <select [value]="nextModel()" (change)="nextModel.set($any($event.target).value)" aria-label="Model for the next reply">
                  @for (m of models(); track m.id) { <option [value]="m.id" [selected]="m.id === nextModel()">{{ m.label }}{{ m.id === r.model ? ' (this run so far)' : '' }}</option> }
                </select>
              </label>
            </div>
          }
          <div class="hint">Enter to send · Shift+Enter for a new line · paste a screenshot or drop files to attach them. Each reply resumes the same session (a few seconds to start).</div>
        }
      </div>
    }
  `,
})
export class RunComposerComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly data = inject(DataService);
  readonly run = input.required<RunMeta>();
  readonly isRouted = isRoutedModel;
  /** The model the next reply goes to: the run's own unless changed (Claude runs; e.g. from a local model on to Opus). */
  readonly nextModel = signal('');
  /** Claude's models and the Models page's local and team ones, with the run's own first if it's none of them. */
  readonly models = computed(() => {
    const claude = (this.data.agents() || []).find((a) => a.id === 'claude') || null;
    const list = modelsFor(claude, this.data.deck()?.options?.models || ['opus', 'sonnet', 'haiku', 'fable']);
    const own = this.run().model || '';
    return own && !list.some((m) => m.id === own) ? [{ id: own, label: own }, ...list] : list;
  });
  /** The run's agent, for labels. */
  readonly who = computed(() => agentLabel(this.run().agent));
  readonly changed = output<RunMeta>();

  readonly text = signal('');
  readonly busy = signal(false);
  readonly picks = signal<Record<number, string[]>>({});
  /** Typed "Other" answers, and which questions have that input open. */
  readonly notes = signal<Record<number, string>>({});
  readonly open = signal<Record<number, boolean>>({});
  readonly questions = computed<Question[]>(() => this.run().question || []);
  readonly single = computed(() => this.questions().length === 1 && !this.questions()[0].multiSelect);
  readonly anyPicked = computed(() =>
    Object.values(this.picks()).some((a) => a.length) || Object.values(this.notes()).some((n) => n.trim()));
  readonly canReply = computed(() => REPLYABLE.has(this.run().status));
  readonly queued = computed<QueuedMessage[]>(() => this.run().queued || []);
  /** The queue isn't going out by itself (a question, a cancel or restart, or a limit): offer Send now. */
  readonly held = computed(() => this.run().status !== 'running' && this.queued().length > 0);
  /** The queued message being edited, and its text so far. */
  readonly editing = signal<string | null>(null);
  readonly draft = signal('');
  private readonly att = viewChild<AttachComponent>('att');

  constructor() {
    // New run or new question → clear old picks and typed answers.
    let lastQ = '';
    effect(() => {
      const q = this.run().id + ' ' + JSON.stringify(this.run().question || null);
      if (q !== lastQ) { lastQ = q; this.clearAnswers(); }
    });
    // Another run, or this one changed model: the next reply starts on the run's own.
    let lastModel = '';
    effect(() => {
      const k = this.run().id + ' ' + (this.run().model || '');
      if (k !== lastModel) { lastModel = k; this.nextModel.set(this.run().model || ''); }
    });
  }

  picked(qi: number, label: string): boolean { return (this.picks()[qi] || []).includes(label); }

  isOpen(qi: number): boolean { return !!this.open()[qi]; }

  setNote(qi: number, value: string): void { this.notes.set({ ...this.notes(), [qi]: value }); }

  /** "Other…": a typed answer. On a single-select question it replaces the pick; on multi-select it's added to them. */
  toggleOther(qi: number, multi: boolean): void {
    if (this.isOpen(qi)) { this.closeOther(qi); return; }
    this.open.set({ ...this.open(), [qi]: true });
    if (!multi) this.picks.set({ ...this.picks(), [qi]: [] });
    setTimeout(() => (document.getElementById('q-other-' + qi) as HTMLInputElement | null)?.focus());
  }

  private closeOther(qi: number): void {
    this.open.set({ ...this.open(), [qi]: false });
    this.notes.set({ ...this.notes(), [qi]: '' });
  }

  private clearAnswers(): void {
    this.picks.set({});
    this.notes.set({});
    this.open.set({});
  }

  pick(qi: number, label: string, multi: boolean): void {
    if (this.single()) {
      this.picks.set({ 0: [label] });
      this.reply(answerText(this.questions(), { 0: [label] }));
      return;
    }
    const cur = this.picks()[qi] || [];
    const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    this.picks.set({ ...this.picks(), [qi]: next });
    if (!multi && this.isOpen(qi)) this.closeOther(qi);
  }

  sendPicks(): void {
    if (!this.anyPicked()) return;
    const extra = this.text().trim();
    const body = answerText(this.questions(), this.picks(), this.notes()) + (extra ? '\n\n' + extra : '');
    this.reply(body, !!extra);
  }

  onKey(e: KeyboardEvent): void {
    const running = this.run().status === 'running';
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (running) this.queue(); else this.send(); }
    // As in the CLI: up in an empty box brings back the last queued message to change it.
    if (e.key === 'ArrowUp' && !this.text() && this.queued().length) { e.preventDefault(); this.startEdit(this.queued()[this.queued().length - 1]); }
  }

  // ---- queued messages

  async queue(): Promise<void> {
    const t = this.text().trim();
    if (!t) return;
    // A new queue takes your last auto-send choice; an existing one keeps its own.
    const autoSend = this.queued().length ? undefined : localStorage.getItem(AUTO_SEND_KEY) === '1';
    if (await this.queuePost('queue', { text: t, autoSend })) this.text.set('');
  }

  async setAutoSend(on: boolean): Promise<void> {
    localStorage.setItem(AUTO_SEND_KEY, on ? '1' : '0');
    await this.queuePost('queue-auto', { on });
  }

  startEdit(q: QueuedMessage): void {
    this.editing.set(q.id);
    this.draft.set(q.text);
    setTimeout(() => (document.getElementById('q-edit-' + q.id) as HTMLTextAreaElement | null)?.focus());
  }

  onEditKey(e: KeyboardEvent, q: QueuedMessage): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.saveEdit(q); }
    if (e.key === 'Escape') { e.preventDefault(); this.editing.set(null); }
  }

  async saveEdit(q: QueuedMessage): Promise<void> {
    if (await this.queuePost('queue-edit', { id: q.id, text: this.draft() })) this.editing.set(null);
  }

  async removeQueued(q: QueuedMessage): Promise<void> {
    if (this.editing() === q.id) this.editing.set(null);
    await this.queuePost('queue-remove', { id: q.id });
  }

  async sendQueued(): Promise<void> {
    this.editing.set(null);
    await this.queuePost('queue-send', {});
  }

  private async queuePost(action: string, body: object): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + this.run().id + '/' + action, body);
      this.changed.emit(res.run);
      return true;
    } catch (e) {
      this.toast.error((e as Error).message);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Enter in an "Other" input sends, unless it's confirming an IME candidate. */
  onOtherEnter(e: KeyboardEvent): void {
    if (e.isComposing) return;
    e.preventDefault();
    this.sendPicks();
  }

  send(): void {
    // Picks or typed answers waiting above go with the text, never dropped.
    if (this.anyPicked()) { this.sendPicks(); return; }
    const t = this.text().trim();
    const att = this.att();
    if (att?.uploading()) { this.toast.error('Wait for the files to finish uploading.'); return; }
    if (!t && !att?.ids().length) return;
    this.reply(t, true);
  }

  private async reply(text: string, clearText = false): Promise<void> {
    if (this.busy()) return;
    const att = this.att();
    if (att?.uploading()) { this.toast.error('Wait for the files to finish uploading.'); return; }
    this.busy.set(true);
    try {
      const attachments = att?.ids() || [];
      const model = this.nextModel() && this.nextModel() !== (this.run().model || '') ? this.nextModel() : undefined;
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + this.run().id + '/reply', { text, attachments, ...(model ? { model } : {}) });
      if (clearText) this.text.set('');
      att?.clear();
      this.clearAnswers();
      this.changed.emit(res.run);
    } catch (e) {
      this.toast.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  async setPlan(on: boolean): Promise<void> {
    this.busy.set(true);
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + this.run().id + '/plan-mode', { on });
      this.changed.emit(res.run);
      this.toast.show(on ? 'Plan mode on: the next turn is read-only' : 'Plan mode off: the next turn can make changes');
    } catch (e) {
      this.toast.error((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}

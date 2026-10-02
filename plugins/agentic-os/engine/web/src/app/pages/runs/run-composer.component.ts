import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import type { Question, RunMeta } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { answerText } from '../../runs/answer';
import { AttachComponent } from '../../shared/attach.component';

const REPLYABLE = new Set(['waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']);

/**
 * Bottom of a run: questions Claude asked (option buttons), a free-text reply box,
 * and the plan-mode bar. Replies resume the same session as a new turn.
 */
@Component({
  selector: 'dash-run-composer',
  imports: [AttachComponent],
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
            <span><b>Plan mode</b> — read-only. Claude can look but not change anything.</span>
            <button class="btn sm" type="button" [disabled]="busy() || r.status === 'running'" (click)="setPlan(false)">Turn off plan mode</button>
          } @else {
            <span class="muted">Claude can make changes in {{ r.workspace }}.</span>
            <button class="linkish" type="button" [disabled]="busy() || r.status === 'running'" (click)="setPlan(true)">Turn on plan mode</button>
          }
        </div>

        @if (r.status === 'running') {
          <div class="note working"><span class="spin"></span> Claude is working… Cancel the turn to interrupt, or wait and reply when it's done.</div>
        } @else if (canReply()) {
          <form class="reply" (submit)="$event.preventDefault(); send()"
            (paste)="att.paste($event)" (dragover)="att.dragOver($event)" (drop)="att.drop($event)">
            <textarea rows="2" [value]="text()" (input)="text.set($any($event.target).value)" (keydown)="onKey($event)"
              [placeholder]="r.status === 'waiting' ? 'Answer in your own words…' : 'Reply to continue this conversation…'" [disabled]="busy()"></textarea>
            <button class="btn primary" type="submit" [disabled]="busy() || att.uploading() || (!text().trim() && !att.ids().length)">{{ busy() ? 'Sending…' : 'Send' }}</button>
          </form>
          <dash-attach #att [compact]="true" />
          <div class="hint">Enter to send · Shift+Enter for a new line · paste a screenshot or drop files to attach them. Each reply resumes the same session (a few seconds to start).</div>
        }
      </div>
    }
  `,
})
export class RunComposerComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly run = input.required<RunMeta>();
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
  private readonly att = viewChild<AttachComponent>('att');

  constructor() {
    // New run or new question → clear old picks and typed answers.
    let lastQ = '';
    effect(() => {
      const q = this.run().id + ' ' + JSON.stringify(this.run().question || null);
      if (q !== lastQ) { lastQ = q; this.clearAnswers(); }
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
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
      const res = await this.api.post<{ run: RunMeta }>('/api/runs/' + this.run().id + '/reply', { text, attachments });
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

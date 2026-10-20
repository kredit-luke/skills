import { ChangeDetectionStrategy, Component, OnDestroy, inject, input, output, signal } from '@angular/core';
import type { McpLoginStatus, MeetingSignInStart } from '../../../../shared/api';
import { ApiService } from '../core/api.service';
import { ToastService } from '../core/toast.service';

/** A sign-in in progress: the page to open, and the address to paste back if this dashboard can't catch it. */
interface SignIn extends MeetingSignInStart { busy: boolean; message: string }

/**
 * Sign in to a tool through the browser (OAuth), against a sign-in endpoint shaped like
 * /api/meetings/sign-in and /api/atlassian/sign-in: { action: 'start' | 'status' | 'finish' | 'cancel' }.
 * Opens the tool's page in a new tab. When the dashboard catches the browser coming back
 * (`listening`: locally on a loopback port, hosted at its own address) it asks every 2s until
 * it's done; otherwise, or locally when that last page doesn't load, the address is pasted back.
 * Emits `done` with the server's message once signed in.
 */
@Component({
  selector: 'dash-oauth-sign-in',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (signIn(); as s) {
      <div class="signin">
        <ol>
          <li><a [href]="s.url" target="_blank" rel="noopener">Open the {{ label() }} sign-in page ↗</a> and sign in.</li>
          <li>
            @if (!s.listening) { The last page won't load (it's an address on your own computer). Copy that address from the browser's address bar and paste it here: }
            @else if (api.hosted()) { This finishes by itself when you're done, and the sign-in tab says so. }
            @else { This finishes by itself when you're done. If the last page doesn't load, copy its address from the address bar and paste it here: }
            @if (!s.listening || !api.hosted()) {
              <span class="row">
                <label class="vh" [for]="inputId()">The address sign-in ended on</label>
                <input #cb [id]="inputId()" type="text" autocomplete="off" spellcheck="false" [placeholder]="s.callback + '?code=…'" (keydown.enter)="finish(cb.value)">
                <button class="btn primary sm" type="button" [disabled]="s.busy" (click)="finish(cb.value)">{{ s.busy ? 'Finishing…' : 'Finish sign-in' }}</button>
              </span>
            }
          </li>
        </ol>
        <div class="row"><span class="msg" role="status">{{ s.message }}</span> <span class="sp"></span><button class="btn ghost sm" type="button" (click)="cancel()">Cancel</button></div>
      </div>
    } @else {
      <button class="btn primary" type="button" [disabled]="starting()" (click)="start()">{{ starting() ? 'Starting…' : (buttonText() || 'Sign in with ' + label()) }}</button>
    }
  `,
  styles: [`
    .signin { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper-2); font-size: 13px; color: var(--ink); }
    .signin ol { margin: 0; padding-left: 18px; line-height: 1.6; }
    .signin li + li { margin-top: 6px; }
    .signin .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .signin .sp { flex: 1; }
    .signin .msg { font-size: 12px; color: var(--risk); }
    .signin input { font-family: var(--font-mono); font-size: 12px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; min-width: 320px; flex: 1; background: var(--surface); color: var(--ink); }
  `],
})
export class OAuthSignInComponent implements OnDestroy {
  readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  /** The sign-in endpoint, e.g. '/api/atlassian/sign-in'. */
  readonly endpoint = input.required<string>();
  /** The tool's name, for the link and the button ("Atlassian", "Roam"). */
  readonly label = input.required<string>();
  /** The button's text; default "Sign in with <label>". */
  readonly buttonText = input<string>('');
  /** The paste box's id (unique on the page). */
  readonly inputId = input<string>('oauth-callback');
  /** Signed in: the server's message ("Connected to ... as ..."). */
  readonly done = output<string>();

  readonly starting = signal(false);
  readonly signIn = signal<SignIn | null>(null);
  private poll: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cancel();
  }

  /** Start signing in: the server hands back the page to open, and whether it catches the redirect itself. */
  async start(): Promise<void> {
    this.cancel();
    this.starting.set(true);
    try {
      const r = await this.api.post<MeetingSignInStart>(this.endpoint(), { action: 'start' });
      if (this.destroyed) { this.api.post(this.endpoint(), { action: 'cancel' }).catch(() => {}); return; }
      this.signIn.set({ ...r, busy: false, message: '' });
      window.open(r.url, '_blank', 'noopener');
      if (r.listening) this.poll = setInterval(() => this.check(), 2000);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.starting.set(false); }
  }

  private async check(): Promise<void> {
    const s = this.signIn();
    if (!s || s.busy) return;
    try {
      const r = await this.api.post<McpLoginStatus>(this.endpoint(), { action: 'status' });
      if (this.signIn() !== s) return;
      if (r.done || !r.pending) this.finished(r);
    } catch { /* keep waiting */ }
  }

  async finish(url: string): Promise<void> {
    const s = this.signIn();
    if (!s || s.busy || !url.trim()) return;
    const b = { ...s, busy: true, message: '' };
    this.signIn.set(b);
    try {
      const r = await this.api.post<McpLoginStatus>(this.endpoint(), { action: 'finish', url });
      // Cancelled (or started again) while this was in flight: leave that alone.
      if (this.signIn() !== b) return;
      if (r.done || !r.pending) this.finished(r);
      else this.signIn.set({ ...s, busy: false, message: r.message });
    } catch (e) {
      if (this.signIn() !== b) return;
      this.signIn.set({ ...s, busy: false, message: (e as Error).message });
    }
  }

  private finished(r: McpLoginStatus): void {
    this.stopPoll();
    this.signIn.set(null);
    if (r.done) {
      if (r.ok) { this.toast.show(r.message); this.done.emit(r.message); }
      else this.toast.error(r.message);
    } else if (r.message) this.toast.error(r.message);
  }

  cancel(): void {
    const s = this.signIn();
    this.stopPoll();
    this.signIn.set(null);
    if (s) this.api.post(this.endpoint(), { action: 'cancel' }).catch(() => {});
  }

  private stopPoll(): void { if (this.poll) { clearInterval(this.poll); this.poll = null; } }
}

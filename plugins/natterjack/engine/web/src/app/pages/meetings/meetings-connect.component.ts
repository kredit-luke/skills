import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import type { MeetingConnectHelp, MeetingSignInStart, MeetingSignInStatus, MeetingsStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { MdPipe } from '../../core/md.pipe';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';

/** A sign-in in progress: the page to open, and the address to paste back if this dashboard can't catch it. */
interface SignIn extends MeetingSignInStart { busy: boolean; message: string }

/**
 * Connect the meeting tool: sign in through the browser (when meetings.json has an OAuth app),
 * or paste a personal access token (always). Emits the new status once connected.
 */
@Component({
  selector: 'dash-meetings-connect',
  imports: [MdPipe, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let st = status();
    <div class="panel connect-card">
      <div class="panel-h"><h2>{{ help()?.title || 'Connect ' + st.label }}</h2></div>
      <div class="cc-b">
        <p class="lead">{{ st.message }}</p>
        @if (note()) { <div class="warn-note">{{ note() }}</div> }
        @if (st.signInProblem) { <div class="warn-note">Sign-in isn't set up right: {{ st.signInProblem }} You can still connect with a personal access token below.</div> }

        @if (st.signIn) {
          <section>
            <h3>Sign in</h3>
            @if (signIn(); as s) {
              <div class="signin">
                <ol>
                  <li><a [href]="s.url" target="_blank" rel="noopener">Open the {{ st.label }} sign-in page ↗</a> and sign in.</li>
                  <li>
                    @if (pasteOnly()) { The last page won't load (it's an address on your own computer). Copy that address from the browser's address bar and paste it here: }
                    @else { This finishes by itself when you're done. If the last page doesn't load, copy its address from the address bar and paste it here: }
                    <span class="row">
                      <label class="vh" for="meetings-callback">The address sign-in ended on</label>
                      <input #cb id="meetings-callback" type="text" autocomplete="off" spellcheck="false" [placeholder]="s.callback + '?code=…'" (keydown.enter)="finishSignIn(cb.value)">
                      <button class="btn primary sm" type="button" [disabled]="s.busy" (click)="finishSignIn(cb.value)">{{ s.busy ? 'Finishing…' : 'Finish sign-in' }}</button>
                    </span>
                  </li>
                </ol>
                <div class="row"><span class="msg" role="status">{{ s.message }}</span> <span class="sp"></span><button class="btn ghost sm" type="button" (click)="cancelSignIn()">Cancel</button></div>
              </div>
            } @else {
              <button class="btn primary" type="button" [disabled]="starting()" (click)="startSignIn()">{{ starting() ? 'Starting…' : 'Sign in with ' + st.label }}</button>
            }
          </section>
        }

        <section>
          <h3>{{ st.signIn ? 'Or use a personal access token' : 'Use a personal access token' }}</h3>
          @if (helpErr()) { <div class="err-note">{{ helpErr() }}</div> }
          @if (help(); as h) {
            @if (h.steps.length) {
              <ol class="steps">
                @for (s of h.steps; track $index) { <li class="md tight" [innerHTML]="s | md | trustedHtml"></li> }
              </ol>
            }
          }
          <form class="row-in" (submit)="$event.preventDefault(); connect()">
            <label class="vh" for="meetings-token">{{ st.label }} personal access token</label>
            <input id="meetings-token" type="password" autocomplete="off" spellcheck="false" [placeholder]="help()?.placeholder || st.label + ' personal access token'"
              [value]="token()" (input)="token.set($any($event.target).value)">
            <button class="btn primary" type="submit" [disabled]="!token().trim() || connecting()">{{ connecting() ? 'Connecting…' : 'Connect' }}</button>
          </form>
          <div class="form-err" role="alert">{{ connectErr() }}</div>
        </section>
      </div>
    </div>
  `,
  styles: [`
    .connect-card { max-width: 620px; margin: 24px auto; }
    .cc-b { padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 14px; }
    .lead { margin: 0; font-size: 13.5px; color: var(--ink-soft); line-height: 1.5; }
    section + section { border-top: 1px solid var(--line-soft); padding-top: 14px; }
    h3 { font-size: 13.5px; font-weight: 600; margin: 0 0 8px; color: var(--ink); }
    .steps { margin: 4px 0 0 18px; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; color: var(--ink-soft); line-height: 1.5; }
    .row-in { display: flex; gap: 8px; margin: 14px 0 8px; }
    .row-in input { flex: 1; font-family: var(--font-mono); }
    .signin { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper-2); font-size: 13px; color: var(--ink); }
    .signin ol { margin: 0; padding-left: 18px; line-height: 1.6; }
    .signin li + li { margin-top: 6px; }
    .signin .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .signin .sp { flex: 1; }
    .signin .msg { font-size: 12px; color: var(--risk); }
    .signin input { font-family: var(--font-mono); font-size: 12px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; min-width: 320px; flex: 1; background: var(--surface); color: var(--ink); }
  `],
})
export class MeetingsConnectComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly status = input.required<MeetingsStatus>();
  /** What's left to do by hand after a disconnect (the server's note), shown until the next connect. */
  readonly note = input<string | null>(null);
  /** Connected: the new status, or null when the page should fetch it. */
  readonly connected = output<MeetingsStatus | null>();

  readonly help = signal<MeetingConnectHelp | null>(null);
  readonly helpErr = signal<string | null>(null);
  readonly token = signal('');
  readonly connecting = signal(false);
  readonly connectErr = signal('');
  readonly starting = signal(false);
  readonly signIn = signal<SignIn | null>(null);
  /** Nothing here catches the redirect (hosted, or the port was busy): the address has to be pasted back. */
  readonly pasteOnly = computed(() => this.api.hosted() || !this.signIn()?.listening);
  private poll: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  async ngOnInit(): Promise<void> {
    try { this.help.set(await this.api.get<MeetingConnectHelp>('/api/meetings/connect-help')); }
    catch (e) { this.helpErr.set((e as Error).message); }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cancelSignIn();
  }

  async connect(): Promise<void> {
    const token = this.token().trim();
    if (!token || this.connecting()) return;
    this.connecting.set(true);
    this.connectErr.set('');
    try {
      const st = await this.api.post<MeetingsStatus>('/api/meetings/connect', { token });
      this.token.set('');
      this.toast.show(`Connected to ${st.label}${st.viewer ? ' as ' + st.viewer : ''}`);
      this.connected.emit(st);
    } catch (e) { this.connectErr.set((e as Error).message); }
    finally { this.connecting.set(false); }
  }

  /** Start signing in: the server hands back the page to open, and whether it's listening for the redirect. */
  async startSignIn(): Promise<void> {
    this.cancelSignIn();
    this.starting.set(true);
    try {
      const r = await this.api.post<MeetingSignInStart>('/api/meetings/sign-in', { action: 'start' });
      if (this.destroyed) { this.api.post('/api/meetings/sign-in', { action: 'cancel' }).catch(() => {}); return; }
      this.signIn.set({ ...r, busy: false, message: '' });
      window.open(r.url, '_blank', 'noopener');
      // Locally the dashboard catches the redirect itself; ask every 2s whether it has.
      if (r.listening && !this.api.hosted()) this.poll = setInterval(() => this.pollSignIn(), 2000);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.starting.set(false); }
  }

  private async pollSignIn(): Promise<void> {
    const s = this.signIn();
    if (!s || s.busy) return;
    try {
      const r = await this.api.post<MeetingSignInStatus>('/api/meetings/sign-in', { action: 'status' });
      if (this.signIn() !== s) return;
      if (r.done || !r.pending) this.signedIn(r);
    } catch { /* keep waiting */ }
  }

  async finishSignIn(url: string): Promise<void> {
    const s = this.signIn();
    if (!s || s.busy || !url.trim()) return;
    const b = { ...s, busy: true, message: '' };
    this.signIn.set(b);
    try {
      const r = await this.api.post<MeetingSignInStatus>('/api/meetings/sign-in', { action: 'finish', url });
      // Cancelled (or started again) while this was in flight: leave that alone.
      if (this.signIn() !== b) return;
      if (r.done || !r.pending) this.signedIn(r);
      else this.signIn.set({ ...s, busy: false, message: r.message });
    } catch (e) {
      if (this.signIn() !== b) return;
      this.signIn.set({ ...s, busy: false, message: (e as Error).message });
    }
  }

  private signedIn(r: MeetingSignInStatus): void {
    this.stopPoll();
    this.signIn.set(null);
    if (r.done) {
      if (r.ok) { this.toast.show(r.message); this.connected.emit(null); }
      else this.toast.error(r.message);
    } else if (r.message) this.toast.error(r.message);
  }

  cancelSignIn(): void {
    const s = this.signIn();
    this.stopPoll();
    this.signIn.set(null);
    if (s) this.api.post('/api/meetings/sign-in', { action: 'cancel' }).catch(() => {});
  }

  private stopPoll(): void { if (this.poll) { clearInterval(this.poll); this.poll = null; } }
}

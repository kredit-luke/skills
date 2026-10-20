import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import type { MeetingConnectHelp, MeetingsStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { MdPipe } from '../../core/md.pipe';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { OAuthSignInComponent } from '../../shared/oauth-sign-in.component';

/**
 * Connect the meeting tool: sign in through the browser (when meetings.json has an OAuth app),
 * or paste a personal access token (always). Emits the new status once connected.
 */
@Component({
  selector: 'dash-meetings-connect',
  imports: [MdPipe, TrustedHtmlPipe, OAuthSignInComponent],
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
            <dash-oauth-sign-in endpoint="/api/meetings/sign-in" [label]="st.label" inputId="meetings-callback" (done)="connected.emit(null)" />
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
  `],
})
export class MeetingsConnectComponent implements OnInit {
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

  async ngOnInit(): Promise<void> {
    try { this.help.set(await this.api.get<MeetingConnectHelp>('/api/meetings/connect-help')); }
    catch (e) { this.helpErr.set((e as Error).message); }
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
}

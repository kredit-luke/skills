import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import type { AtlassianStatus } from '../../../../shared/api';
import { ApiService } from '../core/api.service';
import { OAuthSignInComponent } from './oauth-sign-in.component';

/**
 * Connect to Atlassian: sign in with your own Atlassian account so the dashboard reads Jira
 * and Confluence as you (no API token to make). Shows nothing when the workspace hasn't set
 * up the Atlassian app; says why when it's set up but can't be used here (no client secret).
 * `forTickets`: only when the tracker is Jira and isn't connected at all (the Meetings page,
 * whose ticket badges need it), as a bar. Emits `connected` once signed in.
 */
@Component({
  selector: 'dash-atlassian-connect',
  imports: [OAuthSignInComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (status(); as st) {
      @if (!forTickets() || st.jira === false) {
        @if (st.signIn && !st.connected) {
          <div class="atl" [class.bar]="forTickets()">
            @if (lead()) { <p class="lead">{{ lead() }}</p> }
            <dash-oauth-sign-in endpoint="/api/atlassian/sign-in" label="Atlassian" buttonText="Connect to Atlassian" [inputId]="inputId()" (done)="signedIn()" />
          </div>
        } @else if (st.signInProblem) {
          <div class="warn-note">Connect to Atlassian isn't available here: {{ st.signInProblem }}</div>
        }
      }
    }
  `,
  styles: [`
    .atl { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
    .atl.bar { padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper-2); margin-bottom: 12px; }
    .lead { margin: 0; font-size: 13px; color: var(--ink-soft); line-height: 1.5; }
  `],
})
export class AtlassianConnectComponent implements OnInit {
  private readonly api = inject(ApiService);
  /** A line above the button (e.g. what it's for on this page); none by default. */
  readonly lead = input<string>('');
  readonly inputId = input<string>('atlassian-callback');
  /** Only when the Jira tracker isn't connected (the Meetings page's ticket badges). */
  readonly forTickets = input<boolean>(false);
  readonly connected = output<void>();
  readonly status = signal<AtlassianStatus | null>(null);

  async ngOnInit(): Promise<void> { await this.refresh(); }

  /** Ask again whether Atlassian is connected (a page calls it after reading something that may have found the sign-in expired). */
  async refresh(): Promise<void> {
    try { this.status.set(await this.api.get<AtlassianStatus>('/api/atlassian/status')); }
    catch { /* an older server, or it's down: just no button */ }
  }

  async signedIn(): Promise<void> {
    await this.refresh();
    this.connected.emit();
  }
}

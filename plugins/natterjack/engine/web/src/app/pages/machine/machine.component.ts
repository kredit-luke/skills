import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import type { MachineCheck } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { copyText, relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';

const ICON: Record<string, string> = { ok: '✓', warn: '!', missing: '✕', info: '–' };

@Component({
  selector: 'dash-machine',
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './machine.component.scss',
  template: `
    @let m = data.machine();
    <dash-page-header eyebrow="Machine" [title]="m?.host || 'This machine'" [sub]="sub()">
      <span class="ty">{{ meta() }}</span>
      <button class="btn sm" (click)="recheck()" [disabled]="busy()">{{ busy() ? 'Checking…' : 'Re-check' }}</button>
    </dash-page-header>

    @if (!m) { <div class="empty">Checking…</div> }
    @else {
      @if (m.error) { <div class="warn-note">{{ m.error }}</div> }
      @if (!m.configured) {
        <div class="panel"><div class="empty md tight" style="padding:2rem">
          <p>No checks are set up. List what this workspace needs in <code>.claude/dashboard/machine.json</code> (for example <code>{{ '{' }} "use": "node" {{ '}' }}</code>, <code>{{ '{' }} "use": "docker" {{ '}' }}</code>, <code>{{ '{' }} "use": "go" {{ '}' }}</code>), then reload. The catalog of tools it knows is in <code>{{ api.engineDir() }}/server/src/machine-catalog.ts</code>; ask Claude to derive the list from your repos.</p>
        </div></div>
      }
      <div class="check-groups">
        @for (g of groups(); track g.name) {
          <div class="panel">
            <div class="panel-h"><h2>{{ g.name }} @if (g.bad) { <span class="n bad">{{ g.bad }}</span> }</h2></div>
            @for (c of g.items; track c.id) {
              <div class="check" [class]="'check ' + c.status">
                <span class="ic" [title]="c.status">{{ icon(c.status) }}</span>
                <span class="nm">{{ c.label }}</span>
                <span class="ver">{{ c.version || '' }}@if (c.required) { <span class="req"> need {{ c.required }}</span> }</span>
                @if (c.detail) { <div class="dt">{{ c.detail }}</div> }
                @if (c.status !== 'ok' && c.apps.length) { <div class="needs">Needed by {{ appNames(c) }}</div> }
                @if (c.status !== 'ok' && hosted()) {
                  <!-- Hosted: the container's tools are the image's job; only Claude's sign-in is the person's. -->
                  <!-- By kind: the id is machine.json's ("use": "claude" makes it "claude"). -->
                  @if (c.kind === 'claude-code' && c.install) {
                    <div class="fx signin">
                      @if (!signInUrl()) {
                        <button class="btn primary sm" [disabled]="signingIn()" (click)="startSignIn()">{{ signingIn() ? 'Starting…' : c.install.label }}</button>
                      } @else {
                        <ol>
                          <li><a [href]="signInUrl()" target="_blank" rel="noopener">Open the Claude sign-in page ↗</a> and sign in with your work account.</li>
                          <li>Paste the code it shows you:
                            <span class="row">
                              <input #code type="text" autocomplete="off" spellcheck="false" placeholder="Sign-in code" aria-label="Sign-in code from the Claude sign-in page" (keydown.enter)="finishSignIn(code.value)">
                              <button class="btn primary sm" [disabled]="signingIn()" (click)="finishSignIn(code.value)">{{ signingIn() ? 'Signing in…' : 'Finish sign-in' }}</button>
                              <button class="btn ghost sm" (click)="cancelSignIn()">Cancel</button>
                            </span>
                          </li>
                        </ol>
                      }
                    </div>
                  }
                } @else if (c.status !== 'ok') {
                  <div class="fx">
                    @if (c.fix) { <code title="Click to copy" (click)="copy(c.fix)">{{ c.fix }}</code> }
                    @if (c.install) { <button class="btn primary sm" [disabled]="installing() === c.id" (click)="install(c)" title="Opens a terminal running this command, so you can see and approve any prompts">{{ c.install.label }}</button> }
                    @if (c.action === 'setup') { <button class="btn primary sm" (click)="setup()">Run setup</button> }
                  </div>
                }
              </div>
            }
          </div>
        }
      </div>
    }
  `,
})
export class MachineComponent implements OnInit {
  readonly data = inject(DataService);
  readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly busy = signal(false);
  readonly installing = signal<string | null>(null);
  readonly hosted = this.api.hosted;
  /** Hosted Claude sign-in: the URL to open once started, and whether a step is in flight. */
  readonly signInUrl = signal<string | null>(null);
  readonly signingIn = signal(false);

  readonly sub = computed(() => {
    const m = this.data.machine();
    const what = this.hosted() ? 'What your hosted dashboard has set up, including your Claude sign-in.' : "Everything this computer needs to run the workspace's apps.";
    return m ? `${m.os} ${m.osVersion} · ${m.arch} · ${m.cpus} CPUs · ${m.memoryGb} GB RAM. ${what}` : what;
  });
  readonly meta = computed(() => {
    const m = this.data.machine();
    if (!m) return '';
    return (m.problems ? m.problems + ' missing · ' : 'Ready · ') + (m.warnings ? m.warnings + ' warning' + (m.warnings === 1 ? '' : 's') + ' · ' : '') + 'checked ' + relTime(m.checkedAt);
  });
  readonly groups = computed(() => {
    const m = this.data.machine();
    if (!m) return [];
    const names: string[] = [];
    for (const c of m.checks) if (!names.includes(c.group)) names.push(c.group);
    return names.map((name) => {
      const items = m.checks.filter((c) => c.group === name);
      return { name, items, bad: items.filter((c) => c.status === 'missing').length };
    });
  });
  private readonly names = computed(() => {
    const map: Record<string, string> = {};
    for (const w of this.data.status()?.workspaces || []) for (const a of w.apps) map[a.key] = a.name;
    return map;
  });

  ngOnInit(): void { this.data.loadMachine(false); }

  icon(s: string): string { return ICON[s] || '–'; }
  appNames(c: MachineCheck): string { return c.apps.map((k) => this.names()[k] || k).join(', '); }

  async recheck(): Promise<void> {
    this.busy.set(true);
    await this.data.loadMachine(true);
    this.busy.set(false);
  }
  async copy(text: string): Promise<void> { if (await copyText(text)) this.toast.show('Copied'); }
  setup(): void { this.data.appAction({ action: 'setup', workspace: 'main' }); }

  async install(c: MachineCheck): Promise<void> {
    this.installing.set(c.id);
    try {
      const r = await this.api.post<{ opened: boolean; command: string }>('/api/machine/install', { id: c.id });
      if (r.opened) this.toast.show('Opened a terminal running: ' + r.command + '. Re-check when it finishes.');
      else { await copyText(r.command); this.toast.error('Couldn\'t open a terminal; copied the command instead.'); }
    } catch (e) { this.toast.error((e as Error).message); }
    finally { setTimeout(() => this.installing.set(null), 3000); }
  }

  /** Hosted: start `claude auth login` on the server and show its sign-in URL. */
  async startSignIn(): Promise<void> {
    this.signingIn.set(true);
    try {
      const r = await this.api.post<{ url: string }>('/api/claude/login', { action: 'start' });
      this.signInUrl.set(r.url);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.signingIn.set(false); }
  }

  /** Hosted: hand the code from the sign-in page to the waiting `claude auth login`. */
  async finishSignIn(code: string): Promise<void> {
    if (!code.trim() || this.signingIn()) return;
    this.signingIn.set(true);
    try {
      const r = await this.api.post<{ ok: boolean; message: string }>('/api/claude/login', { action: 'code', code });
      if (r.ok) { this.toast.show(r.message); this.signInUrl.set(null); await this.recheck(); }
      else { this.toast.error(r.message); if (/start again/i.test(r.message)) this.signInUrl.set(null); }
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.signingIn.set(false); }
  }

  cancelSignIn(): void {
    this.signInUrl.set(null);
    this.api.post('/api/claude/login', { action: 'cancel' }).catch(() => {});
  }

  /** Coming back from an install terminal: re-check without making you click. */
  @HostListener('window:focus')
  onFocus(): void {
    const m = this.data.machine();
    if (m && Date.now() - m.checkedAt > 5000 && !this.busy()) this.recheck();
  }
}

import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import type { McpServerConfig } from '../../../../../shared/api';
import { agentLabel } from '../../core/agents';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { parsePairs } from './connections.util';

interface AgentServer {
  name: string; source: 'user' | 'workspace' | 'plugin' | 'builtin'; transport: string; target: string | null;
  enabled: boolean; envKeys: string[]; headerKeys: string[]; auth: string | null; actions: Array<'remove' | 'login'>;
}
interface FromClaude { name: string; from: string; as: string; transport: string; target: string | null }
interface AgentConnections { agent: 'copilot' | 'codex'; servers: AgentServer[]; fromClaude: FromClaude[]; terminal?: { opened: boolean; command: string } }

const SOURCE: Record<string, string> = { user: 'yours', workspace: 'workspace .mcp.json', plugin: 'plugin', builtin: 'built in' };

/**
 * Copilot's or Codex's own MCP servers (each CLI keeps its own list): what it has, add and
 * remove, Codex's sign-in, and Claude's servers it doesn't have yet with a one-click copy.
 * Values of env vars and headers stay on the server; only their names show here.
 */
@Component({
  selector: 'dash-agent-connections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './connections.component.scss',
  template: `
    @if (error()) { <div class="warn-note">{{ error() }}</div> }
    @if (!list()) { <div class="empty">{{ error() ? '' : 'Loading…' }}</div> }
    @else {
      <div class="conn-groups">
        <div class="panel">
          <div class="panel-h"><h2>{{ who() }}'s servers <span class="n">{{ list()!.servers.length }}</span></h2>
            <button class="btn ghost sm" (click)="adding.set(!adding())">{{ adding() ? 'Close' : 'Add server' }}</button></div>
          @if (adding()) {
            <div class="form add-form">
              <label>Name <input [value]="f().name" (input)="patch({ name: $any($event.target).value })" placeholder="notion" autocomplete="off" spellcheck="false"></label>
              <label>Transport
                <select (change)="patch({ type: $any($event.target).value })">
                  <option value="http" [selected]="f().type === 'http'">HTTP</option>
                  <option value="stdio" [selected]="f().type === 'stdio'">Command (stdio)</option>
                </select>
              </label>
              @if (f().type === 'stdio') {
                <label class="full">Command <input [value]="f().command" (input)="patch({ command: $any($event.target).value })" placeholder="npx" autocomplete="off" spellcheck="false"></label>
                <label class="full">Arguments, one per line <textarea rows="2" (input)="patch({ args: $any($event.target).value })" spellcheck="false">{{ f().args }}</textarea></label>
                <label class="full">Environment, NAME=value per line <textarea rows="2" (input)="patch({ env: $any($event.target).value })" spellcheck="false">{{ f().env }}</textarea></label>
              } @else {
                <label class="full">URL <input [value]="f().url" (input)="patch({ url: $any($event.target).value })" placeholder="https://mcp.example.com/mcp" autocomplete="off" spellcheck="false"></label>
                @if (agent() === 'copilot') {
                  <label class="full">Headers, Name: value per line (optional) <textarea rows="2" (input)="patch({ headers: $any($event.target).value })" spellcheck="false">{{ f().headers }}</textarea></label>
                } @else {
                  <span class="full hint">Codex signs in to a remote server while adding it, so this opens a terminal for the browser sign-in.</span>
                }
              }
              <div class="full row-end"><span class="form-err">{{ formError() }}</span><button class="btn primary sm" [disabled]="busy()" (click)="add()">Add</button></div>
            </div>
          }
          @for (s of list()!.servers; track s.name) {
            <div [class]="'check ' + (s.enabled ? (s.actions.includes('login') ? 'warn' : 'ok') : 'info')">
              <span class="ic">{{ s.enabled ? (s.actions.includes('login') ? '!' : '✓') : '–' }}</span>
              <span class="nm">{{ s.name }} <span class="tag">{{ source(s.source) }}</span></span>
              <span class="st">{{ !s.enabled ? 'Turned off' : s.actions.includes('login') ? 'Needs sign-in' : s.auth ? 'Signed in' : 'Configured' }}</span>
              @if (s.target) { <div class="tg" [title]="s.target">{{ s.transport !== 'stdio' ? s.transport.toUpperCase() + ' · ' : '' }}{{ s.target }}</div> }
              @if ((s.envKeys.length || s.headerKeys.length) && (s.source === 'user' || s.source === 'workspace')) { <div class="dt">Uses {{ [...s.envKeys, ...s.headerKeys].join(', ') }} (values stay in {{ who() }}'s config).</div> }
              @if (s.actions.length) {
                <div class="fx">
                  @if (s.actions.includes('login')) { <button class="btn primary sm" [disabled]="busy()" (click)="login(s)">Sign in</button> }
                  <span class="sp"></span>
                  @if (s.actions.includes('remove')) { <button class="btn danger sm" [disabled]="busy()" (click)="remove(s)">{{ armed() === s.name ? 'Click again to remove' : 'Remove' }}</button> }
                </div>
              }
            </div>
            } @empty { <div class="empty">No servers yet. Add one, or copy Claude's below.</div> }
          @if (agent() === 'copilot') { <div class="hint">Copilot also reads this workspace's .mcp.json, so servers the team shares with Claude show up here as "workspace".</div> }
        </div>

        @if (list()!.fromClaude.length) {
          <div class="panel">
            <div class="panel-h"><h2>Copy from Claude <span class="n">{{ list()!.fromClaude.length }}</span></h2></div>
            @for (c of shownCopies(); track c.name) {
              <div class="check info">
                <span class="ic">+</span>
                <span class="nm">{{ c.name }} <span class="tag">{{ c.from }}</span></span>
                <button class="btn ghost sm" [disabled]="busy()" (click)="copy(c)" [title]="'Adds it to ' + who() + ' as ' + c.as">Add to {{ who() }}</button>
                @if (c.target) { <div class="tg" [title]="c.target">{{ c.transport !== 'stdio' ? c.transport.toUpperCase() + ' · ' : '' }}{{ c.target }}</div> }
              </div>
            }
            @if (list()!.fromClaude.length > 8 && !allCopies()) { <div class="hint"><button class="btn ghost sm" (click)="allCopies.set(true)">Show all {{ list()!.fromClaude.length }}</button></div> }
            <div class="hint">Claude's servers {{ who() }} doesn't have yet. A claude.ai connector is copied by its address: {{ who() }} signs in to it on its own.</div>
          </div>
        }
      </div>
    }
  `,
})
export class AgentConnectionsComponent {
  readonly agent = input.required<'copilot' | 'codex'>();
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly list = signal<AgentConnections | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly armed = signal<string | null>(null);
  readonly adding = signal(false);
  readonly allCopies = signal(false);
  readonly formError = signal('');
  readonly f = signal({ name: '', type: 'http' as 'http' | 'stdio', url: '', headers: '', command: '', args: '', env: '' });

  constructor() {
    effect(() => { const a = this.agent(); untracked(() => { this.list.set(null); this.load(a); }); });
  }

  who(): string { return agentLabel(this.agent()); }
  source(s: string): string { return SOURCE[s] || s; }
  shownCopies(): FromClaude[] { const all = this.list()?.fromClaude || []; return this.allCopies() ? all : all.slice(0, 8); }
  patch(p: Partial<ReturnType<typeof this.f>>): void { this.f.set({ ...this.f(), ...p }); }

  private async load(agent = this.agent()): Promise<void> {
    try { this.list.set(await this.api.get<AgentConnections>('/api/connections/agent?agent=' + agent)); this.error.set(''); }
    catch (e) { this.error.set((e as Error).message); }
  }

  private async post(path: string, body: Record<string, unknown>, done: string): Promise<boolean> {
    this.busy.set(true);
    try {
      const r = await this.api.post<AgentConnections>('/api/connections/agent/' + path, { agent: this.agent(), ...body });
      this.list.set(r);
      if (r.terminal) this.toast.show(r.terminal.opened ? 'Opened a terminal: finish signing in there, then come back.' : 'Run this in a terminal: ' + r.terminal.command);
      else this.toast.show(done);
      return true;
    } catch (e) { this.toast.error((e as Error).message); return false; }
    finally { this.busy.set(false); }
  }

  async add(): Promise<void> {
    const v = this.f();
    let config: McpServerConfig;
    try {
      config = v.type === 'stdio'
        ? { type: 'stdio', command: v.command.trim(), args: v.args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean), env: parsePairs(v.env, '=') }
        : { type: 'http', url: v.url.trim(), headers: parsePairs(v.headers, ':') };
    } catch (e) { this.formError.set((e as Error).message); return; }
    this.formError.set('');
    if (await this.post('add', { name: v.name.trim(), config }, 'Added ' + v.name.trim())) {
      this.adding.set(false);
      this.f.set({ name: '', type: 'http', url: '', headers: '', command: '', args: '', env: '' });
    }
  }

  copy(c: FromClaude): void { this.post('copy', { name: c.name }, `Added ${c.as} to ${this.who()}`); }
  login(s: AgentServer): void { this.post('login', { name: s.name }, ''); }

  /** Two clicks: the first arms the button for a few seconds. */
  remove(s: AgentServer): void {
    if (this.armed() !== s.name) { this.armed.set(s.name); setTimeout(() => { if (this.armed() === s.name) this.armed.set(null); }, 4000); return; }
    this.armed.set(null);
    this.post('remove', { name: s.name }, 'Removed ' + s.name);
  }

  /** Back from a sign-in terminal: look again. */
  refresh(): void { this.load(); }
}

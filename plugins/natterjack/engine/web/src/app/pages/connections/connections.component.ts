import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import type { Connection, ConnectionAddRequest, ConnectionsResponse, McpLoginStart, McpLoginStatus, McpServerConfig } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { GROUP_ORDER, SCOPE_LABEL, fillVars, groupOf, pairsText, parsePairs, stateLabel, statusOf } from './connections.util';

const ICON: Record<string, string> = { ok: '✓', warn: '!', missing: '✕', info: '–' };

/** A sign-in in progress for one server: the page to open, and (OAuth servers) the callback to paste back. */
interface SignIn extends McpLoginStart { name: string; busy: boolean; message: string }

interface AddForm {
  name: string; type: 'http' | 'sse' | 'stdio'; url: string; headers: string; command: string; args: string; env: string;
  scope: 'local' | 'user'; allow: boolean;
  /** ${VAR} placeholders from connections.json and what was typed for them. */
  vars: string[]; values: Record<string, string>;
  /** connections.json's config, filled in on submit. */
  preset: McpServerConfig | null;
}

@Component({
  selector: 'dash-connections',
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './connections.component.scss',
  template: `
    @let r = data.connections();
    <dash-page-header eyebrow="Connections" title="Claude's connections"
      [sub]="api.copy('connectionsSub', 'The MCP servers Claude reaches from this workspace: claude.ai connectors, plugins, and servers added here. Dashboard runs can only use the ones you allow.')">
      <span class="ty">{{ meta() }}</span>
      <button class="btn ghost sm" (click)="openAdd(null)">Add server</button>
      <button class="btn sm" (click)="recheck()" [disabled]="busy() || !!r?.checking">{{ busy() || r?.checking ? 'Checking…' : 'Re-check' }}</button>
    </dash-page-header>

    @if (!r) { <div class="empty">Loading…</div> }
    @else {
      @if (r.configError) { <div class="warn-note">{{ r.configError }}</div> }
      @if (r.checkError) { <div class="warn-note">Couldn't run <code>claude mcp list</code>: {{ r.checkError }}</div> }
      @if (!r.connections.length) {
        <div class="panel"><div class="empty md tight" style="padding:2rem">
          <p>{{ r.checkedAt ? 'Claude has no MCP servers here yet.' : 'Checking what Claude can reach…' }} Connect claude.ai connectors at claude.ai → Settings → Connectors, or add a server here.</p>
        </div></div>
      }
      <div class="conn-groups">
        @for (g of groups(); track g.name) {
          <div class="panel">
            <div class="panel-h"><h2>{{ g.name }} <span class="n">{{ g.items.length }}</span> @if (g.bad) { <span class="n bad">{{ g.bad }}</span> }</h2></div>
            @for (c of g.items; track c.name) {
              <div [class]="'check ' + status(c)">
                <span class="ic" [title]="label(c)">{{ icon(status(c)) }}</span>
                <span class="nm">{{ c.name }} @if (scope(c)) { <span class="tag">{{ scope(c) }}</span> }</span>
                <span class="st">{{ label(c) }}</span>
                @if (c.target) { <div class="tg" [title]="c.target">{{ c.transport && c.transport !== 'stdio' ? c.transport.toUpperCase() + ' · ' : '' }}{{ c.target }}</div> }
                @if (c.required?.why) { <div class="dt"><b>Needed for:</b> {{ c.required!.why }}</div> }
                @if (c.status && status(c) !== 'ok' && c.status !== label(c)) { <div class="dt">{{ c.status }}</div> }
                @if (c.hint) { <div class="dt">{{ c.hint }}</div> }
                <div class="fx">
                  @if (c.missing && c.required?.add) { <button class="btn primary sm" (click)="openAdd(c)">Add</button> }
                  @if (c.actions.includes('login') && signIn()?.name !== c.name) { <button class="btn primary sm" [disabled]="working() === c.name" (click)="login(c)">Sign in</button> }
                  @if (c.actions.includes('approve')) { <button class="btn primary sm" [disabled]="working() === c.name" (click)="act(c, 'approve', 'Approved ' + c.name)">Approve</button> }
                  @if (c.actions.includes('allow')) {
                    <label class="chk" [title]="'Adds ' + c.rule + ' to permissions.allow in your .claude/settings.local.json. Runs never ask, so without it they can\\'t use this server\\'s tools.'">
                      <input type="checkbox" [checked]="c.allowed" [disabled]="working() === c.name" (change)="allow(c, $any($event.target).checked)"> Runs can use it
                    </label>
                  }
                  <span class="sp"></span>
                  @if (c.actions.includes('logout')) { <button class="btn ghost sm" [disabled]="working() === c.name" (click)="act(c, 'logout', 'Signed out of ' + c.name)">Sign out</button> }
                  @if (c.actions.includes('remove')) {
                    <button class="btn danger sm" [disabled]="working() === c.name" (click)="remove(c)">{{ armed() === c.name ? 'Click again to remove' : 'Remove' }}</button>
                  }
                </div>
                @if (signIn(); as s) { @if (s.name === c.name) {
                  <div class="signin">
                    <ol>
                      <li><a [href]="s.url" target="_blank" rel="noopener">Open the sign-in page ↗</a> and sign in{{ s.callback ? '' : ' on claude.ai' }}.</li>
                      @if (s.callback) {
                        <li>
                          @if (api.hosted()) { The last page won't load (it's an address on your own computer). Copy that address from the browser's address bar and paste it here: }
                          @else { This finishes by itself when you're done. If the last page doesn't load, copy its address from the address bar and paste it here: }
                          <span class="row">
                            <input #cb type="text" autocomplete="off" spellcheck="false" [placeholder]="s.callback + '?code=…'" aria-label="The address sign-in ended on" (keydown.enter)="finishSignIn(cb.value)">
                            <button class="btn primary sm" [disabled]="s.busy" (click)="finishSignIn(cb.value)">{{ s.busy ? 'Finishing…' : 'Finish sign-in' }}</button>
                          </span>
                        </li>
                      } @else {
                        <li>Come back here when it says it's connected: the page checks again.</li>
                      }
                    </ol>
                    <div class="row">@if (s.message) { <span class="msg">{{ s.message }}</span> } <span class="sp"></span><button class="btn ghost sm" (click)="cancelSignIn()">Cancel</button></div>
                  </div>
                } }
              </div>
            }
          </div>
        }
      </div>
      @if (!r.configured) {
        <div class="hint">List the servers your team relies on in <code>.claude/dashboard/connections.json</code> and they show at the top, with a count in the sidebar for anyone missing one.</div>
      }
    }

    @if (form(); as f) {
      <div class="modal" (mousedown)="onBackdrop($event)">
        <form class="modal-card" (submit)="$event.preventDefault(); submitAdd()" (keydown.escape)="closeAdd()">
          <h3>Add an MCP server</h3>
          <div class="desc">Runs <code>claude mcp add-json</code>. Tokens go straight to Claude Code's own config, never to the dashboard's.</div>
          <div class="form">
            <label>Name <input [value]="f.name" (input)="patch({ name: $any($event.target).value })" [readonly]="!!f.preset" autocomplete="off" spellcheck="false" placeholder="notion"></label>
            <label>Transport
              <select (change)="patch({ type: $any($event.target).value })" [disabled]="!!f.preset">
                <option value="http" [selected]="f.type === 'http'">HTTP</option>
                <option value="sse" [selected]="f.type === 'sse'">SSE</option>
                <option value="stdio" [selected]="f.type === 'stdio'">Command (stdio)</option>
              </select>
            </label>
            @if (f.preset) {
              @for (v of f.vars; track v) {
                <label class="full">{{ v }} <input type="password" [value]="f.values[v] || ''" (input)="setVar(v, $any($event.target).value)" autocomplete="off"></label>
              }
            } @else if (f.type === 'stdio') {
              <label class="full">Command <input [value]="f.command" (input)="patch({ command: $any($event.target).value })" placeholder="npx" autocomplete="off" spellcheck="false"></label>
              <label class="full">Arguments, one per line <textarea rows="3" (input)="patch({ args: $any($event.target).value })" spellcheck="false" placeholder="-y&#10;@some/mcp-server">{{ f.args }}</textarea></label>
              <label class="full">Environment, NAME=value per line <textarea rows="2" (input)="patch({ env: $any($event.target).value })" spellcheck="false" placeholder="API_KEY=…">{{ f.env }}</textarea></label>
            } @else {
              <label class="full">URL <input [value]="f.url" (input)="patch({ url: $any($event.target).value })" placeholder="https://mcp.example.com/mcp" autocomplete="off" spellcheck="false"></label>
              <label class="full">Headers, Name: value per line (optional; most servers sign in with OAuth instead) <textarea rows="2" (input)="patch({ headers: $any($event.target).value })" spellcheck="false" placeholder="Authorization: Bearer …">{{ f.headers }}</textarea></label>
            }
            <label class="full">For
              <select (change)="patch({ scope: $any($event.target).value })">
                <option value="local" [selected]="f.scope === 'local'">Just me, in this workspace</option>
                <option value="user" [selected]="f.scope === 'user'">Just me, in every folder</option>
              </select>
            </label>
            <label class="chk full"><input type="checkbox" [checked]="f.allow" (change)="patch({ allow: $any($event.target).checked })"> Dashboard runs can use it without asking</label>
          </div>
          <div class="form-foot">
            <span class="form-err">{{ formError() }}</span>
            <span>
              <button type="button" class="btn ghost sm" (click)="closeAdd()">Cancel</button>
              <button type="submit" class="btn primary sm" [disabled]="adding()">{{ adding() ? 'Adding…' : 'Add' }}</button>
            </span>
          </div>
        </form>
      </div>
    }
  `,
})
export class ConnectionsComponent implements OnInit, OnDestroy {
  readonly data = inject(DataService);
  readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly busy = signal(false);
  readonly working = signal<string | null>(null);
  readonly armed = signal<string | null>(null);
  readonly form = signal<AddForm | null>(null);
  readonly formError = signal('');
  readonly adding = signal(false);
  readonly signIn = signal<SignIn | null>(null);
  private poll: ReturnType<typeof setInterval> | null = null;

  readonly meta = computed(() => {
    const r = this.data.connections();
    if (!r) return '';
    if (!r.checkedAt) return 'Checking…';
    return (r.problems ? r.problems + ' need attention · ' : '') + 'checked ' + relTime(r.checkedAt);
  });
  readonly groups = computed(() => {
    const list = this.data.connections()?.connections || [];
    return GROUP_ORDER.map((name) => {
      const items = list.filter((c) => groupOf(c) === name);
      return { name, items, bad: items.filter((c) => statusOf(c) === 'missing').length };
    }).filter((g) => g.items.length);
  });

  ngOnInit(): void {
    // The sidebar loaded it once; show that, then make sure the health check is in.
    if (this.data.connections()?.checkedAt) return;
    if (!this.data.connections()) this.data.loadConnections(); // config from files right away
    this.data.loadConnections({ wait: true });
  }

  icon(s: string): string { return ICON[s] || '–'; }
  status(c: Connection): string { return statusOf(c); }
  label(c: Connection): string { return stateLabel(c); }
  scope(c: Connection): string { return SCOPE_LABEL[c.scope] || ''; }

  async recheck(): Promise<void> {
    this.busy.set(true);
    await this.data.loadConnections({ force: true });
    this.busy.set(false);
  }

  private async post(path: string, body: unknown, done?: string): Promise<boolean> {
    try {
      const r = await this.api.post<ConnectionsResponse>(path, body);
      this.data.connections.set(r);
      if (done) this.toast.show(done);
      return true;
    } catch (e) { this.toast.error((e as Error).message); return false; }
  }

  async act(c: Connection, action: 'approve' | 'logout', done: string): Promise<void> {
    this.working.set(c.name);
    await this.post('/api/connections/' + action, { name: c.name }, done);
    this.working.set(null);
  }

  async allow(c: Connection, on: boolean): Promise<void> {
    this.working.set(c.name);
    await this.post('/api/connections/allow', { name: c.name, on }, on ? `Runs can use ${c.name}` : `Runs will no longer use ${c.name}`);
    this.working.set(null);
  }

  /** Start signing in: the server runs `claude mcp login --no-browser` and hands back the page to open. */
  async login(c: Connection): Promise<void> {
    this.cancelSignIn();
    this.working.set(c.name);
    try {
      const r = await this.api.post<McpLoginStart>('/api/connections/login', { name: c.name, action: 'start' });
      if (r.terminal) {
        if (r.terminal.opened) this.toast.show('Opened a terminal to sign in. Finish in the browser; the page checks again when you come back.');
        else this.toast.error("Couldn't open a terminal. Run this in one: " + r.terminal.command);
        return;
      }
      this.signIn.set({ ...r, name: c.name, busy: false, message: '' });
      window.open(r.url, '_blank', 'noopener');
      // OAuth servers: the CLI finishes when the browser reaches its callback (locally) or the address is pasted (hosted).
      if (r.callback) this.poll = setInterval(() => this.pollSignIn(), 2000);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.working.set(null); }
  }

  private async pollSignIn(): Promise<void> {
    const s = this.signIn();
    if (!s || s.busy) return;
    try {
      const r = await this.api.post<McpLoginStatus>('/api/connections/login', { name: s.name, action: 'status' });
      if (r.done || !r.pending) this.signedIn(r);
    } catch { /* keep waiting */ }
  }

  async finishSignIn(url: string): Promise<void> {
    const s = this.signIn();
    if (!s || s.busy || !url.trim()) return;
    this.signIn.set({ ...s, busy: true, message: '' });
    try {
      const r = await this.api.post<McpLoginStatus>('/api/connections/login', { name: s.name, action: 'finish', url });
      if (r.done || !r.pending) this.signedIn(r);
      else this.signIn.set({ ...s, busy: false, message: r.message });
    } catch (e) { this.signIn.set({ ...s, busy: false, message: (e as Error).message }); }
  }

  private signedIn(r: McpLoginStatus): void {
    this.stopPoll();
    this.signIn.set(null);
    if (r.done) { if (r.ok) this.toast.show(r.message); else this.toast.error(r.message); }
    this.recheck();
  }

  cancelSignIn(): void {
    const s = this.signIn();
    this.stopPoll();
    this.signIn.set(null);
    if (s) this.api.post('/api/connections/login', { name: s.name, action: 'cancel' }).catch(() => {});
  }

  private stopPoll(): void { if (this.poll) { clearInterval(this.poll); this.poll = null; } }

  ngOnDestroy(): void { this.cancelSignIn(); }

  /** Two clicks: the first arms the button for a few seconds. */
  async remove(c: Connection): Promise<void> {
    if (this.armed() !== c.name) {
      this.armed.set(c.name);
      setTimeout(() => { if (this.armed() === c.name) this.armed.set(null); }, 4000);
      return;
    }
    this.working.set(c.name);
    if (await this.post('/api/connections/remove', { name: c.name }, 'Removed ' + c.name)) this.armed.set(null);
    this.working.set(null);
  }

  openAdd(c: Connection | null): void {
    const preset = c?.required?.add || null;
    this.formError.set('');
    this.form.set({
      name: c ? c.name : '', type: preset?.type || 'http', url: preset?.url || '', headers: pairsText(preset?.headers, ':'),
      command: preset?.command || '', args: (preset?.args || []).join('\n'), env: pairsText(preset?.env, '='),
      scope: 'local', allow: true, vars: c?.required?.vars || [], values: {}, preset,
    });
  }
  closeAdd(): void { this.form.set(null); }
  /** A method, not `a && b()` in the template: a handler that evaluates to false cancels the mousedown, so no field could get focus. */
  onBackdrop(e: MouseEvent): void { if (e.target === e.currentTarget) this.closeAdd(); }
  patch(p: Partial<AddForm>): void { const f = this.form(); if (f) this.form.set({ ...f, ...p }); }
  setVar(k: string, v: string): void { const f = this.form(); if (f) this.form.set({ ...f, values: { ...f.values, [k]: v } }); }

  async submitAdd(): Promise<void> {
    const f = this.form();
    if (!f || this.adding()) return;
    let config: McpServerConfig;
    try {
      config = f.preset ? fillVars(f.preset, f.values)
        : f.type === 'stdio'
          ? { type: 'stdio', command: f.command.trim(), args: f.args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean), env: parsePairs(f.env, '=') }
          : { type: f.type, url: f.url.trim(), headers: parsePairs(f.headers, ':') };
    } catch (e) { this.formError.set((e as Error).message); return; }
    const body: ConnectionAddRequest = { name: f.name.trim(), scope: f.scope, config, allow: f.allow };
    this.adding.set(true);
    this.formError.set('');
    try {
      this.data.connections.set(await this.api.post<ConnectionsResponse>('/api/connections/add', body));
      this.toast.show('Added ' + body.name);
      this.form.set(null);
    } catch (e) { this.formError.set((e as Error).message); }
    finally { this.adding.set(false); }
  }

  /** Back from signing in or anywhere else: re-check without making you click. A claude.ai sign-in has nothing more to wait for. */
  @HostListener('window:focus')
  onFocus(): void {
    if (this.signIn() && !this.signIn()!.callback) this.signIn.set(null);
    const r = this.data.connections();
    if (r?.checkedAt && Date.now() - r.checkedAt > 5000 && !this.busy() && !r.checking) this.recheck();
  }
}

import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import type { HostedLinkStatus, RemoteLink } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { copyText, relTime } from '../../core/util';
import { linkLive, linkState, remoteControlLine } from '../../runs/remote';

/** A file's bytes as base64, for a JSON body. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Remote control's link between a person's own computer and their hosted dashboard.
 * Hosted: "Linked computers" (make a link token, shown once; remove one).
 * Local, when hosting.json has a `url`: "Hosted dashboard link" (the token pasted from
 * there, a client certificate if the ingress asks for one, and a check of each step).
 */
@Component({
  selector: 'dash-remote-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Settings' row rules (.panel, .row, .t, .h, .ctl): this sits inside Settings, whose emulated
  // styles don't reach a child component, so it loads the same sheet (as external-docs does).
  styleUrl: './settings.component.scss',
  template: `
    @if (api.hosted()) {
      <div class="panel">
        <div class="panel-h"><h2>Linked computers</h2></div>
        <div class="rows wide">
          <div class="row">
            <div class="lbl">
              <div class="t">Link your computer</div>
              <div class="h">Lets the dashboard on your own computer reach this one without a browser, so you can follow and answer its runs from here (Remote control). Make a token, then paste it into Settings on your computer's dashboard. It's shown once.</div>
            </div>
            <div class="ctl">
              <form class="stack" (submit)="$event.preventDefault(); create()">
                <label class="vh" for="link-label">Computer name</label>
                <input id="link-label" placeholder="e.g. Work laptop" [value]="label()" (input)="label.set($any($event.target).value)" maxlength="60">
                <button class="btn primary" type="submit" [disabled]="busy()">Make a link token</button>
              </form>
            </div>
          </div>
          @if (newToken(); as t) {
            <div class="row">
              <div class="lbl">
                <div class="t">Your new link token</div>
                <div class="h">Copy it now: it isn't shown again. Anyone with it (and, where the ingress asks, a client certificate) can reach this dashboard's Remote control API, so treat it like a password.</div>
              </div>
              <div class="ctl">
                <code class="token">{{ t }}</code>
                <button class="btn" type="button" (click)="copy(t)">Copy</button>
              </div>
            </div>
          }
          @for (l of links(); track l.id) {
            <div class="row">
              <div class="lbl">
                <div class="t">{{ l.label }}</div>
                <!-- The state line below shows when it was last seen; "last used" only when it has never synced. -->
                <div class="h">Linked {{ rel(l.createdAt) }}@if (!l.lastSeenAt) { · {{ l.lastUsedAt ? 'last used ' + rel(l.lastUsedAt) : 'not used yet' }}}</div>
                @if (linkLine(l); as s) { <div class="h state" [class.on]="s.startsWith('Online')">{{ s }}</div> }
              </div>
              <div class="ctl"><button class="btn danger" type="button" [disabled]="busy()" (click)="revoke(l)">Remove</button></div>
            </div>
          }
        </div>
      </div>
    } @else if (api.boot()?.hostedUrl) {
      @let st = status();
      <div class="panel">
        <div class="panel-h"><h2>Hosted dashboard link</h2><span class="ty">{{ api.boot()?.hostedUrl }}</span></div>
        <div class="rows wide">
          <div class="row">
            <div class="lbl">
              <div class="t">Link token</div>
              <div class="h">
                Make one on your hosted dashboard (Settings › Linked computers) and paste it here.
                @if (st?.token?.present) { Linked for <b>{{ st?.token?.email }}</b>@if (st?.token?.fromEnv) { (from DASHBOARD_LINK_TOKEN)}. }
              </div>
            </div>
            <div class="ctl">
              <form class="pair" (submit)="$event.preventDefault(); saveToken()">
                <label class="vh" for="link-token">Link token</label>
                <input id="link-token" type="password" autocomplete="off" spellcheck="false" placeholder="njl1.…" [value]="token()" (input)="token.set($any($event.target).value)">
                <button class="btn" type="submit" [disabled]="busy() || !token().trim()">Save</button>
              </form>
            </div>
          </div>
          <div class="row">
            <div class="lbl">
              <div class="t">Client certificate</div>
              <div class="h">
                Only if the hosted dashboard's address asks for one (mutual TLS). A <code>.p12</code> or <code>.pfx</code> file with its key: a certificate in your system's store can't be used here.
                @if (st?.certificate?.present) { One is added@if (st?.certificate?.fromEnv) { (DASHBOARD_CLIENT_CERT)}. }
              </div>
            </div>
            <div class="ctl">
              <form class="group" (submit)="$event.preventDefault(); saveCertificate(file.files?.[0] || null)">
                <label class="vh" for="link-cert">Certificate file</label>
                <input #file id="link-cert" type="file" accept=".p12,.pfx">
                <div class="pair">
                  <label class="vh" for="link-pass">Passphrase</label>
                  <input id="link-pass" type="password" autocomplete="off" placeholder="Passphrase" [value]="pass()" (input)="pass.set($any($event.target).value)">
                  <button class="btn" type="submit" [disabled]="busy()">Add</button>
                </div>
              </form>
            </div>
          </div>
          <div class="row">
            <div class="lbl">
              <div class="t">Check the link</div>
              <div class="h">
                Tries each step in turn.
                @if (st?.lastCheck; as c) { Last checked {{ rel(c.at) }}: {{ c.ok ? 'working' : 'not working' }}. }
              </div>
              @if (st?.lastCheck; as c) {
                <ul class="steps">
                  @for (s of c.steps; track s.name) { <li [class.bad]="!s.ok"><b>{{ s.ok ? '✓' : '✕' }} {{ s.name }}</b> {{ s.message }}</li> }
                </ul>
              }
            </div>
            <div class="ctl">
              <div class="btns">
                <button class="btn primary" type="button" [disabled]="busy()" (click)="check()">{{ checking() ? 'Checking…' : 'Check' }}</button>
                @if (st?.token?.present || st?.certificate?.present) { <button class="btn ghost" type="button" [disabled]="busy()" (click)="forget()">Forget</button> }
              </div>
            </div>
          </div>
          <div class="row">
            <div class="lbl">
              <div class="t">Remote control</div>
              <div class="h">Lets you follow and reply to this computer's runs from your hosted dashboard. Your runs' records and recent events are copied there; the work stays on this computer.</div>
            </div>
            <!-- The switch, its state line and the hint read as one group in the control column. -->
            <div class="ctl switch">
              <label class="chk">
                <input type="checkbox" [attr.aria-describedby]="rcDescribedBy()" [checked]="!!st?.remoteControl?.on" [disabled]="busy() || rcBlocked()" (change)="setRemoteControl($any($event.target))"> Use Remote control
              </label>
              <!-- Not a live region: the line's "last sync 12 s ago" changes every 5 s and would be read out each time. -->
              @if (st) { <div id="rc-state" class="h state" [class.on]="st.remoteControl.on && st.remoteControl.state === 'connected'" [class.bad]="st.remoteControl.on && (st.remoteControl.state === 'refused' || st.remoteControl.state === 'error')">{{ controlLine() }}</div> }
              @if (rcBlocked()) { <div id="rc-hint" class="h">Add a link token first.</div> }
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    /* These rows' forms need more room than Settings' 260 px control column. */
    @media not (max-width: 700px) { .rows.wide .row { grid-template-columns: 1fr 300px; } }
    .ctl > * { max-width: 100%; }
    .ctl form, .ctl .token { align-self: stretch; }
    .stack { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .stack input { width: 100%; }
    .pair { display: flex; gap: 6px; align-items: center; }
    .pair input { flex: 1; min-width: 0; }
    .group { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--line-soft); border-radius: var(--r-sm); background: var(--paper-2); }
    .group input[type=file] { width: 100%; min-width: 0; font-size: 12.5px; }
    .btns { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .token { display: block; font-family: var(--font-mono); font-size: 12px; word-break: break-all; user-select: all; padding: 8px 10px; border: 1px solid var(--line-soft); border-radius: var(--r-sm); background: var(--paper-2); }
    .switch .h { margin-top: 0; }
    .steps { margin: 8px 0 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--ink-soft); }
    .steps li.bad b { color: var(--bad, #b42318); }
    .state { margin-top: 4px; }
    .state.on { color: var(--green); }
    .state.bad { color: var(--bad, #b42318); }
  `],
})
export class RemoteLinkComponent implements OnInit, OnDestroy {
  readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly data = inject(DataService);

  readonly links = signal<RemoteLink[]>([]);
  readonly newToken = signal<string | null>(null);
  readonly label = signal('');
  readonly status = signal<HostedLinkStatus | null>(null);
  readonly token = signal('');
  readonly pass = signal('');
  readonly busy = signal(false);
  readonly checking = signal(false);
  /** Ticks with the refresh, so "last sync 12 s ago" and "Online" / "Last seen" stay current. */
  private readonly now = signal(Date.now());
  /** When this browser received `links` (Date.now()): their `online` is trusted for ONLINE_MS after (runs/remote.ts linkLive), when DataService has no live entry. */
  private linksAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  /** Bumped when a change starts and ends, so a refresh that was in flight meanwhile drops its (older) result. */
  private seq = 0;

  /** Remote control needs a link token and the hosted dashboard's address. */
  readonly canRemote = computed(() => {
    const st = this.status();
    return !!st?.token?.present && !!(st.url || this.api.boot()?.hostedUrl);
  });
  /** The switch is off and can't be turned on yet. */
  readonly rcBlocked = computed(() => !this.status()?.remoteControl?.on && !this.canRemote());
  readonly rcDescribedBy = computed(() => [this.status() ? 'rc-state' : '', this.rcBlocked() ? 'rc-hint' : ''].filter(Boolean).join(' ') || null);
  readonly controlLine = computed(() => {
    const st = this.status();
    return st ? remoteControlLine(st.remoteControl, this.now()) : '';
  });

  async ngOnInit(): Promise<void> {
    await this.api.loadBoot();
    await this.refresh();
    if (this.destroyed || !(this.api.hosted() || this.api.boot()?.hostedUrl)) return;
    // Linked computers come and go, and Remote control's state changes on its own: refresh while the page is open.
    this.timer = setInterval(() => { this.now.set(Date.now()); if (!document.hidden && !this.busy()) this.refresh(); }, 5000);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    const seq = this.seq;
    try {
      if (this.api.hosted()) {
        const links = (await this.api.get<{ links: RemoteLink[] }>('/api/remote-links')).links;
        if (seq === this.seq) this.setLinks(links);
      } else if (this.api.boot()?.hostedUrl) {
        const st = await this.api.get<HostedLinkStatus>('/api/hosted-link');
        if (seq === this.seq) this.status.set(st);
      }
    } catch { /* the rest of Settings still works */ }
    this.now.set(Date.now());
  }

  private setLinks(links: RemoteLink[]): void {
    this.linksAt = Date.now();
    this.links.set(links);
  }

  rel(at: string): string { return relTime(at); }

  /**
   * A link's state line, by the run list's rule (runs/remote.ts linkLive): DataService's live entry
   * for it (the `remote-links` topic, stamped on arrival), else this page's last fetch, stamped when
   * it arrived. Reads both clocks, so it moves with the list's and this page's refresh.
   */
  linkLine(l: RemoteLink): string {
    const now = Math.max(this.now(), this.data.now());
    const entry = this.data.remoteLinks().find((x) => x.linkId === l.id)
      ?? (this.linksAt == null ? null : { label: l.label, online: !!l.online, enabled: l.enabled !== false, lastSeenAt: l.lastSeenAt ?? null, receivedAt: this.linksAt });
    return linkState(linkLive(entry, { enabled: l.enabled !== false, label: l.label }, now), now);
  }

  async setRemoteControl(box: HTMLInputElement): Promise<void> {
    const on = box.checked;
    await this.local({ action: 'remote-control', on }, on ? 'Remote control on' : 'Remote control off');
    // A refused change leaves the binding's value as it was, so put the box back by hand.
    box.checked = !!this.status()?.remoteControl?.on;
  }

  async copy(t: string): Promise<void> {
    if (await copyText(t)) this.toast.show('Copied the link token'); else this.toast.error("Couldn't copy: select it and copy it yourself.");
  }

  private async run<T>(fn: () => Promise<T>): Promise<T | null> {
    this.busy.set(true);
    this.seq++;
    try { return await fn(); }
    catch (e) { this.toast.error((e as Error).message); return null; }
    finally { this.seq++; this.busy.set(false); }
  }

  async create(): Promise<void> {
    const r = await this.run(() => this.api.post<{ token: string; links: RemoteLink[] }>('/api/remote-links', { action: 'create', label: this.label() }));
    if (!r) return;
    this.newToken.set(r.token);
    this.setLinks(r.links);
    this.label.set('');
  }

  async revoke(l: RemoteLink): Promise<void> {
    if (!confirm(`Remove "${l.label}"? Its token stops working at once.`)) return;
    const r = await this.run(() => this.api.post<{ links: RemoteLink[] }>('/api/remote-links', { action: 'revoke', id: l.id }));
    if (r) { this.setLinks(r.links); this.toast.show('Removed'); }
  }

  private async local(body: Record<string, unknown>, done?: string): Promise<void> {
    const st = await this.run(() => this.api.post<HostedLinkStatus>('/api/hosted-link', body));
    if (!st) return;
    this.status.set(st);
    if (st.notice || done) this.toast.show(st.notice || done!);
  }

  async saveToken(): Promise<void> {
    await this.local({ action: 'token', token: this.token().trim() }, 'Link token saved');
    this.token.set('');
  }

  async saveCertificate(file: File | null): Promise<void> {
    if (!file) { this.toast.error('Pick the certificate file first.'); return; }
    await this.local({ action: 'certificate', pfx: await base64Of(file), passphrase: this.pass() }, 'Certificate added');
    this.pass.set('');
  }

  async check(): Promise<void> {
    this.checking.set(true);
    try { await this.local({ action: 'check' }); } finally { this.checking.set(false); }
  }

  async forget(): Promise<void> {
    if (!confirm('Forget this computer\'s link token and certificate? Remote control stops until you add them again.')) return;
    await this.local({ action: 'forget' }, 'Forgotten');
  }
}

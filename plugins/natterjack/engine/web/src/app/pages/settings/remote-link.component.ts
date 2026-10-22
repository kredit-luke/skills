import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import type { HostedLinkStatus, RemoteLink } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { copyText, relTime } from '../../core/util';

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
  template: `
    @if (api.hosted()) {
      <div class="panel">
        <div class="panel-h"><h2>Linked computers</h2></div>
        <div class="rows">
          <div class="row">
            <div class="lbl">
              <div class="t">Link your computer</div>
              <div class="h">Lets the dashboard on your own computer reach this one without a browser, so you can follow and answer its runs from here (Remote control). Make a token, then paste it into Settings on your computer's dashboard. It's shown once.</div>
            </div>
            <div class="ctl">
              <form class="inline" (submit)="$event.preventDefault(); create()">
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
              <div class="ctl tok">
                <code class="token">{{ t }}</code>
                <button class="btn" type="button" (click)="copy(t)">Copy</button>
              </div>
            </div>
          }
          @for (l of links(); track l.id) {
            <div class="row">
              <div class="lbl">
                <div class="t">{{ l.label }}</div>
                <div class="h">Linked {{ rel(l.createdAt) }} · {{ l.lastUsedAt ? 'last used ' + rel(l.lastUsedAt) : 'not used yet' }}</div>
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
        <div class="rows">
          <div class="row">
            <div class="lbl">
              <div class="t">Link token</div>
              <div class="h">
                Make one on your hosted dashboard (Settings › Linked computers) and paste it here.
                @if (st?.token?.present) { Linked for <b>{{ st?.token?.email }}</b>@if (st?.token?.fromEnv) { (from DASHBOARD_LINK_TOKEN)}. }
              </div>
            </div>
            <div class="ctl">
              <form class="inline" (submit)="$event.preventDefault(); saveToken()">
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
              <form class="inline" (submit)="$event.preventDefault(); saveCertificate(file.files?.[0] || null)">
                <label class="vh" for="link-cert">Certificate file</label>
                <input #file id="link-cert" type="file" accept=".p12,.pfx">
                <label class="vh" for="link-pass">Passphrase</label>
                <input id="link-pass" type="password" autocomplete="off" placeholder="Passphrase" [value]="pass()" (input)="pass.set($any($event.target).value)">
                <button class="btn" type="submit" [disabled]="busy()">Add</button>
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
              <button class="btn primary" type="button" [disabled]="busy()" (click)="check()">{{ checking() ? 'Checking…' : 'Check' }}</button>
              @if (st?.token?.present || st?.certificate?.present) { <button class="btn ghost" type="button" [disabled]="busy()" (click)="forget()">Forget</button> }
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .inline { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
    .inline input:not([type=file]) { min-width: 180px; }
    .tok { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .token { font-family: var(--font-mono); font-size: 12px; word-break: break-all; max-width: 420px; user-select: all; }
    .steps { margin: 8px 0 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--ink-soft); }
    .steps li.bad b { color: var(--bad, #b42318); }
  `],
})
export class RemoteLinkComponent implements OnInit {
  readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly links = signal<RemoteLink[]>([]);
  readonly newToken = signal<string | null>(null);
  readonly label = signal('');
  readonly status = signal<HostedLinkStatus | null>(null);
  readonly token = signal('');
  readonly pass = signal('');
  readonly busy = signal(false);
  readonly checking = signal(false);

  async ngOnInit(): Promise<void> {
    await this.api.loadBoot();
    try {
      if (this.api.hosted()) this.links.set((await this.api.get<{ links: RemoteLink[] }>('/api/remote-links')).links);
      else if (this.api.boot()?.hostedUrl) this.status.set(await this.api.get<HostedLinkStatus>('/api/hosted-link'));
    } catch { /* the rest of Settings still works */ }
  }

  rel(at: string): string { return relTime(at); }

  async copy(t: string): Promise<void> {
    if (await copyText(t)) this.toast.show('Copied the link token'); else this.toast.error("Couldn't copy: select it and copy it yourself.");
  }

  private async run<T>(fn: () => Promise<T>): Promise<T | null> {
    this.busy.set(true);
    try { return await fn(); }
    catch (e) { this.toast.error((e as Error).message); return null; }
    finally { this.busy.set(false); }
  }

  async create(): Promise<void> {
    const r = await this.run(() => this.api.post<{ token: string; links: RemoteLink[] }>('/api/remote-links', { action: 'create', label: this.label() }));
    if (!r) return;
    this.newToken.set(r.token);
    this.links.set(r.links);
    this.label.set('');
  }

  async revoke(l: RemoteLink): Promise<void> {
    if (!confirm(`Remove "${l.label}"? Its token stops working at once.`)) return;
    const r = await this.run(() => this.api.post<{ links: RemoteLink[] }>('/api/remote-links', { action: 'revoke', id: l.id }));
    if (r) { this.links.set(r.links); this.toast.show('Removed'); }
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

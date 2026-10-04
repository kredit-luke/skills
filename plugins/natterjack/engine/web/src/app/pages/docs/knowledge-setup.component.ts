import { ChangeDetectionStrategy, Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DocSite, KnowledgeSetup, KnowledgeTool } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { inlineMd } from '../../core/markdown';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { reach } from './knowledge.util';

interface Pick { on: boolean; url: string; area: string }
interface Other { on: boolean; name: string; url: string; connection: string; area: string }
interface StoreForm { on: boolean; name: string; type: 's3' | 'gcs' | 'azure-blob'; bucket: string; region: string; account: string; container: string; prefix: string; area: string }

/**
 * Knowledge setup: which tools the team keeps its knowledge in (more than one), saved to
 * the workspace config for everyone (docs.json sources, connections.json requirements);
 * then each person's own status: can Claude reach each one, and how to connect it.
 * Teams that use none of them get a store in their own bucket, set up by their admin.
 */
@Component({
  selector: 'dash-knowledge-setup',
  imports: [RouterLink, TrustedHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './knowledge-setup.component.scss',
  template: `
    <div class="panel setup">
      <div class="head">
        <h3>Where does your team keep its knowledge?</h3>
        <button class="btn ghost sm" type="button" (click)="closed.emit()">Close</button>
      </div>
      @if (!setup()) { <div class="empty">Loading…</div> }
      @else {
        <p class="sub">Pick every tool you use. Claude reads each one through its connector, and everyone sees whether theirs is connected.</p>
        @if (!setup()!.canEdit) {
          <div class="warn-note">This dashboard is hosted, so the tool list is changed by whoever maintains the workspace (it's in <code>.claude/dashboard/docs.json</code>). Your own connections are below.</div>
        }
        <div class="tools">
          @for (t of setup()!.catalog; track t.id) {
            <div class="tool" [class.on]="picks()[t.id]?.on">
              <label class="chk"><input type="checkbox" [disabled]="!setup()!.canEdit" [checked]="picks()[t.id]?.on" (change)="pick(t.id, { on: $any($event.target).checked })"> <b>{{ t.label }}</b></label>
              <span class="ty">{{ t.description }}</span>
              @if (picks()[t.id]?.on && setup()!.canEdit) {
                <input [value]="picks()[t.id].url" [placeholder]="t.urlPlaceholder" [attr.aria-label]="t.label + ' ' + t.urlLabel" (input)="pick(t.id, { url: $any($event.target).value })" autocomplete="off" spellcheck="false">
                <span class="ty">{{ t.urlLabel }}{{ t.urlRequired ? '' : ' (optional)' }}</span>
                @if (areas().length) { <select (change)="pick(t.id, { area: $any($event.target).value })">@for (o of areaOptions(); track o.key) { <option [value]="o.key" [selected]="o.key === picks()[t.id].area">{{ o.label }}</option> }</select> }
              }
            </div>
          }
          <div class="tool" [class.on]="other().on">
            <label class="chk"><input type="checkbox" [disabled]="!setup()!.canEdit" [checked]="other().on" (change)="other.set({ ...other(), on: $any($event.target).checked })"> <b>Another tool</b></label>
            <span class="ty">Guru, Coda, GitBook, an internal wiki…</span>
            @if (other().on && setup()!.canEdit) {
              <input [value]="other().name" placeholder="Name" aria-label="Tool name" (input)="other.set({ ...other(), name: $any($event.target).value })" autocomplete="off">
              <input [value]="other().url" placeholder="https://…" aria-label="Link" (input)="other.set({ ...other(), url: $any($event.target).value })" autocomplete="off" spellcheck="false">
              <input [value]="other().connection" placeholder="Its MCP server, as Connections shows it (optional)" aria-label="MCP server name" (input)="other.set({ ...other(), connection: $any($event.target).value })" autocomplete="off" spellcheck="false">
            }
          </div>
          <div class="tool" [class.on]="store().on">
            <label class="chk"><input type="checkbox" [disabled]="!setup()!.canEdit" [checked]="store().on" (change)="store.set({ ...store(), on: $any($event.target).checked })"> <b>None of these</b></label>
            <span class="ty">Keep notes in your own storage (S3, Google Cloud Storage or Azure), written and edited right here. No GitHub seats needed.</span>
          </div>
        </div>

        @if (store().on && setup()!.canEdit) {
          <div class="store">
            <h4>Notes in your own storage</h4>
            <div class="form">
              <label>Name <input [value]="store().name" placeholder="Company handbook" (input)="setStore({ name: $any($event.target).value })" autocomplete="off"></label>
              <label>Storage
                <select (change)="setStore({ type: $any($event.target).value })">
                  <option value="s3" [selected]="store().type === 's3'">Amazon S3 (or S3-compatible)</option>
                  <option value="gcs" [selected]="store().type === 'gcs'">Google Cloud Storage</option>
                  <option value="azure-blob" [selected]="store().type === 'azure-blob'">Azure Blob Storage</option>
                </select>
              </label>
              @if (store().type === 'azure-blob') {
                <label>Storage account <input [value]="store().account" placeholder="acmeknowledge" (input)="setStore({ account: $any($event.target).value })" autocomplete="off" spellcheck="false"></label>
                <label>Container <input [value]="store().container" placeholder="knowledge" (input)="setStore({ container: $any($event.target).value })" autocomplete="off" spellcheck="false"></label>
              } @else {
                <label>Bucket <input [value]="store().bucket" placeholder="acme-knowledge" (input)="setStore({ bucket: $any($event.target).value })" autocomplete="off" spellcheck="false"></label>
                @if (store().type === 's3') { <label>Region <input [value]="store().region" placeholder="us-east-1" (input)="setStore({ region: $any($event.target).value })" autocomplete="off" spellcheck="false"></label> }
              }
              <label>Folder in it (optional) <input [value]="store().prefix" placeholder="company/" (input)="setStore({ prefix: $any($event.target).value })" autocomplete="off" spellcheck="false"></label>
              @if (areas().length) { <label>Area <select (change)="setStore({ area: $any($event.target).value })">@for (o of areaOptions(); track o.key) { <option [value]="o.key" [selected]="o.key === store().area">{{ o.label }}</option> }</select></label> }
            </div>
            <details class="guide" open>
              <summary>What your admin sets up</summary>
              <ol>
                <li>A bucket (or a folder in one) for these notes. One per area works well when only some people should read an area, such as Finance.</li>
                <li>A key that can list, read, write and delete there: an IAM user or role for S3; an HMAC key for Google Cloud Storage (Cloud Storage → Settings → Interoperability); a SAS token with read, add, create, write, delete and list for Azure, issued from a stored access policy so it can be revoked.</li>
                <li>Hosted dashboards: put the key in the deployment's secrets as <code>KNOWLEDGE_{{ envKey() }}_KEY</code>, and nobody has to paste it. Local dashboards: each person pastes it on the notes page.</li>
                <li>Commit <code>.claude/dashboard/docs.json</code> so everyone gets the new source. Never put the key in it.</li>
              </ol>
            </details>
          </div>
        }

        @if (setup()!.canEdit) {
          <div class="foot">
            <span class="form-err">{{ error() }}</span>
            <button class="btn primary sm" [disabled]="busy()" (click)="save()">{{ busy() ? 'Saving…' : 'Save' }}</button>
          </div>
        }

        @if (chosenSites().length) {
          <div class="status">
            <h4>Your connections</h4>
            @for (s of chosenSites(); track s.key) {
              <div class="st-row">
                <b>{{ s.name }}</b>
                @switch (reach(s)) {
                  @case ('ok') { <span class="reach ok">✓ Claude can reach it</span> }
                  @case ('bad') { <span class="reach bad">! Not connected for you</span> }
                  @case ('checking') { <span class="reach">Checking…</span> }
                  @default { <span class="reach">No connector named: Claude can't read it yet</span> }
                }
                @if (reach(s) === 'bad' || reach(s) === 'none') {
                  <div class="help">
                    @if (helpFor(s); as h) { <span [innerHTML]="inline(h) | trustedHtml"></span> }
                    <a routerLink="/connections">Open Connections</a>
                  </div>
                }
              </div>
            }
          </div>
        }
      }
    </div>
  `,
})
export class KnowledgeSetupComponent implements OnInit {
  readonly closed = output<void>();
  /** Saved: the parent keeps the panel open to show the new status. */
  readonly saved = output<void>();
  private readonly api = inject(ApiService);
  readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  readonly setup = signal<KnowledgeSetup | null>(null);
  readonly picks = signal<Record<string, Pick>>({});
  readonly other = signal<Other>({ on: false, name: '', url: '', connection: '', area: '' });
  readonly store = signal<StoreForm>({ on: false, name: '', type: 's3', bucket: '', region: '', account: '', container: '', prefix: '', area: '' });
  readonly busy = signal(false);
  readonly error = signal('');

  readonly areas = computed(() => this.data.docAreas());
  readonly areaOptions = computed(() => [{ key: '', label: 'No area' }, ...this.areas().map((a) => ({ key: a.key, label: a.label }))]);
  readonly chosenSites = computed(() => this.data.docSites().filter((s) => !!s.tool));
  readonly envKey = computed(() => (this.store().name || 'SOURCE').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''));

  async ngOnInit(): Promise<void> {
    try {
      const s = await this.api.get<KnowledgeSetup>('/api/knowledge/setup');
      this.setup.set(s);
      const picks: Record<string, Pick> = {};
      for (const t of s.catalog) {
        const c = s.chosen.find((x) => x.tool === t.id);
        picks[t.id] = { on: !!c, url: c?.url && !/^https:\/\/(www\.notion\.so|drive\.google\.com|www\.office\.com)\/?$/.test(c.url) ? c.url : '', area: c?.area || '' };
      }
      this.picks.set(picks);
      const o = s.chosen.find((x) => x.tool === 'other');
      if (o) this.other.set({ on: true, name: o.name, url: o.url || '', connection: o.connection[0] || '', area: o.area || '' });
    } catch (e) { this.error.set((e as Error).message); }
  }

  pick(id: string, p: Partial<Pick>): void { this.picks.set({ ...this.picks(), [id]: { ...this.picks()[id], ...p } }); }
  setStore(p: Partial<StoreForm>): void { this.store.set({ ...this.store(), ...p }); }
  reach(s: DocSite) { return reach(s, this.data.connections()); }
  inline(s: string): string { return inlineMd(s); }
  helpFor(s: DocSite): string | null { return this.setup()?.catalog.find((t: KnowledgeTool) => t.id === s.tool)?.connectHelp || null; }

  async save(): Promise<void> {
    const s = this.setup();
    if (!s || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const tools = s.catalog.filter((t) => this.picks()[t.id]?.on).map((t) => ({ tool: t.id, url: this.picks()[t.id].url.trim() || null, area: this.picks()[t.id].area || null }));
      const o = this.other();
      if (o.on) tools.push({ tool: 'other', name: o.name.trim(), url: o.url.trim() || null, area: o.area || null, connection: o.connection.trim() || null } as any);
      let next = await this.api.post<KnowledgeSetup>('/api/knowledge/setup', { tools });
      const st = this.store();
      if (st.on) {
        const store = st.type === 'azure-blob' ? { type: st.type, account: st.account, container: st.container, prefix: st.prefix }
          : { type: st.type, bucket: st.bucket, region: st.region, prefix: st.prefix };
        next = await this.api.post<KnowledgeSetup>('/api/knowledge/store-source', { name: st.name, area: st.area || null, store });
        this.store.set({ ...st, on: false });
      }
      this.setup.set(next);
      this.saved.emit();
      await Promise.all([this.data.loadDocs(), this.data.loadConnections({ wait: true })]);
      this.toast.show('Saved to the workspace config. Commit .claude/dashboard so your team gets it.');
    } catch (e) { this.error.set((e as Error).message); }
    finally { this.busy.set(false); }
  }
}

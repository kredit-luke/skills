import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Access, PeopleActionName, PeopleActionResponse, PeopleResponse, PeopleRole, PeopleRolesRequest, PeopleRoster, PersonRow, PersonState } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { LaunchService } from '../../core/launch.service';
import { ToastService } from '../../core/toast.service';
import { relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';

const SETUP_PROMPT = `Set up the dashboard's People page for our hosted dashboards. Write .claude/dashboard/hosting.json (the natterjack plugin's references/hosting.md, "Managing people from your dashboard", describes it): our directory (Google Workspace or Microsoft Entra ID, our email domain and optionally an OU or department), where the dashboards run (a Kubernetes context and namespace, or an Azure App Service resource group with its plan, storage account, registry and Key Vault), and a couple of profiles. Copy the matching template from the plugin's templates/hosted/ (kubernetes-person.yaml or app-service-person.bicep) into this workspace (for example hosting/), fill in our settings, and point "platform.template" at it. If dashboards already exist, look at how they're set up and match it. Ask me for anything you can't find from the CLIs I'm signed in to (kubectl, gcloud, az). Don't create or change anything in the cloud.`;

const LABELS: Record<PersonState, string> = {
  'not-set-up': 'Not set up', running: 'Running', starting: 'Starting', stopped: 'Stopped',
  left: 'Left', missing: 'Missing', unmanaged: 'Not in roster',
};
const TAG: Record<PersonState, string> = {
  'not-set-up': '', running: 'good', starting: 'amber', stopped: '', left: 'bad', missing: 'amber', unmanaged: 'amber',
};
type Filter = 'set-up' | 'not-set-up' | 'attention' | 'all';

/** `role`: a workspace role id, or '' for "they pick their own". `access`: 'full', 'read', or '' for the role's. */
interface Pending { row: PersonRow; action: PeopleActionName; profile?: string; role?: string; access?: string; keepVolume?: boolean; preview: PeopleActionResponse | null; error: string | null; busy: boolean; confirmText: string }
/** The role being added (no id) or edited in the Roles dialog. */
interface RoleDraft { id: string | null; label: string; description: string; access: Access; outputStyle: string; busy: boolean; error: string | null }

/**
 * Who in the company has a hosted dashboard (references/hosting.md): the directory (the
 * whole domain or one OU), the roster (.claude/dashboard/people.json, committed), and the
 * platform (Kubernetes or App Service), side by side.
 * Every change is previewed (a server-side dry run) before it's made. Local dashboards
 * only: it runs the engineer's own kubectl or az, gcloud, and git.
 */
@Component({
  selector: 'dash-people',
  imports: [PageHeaderComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './people.component.scss',
  template: `
    <dash-page-header eyebrow="Workspace" title="People" [sub]="sub()">
      @if (view()?.configured) { <button class="btn ghost sm" [disabled]="loading()" (click)="load(true)">{{ loading() ? 'Refreshing…' : 'Refresh' }}</button> }
    </dash-page-header>

    @if (!view()) { <div class="empty">{{ loading() ? 'Reading the directory, the roster and where the dashboards run…' : '' }}</div> }
    @else if (!view()!.configured) {
      <div class="panel none">
        <h2>Manage who has a hosted dashboard</h2>
        <p>This page lists everyone in your company's directory (Google Workspace or Microsoft Entra ID), shows who has a hosted
          dashboard and their profile, and sets people up or removes them on Kubernetes or Azure App Service. It uses the CLIs you're
          already signed in to (kubectl or az, and gcloud for a Google directory), and keeps the list of who has one in <code>.claude/dashboard/people.json</code>, committed with the rest of the config.</p>
        <p>It needs <code>.claude/dashboard/hosting.json</code> to say where everything is.</p>
        <div class="acts">
          <button class="btn primary sm" type="button" (click)="setup()">Ask Claude to set it up</button>
        </div>
      </div>
    } @else if (view()!.problems.length) {
      <div class="panel none">
        <h2>hosting.json needs fixing</h2>
        @for (p of view()!.problems; track p) { <p class="problem">{{ p }}</p> }
      </div>
    } @else {
      @for (e of view()!.errors; track e.source) {
        <div class="warn-note err"><b>{{ sourceLabel(e.source) }}:</b> {{ e.message }}
          @if (e.source === 'directory' && view()!.directory.type === 'google') {
            <!-- The Machine page takes the OAuth client file and runs this sign-in (people/google-login.ts). -->
            <div class="fix"><a class="btn primary sm" routerLink="/machine">Sign in on the Machine page</a> <span class="muted">(Google Workspace directory, under People page)</span></div>
          }
          @if (e.fix) { <div class="fix">Fix: <code>{{ e.fix }}</code> <button class="btn ghost sm" (click)="copy(e.fix)">Copy</button></div> }
        </div>
      }

      @if (view()!.roster?.uncommitted) {
        <div class="panel commit">
          <div class="ct">
            <b>{{ view()!.roster!.file }} has changes that aren't committed.</b> Other engineers see them once you commit and push.
            <ul>@for (c of view()!.roster!.changes; track c) { <li>{{ c }}</li> }</ul>
          </div>
          <button class="btn sm primary" [disabled]="committing()" (click)="commit()">{{ committing() ? 'Committing…' : 'Commit' }}</button>
        </div>
      }
      @if (view()!.rolesFile?.uncommitted) {
        <div class="panel commit">
          <div class="ct">
            <b>{{ view()!.rolesFile!.file }} has role changes that aren't committed.</b> Hosted dashboards get them once you commit, push and publish the snapshot; other engineers once you push.
            <ul>@for (c of view()!.rolesFile!.changes; track c) { <li>{{ c }}</li> }</ul>
          </div>
          <button class="btn sm primary" [disabled]="committing()" (click)="commitRoles()">{{ committing() ? 'Committing…' : 'Commit' }}</button>
        </div>
      }

      <!-- Tabs, so a long roster doesn't push the roles out of sight. -->
      <div class="page-tabs" role="tablist">
        <button type="button" role="tab" [class.on]="tab() === 'people'" [attr.aria-selected]="tab() === 'people'" (click)="tab.set('people')">People <span class="n">{{ counts()['set-up'] }}</span></button>
        <button type="button" role="tab" [class.on]="tab() === 'roles'" [attr.aria-selected]="tab() === 'roles'" (click)="tab.set('roles')">Roles <span class="n">{{ view()!.roles.length }}</span></button>
      </div>

      @if (tab() === 'people') {
      <div class="bar">
        <div class="seg">
          @for (f of filters; track f.id) {
            <button type="button" [class.on]="filter() === f.id" (click)="filter.set(f.id)">{{ f.label }} <span class="n">{{ counts()[f.id] }}</span></button>
          }
        </div>
        <input type="search" placeholder="Search people" [value]="query()" (input)="query.set($any($event.target).value)" />
        <!-- Every directory type: the directory may be unreadable yet (no admin role), or miss someone. -->
        <form class="add" (submit)="$event.preventDefault(); addByEmail(addInput.value); addInput.value = ''">
          <input #addInput type="email" placeholder="name@company.com" required />
          <button class="btn sm" type="submit">Set up…</button>
        </form>
      </div>

      <div class="panel">
        <table class="people">
          <thead><tr><th>Person</th><th>Dashboard</th><th title="hosting.json profiles: memory, CPU, runs at once and areas">Profile</th>@if (hasRoles()) { <th title="workspace.json roles: who they are and how Claude answers them; they can't change it">Role</th> }<th title="What they can do with the code: full stack (GitHub sign-in, Implement, Publish) or read-only; by default their role's">Access</th><th>Set up</th><th></th></tr></thead>
          <tbody>
            @for (r of shown(); track r.email) {
              <tr [class.dim]="r.state === 'not-set-up'">
                <td><div class="nm">{{ r.name }}</div><div class="em">{{ r.email }}</div></td>
                <td>
                  <span [class]="'tag ' + tag(r.state)">{{ label(r.state) }}</span>
                  @if (r.needsUpdate) { <span class="tag amber" title="The template, its profile or the image changed since it was applied">Needs update</span> }
                </td>
                <td>
                  @if (r.state === 'not-set-up' || r.state === 'unmanaged' || r.state === 'missing') {
                    <span class="muted">{{ profileName(r.profile) || '—' }}</span>
                  } @else {
                    <select (change)="ask(r, 'profile', $any($event.target).value); $any($event.target).value = r.profile || ''">
                      @if (r.profile && !knownProfile(r.profile)) { <option [value]="r.profile" selected>{{ r.profile }} (removed)</option> }
                      @for (p of view()!.profiles; track p.id) { <option [value]="p.id" [selected]="p.id === r.profile">{{ p.name }}</option> }
                    </select>
                  }
                </td>
                @if (hasRoles()) {
                  <td>
                    @if (r.state === 'not-set-up' || r.state === 'unmanaged' || r.state === 'missing') {
                      <span class="muted">{{ r.role ? roleLabel(r.role) : '—' }}</span>
                    } @else {
                      <select (change)="ask(r, 'role', undefined, $any($event.target).value); $any($event.target).value = r.role || ''">
                        <option value="" [selected]="!r.role">They choose</option>
                        @if (r.role && !knownRole(r.role)) { <option [value]="r.role" selected>{{ r.role }} (removed)</option> }
                        @for (ro of view()!.roles; track ro.id) { <option [value]="ro.id" [selected]="ro.id === r.role">{{ ro.label }}</option> }
                      </select>
                    }
                  </td>
                }
                <td>
                  @if (r.state === 'not-set-up' || r.state === 'unmanaged' || r.state === 'missing') {
                    <span class="muted">{{ r.access ? accessLabel(r.access) : '—' }}</span>
                  } @else {
                    <select (change)="ask(r, 'access', undefined, undefined, $any($event.target).value); $any($event.target).value = r.access || ''">
                      <option value="" [selected]="!r.access">Role's ({{ accessLabel(roleAccess(r.role)) }})</option>
                      <option value="full" [selected]="r.access === 'full'">Full stack</option>
                      <option value="read" [selected]="r.access === 'read'">Read-only</option>
                    </select>
                  }
                </td>
                <td class="muted">@if (r.provisionedAt) { {{ rel(r.provisionedAt) }} by {{ r.provisionedBy }} }</td>
                <td class="acts">
                  @switch (r.state) {
                    @case ('not-set-up') { <button class="btn sm primary" (click)="ask(r, 'provision')">Set up…</button> }
                    @case ('unmanaged') { <button class="btn sm" (click)="ask(r, 'adopt')">Adopt</button> <button class="btn sm danger" (click)="ask(r, 'remove')">Remove…</button> }
                    @case ('missing') { <button class="btn sm" (click)="ask(r, 'provision')">Set up again</button> <button class="btn sm ghost" (click)="ask(r, 'forget')">Forget</button> }
                    @default {
                      @if (r.needsUpdate) { <button class="btn sm" (click)="ask(r, 'update')">Update</button> }
                      @if (r.state === 'stopped') { <button class="btn sm ghost" (click)="ask(r, 'start')">Start</button> }
                      @if (r.state === 'running' || r.state === 'starting') { <button class="btn sm ghost" (click)="ask(r, 'stop')">Stop</button> }
                      <button class="btn sm danger" (click)="ask(r, 'remove')">Remove…</button>
                    }
                  }
                </td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="hasRoles() ? 7 : 6" class="empty">{{ query() ? 'Nobody matches.' : filter() === 'set-up' ? 'Nobody has a hosted dashboard yet. Find someone under "Not set up".' : 'Nobody here.' }}</td></tr>
            }
          </tbody>
        </table>
        @if (more() > 0) { <div class="more">and {{ more() }} more: search to find someone.</div> }
      </div>
      }

      @if (tab() === 'roles') {
      <!-- The team's roles (workspace.json): who someone is and how Claude answers them; access is only their default. -->
      <div class="panel roles">
        <div class="panel-h">
          <h2>Roles <span class="n">{{ view()!.roles.length }}</span></h2>
          <button class="btn sm" (click)="editRole(null)">Add role</button>
        </div>
        <p class="muted rh">A role sets how Claude answers someone (its output style) and the access they get unless you give them their own on the People tab.</p>
        @if (view()!.roles.length) {
          <table class="people">
            <thead><tr><th>Role</th><th>Access by default</th><th>Claude answers</th><th>People</th><th></th></tr></thead>
            <tbody>
              @for (ro of view()!.roles; track ro.id) {
                <tr>
                  <td><div class="nm">{{ ro.label }}</div>@if (ro.description) { <div class="em">{{ ro.description }}</div> }</td>
                  <td>{{ accessLabel(ro.access) }}</td>
                  <td>{{ ro.outputStyle || "Claude's default" }}</td>
                  <td class="muted">{{ ro.people || '—' }}</td>
                  <td class="acts">
                    <button class="btn sm ghost" (click)="editRole(ro)">Edit</button>
                    <button class="btn sm ghost danger" [disabled]="ro.people > 0" [title]="ro.people ? 'Give them another role first' : 'Remove this role'" (click)="removeRole(ro)">Remove</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="empty">No roles yet: everyone gets the built-in Developer and Reader. Add the roles your team has.</div>
        }
      </div>
      }

    }

    @if (roleDraft(); as rd) {
      <div class="scrim" (click)="roleDraft.set(null)"></div>
      <div class="dialog panel" role="dialog" aria-modal="true" aria-labelledby="role-dialog-title">
        <div class="panel-h"><h2 id="role-dialog-title">{{ rd.id ? 'Edit the ' + rd.label + ' role' : 'Add a role' }}</h2></div>
        <div class="dbody">
          <label>Name <input type="text" [value]="rd.label" (input)="patchRole({ label: $any($event.target).value })" placeholder="Operations" /></label>
          <label>Description <input type="text" [value]="rd.description" (input)="patchRole({ description: $any($event.target).value })" placeholder="Runs the business day to day" /></label>
          <label>Access by default
            <select (change)="patchRole({ access: $any($event.target).value })">
              <option value="full" [selected]="rd.access === 'full'">Full stack: GitHub sign-in, Implement, Publish, apps</option>
              <option value="read" [selected]="rd.access === 'read'">Read-only: ask, explain and search the code</option>
            </select>
          </label>
          <label>Claude answers in
            <select (change)="patchRole({ outputStyle: $any($event.target).value })">
              <option value="" [selected]="!rd.outputStyle">Claude's default (technical)</option>
              @for (s of view()!.styles; track s) { <option [value]="s" [selected]="s === rd.outputStyle">{{ s }}</option> }
            </select>
          </label>
          <p class="muted">Team styles are files in <code>.claude/output-styles/</code>. People can still be given their own access above. Nothing is committed until you click Commit.</p>
          @if (rd.error) { <div class="warn-note err">{{ rd.error }}</div> }
        </div>
        <div class="dfoot">
          <button class="btn ghost sm" (click)="roleDraft.set(null)">Cancel</button>
          <button class="btn sm primary" [disabled]="rd.busy || !rd.label.trim()" (click)="saveRole()">{{ rd.busy ? 'Saving…' : rd.id ? 'Save' : 'Add' }}</button>
        </div>
      </div>
    }

    @if (pending(); as pd) {
      <div class="scrim" (click)="cancel()"></div>
      <div class="dialog panel" role="dialog" aria-modal="true" aria-labelledby="people-dialog-title">
        <div class="panel-h"><h2 id="people-dialog-title">{{ title(pd) }}</h2></div>
        <div class="dbody">
          @if (pd.action === 'provision') {
            <label>Profile
              <select (change)="setPending({ profile: $any($event.target).value })">
                @for (p of view()!.profiles; track p.id) { <option [value]="p.id" [selected]="p.id === pd.profile">{{ p.name }}@if (p.areas.length) { ({{ p.areas.join(', ') }}) }</option> }
              </select>
            </label>
            @if (view()!.roles.length) {
              <label>Role
                <select (change)="setPending({ role: $any($event.target).value })">
                  <option value="" [selected]="!pd.role">Let them choose</option>
                  @for (ro of view()!.roles; track ro.id) { <option [value]="ro.id" [selected]="ro.id === pd.role">{{ ro.label }}</option> }
                </select>
              </label>
              <p class="muted">An assigned role is fixed: they see it in Settings but can't change it.</p>
            }
            <label>Access
              <select (change)="setPending({ access: $any($event.target).value })">
                <option value="" [selected]="!pd.access">Their role's ({{ accessLabel(roleAccess(pd.role || null)) }})</option>
                <option value="full" [selected]="pd.access === 'full'">Full stack: GitHub sign-in, Implement, Publish</option>
                <option value="read" [selected]="pd.access === 'read'">Read-only: ask, explain and search the code</option>
              </select>
            </label>
          }
          @if (pd.action === 'remove') {
            <label class="check"><input type="checkbox" [checked]="!pd.keepVolume" (change)="setPending({ keepVolume: !$any($event.target).checked })" />
              Also delete their {{ view()!.dataLabel || 'data' }} (chat history, Claude sign-in, workspace). This can't be undone.</label>
            @if (!pd.keepVolume) {
              <label>Type <b>{{ pd.row.email }}</b> to confirm <input type="text" [value]="pd.confirmText" (input)="setPending({ confirmText: $any($event.target).value })" /></label>
            }
          }
          @if (pd.action === 'profile' || pd.action === 'role' || pd.action === 'access' || pd.action === 'update') { <p class="muted">This restarts their dashboard. A run in progress is interrupted (they can reply to it to carry on).</p> }
          @if (pd.error) { <div class="warn-note err">{{ pd.error }}</div> }
          @if (pd.preview) { <div class="pv-h">Preview (nothing has changed yet):</div><pre class="pv">{{ pd.preview.output || 'OK' }}</pre> }
          @else if (pd.busy) { <div class="muted">Checking the change with {{ view()!.cluster }}…</div> }
        </div>
        <div class="dfoot">
          <button class="btn ghost sm" (click)="cancel()">Cancel</button>
          <button class="btn sm" [disabled]="pd.busy" (click)="previewIt()">Preview again</button>
          <button class="btn sm" [class.primary]="pd.action !== 'remove'" [class.danger]="pd.action === 'remove'" [disabled]="!canConfirm()" (click)="confirm()">{{ confirmLabel(pd.action) }}</button>
        </div>
      </div>
    }
  `,
})
export class PeopleComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly launch = inject(LaunchService);

  readonly view = signal<PeopleResponse | null>(null);
  readonly loading = signal(false);
  readonly filter = signal<Filter>('set-up');
  readonly query = signal('');
  readonly pending = signal<Pending | null>(null);
  readonly committing = signal(false);
  readonly tab = signal<'people' | 'roles'>('people');
  readonly filters: { id: Filter; label: string }[] = [
    { id: 'set-up', label: 'Have a dashboard' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'not-set-up', label: 'Not set up' },
    { id: 'all', label: 'Everyone' },
  ];
  private readonly LIMIT = 200;

  readonly sub = computed(() => {
    const v = this.view();
    if (!v?.configured || v.problems.length) return 'Who has a hosted dashboard, and their profile and role.';
    const n = v.rows.filter((r) => r.state !== 'not-set-up').length;
    return `${n} with a hosted dashboard · ${v.directory.label}${v.directory.count !== null ? ` (${v.directory.count} people)` : ''} · ${v.cluster}`;
  });

  private matches(r: PersonRow, f: Filter): boolean {
    if (f === 'all') return true;
    if (f === 'not-set-up') return r.state === 'not-set-up';
    if (f === 'attention') return r.needsUpdate || r.state === 'left' || r.state === 'missing' || r.state === 'unmanaged';
    return r.state !== 'not-set-up';
  }
  readonly counts = computed(() => {
    const rows = this.view()?.rows || [];
    return Object.fromEntries(this.filters.map((f) => [f.id, rows.filter((r) => this.matches(r, f.id)).length])) as Record<Filter, number>;
  });
  private readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return (this.view()?.rows || []).filter((r) => (q ? `${r.name} ${r.email}`.toLowerCase().includes(q) : this.matches(r, this.filter())));
  });
  readonly shown = computed(() => this.filtered().slice(0, this.LIMIT));
  readonly more = computed(() => Math.max(0, this.filtered().length - this.LIMIT));

  ngOnInit(): void { void this.load(false); }

  async load(force: boolean): Promise<void> {
    this.loading.set(true);
    try { this.view.set(await this.api.get<PeopleResponse>(`/api/people${force ? '?force=1' : ''}`)); }
    catch (e) { this.toast.error((e as Error).message); }
    finally { this.loading.set(false); }
  }

  label(s: PersonState) { return LABELS[s]; }
  tag(s: PersonState) { return TAG[s]; }
  rel(t: string) { return relTime(t); }
  profileName(id: string | null) { return this.view()?.profiles.find((p) => p.id === id)?.name || id; }
  // Also while anyone still has a role the workspace dropped, so it can be cleared ("They choose").
  readonly hasRoles = computed(() => !!this.view()?.roles.length || !!this.view()?.rows.some((r) => r.role));
  knownProfile(id: string | null) { return !!id && !!this.view()?.profiles.some((p) => p.id === id); }
  knownRole(id: string | null) { return !!id && !!this.view()?.roles.some((r) => r.id === id); }
  roleLabel(id: string) { return this.view()?.roles.find((r) => r.id === id)?.label || id; }
  accessLabel(a: Access | null) { return a === 'read' ? 'Read-only' : 'Full stack'; }
  /** The access a role gives by default; someone who picks their own role gets their pick's, shown as full. */
  roleAccess(id: string | null): Access { return (id && this.view()?.roles.find((r) => r.id === id)?.access) || 'full'; }
  sourceLabel(s: string) { return ({ directory: 'Directory', roster: 'Roster', cluster: 'Dashboards', template: 'Template' } as Record<string, string>)[s] || s; }
  confirmLabel(a: PeopleActionName) { return ({ provision: 'Set up', update: 'Update', profile: 'Change profile', role: 'Change role', access: 'Change access', start: 'Start', stop: 'Stop', remove: 'Remove', adopt: 'Adopt', forget: 'Forget' } as Record<string, string>)[a]; }
  title(p: Pending) {
    const who = p.row.name;
    const access = p.access ? `Give ${who} ${p.access === 'full' ? 'full-stack' : 'read-only'} access` : `Let ${who}'s access follow their role`;
    return ({ provision: `Set up a dashboard for ${who}`, update: `Update ${who}'s dashboard`, profile: `Change ${who}'s profile to ${this.profileName(p.profile || null)}`, role: p.role ? `Change ${who}'s role to ${this.roleLabel(p.role)}` : `Let ${who} choose their role`, access, start: `Start ${who}'s dashboard`, stop: `Stop ${who}'s dashboard`, remove: `Remove ${who}'s dashboard`, adopt: `Add ${who} to the roster`, forget: `Forget ${who}` } as Record<string, string>)[p.action];
  }

  addByEmail(email: string): void {
    const e = email.trim().toLowerCase();
    if (!e) return;
    const row = this.view()?.rows.find((r) => r.email === e) || { email: e, name: e, active: null, state: 'not-set-up' as const, slug: null, profile: null, needsUpdate: false, role: null, access: null, provisionedAt: null, provisionedBy: null };
    this.ask(row, 'provision');
  }

  ask(row: PersonRow, action: PeopleActionName, profile?: string, role?: string, access?: string): void {
    if (action === 'profile' && profile === row.profile) return;
    if (action === 'role' && role === (row.role || '')) return;
    if (action === 'access' && access === (row.access || '')) return;
    this.pending.set({ row, action, profile: profile || row.profile || this.view()?.defaultProfile || undefined, role: role ?? row.role ?? '', access: access ?? row.access ?? '', keepVolume: true, preview: null, error: null, busy: false, confirmText: '' });
    void this.previewIt();
  }
  setPending(patch: Partial<Pending>): void {
    const p = this.pending();
    if (!p) return;
    const next = { ...p, ...patch };
    this.pending.set(next);
    if ('profile' in patch || 'role' in patch || 'access' in patch || 'keepVolume' in patch) void this.previewIt();
  }
  cancel(): void { this.previewSeq++; this.pending.set(null); }

  canConfirm = computed(() => {
    const p = this.pending();
    if (!p || p.busy || p.error) return false;
    if (p.action === 'remove' && !p.keepVolume) return p.confirmText.trim().toLowerCase() === p.row.email;
    return true;
  });

  private body(p: Pending, dryRun: boolean) {
    const role = p.action === 'provision' || p.action === 'role' ? { role: p.role ?? '' } : {};
    const access = p.action === 'provision' || p.action === 'access' ? { access: p.access ?? '' } : {};
    return { action: p.action, email: p.row.email, profile: p.profile, ...role, ...access, keepVolume: p.keepVolume, dryRun };
  }

  /** Bumped by each preview, cancel and confirm: only the latest preview's answer is shown. */
  private previewSeq = 0;

  async previewIt(): Promise<void> {
    const p = this.pending();
    if (!p) return;
    const seq = ++this.previewSeq;
    this.pending.set({ ...p, busy: true, error: null, preview: null });
    try {
      const preview = await this.api.post<PeopleActionResponse>('/api/people/action', this.body(p, true));
      if (seq === this.previewSeq && this.pending()) this.pending.set({ ...this.pending()!, busy: false, preview });
    } catch (e) {
      if (seq === this.previewSeq && this.pending()) this.pending.set({ ...this.pending()!, busy: false, error: (e as Error).message });
    }
  }

  async confirm(): Promise<void> {
    const p = this.pending();
    if (!p || !this.canConfirm()) return;
    this.previewSeq++;
    this.pending.set({ ...p, busy: true });
    try {
      await this.api.post<PeopleActionResponse>('/api/people/action', this.body(p, false));
      this.pending.set(null);
      this.toast.show(`${this.confirmLabel(p.action)}: ${p.row.email}`);
      await this.load(false);
    } catch (e) {
      this.pending.set({ ...p, busy: false, error: (e as Error).message });
    }
  }

  async copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); this.toast.show('Copied'); } catch { this.toast.error("Couldn't copy: the browser blocked the clipboard"); }
  }

  /** Commit people.json on its own; pushing is the engineer's. */
  async commit(): Promise<void> {
    this.committing.set(true);
    try {
      const roster = await this.api.post<PeopleRoster>('/api/people/commit');
      const v = this.view();
      if (v) this.view.set({ ...v, roster });
      this.toast.show(`Committed ${roster.file}. Push when you're ready.`);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.committing.set(false); }
  }

  /** Commit workspace.json (the roles) on its own; pushing is the engineer's. */
  async commitRoles(): Promise<void> {
    this.committing.set(true);
    try {
      const rolesFile = await this.api.post<PeopleRoster>('/api/people/commit', { file: 'roles' });
      const v = this.view();
      if (v) this.view.set({ ...v, rolesFile });
      this.toast.show(`Committed ${rolesFile.file}. Push, then publish the snapshot, when you're ready.`);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.committing.set(false); }
  }

  readonly roleDraft = signal<RoleDraft | null>(null);

  editRole(ro: PeopleRole | null): void {
    this.roleDraft.set(ro
      ? { id: ro.id, label: ro.label, description: ro.description, access: ro.access, outputStyle: ro.outputStyle || '', busy: false, error: null }
      : { id: null, label: '', description: '', access: 'read', outputStyle: '', busy: false, error: null });
  }
  patchRole(patch: Partial<RoleDraft>): void { const d = this.roleDraft(); if (d) this.roleDraft.set({ ...d, ...patch, error: null }); }

  async saveRole(): Promise<void> {
    const d = this.roleDraft();
    if (!d || !d.label.trim()) return;
    this.roleDraft.set({ ...d, busy: true });
    const req: PeopleRolesRequest = { action: 'save', ...(d.id ? { id: d.id } : {}), role: { label: d.label.trim(), description: d.description.trim(), access: d.access, outputStyle: d.outputStyle || null } };
    try {
      await this.api.post('/api/people/roles', req);
      this.roleDraft.set(null);
      await this.load(false);
    } catch (e) { this.roleDraft.set({ ...d, busy: false, error: (e as Error).message }); }
  }

  async removeRole(ro: PeopleRole): Promise<void> {
    if (!window.confirm(`Remove the ${ro.label} role? People who picked it themselves get the first role on their access instead.`)) return;
    try {
      await this.api.post('/api/people/roles', { action: 'remove', id: ro.id } satisfies PeopleRolesRequest);
      await this.load(false);
    } catch (e) { this.toast.error((e as Error).message); }
  }

  setup(): void {
    this.launch.open({ title: 'Set up the People page', workspace: 'main', prompt: SETUP_PROMPT, focusPrompt: true });
  }
}

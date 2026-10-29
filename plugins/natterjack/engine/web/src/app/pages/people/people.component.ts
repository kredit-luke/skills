import { ChangeDetectionStrategy, Component, OnInit, computed, inject, linkedSignal, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Access, PeopleActionName, PeopleActionRequest, PeopleActionResponse, PeopleResponse, PeopleRole, PeopleRolesRequest, PeopleRoster, PersonRow, PersonState } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { LaunchService } from '../../core/launch.service';
import { ToastService } from '../../core/toast.service';
import { relTime } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { ACTION_LABEL, BULK_ACTIONS, type BulkAction, type BulkChoice, appliesTo, bulkBody, bulkSummary, bulkTitle, managed, noAnswer, rowActions, selectable, skipReason, stopAfter } from './bulk';

const SETUP_PROMPT = `Set up the dashboard's People page for our hosted dashboards. Write .claude/dashboard/hosting.json (the natterjack plugin's references/hosting.md, "Managing people from your dashboard", describes it): our directory (Google Workspace or Microsoft Entra ID, our email domain and optionally an OU or department), where the dashboards run (a Kubernetes context and namespace, or an Azure App Service resource group with its plan, storage account, registry and Key Vault), and a couple of profiles. Copy the matching template from the plugin's templates/hosted/ (kubernetes-person.yaml or app-service-person.bicep) into this workspace (for example hosting/), fill in our settings, and point "platform.template" at it. If dashboards already exist, look at how they're set up and match it. Ask me for anything you can't find from the CLIs I'm signed in to (kubectl, gcloud, az). Don't create or change anything in the cloud.`;

const LABELS: Record<PersonState, string> = {
  'not-set-up': 'Not set up', running: 'Running', starting: 'Starting', stopped: 'Stopped',
  left: 'Left', missing: 'Missing', unmanaged: 'Not in roster', unknown: 'Unknown',
};
const TAG: Record<PersonState, string> = {
  'not-set-up': '', running: 'good', starting: 'amber', stopped: '', left: 'bad', missing: 'amber', unmanaged: 'amber', unknown: 'amber',
};
type Filter = 'set-up' | 'not-set-up' | 'attention' | 'all';
/** A row button's look: Set up is the main one for someone new (rowBtn), Remove is dangerous, Start, Stop and Forget are quiet. */
const ROW_BTN: Partial<Record<PeopleActionName, string>> = { remove: 'danger', start: 'ghost', stop: 'ghost', forget: 'ghost' };

/** `role`: a workspace role id, or '' for "they pick their own". `access`: 'full', 'read', or '' for the role's. */
interface Pending { row: PersonRow; action: PeopleActionName; profile?: string; role?: string; access?: string; keepVolume?: boolean; preview: PeopleActionResponse | null; error: string | null; busy: boolean; confirmText: string }
/**
 * One person in the bulk dialog. Preview: idle (nothing chosen yet), waiting, checking, then ok or error (skipped never runs;
 * unchecked when the preview stopped before them: no answer, or the same error twice in a row). Confirm runs the ok ones: queued, running, then done or failed.
 */
type LineStatus = 'skipped' | 'idle' | 'waiting' | 'checking' | 'ok' | 'error' | 'unchecked' | 'queued' | 'running' | 'done' | 'failed';
const LINE_LABEL: Record<Exclude<LineStatus, 'skipped'>, string> = {
  idle: 'To do', waiting: 'Waiting', checking: 'Checking…', ok: 'Ready', error: 'Preview failed', unchecked: 'Not checked',
  queued: 'Queued', running: 'Working…', done: 'Done', failed: 'Failed',
};
interface BulkLine { row: PersonRow; skip: string | null; status: LineStatus; output: string | null; message: string | null }
/**
 * The bulk dialog: one action and one choice for everyone ticked. profile/role/access undefined: not chosen yet (Set up: keep each person's own).
 * stopped: why the last preview stopped early (its unchecked lines), or null.
 */
interface BulkPending extends BulkChoice { action: BulkAction; lines: BulkLine[]; running: boolean; ran: boolean; stopped: string | null }
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

      @if (picked().length) {
        <!-- Ticked people: each button counts who it applies to (bulk.ts mirrors the row buttons). -->
        <div class="bulk">
          <b aria-live="polite">{{ picked().length }} selected</b>
          @for (b of bulkButtons(); track b.action) {
            <button class="btn sm" [disabled]="!b.n" (click)="askBulk(b.action)">{{ confirmLabel(b.action) }}@if (b.n) { ({{ b.n }}) }</button>
          }
          <button class="btn sm ghost" (click)="clearTicks()">Clear</button>
        </div>
      }

      <div class="panel">
        <table class="people">
          <thead><tr><th class="sel"><input type="checkbox" aria-label="Select everyone shown" [checked]="allTicked() === 'all'" [indeterminate]="allTicked() === 'some'" [disabled]="!tickable().length" (change)="tickAll()" /></th><th>Person</th><th>Dashboard</th><th title="hosting.json profiles: memory, CPU, runs at once and areas">Profile</th>@if (hasRoles()) { <th title="workspace.json roles: who they are and how Claude answers them; they can't change it">Role</th> }<th title="What they can do with the code: full stack (GitHub sign-in, Implement, Publish) or read-only; by default their role's">Access</th><th>Set up</th><th></th></tr></thead>
          <tbody>
            @for (r of shown(); track r.email) {
              <tr [class.dim]="r.state === 'not-set-up'" [class.on]="selected().has(r.email)">
                <td class="sel"><input type="checkbox" [attr.aria-label]="'Select ' + r.name + ' (' + r.email + ')'" [checked]="selected().has(r.email)" [disabled]="!selectable(r)" [title]="selectable(r) ? '' : 'Nothing to do for them in bulk'" (change)="tick(r)" /></td>
                <td><div class="nm">{{ r.name }}</div><div class="em">{{ r.email }}</div></td>
                <td>
                  <span [class]="'tag ' + tag(r.state)" [attr.title]="r.stateError">{{ label(r.state) }}</span>
                  @if (r.needsUpdate) { <span class="tag amber" title="The template, its profile or the image changed since it was applied">Needs update</span> }
                </td>
                <td>
                  @if (!managed(r)) {
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
                    @if (!managed(r)) {
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
                  @if (!managed(r)) {
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
                  <!-- bulk.ts rowActions, so the row and the bulk bar agree. Unknown (the platform didn't answer; the error is on the tag) has none: Refresh asks again. -->
                  @for (a of rowActions(r); track a) {
                    <button [class]="'btn sm ' + rowBtn(r, a)" (click)="ask(r, a)">{{ rowLabel(r, a) }}</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="hasRoles() ? 8 : 7" class="empty">{{ query() ? 'Nobody matches.' : filter() === 'set-up' ? 'Nobody has a hosted dashboard yet. Find someone under "Not set up".' : 'Nobody here.' }}</td></tr>
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

    @if (bulk(); as bd) {
      <div class="scrim" (click)="closeBulk()"></div>
      <div class="dialog panel" role="dialog" aria-modal="true" aria-labelledby="bulk-dialog-title">
        <div class="panel-h"><h2 id="bulk-dialog-title">{{ bulkHeading(bd) }}</h2></div>
        <div class="dbody">
          @if (bd.action === 'provision' || bd.action === 'profile') {
            <label>Profile
              <select [disabled]="bd.running || bd.ran" (change)="setBulk({ profile: keepOr($any($event.target).value) })">
                @if (bd.action === 'provision') { <option [value]="KEEP" [selected]="bd.profile === undefined">Keep each person's own (new people: {{ profileName(view()!.defaultProfile) || 'the default' }})</option> }
                @else if (bd.profile === undefined) { <option disabled selected>Choose a profile…</option> }
                @for (p of view()!.profiles; track p.id) { <option [value]="p.id" [selected]="p.id === bd.profile">{{ p.name }}@if (p.areas.length) { ({{ p.areas.join(', ') }}) }</option> }
              </select>
            </label>
          }
          @if ((bd.action === 'provision' && view()!.roles.length) || bd.action === 'role') {
            <label>Role
              <select [disabled]="bd.running || bd.ran" (change)="setBulk({ role: keepOr($any($event.target).value) })">
                @if (bd.action === 'provision') { <option [value]="KEEP" [selected]="bd.role === undefined">Keep each person's own (new people: they choose)</option> }
                @else if (bd.role === undefined) { <option disabled selected>Choose a role…</option> }
                <option value="" [selected]="bd.role === ''">Let them choose</option>
                @for (ro of view()!.roles; track ro.id) { <option [value]="ro.id" [selected]="ro.id === bd.role">{{ ro.label }}</option> }
              </select>
            </label>
          }
          @if (bd.action === 'provision' || bd.action === 'access') {
            <label>Access
              <select [disabled]="bd.running || bd.ran" (change)="setBulk({ access: keepOr($any($event.target).value) })">
                @if (bd.action === 'provision') { <option [value]="KEEP" [selected]="bd.access === undefined">Keep each person's own (new people: their role's)</option> }
                @else if (bd.access === undefined) { <option disabled selected>Choose access…</option> }
                <option value="" [selected]="bd.access === ''">Their role's</option>
                <option value="full" [selected]="bd.access === 'full'">Full stack: GitHub sign-in, Implement, Publish</option>
                <option value="read" [selected]="bd.access === 'read'">Read-only: ask, explain and search the code</option>
              </select>
            </label>
          }
          @if (bd.action === 'profile' || bd.action === 'role' || bd.action === 'access' || bd.action === 'update') { <p class="muted">This restarts the dashboards of those who have one. A run in progress is interrupted (they can reply to it to carry on).</p> }
          @if (bulkOn(bd) || !bd.lines.length) { <div class="pv-h">{{ bulkStatus(bd) }}</div> } @else { <p class="muted">{{ bulkStatus(bd) }}</p> }
          <ul class="lines" aria-live="polite">
            @for (l of bd.lines; track l.row.email) {
              <li>
                <div class="lh">
                  <span><span class="nm">{{ l.row.name }}</span> <span class="em">{{ l.row.email }}</span></span>
                  <span [class]="'tag ' + lineTag(l.status)">{{ lineLabel(l) }}</span>
                </div>
                @if (l.message) { <div class="warn-note err">{{ l.message }}</div> }
                @if (l.output) { <details><summary>Preview</summary><pre class="pv">{{ l.output }}</pre></details> }
              </li>
            }
          </ul>
        </div>
        <div class="dfoot">
          <button class="btn ghost sm" [disabled]="bd.running" (click)="closeBulk()">{{ bd.ran ? 'Close' : 'Cancel' }}</button>
          <button class="btn sm" [disabled]="bd.running || bd.ran || bulkChecking()" (click)="previewBulk(true)">Preview again</button>
          <button class="btn sm primary" [disabled]="!canRunBulk()" (click)="runBulk()">{{ bd.running ? 'Working…' : confirmLabel(bd.action) + (bulkReady() ? ' (' + bulkReady() + ')' : '') }}</button>
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
          @else if (pd.busy) { <div class="muted">Checking the change with {{ view()!.cluster || 'the platform' }}…</div> }
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
    if (f === 'attention') return r.needsUpdate || r.state === 'left' || r.state === 'missing' || r.state === 'unmanaged' || r.state === 'unknown';
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

  readonly tickable = computed(() => this.shown().filter(selectable));
  /** Ticked people, by email. Only tickable rows on screen stay ticked: a filter, search or reload drops the rest. */
  readonly selected = linkedSignal<PersonRow[], ReadonlySet<string>>({
    source: this.tickable,
    computation: (rows, was) => new Set(rows.map((r) => r.email).filter((e) => was?.value.has(e))),
  });
  readonly picked = computed(() => this.tickable().filter((r) => this.selected().has(r.email)));
  readonly allTicked = computed(() => { const n = this.picked().length; return !n ? 'none' : n === this.tickable().length ? 'all' : 'some'; });
  /** The action bar: how many ticked people each bulk action applies to. Role only when the workspace has roles. */
  readonly bulkButtons = computed(() => BULK_ACTIONS.filter((a) => a !== 'role' || this.hasRoles())
    .map((action) => ({ action, n: this.picked().filter((r) => skipReason(r, action) === null).length })));

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
  confirmLabel(a: PeopleActionName) { return ACTION_LABEL[a]; }
  readonly managed = managed;
  readonly rowActions = rowActions;
  rowLabel(r: PersonRow, a: PeopleActionName) { return a === 'provision' ? (r.state === 'missing' ? 'Set up again' : 'Set up…') : a === 'remove' ? 'Remove…' : ACTION_LABEL[a]; }
  rowBtn(r: PersonRow, a: PeopleActionName) { return a === 'provision' && r.state === 'not-set-up' ? 'primary' : ROW_BTN[a] || ''; }
  title(p: Pending) {
    const who = p.row.name;
    const access = p.access ? `Give ${who} ${p.access === 'full' ? 'full-stack' : 'read-only'} access` : `Let ${who}'s access follow their role`;
    return ({ provision: `Set up a dashboard for ${who}`, update: `Update ${who}'s dashboard`, profile: `Change ${who}'s profile to ${this.profileName(p.profile || null)}`, role: p.role ? `Change ${who}'s role to ${this.roleLabel(p.role)}` : `Let ${who} choose their role`, access, start: `Start ${who}'s dashboard`, stop: `Stop ${who}'s dashboard`, remove: `Remove ${who}'s dashboard`, adopt: `Add ${who} to the roster`, forget: `Forget ${who}` } as Record<string, string>)[p.action];
  }

  addByEmail(email: string): void {
    const e = email.trim().toLowerCase();
    if (!e) return;
    const row = this.view()?.rows.find((r) => r.email === e) || { email: e, name: e, active: null, state: 'not-set-up' as const, stateError: null, slug: null, profile: null, needsUpdate: false, role: null, access: null, provisionedAt: null, provisionedBy: null };
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

  readonly selectable = selectable;
  clearTicks(): void { this.selected.set(new Set()); }
  tick(r: PersonRow): void {
    const next = new Set(this.selected());
    if (!next.delete(r.email)) next.add(r.email);
    this.selected.set(next);
  }
  tickAll(): void { if (this.allTicked() === 'all') this.clearTicks(); else this.selected.set(new Set(this.tickable().map((r) => r.email))); }

  readonly bulk = signal<BulkPending | null>(null);
  bulkHeading(b: BulkPending) { return bulkTitle(b.action, this.bulkOn(b)); }
  /** How many ticked people the action applies to (not skipped). */
  bulkOn(b: BulkPending) { return b.lines.filter((l) => !l.skip).length; }
  /** The Set up dialog's "Keep each person's own" option: undefined in the choice, so it's left out of the request. */
  readonly KEEP = ':keep';
  keepOr<T extends string>(v: T): T | undefined { return v === this.KEEP ? undefined : v; }
  /** Bumped by each bulk preview, close and run: an older preview stops writing its answers. */
  private bulkSeq = 0;
  /** The bulk dialog's latest request, settled: the next is chained after it, so the platform has one call at a time even when a choice changes mid-preview. */
  private bulkCall: Promise<unknown> = Promise.resolve();
  /** Sends `body` once the call before it settles. `go` runs just before: false (a stale preview) sends nothing and gives null. */
  private bulkPost(body: PeopleActionRequest, go: () => boolean): Promise<PeopleActionResponse | null> {
    const call = this.bulkCall.then(() => (go() ? this.api.post<PeopleActionResponse>('/api/people/action', body) : null));
    this.bulkCall = call.catch(() => undefined);
    return call;
  }
  readonly bulkChecking = computed(() => !!this.bulk()?.lines.some((l) => l.status === 'waiting' || l.status === 'checking'));
  /** How many previewed fine: Confirm runs those, and skips the ones whose preview failed. */
  readonly bulkReady = computed(() => this.bulk()?.lines.filter((l) => l.status === 'ok').length || 0);
  /** Unchecked lines block Confirm: Preview again checks them (and keeps the ready ones). */
  readonly bulkUnchecked = computed(() => this.bulk()?.lines.filter((l) => l.status === 'unchecked').length || 0);
  readonly canRunBulk = computed(() => {
    const b = this.bulk();
    return !!b && !b.running && !b.ran && !this.bulkChecking() && !this.bulkUnchecked() && this.bulkReady() > 0;
  });

  bulkStatus(b: BulkPending): string {
    const on = this.bulkOn(b);
    const head = appliesTo(on, b.lines.length - on);
    if (!on) return head;
    if (!this.chosen(b)) return `${head} Choose the new ${b.action} to preview it.`;
    if (b.running || b.ran) return head;
    if (this.bulkUnchecked()) return `${head} ${this.bulkUnchecked()} not checked: ${b.stopped || 'the preview stopped'}. Fix it, then Preview again.`;
    return `${head} Preview (nothing has changed yet)${this.bulkChecking() ? `, checking with ${this.view()?.cluster || 'the platform'}…` : ':'}`;
  }
  lineLabel(l: BulkLine): string { return l.status === 'skipped' ? `Skipped: ${l.skip}` : LINE_LABEL[l.status]; }
  lineTag(s: LineStatus): string { return s === 'ok' || s === 'done' ? 'good' : s === 'error' || s === 'failed' ? 'bad' : s === 'checking' || s === 'running' ? 'amber' : ''; }

  /** Profile, role and access are picked before anything is previewed; Set up starts on keeping each person's own. */
  private chosen(b: BulkPending): boolean { return b.action === 'profile' || b.action === 'role' || b.action === 'access' ? b[b.action] !== undefined : true; }

  askBulk(action: BulkAction): void {
    const lines = this.picked().map((row): BulkLine => ({ row, skip: null, status: 'idle', output: null, message: null }));
    this.bulk.set({ action, lines, running: false, ran: false, stopped: null });
    void this.previewBulk();
  }
  setBulk(patch: BulkChoice): void {
    const b = this.bulk();
    if (!b || b.running || b.ran) return;
    this.bulk.set({ ...b, ...patch });
    void this.previewBulk();
  }
  closeBulk(): void {
    if (this.bulk()?.running) return;
    this.bulkSeq++;
    this.bulk.set(null);
  }
  private patchLine(email: string, patch: Partial<BulkLine>): void {
    const b = this.bulk();
    if (b) this.bulk.set({ ...b, lines: b.lines.map((l) => (l.row.email === email ? { ...l, ...patch } : l)) });
  }

  /**
   * Dry-runs the action for each person it applies to, one at a time (the platform calls are heavy), chained after an older preview's call.
   * A failure is marked and the rest go on, unless there was no answer or it's the same error as the one before (stopAfter): then the rest are unchecked.
   * `again` (the Preview again button) keeps the ready lines; a new choice (setBulk) re-checks everyone, as their ok was for the old one.
   */
  async previewBulk(again = false): Promise<void> {
    const b = this.bulk();
    if (!b) return;
    const seq = ++this.bulkSeq;
    const ready = this.chosen(b);
    // Who it applies to first, then who's skipped and why. Nothing chosen yet: idle until it is.
    const lines = b.lines.map((was): BulkLine => {
      const skip = skipReason(was.row, b.action, b);
      if (again && !skip && was.status === 'ok') return was;
      return { row: was.row, skip, status: skip ? 'skipped' : ready ? 'waiting' : 'idle', output: null, message: null };
    }).sort((x, y) => Number(!!x.skip) - Number(!!y.skip));
    this.bulk.set({ ...b, lines, stopped: null });
    if (!ready) return;
    const todo = lines.filter((x) => x.status === 'waiting');
    let prev: string | null = null;
    for (const [i, l] of todo.entries()) {
      // In the chained step, just before the POST: a stale preview sends nothing.
      const go = () => {
        if (seq !== this.bulkSeq) return false;
        this.patchLine(l.row.email, { status: 'checking' });
        return true;
      };
      try {
        const res = await this.bulkPost(bulkBody(b.action, l.row, b, true), go);
        if (seq !== this.bulkSeq || !res) return;
        this.patchLine(l.row.email, { status: 'ok', output: res.output || 'OK' });
        prev = null;
      } catch (e) {
        if (seq !== this.bulkSeq) return;
        const message = (e as Error).message;
        this.patchLine(l.row.email, { status: 'error', message });
        if (stopAfter(prev, e)) {
          const rest = todo.slice(i + 1);
          for (const r of rest) this.patchLine(r.row.email, { status: 'unchecked' });
          const cur = this.bulk();
          if (cur && rest.length) this.bulk.set({ ...cur, stopped: noAnswer(e) ? "the dashboard server didn't answer" : 'the same error twice in a row' });
          return;
        }
        prev = message;
      }
    }
  }

  /**
   * Runs it for real for everyone whose preview passed, one at a time, carrying on past failures.
   * The dialog stays open when anyone failed or wasn't run (their preview failed), so the toast isn't the only word on them.
   */
  async runBulk(): Promise<void> {
    const b = this.bulk();
    if (!b || !this.canRunBulk()) return;
    this.bulkSeq++;
    const todo = b.lines.filter((l) => l.status === 'ok');
    this.bulk.set({ ...b, running: true, lines: b.lines.map((l): BulkLine => (l.status === 'ok' ? { ...l, status: 'queued' } : l)) });
    const done = new Set<string>();
    let failed = 0;
    const notRun = b.lines.filter((l) => !l.skip && l.status !== 'ok').length;
    for (const l of todo) {
      try {
        await this.bulkPost(bulkBody(b.action, l.row, b, false), () => { this.patchLine(l.row.email, { status: 'running' }); return true; });
        this.patchLine(l.row.email, { status: 'done' });
        done.add(l.row.email);
      } catch (e) {
        this.patchLine(l.row.email, { status: 'failed', message: (e as Error).message });
        failed++;
      }
    }
    this.toast.show(bulkSummary(b.action, done.size, failed, notRun), failed + notRun > 0);
    this.selected.set(new Set([...this.selected()].filter((e) => !done.has(e))));
    // Failures and the ones not run stay on screen so their errors can be read; Close then.
    this.bulk.set(failed || notRun ? { ...this.bulk()!, running: false, ran: true } : null);
    await this.load(false);
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

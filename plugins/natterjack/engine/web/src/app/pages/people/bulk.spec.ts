import { describe, expect, it } from 'vitest';
import type { PersonRow } from '../../../../../shared/api';
import { ACTION_LABEL, appliesTo, bulkBody, bulkSummary, bulkTitle, managed, rowActions, selectable, skipReason, stopAfter } from './bulk';

const row = (p: Partial<PersonRow> = {}): PersonRow => ({
  email: 'a@x.com', name: 'A', active: true, state: 'running', stateError: null, slug: 'a', profile: 'std',
  needsUpdate: false, role: null, access: null, provisionedAt: null, provisionedBy: null, ...p,
});

describe('bulk skipReason', () => {
  it('sets up people without a dashboard, or whose dashboard went missing', () => {
    expect(skipReason(row({ state: 'not-set-up' }), 'provision')).toBeNull();
    expect(skipReason(row({ state: 'missing' }), 'provision')).toBeNull();
    expect(skipReason(row({ state: 'running' }), 'provision')).toBe('Already has a dashboard');
  });
  it('updates only managed dashboards that need it', () => {
    expect(skipReason(row({ needsUpdate: true }), 'update')).toBeNull();
    expect(skipReason(row({ state: 'stopped', needsUpdate: true }), 'update')).toBeNull();
    expect(skipReason(row(), 'update')).toBe('Up to date');
    expect(skipReason(row({ state: 'unmanaged', needsUpdate: true }), 'update')).toBe('Not in the roster');
  });
  it('starts stopped dashboards and stops running or starting ones', () => {
    expect(skipReason(row({ state: 'stopped' }), 'start')).toBeNull();
    expect(skipReason(row(), 'start')).toBe('Not stopped');
    expect(skipReason(row({ state: 'starting' }), 'stop')).toBeNull();
    expect(skipReason(row({ state: 'stopped' }), 'stop')).toBe('Not running');
    expect(skipReason(row({ state: 'not-set-up' }), 'stop')).toBe('No dashboard');
  });
  it('changes profile, role or access on managed dashboards before a value is chosen', () => {
    expect(skipReason(row({ state: 'stopped' }), 'profile')).toBeNull();
    expect(skipReason(row(), 'role')).toBeNull();
    expect(skipReason(row({ state: 'missing' }), 'access')).toBe('Dashboard is missing');
  });
  it("gives a left person's reason, not an already-set-up one", () => {
    expect(skipReason(row({ state: 'left' }), 'provision')).toBe('No longer active in the directory');
    expect(skipReason(row({ state: 'left' }), 'start')).toBe('No longer active in the directory');
    expect(skipReason(row({ state: 'left' }), 'stop')).toBe('No longer active in the directory');
    expect(skipReason(row({ state: 'left', needsUpdate: true }), 'update')).toBeNull();
  });
  it('skips a left person for a bulk profile, role or access change, chosen value or not', () => {
    for (const a of ['profile', 'role', 'access'] as const) expect(skipReason(row({ state: 'left' }), a)).toBe('No longer active in the directory');
    expect(skipReason(row({ state: 'left' }), 'profile', { profile: 'big' })).toBe('No longer active in the directory');
    expect(skipReason(row({ state: 'left' }), 'role', { role: '' })).toBe('No longer active in the directory');
  });
  it("says why it can't set up someone whose state couldn't be read", () => {
    expect(skipReason(row({ state: 'unknown' }), 'provision')).toBe("Couldn't read its state");
    expect(skipReason(row({ state: 'unmanaged' }), 'provision')).toBe('Already has a dashboard');
  });
  it('skips people already on the chosen value', () => {
    expect(skipReason(row(), 'profile', { profile: 'std' })).toBe('Already on that profile');
    expect(skipReason(row(), 'profile', { profile: 'big' })).toBeNull();
    expect(skipReason(row(), 'role', { role: '' })).toBe('Already has that role');
    expect(skipReason(row({ role: 'ops' }), 'role', { role: '' })).toBeNull();
    expect(skipReason(row({ access: 'read' }), 'access', { access: 'read' })).toBe('Already has that access');
    expect(skipReason(row(), 'access', { access: 'full' })).toBeNull();
  });
});

describe('bulk selectable', () => {
  it('people some bulk action applies to', () => {
    expect(selectable(row({ state: 'not-set-up' }))).toBe(true);
    expect(selectable(row({ state: 'left', needsUpdate: true }))).toBe(true);
    expect(selectable(row({ state: 'left' }))).toBe(false);
    expect(selectable(row({ state: 'unmanaged' }))).toBe(false);
    expect(selectable(row({ state: 'unknown' }))).toBe(false);
  });
});

describe('bulk managed and rowActions', () => {
  it('has a managed dashboard to change when the platform and the roster both know it', () => {
    expect(managed(row())).toBe(true);
    expect(managed(row({ state: 'left' }))).toBe(true);
    expect(managed(row({ state: 'stopped' }))).toBe(true);
    expect(managed(row({ state: 'not-set-up' }))).toBe(false);
    expect(managed(row({ state: 'unmanaged' }))).toBe(false);
    expect(managed(row({ state: 'missing' }))).toBe(false);
    expect(managed(row({ state: 'unknown' }))).toBe(false);
  });
  it('pins the per-row buttons for each state', () => {
    expect(rowActions(row({ state: 'not-set-up' }))).toEqual(['provision']);
    expect(rowActions(row({ state: 'unmanaged' }))).toEqual(['adopt', 'remove']);
    expect(rowActions(row({ state: 'missing' }))).toEqual(['provision', 'forget']);
    expect(rowActions(row({ state: 'unknown' }))).toEqual([]);
    expect(rowActions(row({ state: 'running' }))).toEqual(['stop', 'remove']);
    expect(rowActions(row({ state: 'starting', needsUpdate: true }))).toEqual(['update', 'stop', 'remove']);
    expect(rowActions(row({ state: 'stopped' }))).toEqual(['start', 'remove']);
    expect(rowActions(row({ state: 'left' }))).toEqual(['remove']);
    expect(rowActions(row({ state: 'left', needsUpdate: true }))).toEqual(['update', 'remove']);
  });
});

describe('bulk stopAfter', () => {
  const err = (message: string, status?: number) => Object.assign(new Error(message), status === undefined ? {} : { status });
  it('stops when the dashboard server gave no answer', () => {
    expect(stopAfter(null, err('Dashboard server is not reachable.'))).toBe(true);
  });
  it('stops at the same error twice in a row, whatever its status', () => {
    expect(stopAfter('kubectl: Unauthorized', err('kubectl: Unauthorized', 502))).toBe(true);
    expect(stopAfter('No template', err('No template', 400))).toBe(true);
  });
  it('goes on after a single failure, or a different one', () => {
    expect(stopAfter(null, err('admission webhook denied', 502))).toBe(false);
    expect(stopAfter('already has a dashboard', err("isn't in the roster", 404))).toBe(false);
  });
});

describe('bulk ACTION_LABEL', () => {
  it('labels every action, bulk or per row', () => {
    expect(ACTION_LABEL.provision).toBe('Set up');
    expect(ACTION_LABEL.access).toBe('Change access');
    expect(ACTION_LABEL.forget).toBe('Forget');
  });
});

describe('bulk bulkBody', () => {
  it('sets up with the chosen profile, role and access', () => {
    expect(bulkBody('provision', row({ state: 'not-set-up', profile: null }), { profile: 'big', role: 'ops', access: '' }, true))
      .toEqual({ action: 'provision', email: 'a@x.com', profile: 'big', role: 'ops', access: '', keepVolume: true, dryRun: true });
  });
  it("sets up keeping each person's own profile, role and access when none is chosen", () => {
    // Undefined: the server falls back to their roster entry (a Missing person's), then the defaults.
    expect(bulkBody('provision', row({ state: 'missing' }), {}, true))
      .toStrictEqual({ action: 'provision', email: 'a@x.com', keepVolume: true, dryRun: true });
  });
  it("sends an explicit 'they choose' role and 'their role's' access", () => {
    expect(bulkBody('provision', row({ state: 'missing', role: 'ops', access: 'read' }), { role: '', access: '' }, false))
      .toStrictEqual({ action: 'provision', email: 'a@x.com', role: '', access: '', keepVolume: true, dryRun: false });
  });
  it('sends only the value the action changes (the server keeps their own profile)', () => {
    expect(bulkBody('role', row(), { profile: 'big', role: '', access: 'read' }, false))
      .toStrictEqual({ action: 'role', email: 'a@x.com', role: '', keepVolume: true, dryRun: false });
    expect(bulkBody('access', row(), { access: 'read' }, true))
      .toStrictEqual({ action: 'access', email: 'a@x.com', access: 'read', keepVolume: true, dryRun: true });
    expect(bulkBody('profile', row(), { profile: 'big' }, true))
      .toStrictEqual({ action: 'profile', email: 'a@x.com', profile: 'big', keepVolume: true, dryRun: true });
    expect(bulkBody('update', row(), {}, true))
      .toStrictEqual({ action: 'update', email: 'a@x.com', keepVolume: true, dryRun: true });
  });
});

describe('bulk wording', () => {
  it('titles the dialog with the action and how many', () => {
    expect(bulkTitle('update', 4)).toBe('Update 4 dashboards');
    expect(bulkTitle('provision', 1)).toBe('Set up 1 dashboard');
    expect(bulkTitle('role', 2)).toBe('Change the role of 2 dashboards');
    expect(bulkTitle('update', 0)).toBe('Update: nothing to do');
  });
  it('says who it applies to', () => {
    expect(appliesTo(3, 0)).toBe('Applies to 3 people.');
    expect(appliesTo(1, 2)).toBe('Applies to 1 person; 2 skipped.');
    expect(appliesTo(0, 1)).toBe('Nothing to do for the 1 person ticked.');
    expect(appliesTo(0, 4)).toBe('Nothing to do for the 4 people ticked.');
  });
  it('sums up a run', () => {
    expect(bulkSummary('update', 4, 1)).toBe('Updated 4 dashboards, 1 failed');
    expect(bulkSummary('start', 1, 0)).toBe('Started 1 dashboard');
    expect(bulkSummary('access', 0, 2)).toBe('Change access: 2 failed');
  });
  it("counts who wasn't run", () => {
    expect(bulkSummary('update', 3, 0, 2)).toBe('Updated 3 dashboards, 2 not run');
    expect(bulkSummary('update', 3, 1, 1)).toBe('Updated 3 dashboards, 1 failed, 1 not run');
    expect(bulkSummary('stop', 0, 1, 2)).toBe('Stop: 1 failed, 2 not run');
  });
});

import type { Access, PeopleActionName, PeopleActionRequest, PersonRow, PersonState } from '../../../../../shared/api';

/**
 * The People page's bulk actions: the per-row actions that make sense for many people at once
 * (remove, adopt and forget stay per row). Pure, so it's unit-tested (bulk.spec.ts).
 */
export type BulkAction = 'provision' | 'update' | 'start' | 'stop' | 'profile' | 'role' | 'access';
export const BULK_ACTIONS: readonly BulkAction[] = ['provision', 'update', 'start', 'stop', 'profile', 'role', 'access'];

/**
 * What the bulk dialog chose for everyone. `role`/`access`: '' is "they choose" / their role's, as in the single dialog.
 * Undefined: not chosen; for Set up that keeps each person's own (their roster entry, then the defaults).
 */
export interface BulkChoice { profile?: string; role?: string; access?: Access | '' }

/** Why a state has no managed dashboard to act on (the per-row buttons hide these). */
const UNMANAGED: Partial<Record<PersonState, string>> = {
  'not-set-up': 'No dashboard', unmanaged: 'Not in the roster', missing: 'Dashboard is missing', unknown: "Couldn't read its state",
};
/**
 * Left: suspended or gone from the directory (they may still have a dashboard). The row offers only Update and Remove;
 * its own profile, role and access selects stay (managed), but a bulk change skips them.
 */
const LEFT = 'No longer active in the directory';

/** A dashboard both the roster and the platform know (or a left person's): its profile, role and access can change. */
export function managed(r: PersonRow): boolean { return !UNMANAGED[r.state]; }

/**
 * Why `a` doesn't apply to this person, or null when it does; the per-row buttons (rowActions) use it too.
 * Without a chosen value (the action bar's counts) profile, role and access only need a managed dashboard (not a left person's).
 */
export function skipReason(r: PersonRow, a: BulkAction, c: BulkChoice = {}): string | null {
  if (a === 'provision') {
    if (r.state === 'not-set-up' || r.state === 'missing') return null;
    return r.state === 'left' ? LEFT : r.state === 'unknown' ? UNMANAGED.unknown! : 'Already has a dashboard';
  }
  const unmanaged = UNMANAGED[r.state];
  if (unmanaged) return unmanaged;
  switch (a) {
    case 'update': return r.needsUpdate ? null : 'Up to date';
    case 'start': return r.state === 'stopped' ? null : r.state === 'left' ? LEFT : 'Not stopped';
    case 'stop': return r.state === 'running' || r.state === 'starting' ? null : r.state === 'left' ? LEFT : 'Not running';
    case 'profile': return r.state === 'left' ? LEFT : c.profile !== undefined && c.profile === r.profile ? 'Already on that profile' : null;
    case 'role': return r.state === 'left' ? LEFT : c.role !== undefined && c.role === (r.role || '') ? 'Already has that role' : null;
    case 'access': return r.state === 'left' ? LEFT : c.access !== undefined && c.access === (r.access || '') ? 'Already has that access' : null;
  }
}

/** The row's buttons, in order: the bulk ones that apply, then adopt or forget, then remove (anything on the platform or in the roster). */
export function rowActions(r: PersonRow): PeopleActionName[] {
  const out: PeopleActionName[] = (['provision', 'update', 'start', 'stop'] as const).filter((a) => skipReason(r, a) === null);
  if (r.state === 'unmanaged') out.push('adopt');
  if (r.state === 'missing') out.push('forget');
  if (managed(r) || r.state === 'unmanaged') out.push('remove');
  return out;
}

/** A failure with no status: the dashboard server didn't answer, so nobody else's preview would either. */
export function noAnswer(e: unknown): boolean { return typeof (e as { status?: unknown })?.status !== 'number'; }

/**
 * Whether a failed preview stops the rest: no answer, or the same error as the one just before it (a 502 can be one
 * person's rejected dry run or a signed-out CLI, a 400 a bad email or a missing template, so the status can't tell).
 */
export function stopAfter(prevError: string | null, e: unknown): boolean {
  return noAnswer(e) || (e as Error).message === prevError;
}

/** A row can be ticked when some bulk action applies to it: not unknown (the platform didn't answer) or unmanaged (adopt or remove it first). */
export function selectable(r: PersonRow): boolean {
  return BULK_ACTIONS.some((a) => skipReason(r, a) === null);
}

/**
 * The POST /api/people/action body for one person, shaped like the single dialog's.
 * A value left undefined is left out, so the server keeps the person's own (a Missing person's roster settings);
 * only Set up and Change profile send a profile (the others re-apply their roster one).
 */
export function bulkBody(a: BulkAction, r: PersonRow, c: BulkChoice, dryRun: boolean): PeopleActionRequest {
  const profile = a === 'provision' || a === 'profile' ? c.profile : undefined;
  const role = a === 'provision' || a === 'role' ? c.role : undefined;
  const access = a === 'provision' || a === 'access' ? c.access : undefined;
  return {
    action: a, email: r.email,
    ...(profile !== undefined && { profile }), ...(role !== undefined && { role }), ...(access !== undefined && { access }),
    keepVolume: true, dryRun,
  };
}

/** Every action's button label: the action bar, both dialogs' confirm buttons and their toasts. */
export const ACTION_LABEL: Record<PeopleActionName, string> = {
  provision: 'Set up', update: 'Update', start: 'Start', stop: 'Stop', profile: 'Change profile', role: 'Change role', access: 'Change access',
  remove: 'Remove', adopt: 'Adopt', forget: 'Forget',
};
const TITLE: Record<BulkAction, string> = {
  provision: 'Set up', update: 'Update', start: 'Start', stop: 'Stop', profile: 'Change the profile of', role: 'Change the role of', access: 'Change access for',
};
const DONE: Record<BulkAction, string> = {
  provision: 'Set up', update: 'Updated', start: 'Started', stop: 'Stopped', profile: 'Changed the profile of', role: 'Changed the role of', access: 'Changed access for',
};
const dashboards = (n: number) => `${n} dashboard${n === 1 ? '' : 's'}`;
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** "Update 4 dashboards"; "Update: nothing to do" when it applies to nobody ticked. */
export function bulkTitle(a: BulkAction, n: number): string { return n ? `${TITLE[a]} ${dashboards(n)}` : `${ACTION_LABEL[a]}: nothing to do`; }

/** The dialog's first line: "Applies to 3 people; 1 skipped.", or "Nothing to do for the 2 people ticked." */
export function appliesTo(on: number, skipped: number): string {
  if (!on) return `Nothing to do for the ${people(skipped)} ticked.`;
  return `Applies to ${people(on)}${skipped ? `; ${skipped} skipped` : ''}.`;
}

/** The toast after a run: "Updated 4 dashboards, 1 failed, 2 not run" (not run: their preview failed or wasn't checked). */
export function bulkSummary(a: BulkAction, done: number, failed: number, notRun = 0): string {
  const rest = [failed && `${failed} failed`, notRun && `${notRun} not run`].filter(Boolean).join(', ');
  if (!done) return `${ACTION_LABEL[a]}: ${rest}`;
  return `${DONE[a]} ${dashboards(done)}${rest ? `, ${rest}` : ''}`;
}

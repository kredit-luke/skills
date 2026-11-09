import { describe, expect, it } from 'vitest';
import type { RoutineView, RunWatch } from '../../../../../shared/api';
import { blankDraft, draftFrom, draftToInput, lastSummary, watchWhat } from './loops.util';

const view = (o: Partial<RoutineView>): RoutineView => ({ id: 'r', enabled: true, source: 'personal', nextAt: null, schedule: '', last: null, ...o });

describe('loops.util', () => {
  it('turns a routine into a draft and back', () => {
    const r = view({ id: 'q', label: 'Queue', prompt: 'Check.', every: '2h', between: '08:00-18:00', days: ['mon', 'fri'], mode: 'continue', model: 'sonnet', catchUpMinutes: 30 });
    const d = draftFrom(r);
    expect(d.when).toBe('every');
    expect(d.between).toBe(true);
    expect(d.days).toBe('custom');
    expect(draftToInput(d)).toEqual({ id: 'q', label: 'Queue', enabled: true, prompt: 'Check.', every: '2h', between: '08:00-18:00', days: ['mon', 'fri'], mode: 'continue', workspace: 'main', model: 'sonnet', catchUpMinutes: 30 });
  });

  it('keeps what the form doesn\'t show when a routine is edited and saved', () => {
    const out = draftToInput(draftFrom(view({ id: 'p', prompt: 'Read only.', at: '07:00', enabled: false, permissionMode: 'plan' })));
    expect(out.enabled).toBe(false);
    expect(out.permissionMode).toBe('plan');
    expect(draftToInput(blankDraft()).enabled).toBe(true);
  });

  it('keeps only the chosen preset\'s args', () => {
    const d = { ...blankDraft(), what: 'preset' as const, preset: 'implement', args: { ticket: 'PROJ-1', stale: 'x' } };
    const out = draftToInput(d, [{ id: 'implement', label: 'Implement', prompt: '/implement {ticket}', args: [{ name: 'ticket' }] }]);
    expect(out.preset).toBe('implement');
    expect(out.args).toEqual({ ticket: 'PROJ-1' });
    expect(out.prompt).toBeUndefined();
    expect(out.at).toBe('09:00');
    expect(out.days).toBe('weekdays');
  });

  it('says what a watch waits for', () => {
    const base = { prs: [], everyMinutes: 5 } as unknown as RunWatch;
    expect(watchWhat({ ...base, kind: 'every', everyMinutes: 90 })).toBe('Every 1 h 30 min');
    expect(watchWhat({ ...base, kind: 'check', until: 'success' })).toBe('Until it succeeds, checked every 5 min');
    expect(watchWhat({ ...base, kind: 'github-pr', prs: [{ repo: 'a/b', number: 1, seen: null }] })).toBe('a/b#1, checked every 5 min');
  });

  it('sums up the last firing, a skip after it winning', () => {
    expect(lastSummary(view({}))).toBeNull();
    expect(lastSummary(view({ last: { firedAt: '2026-11-09T09:00:00Z', ok: true } }))).toEqual({ text: 'Ran', bad: false });
    expect(lastSummary(view({ last: { firedAt: '2026-11-09T09:00:00Z', ok: false, error: 'limit' } }))!.text).toMatch(/limit/);
    expect(lastSummary(view({ last: { firedAt: '2026-11-09T09:00:00Z', ok: true, skipped: 'Skipped: busy', skippedAt: '2026-11-10T09:00:00Z' } }))).toEqual({ text: 'Skipped: busy', bad: true });
  });
});

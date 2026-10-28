import { describe, expect, it } from 'vitest';
import type { StandupSource } from '../../../../../shared/api';
import { dateStart, isWorkday, itemTarget, localDay, sinceLabel, windowStart, withItems } from './standup.util';

// Local times: 2026-10-26 is a Monday.
const mon = new Date(2026, 9, 26, 9, 30);
const wed = new Date(2026, 9, 28, 17, 0);
const sun = new Date(2026, 9, 25, 12, 0);

describe('windowStart', () => {
  it("goes back to the last workday's midnight: Friday on a Monday or a weekend", () => {
    expect(localDay(windowStart(mon, 'workday'))).toBe('2026-10-23');
    expect(localDay(windowStart(sun, 'workday'))).toBe('2026-10-23');
    expect(localDay(windowStart(wed, 'workday'))).toBe('2026-10-27');
    expect(windowStart(wed, 'workday').getHours()).toBe(0);
  });

  it('counts workdays only, and today starts at midnight', () => {
    expect(localDay(windowStart(mon, '2-workdays'))).toBe('2026-10-22');
    expect(localDay(windowStart(wed, 'week'))).toBe('2026-10-21');
    expect(localDay(windowStart(wed, 'today'))).toBe('2026-10-28');
  });

  it('knows Monday to Friday', () => {
    expect(isWorkday(mon)).toBe(true);
    expect(isWorkday(sun)).toBe(false);
  });
});

describe('dates', () => {
  it('reads a date input as local midnight', () => {
    const d = dateStart('2026-10-20')!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 20, 0]);
    expect(dateStart('')).toBe(null);
    expect(dateStart('20/10/2026')).toBe(null);
  });

  it('labels the window by how far back it starts', () => {
    expect(sinceLabel(new Date(2026, 9, 28), wed)).toBe('Today');
    expect(sinceLabel(new Date(2026, 9, 27), wed)).toBe('Since yesterday');
    expect(sinceLabel(new Date(2026, 9, 23), mon)).toMatch(/^Since \S+$/);
    expect(sinceLabel(new Date(2026, 9, 1), mon)).toMatch(/^Since .*1/);
  });
});

describe('items', () => {
  const src = (id: StandupSource['id'], done: number, next: number): StandupSource => ({
    id, label: id, error: null, blockers: [],
    done: Array.from({ length: done }, (_, i) => ({ title: `d${i}`, detail: '' })),
    next: Array.from({ length: next }, (_, i) => ({ title: `n${i}`, detail: '' })),
  });

  it('keeps only the sources with something in that part', () => {
    const s = [src('tracker', 2, 0), src('code', 0, 1), src('runs', 0, 0)];
    expect(withItems(s, 'done').map((x) => [x.source.id, x.items.length])).toEqual([['tracker', 2]]);
    expect(withItems(s, 'next').map((x) => x.source.id)).toEqual(['code']);
    expect(withItems(s, 'blockers')).toEqual([]);
  });

  it('opens runs and meetings here, https links elsewhere, and nothing else', () => {
    expect(itemTarget({ title: '', detail: '', runId: 'r1' })).toEqual({ route: ['/runs', 'r1'], query: null });
    expect(itemTarget({ title: '', detail: '', meetingId: 'm1' })).toEqual({ route: ['/meetings'], query: { m: 'm1' } });
    expect(itemTarget({ title: '', detail: '', url: 'https://x.example/1' })).toEqual({ href: 'https://x.example/1' });
    expect(itemTarget({ title: '', detail: '', url: 'javascript:alert(1)' })).toBe(null);
    expect(itemTarget({ title: '', detail: '' })).toBe(null);
  });
});

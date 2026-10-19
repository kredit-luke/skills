import { describe, expect, it } from 'vitest';
import type { ActionItem, Meeting, MeetingTicket } from '../../../../../shared/api';
import { actionCounts, dateLabel, isHttpsUrl, isNotConnected, mergePages, moreParticipants, statusOf, summaryPreview, ticketSummary, timeLabel } from './meetings.util';

const meeting = (id: string, over: Partial<Meeting> = {}): Meeting => ({
  id, title: 'M ' + id, startedAt: '2026-10-19T10:00:00Z', endedAt: null, participantCount: 2,
  host: null, summary: null, actionItems: null, tickets: [], ...over,
});
const item = (complete: boolean): ActionItem => ({ text: 't', description: null, complete, suggestedOwner: null });

describe('mergePages', () => {
  it('appends a new page in order', () => {
    expect(mergePages([meeting('a'), meeting('b')], [meeting('c'), meeting('d')]).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('drops duplicates across pages, keeping the first position and the newest data', () => {
    const out = mergePages([meeting('a'), meeting('b')], [meeting('b', { title: 'new' }), meeting('c')]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(out[1].title).toBe('new');
  });
  it('drops duplicates within one page', () => {
    expect(mergePages([], [meeting('a'), meeting('a'), meeting('b')]).map((m) => m.id)).toEqual(['a', 'b']);
  });
  it('starts from an empty list', () => {
    expect(mergePages([], [])).toEqual([]);
  });
});

describe('dateLabel', () => {
  const now = new Date(2026, 9, 19, 9, 30);
  it('says Today and Yesterday by local calendar day', () => {
    expect(dateLabel(new Date(2026, 9, 19, 0, 5).toISOString(), now)).toBe('Today');
    expect(dateLabel(new Date(2026, 9, 18, 23, 59).toISOString(), now)).toBe('Yesterday');
    expect(dateLabel(new Date(2026, 9, 18, 0, 1).toISOString(), now)).toBe('Yesterday');
  });
  it('names the day this year and the year otherwise', () => {
    expect(dateLabel(new Date(2026, 9, 13, 15).toISOString(), now)).toBe('Tue 13 Oct');
    expect(dateLabel(new Date(2025, 11, 31, 15).toISOString(), now)).toBe('31 Dec 2025');
  });
  it('is empty for a missing or bad date', () => {
    expect(dateLabel(null, now)).toBe('');
    expect(dateLabel('not a date', now)).toBe('');
  });
});

describe('timeLabel', () => {
  it('pads hours and minutes', () => {
    expect(timeLabel(new Date(2026, 9, 19, 9, 5).toISOString())).toBe('09:05');
    expect(timeLabel('')).toBe('');
  });
});

describe('actionCounts', () => {
  it('counts open and total', () => {
    expect(actionCounts([item(false), item(true), item(false)])).toEqual({ open: 2, total: 3 });
    expect(actionCounts([])).toEqual({ open: 0, total: 0 });
  });
  it('is null when the tool sent none', () => {
    expect(actionCounts(null)).toBeNull();
  });
});

describe('summaryPreview', () => {
  it('flattens markdown into one line', () => {
    const md = '## Summary\n\nWe **agreed** to ship the `export` fix.\n\n- Check [the doc](https://x.test/a)\n- 1. *Then* call Sam\n> quoted';
    expect(summaryPreview(md)).toBe('We agreed to ship the export fix. Check the doc 1. Then call Sam quoted');
  });
  it('keeps underscores in names', () => {
    expect(summaryPreview('Rename my_table_name today')).toBe('Rename my_table_name today');
  });
  it('cuts long text at a word with an ellipsis', () => {
    const out = summaryPreview('alpha beta gamma delta epsilon zeta', 20);
    expect(out).toBe('alpha beta gamma…');
    expect(out.length).toBeLessThanOrEqual(21);
  });
  it('is empty without a summary', () => {
    expect(summaryPreview(null)).toBe('');
    expect(summaryPreview('# Only a heading')).toBe('');
  });
});

describe('moreParticipants', () => {
  it('counts the ones left out', () => {
    expect(moreParticipants({ participants: [{ id: '1', name: 'A', type: 'member' }], participantsOmitted: true, participantCount: 4 })).toBe(3);
  });
  it("says 'more' when the count doesn't tell", () => {
    expect(moreParticipants({ participants: [{ id: '1', name: 'A', type: 'member' }], participantsOmitted: true, participantCount: 1 })).toBe('more');
  });
  it('is null when everyone is listed', () => {
    expect(moreParticipants({ participants: [], participantsOmitted: false, participantCount: 0 })).toBeNull();
  });
});

describe('isNotConnected', () => {
  it('is a 401', () => {
    expect(isNotConnected(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(isNotConnected(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
    expect(isNotConnected(new Error('x'))).toBe(false);
    expect(isNotConnected(null)).toBe(false);
  });
});

describe('statusOf', () => {
  it("is the failed call's HTTP status, when it had one", () => {
    expect(statusOf(Object.assign(new Error('x'), { status: 404 }))).toBe(404);
    expect(statusOf(new Error('x'))).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf(undefined)).toBeUndefined();
  });
});

describe('isHttpsUrl', () => {
  it('takes https: only', () => {
    expect(isHttpsUrl('https://ro.am/share/abc')).toBe(true);
    expect(isHttpsUrl('HTTPS://ro.am/share/abc')).toBe(true);
    expect(isHttpsUrl('http://ro.am/share/abc')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl(' https://ro.am')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
    expect(isHttpsUrl(null)).toBe(false);
  });
});

describe('ticketSummary', () => {
  const t = (key: string): MeetingTicket => ({ key, url: 'https://x.example/' + key, title: '', source: 'tracker' });
  it('is null when a meeting has no tickets', () => {
    expect(ticketSummary([])).toBeNull();
    expect(ticketSummary(null)).toBeNull();
    expect(ticketSummary(undefined)).toBeNull();
  });
  it('lists them all when they fit', () => {
    const s = ticketSummary([t('ENG-1'), t('ENG-2')])!;
    expect(s.shown.map((x) => x.key)).toEqual(['ENG-1', 'ENG-2']);
    expect(s.more).toBe(0);
    expect(s.text).toBe('Tickets: ENG-1, ENG-2');
    expect(s.moreText).toBe('');
  });
  it('shows the first few and counts the rest; the text (the tooltip) has every key', () => {
    const s = ticketSummary([t('ENG-1'), t('ENG-2'), t('ENG-3'), t('ENG-4'), t('ENG-5')], 2)!;
    expect(s.shown.map((x) => x.key)).toEqual(['ENG-1', 'ENG-2']);
    expect(s.more).toBe(3);
    expect(s.text).toBe('Tickets: ENG-1, ENG-2, ENG-3, ENG-4, ENG-5');
    expect(s.moreText).toBe('3 more tickets: ENG-3, ENG-4, ENG-5');
  });
  it('shows three by default', () => {
    const s = ticketSummary([t('ENG-1'), t('ENG-2'), t('ENG-3'), t('ENG-4')])!;
    expect(s.shown.map((x) => x.key)).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
    expect(s.more).toBe(1);
    expect(s.moreText).toBe('1 more ticket: ENG-4');
  });
  it('always shows at least one', () => {
    const s = ticketSummary([t('ENG-1'), t('ENG-2')], 0)!;
    expect(s.shown.map((x) => x.key)).toEqual(['ENG-1']);
    expect(s.more).toBe(1);
  });
});

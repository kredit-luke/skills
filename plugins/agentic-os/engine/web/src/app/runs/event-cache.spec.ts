import { describe, expect, it } from 'vitest';
import { RunEventCache } from './event-cache';

describe('RunEventCache', () => {
  it('returns the same entry when a run is opened again', () => {
    const c = new RunEventCache();
    const a = c.open('a');
    a.events.push({ type: 'human', text: 'hi' });
    a.next = 1;
    expect(c.open('a')).toBe(a);
    expect(c.open('a').next).toBe(1);
  });
  it('drops the least recently opened run past maxRuns', () => {
    const c = new RunEventCache();
    c.maxRuns = 2;
    c.open('a'); c.open('b'); c.open('a'); c.open('c');
    expect([c.has('a'), c.has('b'), c.has('c')]).toEqual([true, false, true]);
  });
  it('drops old runs past maxBytes but always keeps the one being opened', () => {
    const c = new RunEventCache();
    c.maxBytes = 100;
    c.open('a').bytes = 60;
    c.open('b').bytes = 60;
    c.open('c').bytes = 500;
    c.open('c');
    expect([c.has('a'), c.has('b'), c.has('c')]).toEqual([false, false, true]);
  });
});

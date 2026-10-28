import { describe, expect, it } from 'vitest';
import { BacklogTracker } from './backlog';

describe('BacklogTracker', () => {
  it('is not loading before a run is opened', () => {
    expect(new BacklogTracker().loading).toBe(false);
  });
  it('loads from opening a run until something ends it', () => {
    const t = new BacklogTracker();
    t.start(1);
    expect(t.loading).toBe(true);
    expect(t.end(1)).toBe(true);
    expect(t.loading).toBe(false);
  });
  it('ends once: a later meta or fetch for the same run is not a second end', () => {
    const t = new BacklogTracker();
    t.start(1);
    t.end(1);
    expect(t.end(1)).toBe(false);
    expect(t.loading).toBe(false);
  });
  it('ignores an end from a run that is no longer open', () => {
    const t = new BacklogTracker();
    t.start(1);
    t.start(2);
    expect(t.end(1)).toBe(false);
    expect(t.loading).toBe(true);
    expect(t.end(2)).toBe(true);
  });
  it('loads again when the same run is opened again', () => {
    const t = new BacklogTracker();
    t.start(1);
    t.end(1);
    t.start(2);
    expect(t.loading).toBe(true);
  });
});

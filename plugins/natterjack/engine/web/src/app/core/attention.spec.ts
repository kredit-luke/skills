import { describe, expect, it } from 'vitest';
import { newlyWaiting, titlePrefix } from './attention';

describe('attention', () => {
  it('the first look reports nothing', () => {
    expect(newlyWaiting(null, ['a', 'b'])).toEqual([]);
  });
  it('reports only runs that weren\'t waiting before', () => {
    expect(newlyWaiting(new Set(['a']), ['a', 'b'])).toEqual(['b']);
    expect(newlyWaiting(new Set(['a', 'b']), ['a'])).toEqual([]);
  });
  it('title prefix', () => {
    expect(titlePrefix(0)).toBe('');
    expect(titlePrefix(3)).toBe('(3) ');
    expect(titlePrefix(120)).toBe('(99+) ');
  });
});

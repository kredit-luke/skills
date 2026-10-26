import { describe, expect, it } from 'vitest';
import { LONG_CHARS, LONG_LINES, longTextSize } from './long-text';

describe('longTextSize', () => {
  it('is null for short text', () => {
    expect(longTextSize('hello')).toBeNull();
    expect(longTextSize(Array(LONG_LINES).fill('x').join('\n'))).toBeNull();
    expect(longTextSize('x'.repeat(LONG_CHARS))).toBeNull();
  });
  it('counts lines first, then characters', () => {
    expect(longTextSize(Array(340).fill('x').join('\n'))).toBe('340 lines');
    expect(longTextSize('x'.repeat(52000))).toBe('52,000 characters');
  });
});

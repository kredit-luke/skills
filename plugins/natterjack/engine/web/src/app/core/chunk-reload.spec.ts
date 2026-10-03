import { describe, expect, it } from 'vitest';
import { isChunkLoadError, shouldReload } from './chunk-reload';

describe('chunk reload', () => {
  it('recognises a failed lazy load in each browser', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://localhost:3335/chunk-6vw9bWPK.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
  it('reloads once per address per minute', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(shouldReload('/knowledge', store, 1000)).toBe(true);
    expect(shouldReload('/knowledge', store, 2000)).toBe(false);
    expect(shouldReload('/connections', store, 3000)).toBe(true);
    expect(shouldReload('/connections', store, 3000 + 61_000)).toBe(true);
  });
});

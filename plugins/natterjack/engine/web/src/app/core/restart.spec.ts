import { describe, expect, it } from 'vitest';
import { waitForRestart } from './restart';

const noSleep = () => Promise.resolve();

describe('waitForRestart', () => {
  it('waits through the old server and the gap, until a new one answers', async () => {
    const answers = ['old', 'old', null, null, 'new'];
    const seen: (string | null)[] = [];
    let i = 0;
    const ok = await waitForRestart('old', async () => { const a = i < answers.length ? answers[i++] : 'new'; seen.push(a); return a; }, { sleep: noSleep });
    expect(ok).toBe(true);
    expect(seen).toEqual(['old', 'old', null, null, 'new']);
  });

  it('treats a failed request as down, not as an error', async () => {
    let n = 0;
    const ok = await waitForRestart('old', async () => { if (n++ < 2) throw new Error('offline'); return 'new'; }, { sleep: noSleep });
    expect(ok).toBe(true);
  });

  it('gives up after the timeout', async () => {
    const ok = await waitForRestart('old', async () => 'old', { timeoutMs: 30, intervalMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    expect(ok).toBe(false);
  });
});

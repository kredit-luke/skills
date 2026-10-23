import { describe, expect, it } from 'vitest';
import type { RunMeta } from '../../../../shared/api';
import { REVIEW_WINDOW_MS, needsAnswer, toReview, unrated } from './run-status';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const ended = (ms: number) => new Date(NOW - ms).toISOString();
const remote = { linkId: 'l1', label: 'Work laptop', enabled: true, pending: [] };

describe('toReview', () => {
  const fine: Pick<RunMeta, 'status' | 'verdict' | 'endedAt' | 'remote'> = { status: 'succeeded', verdict: null, endedAt: ended(60_000) };

  it('a run that finished fine in the last day and is unrated', () => {
    expect(toReview(fine, NOW)).toBe(true);
  });
  it('not once rated, older than a day, unfinished or not succeeded', () => {
    expect(toReview({ ...fine, verdict: 'good' }, NOW)).toBe(false);
    expect(toReview({ ...fine, endedAt: ended(REVIEW_WINDOW_MS) }, NOW)).toBe(false);
    expect(toReview({ ...fine, endedAt: null }, NOW)).toBe(false);
    expect(toReview({ ...fine, status: 'failed' }, NOW)).toBe(false);
  });
  it('never a run mirrored from a linked computer: it is rated there, so it stays out of To review and Focus', () => {
    expect(toReview({ ...fine, remote }, NOW)).toBe(false);
  });
});

describe('unrated', () => {
  const done: Pick<RunMeta, 'status' | 'verdict' | 'remote'> = { status: 'failed', verdict: null };

  it('a finished run with no verdict, at any age or outcome', () => {
    expect(unrated(done)).toBe(true);
    expect(unrated({ ...done, status: 'succeeded' })).toBe(true);
  });
  it('not once rated, or while running or waiting', () => {
    expect(unrated({ ...done, verdict: 'bad' })).toBe(false);
    expect(unrated({ ...done, status: 'running' })).toBe(false);
    expect(unrated({ ...done, status: 'waiting' })).toBe(false);
  });
  it('never a mirrored run: it is rated on the computer', () => {
    expect(unrated({ ...done, remote })).toBe(false);
  });
});

describe('needsAnswer', () => {
  const waiting: Pick<RunMeta, 'status' | 'remote'> = { status: 'waiting' };

  it('a local run waiting for an answer, and not one in any other state', () => {
    expect(needsAnswer(waiting)).toBe(true);
    expect(needsAnswer({ status: 'running' })).toBe(false);
    expect(needsAnswer({ status: 'running', remote })).toBe(false);
  });
  it('a mirrored waiting run whose computer has Remote control on', () => {
    expect(needsAnswer({ ...waiting, remote })).toBe(true);
    expect(needsAnswer({ ...waiting, remote }, true)).toBe(true);
  });
  it('not a mirrored waiting run whose link is off: it cannot be answered here', () => {
    expect(needsAnswer({ ...waiting, remote: { ...remote, enabled: false } })).toBe(false);
  });
  it('the link\'s live state wins over the run\'s own copy, either way', () => {
    expect(needsAnswer({ ...waiting, remote }, false)).toBe(false);
    expect(needsAnswer({ ...waiting, remote: { ...remote, enabled: false } }, true)).toBe(true);
  });
  it('a live link state never affects a local run', () => {
    expect(needsAnswer(waiting, false)).toBe(true);
  });
});

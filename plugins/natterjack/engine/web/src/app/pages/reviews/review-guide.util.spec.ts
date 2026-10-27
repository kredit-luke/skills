import { describe, expect, it } from 'vitest';
import type { DiffFile, ReviewGuide } from '../../../../../shared/api';
import { groupHunks, hunkLabel, noHunkLabel, progressKey } from './review-guide.util';

const hunk = (id: string, newStart = 1) => ({ id, header: '@@', oldStart: newStart, newStart, lines: [] });
const files: DiffFile[] = [
  { path: 'src/a.ts', oldPath: null, status: 'modified', binary: false, additions: 1, deletions: 0, hunks: [hunk('h1', 10), hunk('h2', 40)] },
  { path: 'test/a.test.ts', oldPath: null, status: 'added', binary: false, additions: 1, deletions: 0, hunks: [hunk('h3')] },
  { path: 'package-lock.json', oldPath: null, status: 'modified', binary: false, additions: 1, deletions: 0, hunks: [hunk('h4')] },
];

function guide(over: Partial<ReviewGuide> = {}): ReviewGuide {
  return { sha: 's', at: '', ticket: null, intent: '', core: [], consequences: [], supporting: [], risk: [], questions: [], tags: {}, minutes: 0, ...over };
}

describe('groupHunks', () => {
  it('shows one group in file order without a guide', () => {
    const g = groupHunks(files, null);
    expect(g.map((x) => x.tag)).toEqual(['all']);
    expect(g[0].hunks.map((p) => p.hunk.id)).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('groups by tag, core first in the order the guide names it, empty groups left out', () => {
    const g = groupHunks(files, guide({
      core: [{ title: 'b', text: '', hunks: ['h2'] }, { title: 'a', text: '', hunks: ['h1', 'h2', 'h9'] }],
      tags: { h1: 'core', h2: 'core', h3: 'test', h4: 'generated' },
    }));
    expect(g.map((x) => [x.tag, x.open, x.hunks.map((p) => p.hunk.id)])).toEqual([
      ['core', true, ['h2', 'h1']], ['test', false, ['h3']], ['generated', false, ['h4']],
    ]);
  });

  it('counts an untagged hunk as supporting, and a core-tagged one the points missed as core', () => {
    const g = groupHunks(files, guide({ tags: { h3: 'core' } }));
    expect(g.map((x) => [x.tag, x.hunks.map((p) => p.hunk.id)])).toEqual([['core', ['h3']], ['supporting', ['h1', 'h2', 'h4']]]);
  });
});

describe('hunkLabel and progressKey', () => {
  it('names a hunk by file and line', () => {
    expect(hunkLabel(files, 'h2')).toBe('a.ts:40');
    expect(hunkLabel(files, 'h9')).toBe('h9');
  });
  it('keys progress by PR and commit', () => {
    expect(progressKey('acme/api', 3, 'abc')).toBe('natterjack.review.acme/api#3@abc');
  });
});

describe('noHunkLabel', () => {
  it('says why a file has no lines to show', () => {
    expect(noHunkLabel({ binary: true, status: 'modified' })).toMatch(/binary/);
    expect(noHunkLabel({ binary: false, status: 'renamed' })).toMatch(/renamed/);
    expect(noHunkLabel({ binary: false, status: 'added' })).toMatch(/empty/);
    expect(noHunkLabel({ binary: false, status: 'deleted' })).toMatch(/deleted/);
  });
});

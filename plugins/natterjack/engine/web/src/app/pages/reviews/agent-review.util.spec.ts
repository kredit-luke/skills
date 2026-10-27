import { describe, expect, it } from 'vitest';
import type { AgentFinding } from '../../../../../shared/api';
import { commentBody, groupFindings, initialPicks, placeOf } from './agent-review.util';

function finding(over: Partial<AgentFinding> = {}): AgentFinding {
  return { id: 'f1', category: 'bug', severity: 'high', title: 'Off by one', text: 'Use <=.', file: 'src/a.ts', line: 4, onDiff: true, ...over };
}

describe('agent review findings', () => {
  it('groups in page order and leaves empty groups out', () => {
    const g = groupFindings([finding({ id: 'a', category: 'nitpick' }), finding({ id: 'b', category: 'security' }), finding({ id: 'c' })]);
    expect(g.map((x) => [x.label, x.items.map((f) => f.id)])).toEqual([['Bugs', ['c']], ['Security', ['b']], ['Nitpicks', ['a']]]);
  });

  it('picks everything but nitpicks at first', () => {
    expect([...initialPicks([finding({ id: 'a' }), finding({ id: 'b', category: 'nitpick' }), finding({ id: 'c', category: 'performance' })])]).toEqual(['a', 'c']);
  });

  it('writes the comment with the category, severity, edited text and the agent', () => {
    expect(commentBody(finding(), ' Use < instead. ', 'Codex')).toBe('**Bug (high): Off by one**\n\nUse < instead.\n\n<sub>Found by Codex in an agent review.</sub>');
    expect(commentBody(finding({ category: 'nitpick' }), '', 'Claude Code')).toBe('**Nitpick: Off by one**\n\n<sub>Found by Claude Code in an agent review.</sub>');
  });

  it('names the place', () => {
    expect(placeOf(finding())).toBe('src/a.ts:4');
    expect(placeOf(finding({ line: null }))).toBe('src/a.ts');
    expect(placeOf(finding({ file: null, line: null }))).toBe('');
  });
});

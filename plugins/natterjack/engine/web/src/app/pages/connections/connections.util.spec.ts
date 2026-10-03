import { describe, expect, it } from 'vitest';
import type { Connection } from '../../../../../shared/api';
import { fillVars, groupOf, pairsText, parsePairs, stateLabel, statusOf } from './connections.util';

const row = (over: Partial<Connection>): Connection => ({
  name: 'x', scope: 'user', transport: 'http', target: null, envKeys: [], headerKeys: [], state: 'connected', status: 'Connected',
  approval: null, allowed: false, rule: 'mcp__x', required: null, missing: false, actions: [], hint: null, ...over,
});

describe('connections status', () => {
  it('maps states to the Machine page classes', () => {
    expect(statusOf(row({}))).toBe('ok');
    expect(statusOf(row({ state: 'needs-auth' }))).toBe('warn');
    expect(statusOf(row({ state: 'failed' }))).toBe('missing');
    expect(statusOf(row({ state: null }))).toBe('info');
    expect(statusOf(row({ scope: 'project', approval: 'pending', state: 'pending' }))).toBe('warn');
    expect(statusOf(row({ missing: true, state: null, required: { why: '', add: null, vars: [] } }))).toBe('missing');
  });
  it('labels', () => {
    expect(stateLabel(row({ state: null }))).toBe('Checking…');
    expect(stateLabel(row({ missing: true }))).toBe('Not set up');
  });
  it('groups required servers first', () => {
    expect(groupOf(row({ required: { why: '', add: null, vars: [] }, scope: 'claude.ai' }))).toBe('Your team relies on');
    expect(groupOf(row({ scope: 'local' }))).toBe('This workspace');
  });
});

describe('connections form helpers', () => {
  it('parses and prints pairs', () => {
    expect(parsePairs('Authorization: Bearer a:b\n\nX-Team: 1', ':')).toEqual({ Authorization: 'Bearer a:b', 'X-Team': '1' });
    expect(parsePairs('TOKEN=a=b', '=')).toEqual({ TOKEN: 'a=b' });
    expect(() => parsePairs('oops', '=')).toThrow();
    expect(pairsText({ A: '1' }, ':')).toBe('A: 1');
  });
  it('fills ${VAR} placeholders and leaves unfilled ones', () => {
    const c = fillVars({ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Org': '${ORG}' } }, { TOKEN: 'abc' });
    expect(c.headers).toEqual({ Authorization: 'Bearer abc', 'X-Org': '${ORG}' });
  });
});

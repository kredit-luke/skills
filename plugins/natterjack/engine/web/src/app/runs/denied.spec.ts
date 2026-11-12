import { describe, expect, it } from 'vitest';
import { deniedLabel } from './denied';

describe('deniedLabel', () => {
  it('drops the claude.ai and plugin prefixes', () => {
    expect(deniedLabel({ name: 'claude.ai Slack' })).toBe('Slack');
    expect(deniedLabel({ name: 'plugin:postman:postman' })).toBe('postman');
    expect(deniedLabel({ name: 'github' })).toBe('github');
  });
});

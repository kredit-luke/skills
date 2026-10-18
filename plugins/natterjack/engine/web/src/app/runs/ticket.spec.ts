import { describe, expect, it } from 'vitest';
import { implementTicket, runTicket } from '../../../../shared/run-ticket';

describe('runTicket', () => {
  it('prefers the worktree ticket', () => {
    expect(runTicket({ label: 'ENG-1 thing', prompt: '/implement ENG-2' }, 'eng-294')).toEqual({ id: 'ENG-294', sure: true });
  });
  it('reads /implement and Explain prompts as sure', () => {
    expect(runTicket({ prompt: '/implement ENG-294 --auto' })).toEqual({ id: 'ENG-294', sure: true });
    expect(runTicket({ prompt: 'Explain Linear issue CONF-12: "x"' })).toEqual({ id: 'CONF-12', sure: true });
    expect(runTicket({ prompt: 'Explain issue CONF-13: "x"' })).toEqual({ id: 'CONF-13', sure: true });
    expect(runTicket({ prompt: '/implement api#42' })).toEqual({ id: 'api#42', sure: true });
    expect(runTicket({ prompt: 'Explain issue web#7: "x"' })).toEqual({ id: 'web#7', sure: true });
  });
  it('reads a plugin-namespaced implement as sure', () => {
    expect(runTicket({ prompt: '/multirepo:implement ENG-3 --auto' })).toEqual({ id: 'ENG-3', sure: true });
    expect(runTicket({ prompt: '/acme-tools:implement api#42' })).toEqual({ id: 'api#42', sure: true });
    expect(runTicket({ label: 'x', prompt: '/multirepo:commit now' })).toBeNull();
  });
  it('implementTicket reads only Implement and Explain prompts', () => {
    expect(implementTicket('/multirepo:implement ENG-3 --auto')).toBe('ENG-3');
    expect(implementTicket('/implement ENG-4')).toBe('ENG-4');
    expect(implementTicket('Explain issue ENG-5: "x"')).toBe('ENG-5');
    expect(implementTicket('please /implement ENG-6')).toBeNull();
    expect(implementTicket(null)).toBeNull();
  });
  it('falls back to a mention in the title, then the prompt, as unsure', () => {
    expect(runTicket({ label: 'Test ENG-294 wizard', prompt: 'ENG-1' })).toEqual({ id: 'ENG-294', sure: false });
    expect(runTicket({ label: 'Start the stack', prompt: 'for ENG-294 please' })).toEqual({ id: 'ENG-294', sure: false });
  });
  it('finds nothing in plain text', () => {
    expect(runTicket({ label: 'Tidy the docs', prompt: 'fix the typo' })).toBeNull();
  });
});

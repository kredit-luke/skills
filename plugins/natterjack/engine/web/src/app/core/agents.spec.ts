import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../../shared/api';
import { agentLabel, defaultsFor, effortsFor, isRoutedModel, modelsFor, startAgent, usableAgents } from './agents';

const agent = (id: AgentInfo['id'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  id, label: agentLabel(id), installed: true, signedIn: true, version: '1', problem: null,
  models: [], efforts: [], defaultModel: null, defaultEffort: null,
  capabilities: { planMode: true, costUsd: id === 'claude', backgroundTasks: false, transcripts: false }, ...over,
});
const codex = agent('codex', { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'ultra'] }, { id: 'gpt-6-luna', label: 'Luna', efforts: null }], efforts: ['low', 'medium'], defaultModel: 'gpt-6.1-sol' });

describe('agent picker', () => {
  it('lists only agents that can run here', () => {
    expect(usableAgents([agent('claude'), agent('copilot', { signedIn: false }), codex]).map((a) => a.id)).toEqual(['claude', 'codex']);
    expect(usableAgents(null)).toEqual([]);
  });
  it('Claude uses deck.json options; others their CLI', () => {
    expect(modelsFor(agent('claude'), ['opus', 'sonnet'])).toEqual([{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }]);
    expect(modelsFor(codex, ['opus']).map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(effortsFor(codex, 'gpt-6.1-sol', [])).toEqual(['low', 'ultra']);
    expect(effortsFor(codex, 'gpt-6-luna', []), 'a model without its own list').toEqual(['low', 'medium']);
    expect(effortsFor(agent('claude'), 'opus', ['low', 'max'])).toEqual(['low', 'max']);
  });
  it('defaults: Claude on deck.json, others on their own', () => {
    expect(defaultsFor(agent('claude'), { model: 'opus', effort: 'medium' })).toEqual({ model: 'opus', effort: 'medium' });
    expect(defaultsFor(codex, { model: 'opus', effort: 'medium' })).toEqual({ model: 'gpt-6.1-sol', effort: '' });
  });
  it('starts on the remembered agent, then the workspace default, then Claude', () => {
    const usable = [agent('claude'), codex];
    expect(startAgent(usable, 'codex', null)).toBe('codex');
    expect(startAgent(usable, 'copilot', 'codex'), 'remembered but not usable here').toBe('codex');
    expect(startAgent(usable, null, null)).toBe('claude');
    expect(startAgent([codex], null, null), 'Claude not usable').toBe('codex');
    expect(agentLabel(undefined)).toBe('Claude');
  });
});

describe('local and team models (the Models page)', () => {
  const claude = agent('claude', { models: [
    { id: 'opus', label: 'Opus', efforts: null },
    { id: 'local/ornith:9b', label: 'Local · Ornith 9B', efforts: [] },
    { id: 'team/gpu/glm-5.3', label: 'Team GPU · GLM 5.3', efforts: [] },
  ] });

  it("follow Claude's own models in the Model select, and take no effort", () => {
    expect(modelsFor(claude, ['opus', 'sonnet']).map((m) => m.id)).toEqual(['opus', 'sonnet', 'local/ornith:9b', 'team/gpu/glm-5.3']);
    expect(modelsFor(null, ['opus']).map((m) => m.id)).toEqual(['opus']);
    expect(effortsFor(claude, 'local/ornith:9b', ['low', 'high'])).toEqual([]);
    expect(effortsFor(claude, 'opus', ['low', 'high'])).toEqual(['low', 'high']);
    expect(isRoutedModel('team/gpu/x') && !isRoutedModel('opus') && !isRoutedModel(null)).toBe(true);
  });
});

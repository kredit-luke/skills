import type { AgentId, AgentInfo } from '../../../../shared/api';

/** The agents a run can use here: installed and signed in. Claude stays listed while its status loads. */
export function usableAgents(agents: AgentInfo[] | null): AgentInfo[] {
  if (!agents) return [];
  return agents.filter((a) => a.installed && a.signedIn);
}

/** Model choices for an agent: Claude's come from deck.json options, the others' from their CLI. */
export function modelsFor(agent: AgentInfo | null, deckModels: string[]): { id: string; label: string }[] {
  if (!agent || agent.id === 'claude') return deckModels.map((m) => ({ id: m, label: m }));
  return agent.models.map((m) => ({ id: m.id, label: m.label }));
}

/** Effort choices: the model's own list when it has one, else the agent's (Claude: deck.json options). */
export function effortsFor(agent: AgentInfo | null, modelId: string, deckEfforts: string[]): string[] {
  if (!agent || agent.id === 'claude') return deckEfforts;
  return agent.models.find((m) => m.id === modelId)?.efforts || agent.efforts;
}

/** Where a run starts: Claude on deck.json's defaults; another agent on its CLI's own defaults. */
export function defaultsFor(agent: AgentInfo | null, deck: { model: string; effort: string }): { model: string; effort: string } {
  if (!agent || agent.id === 'claude') return deck;
  return { model: agent.defaultModel || agent.models[0]?.id || '', effort: agent.defaultEffort || '' };
}

/** The agent to start on: the one picked last on this browser, else the workspace default, else Claude (if usable). */
export function startAgent(usable: AgentInfo[], remembered: string | null, workspaceDefault: string | null): AgentId {
  const ids = usable.map((a) => a.id);
  for (const id of [remembered, workspaceDefault, 'claude']) if (id && ids.includes(id as AgentId)) return id as AgentId;
  return (ids[0] || 'claude') as AgentId;
}

const LABELS: Record<string, string> = { claude: 'Claude', copilot: 'Copilot', codex: 'Codex' };
/** An agent's name for labels ("Copilot is working…"); runs from before agents are Claude's. */
export function agentLabel(id: string | null | undefined): string {
  return LABELS[id || 'claude'] || 'Claude';
}

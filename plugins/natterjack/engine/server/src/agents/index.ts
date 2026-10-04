/**
 * Agents: the coding-agent CLIs a dashboard run can use (Claude Code, GitHub Copilot CLI,
 * OpenAI Codex CLI). Everything about a run that isn't the CLI itself (the ledger, statuses,
 * queued messages, question cards, watches, worktrees, diffs) is shared; an adapter only
 * knows how to:
 *   - say whether its CLI is installed and signed in, and which models / efforts it has
 *   - build one turn's command line (first turn, or a resume of its session)
 *   - translate each line it prints into the dashboard's run events, which are Claude
 *     Code's stream-json shapes (system/init, assistant text and tool_use, user tool_result,
 *     result), so the run page renders every agent the same way
 *   - name the terminal command that continues a session
 * `capabilities` switches off what only Claude Code has (plan-usage meters, background-task
 * tracking, transcripts for "continue in terminal", budgets in dollars).
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { RunEvent } from "../../../shared/api.ts";
import { ClaudeAgent } from "./claude.ts";
import { CodexAgent } from "./codex.ts";
import { CopilotAgent } from "./copilot.ts";

export type AgentId = "claude" | "copilot" | "codex";

export interface AgentModel { id: string; label: string; efforts: string[] | null }

export interface AgentStatus {
  id: AgentId;
  label: string;
  installed: boolean;
  signedIn: boolean;
  version: string | null;
  /** Why it can't run, in a sentence (not installed, not signed in), or null. */
  problem: string | null;
  models: AgentModel[];
  efforts: string[];
  defaultModel: string | null;
  defaultEffort: string | null;
  capabilities: AgentCapabilities;
}

export interface AgentCapabilities {
  /** Plan mode that actually stops edits (not just a prompt). */
  planMode: boolean;
  /** Reports what a turn cost in dollars (and takes a per-run budget). */
  costUsd: boolean;
  /** Tracks background tasks and subagents (Claude's task_* events). */
  backgroundTasks: boolean;
  /** A transcript on disk the dashboard can follow after "Continue in terminal". */
  transcripts: boolean;
}

/** What a turn needs from the run. */
export interface TurnInput {
  first: boolean;
  sessionId: string;
  prompt: string;
  label: string;
  model: string | null;
  effort: string | null;
  planMode: boolean;
  permissionMode: string;
  budgetUsd: number | null;
  /** The dashboard's headless rules plus the run's extra notes (docs sources, knowledge). */
  rules: string;
  /** Plan mode's rule for this turn, or null. */
  planRule: string | null;
  addDirs: string[];
}

/** Translation state for one turn (some CLIs spread a tool call over several lines). */
export type ParseState = Record<string, any>;

export interface Agent {
  id: AgentId;
  label: string;
  capabilities: AgentCapabilities;
  status(force?: boolean): Promise<AgentStatus>;
  /** The CLI's arguments for one turn. */
  turnArgs(t: TurnInput): string[];
  spawn(args: string[], opts: SpawnOptions): ChildProcess;
  /** One printed line (parsed JSON) → the dashboard's run events (none to drop it). */
  parse(line: any, state: ParseState): RunEvent[];
  /** The command that continues this session in a terminal. */
  resumeCommand(sessionId: string): string;
}

const AGENTS: Record<AgentId, Agent> = {
  claude: new ClaudeAgent(),
  copilot: new CopilotAgent(),
  codex: new CodexAgent(),
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** The adapter for an agent id (anything unknown, or missing, is Claude: older runs and config). */
export function agentOf(id: unknown): Agent {
  return AGENTS[(typeof id === "string" && id in AGENTS ? id : "claude") as AgentId];
}

export function isAgentId(id: unknown): id is AgentId {
  return typeof id === "string" && id in AGENTS;
}

/** Every agent's status, checked in parallel. */
export async function agentStatuses(force = false): Promise<AgentStatus[]> {
  return Promise.all(AGENT_IDS.map((id) => AGENTS[id].status(force).catch((e) => ({
    id, label: AGENTS[id].label, installed: false, signedIn: false, version: null, problem: e.message,
    models: [], efforts: [], defaultModel: null, defaultEffort: null, capabilities: AGENTS[id].capabilities,
  }))));
}

export { AGENT_HEADLESS_RULES, clip, withRules } from "./util.ts";

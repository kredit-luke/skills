/**
 * Turns a run's flat stream-json events into a tree the run page renders:
 * main-session items, with each subagent (Agent tool call) as a card holding its
 * own items and any nested cards. Pure: no DOM, no Angular (unit tested).
 *
 * What the CLI emits (captured from a real stream, see fixtures/):
 *  - assistant/user messages carry parent_tool_use_id: null for the main session,
 *    else the id of the Agent tool_use whose subagent produced them.
 *  - system task_started / task_progress / task_updated / task_notification track
 *    subagents (task_type 'local_agent') and background Bash ('local_bash').
 *    task_updated carries only task_id, so task_id → tool_use_id is remembered.
 *  - a background agent's tool_result is "Async agent launched…"; it finishes later
 *    (task_notification), and the model is re-invoked: a second init + result.
 * Dashboard-added: { type: 'human' } (your replies), { type: 'turn' } (turn N starts),
 * { type: 'divider', text } (e.g. "Continued in terminal").
 */

import type { Attachment } from '../../../../shared/api';

export type AgentStatus ='starting' | 'running' | 'completed' | 'failed' | 'stopped';

export interface ToolItem {
  kind: 'tool'; key: string; id: string; name: string; label: string;
  input: Record<string, any>; output: string | null; isError: boolean; done: boolean;
  /** Set for background Bash tasks: 'running' | 'completed' | 'failed' | 'killed' … */
  bgStatus?: string;
}
export interface AgentCard {
  id: string; agentType: string; description: string; prompt: string; background: boolean;
  status: AgentStatus; activity: string; lastTool: string; tokens: number; toolUses: number;
  durationMs: number | null; summary: string; steps: number; depth: number;
  items: ThreadItem[];
}
export type ThreadItem =
  | { kind: 'text'; key: string; text: string }
  | ToolItem
  | { kind: 'agent'; key: string; card: AgentCard }
  | { kind: 'human'; key: string; text: string; from: 'dashboard' | 'terminal'; attachments: Attachment[] }
  | { kind: 'turn'; key: string; turn: number; planMode: boolean }
  | { kind: 'sys'; key: string; text: string }
  | { kind: 'result'; key: string; ok: boolean; subtype: string; text: string; durationMs: number | null; numTurns: number }
  | { kind: 'divider'; key: string; text: string };

export interface Thread {
  items: ThreadItem[];
  /** Every agent card in order of appearance (nested ones too), for the agent strip. */
  agents: AgentCard[];
}

const SKIP_TYPES = new Set(['rate_limit_event', 'tool_progress', 'stream_event', 'keep_alive']);
const SKIP_SYSTEM = new Set(['hook_started', 'hook_response', 'commands_changed', 'thinking_tokens', 'background_tasks_changed', 'status', 'compact_boundary', 'api_retry']);
const FINISHED: AgentStatus[] = ['completed', 'failed', 'stopped'];
const QUESTION_RE = /<<QUESTION>>[\s\S]*?(<<\/QUESTION>>|$)/g;

export function stripQuestion(text: string): string {
  return String(text || '').replace(QUESTION_RE, '').trim();
}

function base(p: string | null | undefined): string {
  const s = String(p || '');
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || s;
}

function oneLine(s: unknown, max = 160): string {
  return String(s == null ? '' : s).split('\n')[0].trim().slice(0, max);
}

/** Short, human label for a tool call: what it does, not its raw input. */
export function toolLabel(name: string, input: Record<string, any> = {}): string {
  switch (name) {
    case 'Bash': case 'PowerShell': case 'BashOutput':
      return oneLine(input['description'] || input['command']);
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return base(input['file_path'] || input['notebook_path']);
    case 'Grep':
      return `"${oneLine(input['pattern'], 80)}" in ${input['path'] ? base(input['path']) : '.'}`;
    case 'Glob':
      return oneLine(input['pattern']) + (input['path'] ? ' in ' + base(input['path']) : '');
    case 'Skill':
      return '/' + (input['skill'] || '') + (input['args'] ? ' ' + oneLine(input['args'], 100) : '');
    case 'Agent': case 'Task':
      return oneLine(input['description'] || input['subagent_type']);
    case 'WebFetch':
      return oneLine(input['url']);
    case 'WebSearch':
      return oneLine(input['query']);
    case 'TodoWrite':
      return (Array.isArray(input['todos']) ? input['todos'].length : 0) + ' todos';
  }
  const v = input['command'] || input['file_path'] || input['pattern'] || input['url'] || input['query'] ||
    input['description'] || input['prompt'] || input['skill'] || input['name'] || input['title'];
  return oneLine(v);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c && c.type === 'text' ? c.text : '[' + (c && c.type) + ']')).join('\n');
  return '';
}

export interface BuildOptions {
  /** False once the run has no live process: unfinished agents then show "Stopped". */
  runActive?: boolean;
}

export function buildThread(events: readonly any[], opts: BuildOptions = {}): Thread {
  const main: ThreadItem[] = [];
  const agents: AgentCard[] = [];
  const cards = new Map<string, AgentCard>();
  const tools = new Map<string, ToolItem>();
  const taskToTool = new Map<string, string>();
  let n = 0;
  const key = (p: string) => p + ':' + n++;
  let inits = 0;
  let turn = 1;
  let lastInitTurn = 0;

  const card = (id: string, depth = 1): AgentCard => {
    let c = cards.get(id);
    if (!c) {
      c = { id, agentType: '', description: '', prompt: '', background: false, status: 'starting', activity: '', lastTool: '', tokens: 0, toolUses: 0, durationMs: null, summary: '', steps: 0, depth, items: [] };
      cards.set(id, c);
      agents.push(c);
    }
    return c;
  };
  const containerFor = (parent: string | null | undefined): ThreadItem[] => (parent ? card(parent).items : main);
  const finish = (c: AgentCard, status: AgentStatus) => { if (!FINISHED.includes(c.status) || status === 'failed') c.status = status; };

  for (const ev of events) {
    if (!ev || SKIP_TYPES.has(ev.type)) continue;

    if (ev.type === 'system') {
      const st = ev.subtype;
      if (SKIP_SYSTEM.has(st)) continue;
      if (st === 'init') {
        // A background agent finishing re-invokes the model inside the same turn: that
        // repeat init isn't a new session, so only label the first per turn.
        if (lastInitTurn === turn) continue;
        lastInitTurn = turn;
        inits++;
        const bits = [ev.model, ev.permissionMode].filter(Boolean).join(' · ');
        main.push({ kind: 'sys', key: key('init'), text: (inits === 1 ? 'Session started' : 'Resumed') + (bits ? ' · ' + bits : '') });
        continue;
      }
      if (st && st.startsWith('task_')) {
        const toolId: string | undefined = ev.tool_use_id || (ev.task_id ? taskToTool.get(ev.task_id) : undefined);
        if (ev.task_id && ev.tool_use_id) taskToTool.set(ev.task_id, ev.tool_use_id);
        if (!toolId) continue;
        const isAgent = ev.task_type === 'local_agent' || cards.has(toolId) || (ev.task_type !== 'local_bash' && !tools.has(toolId));
        if (!isAgent) {
          const t = tools.get(toolId);
          if (t) t.bgStatus = st === 'task_started' ? 'running' : ev.status || (ev.patch && ev.patch.status) || t.bgStatus;
          continue;
        }
        const c = card(toolId);
        if (st === 'task_started') {
          if (!FINISHED.includes(c.status)) c.status = 'running';
          c.background = c.background || !!ev.is_backgrounded;
          c.agentType = c.agentType || ev.subagent_type || '';
          c.description = c.description || ev.description || '';
          c.prompt = c.prompt || ev.prompt || '';
        } else if (st === 'task_progress') {
          // A late progress event must not reset a finished agent to running.
          if (!FINISHED.includes(c.status)) {
            c.status = 'running';
            c.activity = ev.description || c.activity;
            c.lastTool = ev.last_tool_name || c.lastTool;
          }
          if (ev.usage) applyUsage(c, ev.usage);
        } else if (st === 'task_updated') {
          const s = ev.patch && ev.patch.status;
          if (s) finish(c, mapStatus(s));
        } else if (st === 'task_notification') {
          if (ev.status) finish(c, mapStatus(ev.status));
          if (ev.summary) c.summary = ev.summary;
          if (ev.usage) applyUsage(c, ev.usage);
        }
        continue;
      }
      continue; // other system events aren't shown
    }

    if (ev.type === 'turn') {
      turn = ev.turn || turn + 1;
      main.push({ kind: 'turn', key: key('turn'), turn, planMode: !!ev.planMode });
      continue;
    }
    if (ev.type === 'human') {
      const text = String(ev.text || '').trim();
      const attachments: Attachment[] = Array.isArray(ev.attachments) ? ev.attachments : [];
      if (text || attachments.length) main.push({ kind: 'human', key: key('human'), text, from: ev.turn ? 'dashboard' : 'terminal', attachments });
      continue;
    }
    if (ev.type === 'divider') {
      main.push({ kind: 'divider', key: key('div'), text: String(ev.text || '') });
      continue;
    }

    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      const parent: string | null = ev.parent_tool_use_id || null;
      const into = containerFor(parent);
      const owner = parent ? card(parent) : null;
      for (const b of ev.message.content) {
        if (!b) continue;
        if (b.type === 'text') {
          const text = parent ? String(b.text || '').trim() : stripQuestion(b.text);
          if (text) into.push({ kind: 'text', key: key('text'), text });
        } else if (b.type === 'tool_use') {
          if (owner) owner.steps++;
          if (b.name === 'Agent' || b.name === 'Task') {
            const c = card(b.id, owner ? owner.depth + 1 : 1);
            const input = b.input || {};
            c.agentType = input.subagent_type || c.agentType || 'agent';
            c.description = input.description || c.description;
            c.prompt = typeof input.prompt === 'string' ? input.prompt : c.prompt;
            c.background = c.background || !!input.run_in_background;
            if (owner) c.depth = owner.depth + 1;
            into.push({ kind: 'agent', key: 'agent:' + b.id, card: c });
          } else {
            const t: ToolItem = { kind: 'tool', key: 'tool:' + b.id, id: b.id, name: b.name, label: toolLabel(b.name, b.input), input: b.input || {}, output: null, isError: false, done: false };
            tools.set(b.id, t);
            into.push(t);
          }
        }
        // thinking / redacted_thinking blocks are never shown
      }
      continue;
    }

    if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const text = resultText(b.content);
        const c = cards.get(b.tool_use_id);
        if (c) {
          if (/Async agent launched/i.test(text)) { c.background = true; if (c.status === 'starting') c.status = 'running'; continue; }
          if (!c.background) {
            finish(c, b.is_error ? 'failed' : 'completed');
            if (!c.summary) c.summary = text.trim();
          }
          continue;
        }
        const t = tools.get(b.tool_use_id);
        if (t) { t.output = text; t.isError = !!b.is_error; t.done = true; }
      }
      continue;
    }

    if (ev.type === 'result') {
      const text = stripQuestion(typeof ev.result === 'string' ? ev.result : '');
      // The result repeats the final assistant message; drop the duplicate.
      const last = main[main.length - 1];
      if (last && last.kind === 'text' && text && last.text === text) main.pop();
      const ok = !ev.is_error && (!ev.subtype || ev.subtype === 'success');
      main.push({ kind: 'result', key: key('result'), ok, subtype: ev.subtype || '', text, durationMs: ev.duration_ms ?? null, numTurns: ev.num_turns || 0 });
      continue;
    }
  }

  if (opts.runActive === false) {
    for (const c of agents) if (!FINISHED.includes(c.status)) c.status = 'stopped';
  }
  return { items: main, agents };
}

function applyUsage(c: AgentCard, u: any): void {
  if (u.total_tokens != null) c.tokens = u.total_tokens;
  if (u.tool_uses != null) c.toolUses = u.tool_uses;
  if (u.duration_ms != null) c.durationMs = u.duration_ms;
}

function mapStatus(s: string): AgentStatus {
  if (s === 'completed' || s === 'success') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'killed' || s === 'stopped' || s === 'cancelled') return 'stopped';
  return 'running';
}

/** Count items (tool rows, nested agents' rows) for a card's "N steps". */
export function countSteps(c: AgentCard): number {
  return Math.max(c.steps, c.toolUses);
}

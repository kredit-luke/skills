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
 *  - SendMessage({ to: <agentId> }) resumes a finished subagent: task_* events come
 *    under the SendMessage's id (task_id = the agent) and its result is a JSON
 *    "Resuming agent …", but the pass's own messages keep the FIRST Agent call's id
 *    as parent_tool_use_id. Each pass is its own card where the SendMessage was, so
 *    the transcript stays in time order, and messages under an earlier pass's id go
 *    to the newest pass that has started. Cards of one agent share agentId and count
 *    up `pass`.
 *  - a subagent's report is its SubagentHandback call; the CLI's tool_result and
 *    notification only say it was "delivered to you as a message".
 *  - a foreground Bash that outlives the CLI's own timer gets task_* events too
 *    (is_backgrounded: false): that isn't a background task.
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
  /** The subagent's own id (task_id), shared by every pass of it; '' until known. */
  agentId: string;
  /** 1 for the Agent call, 2+ for each SendMessage that resumed the same agent. */
  pass: number;
  /** This card is a SendMessage resume, not the Agent call itself. */
  resumed: boolean;
  /**
   * The model that answered the subagent (its first assistant message's message.model); '' until
   * known. With smart routing an Explore runs on an open model, and this is the only place that shows.
   */
  model: string;
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
const WATCH_RE = /<<WATCH>>[\s\S]*?(<<\/WATCH>>|$)/g;
/** message.model on messages the CLI made up itself (an interrupt, an error), not a model's answer. */
const SYNTHETIC_MODEL = '<synthetic>';

/** True for a model that isn't Claude: a smart-routing explorer, or a local/team model. */
export function isOpenModel(model: string | null | undefined): boolean {
  return !!model && !/^claude-/i.test(model);
}

export function stripQuestion(text: string): string {
  return String(text || '').replace(QUESTION_RE, '').replace(WATCH_RE, '').trim();
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

/** The CLI's stand-in for a report that went to the lead as a SubagentHandback message. */
const HANDBACK_NOTE = /report was delivered to you as a message from/i;
const AGENT_ID_IN_TEXT = /agentId:\s*([\w-]{6,64})/;

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
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
  /** Where each tool row sits, so a SendMessage row can become a card in place. */
  const toolIn = new Map<string, ThreadItem[]>();
  const taskToTool = new Map<string, string>();
  /** Every card of one subagent, by its agent id, in pass order. */
  const passes = new Map<string, AgentCard[]>();
  /** A parent id the stream never showed, tied to the agent whose resumed pass its messages turned out to be. */
  const aliases = new Map<string, string>();
  /** Tool calls the CLI actually backgrounded (task_started is_backgrounded). */
  const backgrounded = new Set<string>();
  let n = 0;
  const key = (p: string) => p + ':' + n++;
  let inits = 0;
  let turn = 1;
  let lastInitTurn = 0;

  const card = (id: string, depth = 1): AgentCard => {
    let c = cards.get(id);
    if (!c) {
      c = { id, agentType: '', description: '', prompt: '', background: false, status: 'starting', activity: '', lastTool: '', tokens: 0, toolUses: 0, durationMs: null, summary: '', steps: 0, depth, items: [], agentId: '', pass: 1, resumed: false, model: '' };
      cards.set(id, c);
      agents.push(c);
    }
    return c;
  };
  /** Tie a card to its subagent; a resume's pass number follows the agent's earlier cards. */
  const link = (c: AgentCard, agentId: unknown) => {
    const id = String(agentId || '');
    if (!id || c.agentId) return;
    c.agentId = id;
    const list = passes.get(id) || [];
    list.push(c);
    passes.set(id, list);
    c.pass = list.length;
    const first = list[0];
    if (c !== first) {
      c.agentType = c.agentType || first.agentType;
      c.depth = first.depth;
    }
  };
  /** A SendMessage row that turned out to resume a subagent: swap it for that pass's card, in place. */
  const resumeCard = (toolId: string): AgentCard => {
    const c = card(toolId);
    const t = tools.get(toolId);
    if (t && t.name === 'SendMessage') {
      const box = toolIn.get(toolId);
      const at = box ? box.indexOf(t) : -1;
      if (box && at >= 0) box.splice(at, 1, { kind: 'agent', key: 'agent:' + toolId, card: c });
      tools.delete(toolId);
      c.resumed = true;
      c.background = true;
      c.description = c.description || oneLine(t.input['summary']);
      c.prompt = c.prompt || (typeof t.input['message'] === 'string' ? t.input['message'] : '');
    }
    return c;
  };
  /**
   * Some resumed passes stream under the first Agent call's id, not the SendMessage's:
   * once a later pass of the same agent has started, its messages belong to that pass.
   * (A message queued while the agent is still busy starts no pass, so nothing moves.)
   */
  const currentPass = (parent: string | null): string | null => {
    if (!parent) return parent;
    const c = cards.get(parent);
    let agentId = c ? c.agentId : aliases.get(parent);
    if (!c && !agentId) {
      // A parent this stream never showed (it starts after the Agent call): the messages are
      // the running resumed pass's, when exactly one agent is resumed without its first pass here.
      const orphans = agents.filter((a) => a.resumed && a.status === 'running' && a.agentId && !(passes.get(a.agentId) || []).some((p) => !p.resumed));
      if (orphans.length === 1) { agentId = orphans[0].agentId; aliases.set(parent, agentId); }
    }
    const list = agentId ? passes.get(agentId) : undefined;
    const latest = list ? [...list].reverse().find((p) => p.status !== 'starting') : undefined;
    if (!latest) return parent;
    return c ? (latest.pass > c.pass ? latest.id : parent) : latest.id;
  };
  const containerFor = (parent: string | null | undefined): ThreadItem[] => (parent ? card(parent).items : main);
  const finish = (c: AgentCard, status: AgentStatus) => { if (!FINISHED.includes(c.status) || status === 'failed') c.status = status; };
  /** A report, unless it's only the CLI's note that the report went elsewhere (the SubagentHandback has it). */
  const report = (c: AgentCard, text: string) => { if (!c.summary && text.trim() && !HANDBACK_NOTE.test(text)) c.summary = text.trim(); };

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
          if (st === 'task_started' && ev.is_backgrounded) backgrounded.add(toolId);
          // Only a call the CLI backgrounded is a background task; a long foreground one gets task_* events too.
          if (t && (backgrounded.has(toolId) || t.input['run_in_background'])) {
            t.bgStatus = st === 'task_started' ? 'running' : ev.status || (ev.patch && ev.patch.status) || t.bgStatus;
          }
          continue;
        }
        const c = resumeCard(toolId);
        if (st === 'task_started') {
          if (!FINISHED.includes(c.status)) c.status = 'running';
          c.background = c.background || !!ev.is_backgrounded;
          c.agentType = c.agentType || ev.subagent_type || '';
          link(c, ev.task_id);
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
          if (ev.summary) report(c, String(ev.summary));
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
      const parent: string | null = currentPass(ev.parent_tool_use_id || null);
      const into = containerFor(parent);
      const owner = parent ? card(parent) : null;
      const model = ev.message.model;
      if (owner && !owner.model && typeof model === 'string' && model && model !== SYNTHETIC_MODEL) owner.model = model;
      for (const b of ev.message.content) {
        if (!b) continue;
        if (b.type === 'text') {
          const text = parent ? String(b.text || '').trim() : stripQuestion(b.text);
          if (text) into.push({ kind: 'text', key: key('text'), text });
        } else if (b.type === 'tool_use') {
          // The subagent's report: the card's summary, not a step.
          if (owner && b.name === 'SubagentHandback') {
            const msg = b.input && b.input.message;
            if (typeof msg === 'string' && msg.trim()) owner.summary = msg.trim();
            continue;
          }
          if (owner) owner.steps++;
          // A SendMessage stays a plain row until the CLI confirms it started a pass (task_started,
          // or a result naming resumedAgentId): one to an agent that's still busy is only a message.
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
            toolIn.set(b.id, into);
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
          const id = AGENT_ID_IN_TEXT.exec(text);
          if (id) link(c, id[1]);
          if (c.resumed) {
            // SendMessage's own result: the resume was accepted (the pass itself finishes later) or refused.
            const r = parseJson(text.trim());
            if (r && r.resumedAgentId) link(c, r.resumedAgentId);
            if (b.is_error || (r && r.success === false)) { finish(c, 'failed'); report(c, (r && r.message) || text); }
            else if (c.status === 'starting') c.status = 'running';
            continue;
          }
          if (/Async agent launched/i.test(text)) { c.background = true; if (c.status === 'starting') c.status = 'running'; continue; }
          if (!c.background) {
            finish(c, b.is_error ? 'failed' : 'completed');
            report(c, text);
          }
          continue;
        }
        const t = tools.get(b.tool_use_id);
        if (t && t.name === 'SendMessage' && !b.is_error) {
          // "Resuming agent …" before (or without) its task_started: that is a new pass.
          const r = parseJson(text.trim());
          if (r && r.success !== false && r.resumedAgentId) {
            const rc = resumeCard(b.tool_use_id);
            link(rc, r.resumedAgentId);
            if (rc.status === 'starting') rc.status = 'running';
            continue;
          }
        }
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

/** The subagent strip shows every card up to this many; past it, it collapses. */
export const STRIP_COLLAPSE_AT = 8;

/**
 * The subagent strip, collapsed: every card still working or that failed (what needs a look),
 * plus the last `recent` cards, in run order. `hidden` is how many were left out.
 */
export function stripAgents(agents: readonly AgentCard[], recent = 4): { shown: AgentCard[]; hidden: number } {
  if (agents.length <= STRIP_COLLAPSE_AT) return { shown: [...agents], hidden: 0 };
  const keep = new Set(agents.slice(-recent));
  for (const a of agents) if (a.status === 'running' || a.status === 'starting' || a.status === 'failed') keep.add(a);
  const shown = agents.filter((a) => keep.has(a));
  return { shown, hidden: agents.length - shown.length };
}

/** "1 running · 41 done · 1 failed": the strip's one-line summary. */
export function stripSummary(agents: readonly AgentCard[]): string {
  const n = (s: AgentStatus[]) => agents.filter((a) => s.includes(a.status)).length;
  return [[n(['running', 'starting']), 'running'], [n(['completed']), 'done'], [n(['failed']), 'failed'], [n(['stopped']), 'stopped']]
    .filter(([c]) => c).map(([c, l]) => `${c} ${l}`).join(' · ');
}

/** "3 on gemma4:12b-ctx64k": the subagents that ran on an open model, per model; '' when none did. */
export function openModelSummary(agents: readonly AgentCard[]): string {
  const counts = new Map<string, number>();
  for (const a of agents) if (isOpenModel(a.model)) counts.set(a.model, (counts.get(a.model) || 0) + 1);
  return [...counts].map(([m, c]) => `${c} on ${m}`).join(' · ');
}

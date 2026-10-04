import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STRIP_COLLAPSE_AT, buildThread, isOpenModel, openModelSummary, stripAgents, stripQuestion, stripSummary, toolLabel, type AgentCard, type AgentStatus, type ThreadItem } from './thread';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(here, 'fixtures', name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const kinds = (items: ThreadItem[]) => items.map((i) => i.kind);

describe('buildThread on a real background-subagent stream', () => {
  const events = fixture('subagent-background.jsonl');
  const t = buildThread(events, { runActive: false });

  it('makes one agent card with its type, description and prompt', () => {
    expect(t.agents).toHaveLength(1);
    const a = t.agents[0];
    expect(a.agentType).toBe('general-purpose');
    expect(a.description).toBe('Probe agent');
    expect(a.prompt).toContain('echo probe-ok');
    expect(a.background).toBe(true);
  });

  it('nests the subagent tool call inside the card, paired with its result', () => {
    const a = t.agents[0];
    const tool = a.items.find((i) => i.kind === 'tool');
    expect(tool && tool.kind === 'tool' && tool.name).toBe('PowerShell');
    expect(tool && tool.kind === 'tool' && tool.label).toBe('Run probe command');
    expect(tool && tool.kind === 'tool' && tool.output).toBe('probe-ok');
    expect(tool && tool.kind === 'tool' && tool.done).toBe(true);
  });

  it('keeps subagent tool rows out of the main thread', () => {
    expect(t.items.some((i) => i.kind === 'tool')).toBe(false);
  });

  it('finishes the agent from task_updated/task_notification with usage and summary', () => {
    const a = t.agents[0];
    expect(a.status).toBe('completed');
    expect(a.tokens).toBe(21097);
    expect(a.durationMs).toBe(5131);
    expect(a.summary).toContain('probe-ok');
  });

  it('labels only the first init of a turn, even when the model is re-invoked', () => {
    const sys = t.items.filter((i) => i.kind === 'sys');
    expect(sys).toHaveLength(1);
    expect(sys[0].kind === 'sys' && sys[0].text).toMatch(/^Session started/);
  });

  it('keeps both results of the turn (background agent re-invocation)', () => {
    expect(t.items.filter((i) => i.kind === 'result')).toHaveLength(2);
  });
});

describe('buildThread basics', () => {
  it('pairs a main-session tool call with its result and marks errors', () => {
    const t = buildThread([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] } },
    ]);
    expect(t.items).toHaveLength(1);
    const row = t.items[0];
    expect(row.kind).toBe('tool');
    if (row.kind === 'tool') { expect(row.label).toBe('Run tests'); expect(row.isError).toBe(true); expect(row.output).toBe('boom'); }
  });

  it('labels turns: Session started, then Resumed after a reply', () => {
    const t = buildThread([
      { type: 'system', subtype: 'init', model: 'opus', permissionMode: 'plan' },
      { type: 'result', subtype: 'success', result: 'hi' },
      { type: 'turn', turn: 2, planMode: false },
      { type: 'human', text: 'go on', turn: 2 },
      { type: 'system', subtype: 'init', model: 'opus', permissionMode: 'auto' },
      { type: 'result', subtype: 'success', result: 'done' },
    ]);
    expect(kinds(t.items)).toEqual(['sys', 'result', 'turn', 'human', 'sys', 'result']);
    const sys = t.items.filter((i) => i.kind === 'sys').map((i) => (i.kind === 'sys' ? i.text : ''));
    expect(sys[0]).toMatch(/^Session started · opus · plan/);
    expect(sys[1]).toMatch(/^Resumed · opus · auto/);
  });

  it('drops the assistant text the result repeats', () => {
    const t = buildThread([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'All done.' }] } },
      { type: 'result', subtype: 'success', result: 'All done.' },
    ]);
    expect(kinds(t.items)).toEqual(['result']);
  });

  it('strips question blocks from main-session text only', () => {
    const q = 'Pick one.\n<<QUESTION>>\n{"questions":[]}\n<</QUESTION>>';
    const t = buildThread([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'x', description: 'd', prompt: 'p' } }] } },
      { type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'text', text: 'sub says <<QUESTION>>' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: q }] } },
    ]);
    const mainText = t.items.find((i) => i.kind === 'text');
    expect(mainText && mainText.kind === 'text' && mainText.text).toBe('Pick one.');
    const sub = t.agents[0].items[0];
    expect(sub.kind === 'text' && sub.text).toBe('sub says <<QUESTION>>');
    expect(stripQuestion('a <<QUESTION>> {"x":1}')).toBe('a');
    expect(stripQuestion('watching now <<WATCH>>{"prs":["a/b#1"]}<</WATCH>>')).toBe('watching now');
  });

  it('nests agents inside agents', () => {
    const t = buildThread([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'p', name: 'Agent', input: { subagent_type: 'planner', description: 'Plan it' } }] } },
      { type: 'assistant', parent_tool_use_id: 'p', message: { content: [{ type: 'tool_use', id: 'c', name: 'Agent', input: { subagent_type: 'reviewer', description: 'Review it' } }] } },
      { type: 'user', parent_tool_use_id: 'p', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: 'looks good' }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'p', content: 'plan done' }] } },
    ]);
    expect(t.agents.map((a) => a.agentType)).toEqual(['planner', 'reviewer']);
    const planner = t.agents[0];
    const nested = planner.items[0];
    expect(nested.kind).toBe('agent');
    expect(nested.kind === 'agent' && (nested.card as AgentCard).depth).toBe(2);
    expect(planner.status).toBe('completed');
    expect(planner.summary).toBe('plan done');
    expect(t.agents[1].status).toBe('completed');
  });

  it('does not let a late task_progress reset a finished agent', () => {
    const t = buildThread([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { subagent_type: 'x' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'k', tool_use_id: 'a', task_type: 'local_agent' },
      { type: 'system', subtype: 'task_updated', task_id: 'k', patch: { status: 'completed' } },
      { type: 'system', subtype: 'task_progress', task_id: 'k', tool_use_id: 'a', description: 'Running late thing', usage: { total_tokens: 5 } },
    ], { runActive: true });
    expect(t.agents[0].status).toBe('completed');
    expect(t.agents[0].activity).toBe('');
  });

  it('shows unfinished agents as Stopped once the run is over', () => {
    const events = [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { subagent_type: 'x' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'k', tool_use_id: 'a', task_type: 'local_agent' },
    ];
    expect(buildThread(events, { runActive: true }).agents[0].status).toBe('running');
    expect(buildThread(events, { runActive: false }).agents[0].status).toBe('stopped');
  });

  it('tracks background Bash tasks on their tool row, not as agents', () => {
    const t = buildThread([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm ci', run_in_background: true } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'k', tool_use_id: 'b', task_type: 'local_bash' },
      { type: 'system', subtype: 'task_updated', task_id: 'k', patch: { status: 'killed' } },
    ]);
    expect(t.agents).toHaveLength(0);
    const row = t.items[0];
    expect(row.kind === 'tool' && row.bgStatus).toBe('killed');
  });

  it('skips noise events', () => {
    const t = buildThread([
      { type: 'rate_limit_event' }, { type: 'tool_progress' },
      { type: 'system', subtype: 'hook_started' }, { type: 'system', subtype: 'thinking_tokens' },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
    ]);
    expect(t.items).toHaveLength(0);
  });
});

describe('toolLabel', () => {
  it('says what each tool does', () => {
    expect(toolLabel('Bash', { command: 'ls -la', description: 'List files' })).toBe('List files');
    expect(toolLabel('Bash', { command: 'ls -la\necho hi' })).toBe('ls -la');
    expect(toolLabel('Read', { file_path: 'C:\\repo\\src\\app.ts' })).toBe('app.ts');
    expect(toolLabel('Grep', { pattern: 'foo', path: '/repo/src' })).toBe('"foo" in src');
    expect(toolLabel('Grep', { pattern: 'foo' })).toBe('"foo" in .');
    expect(toolLabel('Skill', { skill: 'commit', args: '--amend' })).toBe('/commit --amend');
    expect(toolLabel('Agent', { description: 'Review diff', subagent_type: 'reviewer' })).toBe('Review diff');
    expect(toolLabel('mcp__linear__get_issue', { title: 'x' })).toBe('x');
  });
});

// A real /implement stream (trimmed, text scrubbed): a reviewer's first pass is an Agent
// call; later passes are SendMessage({ to: <agentId> }) resumes, whose task_* events carry
// the SendMessage id while their messages keep the Agent call's. A foreground "wait" Bash
// also gets task_* events there.
describe('buildThread: subagents resumed with SendMessage', () => {
  const events = fixture('subagent-resume.jsonl');
  const AGENT = 'ad4b466c915fda516';
  const FIRST = 'toolu_01A38qv6pjPY8FSYaMGwN8LH';
  const RESUME1 = 'toolu_01F37uHkgnkc5ujDNnZPU3kU';
  const RESUME2 = 'toolu_016CP1UfazUhjFwQweq3TefT';
  const WAIT = 'toolu_01WxwdCAdF4AJJNABVP6GYnn';
  const t = buildThread(events, { runActive: false });
  const byId = (id: string) => t.agents.find((a) => a.id === id)!;
  const agentItems = (items: ThreadItem[]): AgentCard[] =>
    items.flatMap((i) => (i.kind === 'agent' ? [i.card, ...agentItems(i.card.items)] : []));

  it('gives each pass its own card in time order, numbered and tied to the same agent', () => {
    expect(t.agents.map((a) => [a.id, a.pass, a.resumed, a.agentId])).toEqual([
      [FIRST, 1, false, AGENT], [RESUME1, 2, true, AGENT], [RESUME2, 3, true, AGENT],
    ]);
    const main = t.items.filter((i) => i.kind === 'agent').map((i) => i.kind === 'agent' && i.card.id);
    expect(main).toEqual([FIRST, RESUME1, RESUME2]);
    expect(t.items.some((i) => i.kind === 'tool' && i.name === 'SendMessage')).toBe(false);
  });

  it('a completed resume has the agent type, the SendMessage summary, its prompt, usage and status', () => {
    const r = byId(RESUME1);
    expect(r.agentType).toBe('backend-code-review-agent');
    expect(r.description).toBe('summary 9');
    expect(r.prompt).toBe('message 10');
    expect(r.status).toBe('completed');
    expect([r.tokens, r.toolUses, r.durationMs]).toEqual([211089, 15, 271144]);
    // Its own report (its SubagentHandback), not the CLI's "delivered to you as a message" note.
    expect(r.summary).toBe('message 24');
  });

  it("the pass's steps, streamed under the first Agent call's id, land in the resume's card", () => {
    const r = byId(RESUME1);
    expect(r.items.map((i) => i.kind === 'tool' && [i.name, i.done])).toEqual([['Bash', true], ['Grep', true]]);
    const first = byId(FIRST);
    expect(first.items.map((i) => i.kind === 'tool' && i.name)).toEqual(['Bash'], 'only the first pass\'s own step');
    expect(first.summary).toBe('message 7', 'and its own report');
  });

  it('a resume still going when the run has no process shows Stopped (running while it does)', () => {
    expect(byId(RESUME2).status).toBe('stopped');
    expect(buildThread(events, { runActive: true }).agents.find((a) => a.id === RESUME2)!.status).toBe('running');
  });

  it('every card in the strip has a card in the transcript to scroll to', () => {
    const targets = new Set(agentItems(t.items).map((c) => c.id));
    for (const a of t.agents) expect(targets.has(a.id)).toBe(true);
  });

  it('the first pass reports its SubagentHandback, not the "delivered to you" note', () => {
    const first = byId(FIRST);
    expect(first.status).toBe('completed');
    expect(first.summary).toBe('message 7');
    expect(first.items.some((i) => i.kind === 'tool' && i.name === 'SubagentHandback')).toBe(false);
  });

  it('a long foreground Bash with task_* events finishes normally and is not labelled background', () => {
    const wait = t.items.find((i) => i.kind === 'tool' && i.id === WAIT);
    expect(wait && wait.kind === 'tool' && wait.done).toBe(true);
    expect(wait && wait.kind === 'tool' && wait.bgStatus).toBeUndefined();
  });

  it('a resume of an agent the excerpt never started turns its SendMessage row into a card in place', () => {
    const from = events.findIndex((e) => e.type === 'assistant' && JSON.stringify(e).includes(RESUME1));
    const t2 = buildThread(events.slice(from), { runActive: false });
    const r = t2.agents.find((a) => a.id === RESUME1)!;
    expect(r.resumed).toBe(true);
    expect(r.description).toBe('summary 9');
    expect(r.status).toBe('completed');
    expect(t2.items[0].kind).toBe('agent');
    expect(t2.items.some((i) => i.kind === 'tool' && i.name === 'SendMessage')).toBe(false);
    // Its steps and report arrive under the first call's id, which this excerpt never showed: no ghost card.
    expect(r.items.map((i) => i.kind === 'tool' && i.name)).toEqual(['Bash', 'Grep']);
    expect(r.summary).toBe('message 24');
    expect(t2.agents.some((a) => a.id === FIRST)).toBe(false);
  });

  it('a message sent while the agent is still busy starts no pass, so its steps stay with the pass that is running', () => {
    const send = events.findIndex((e) => e.type === 'assistant' && JSON.stringify(e).includes(RESUME1));
    // Up to the SendMessage, then the CLI's ordinary answer for a delivered message, then the agent carries on.
    const delivered = { type: 'user', uuid: 'd1', message: { content: [{ type: 'tool_result', tool_use_id: RESUME1, content: '{"success":true,"message":"Message delivered"}' }] } };
    const queued = { type: 'assistant', parent_tool_use_id: FIRST, uuid: 'q1', message: { content: [{ type: 'tool_use', id: 'toolu_q', name: 'Read', input: { file_path: 'a.ts' } }] } };
    const t2 = buildThread([...events.slice(0, send + 1), delivered, queued], { runActive: true });
    expect(t2.agents.find((a) => a.id === FIRST)!.items.some((i) => i.kind === 'tool' && i.name === 'Read')).toBe(true);
    expect(t2.agents.some((a) => a.id === RESUME1)).toBe(false, 'no phantom pass');
    const row = t2.items.find((i) => i.kind === 'tool' && i.id === RESUME1);
    expect(row && row.kind === 'tool' && row.done).toBe(true);
  });

  it('a "Resuming agent" result starts the pass even before its task_started', () => {
    const at = events.findIndex((e) => e.subtype === 'task_started' && e.tool_use_id === RESUME1);
    const t2 = buildThread([...events.slice(0, at), ...events.slice(at + 1)], { runActive: true });
    const r = t2.agents.find((a) => a.id === RESUME1)!;
    expect([r.resumed, r.pass, r.agentId]).toEqual([true, 2, 'ad4b466c915fda516']);
    expect(r.items.map((i) => i.kind === 'tool' && i.name)).toEqual(['Bash', 'Grep']);
  });

  it('a refused resume fails with its message', () => {
    // A refused resume runs no pass: the stream stops at its result here.
    const at = events.findIndex((e) => e.type === 'user' && JSON.stringify(e).includes(RESUME1) && JSON.stringify(e).includes('resumedAgentId'));
    const refused = [...events.slice(0, at), { ...events[at], message: { content: [{ type: 'tool_result', tool_use_id: RESUME1, content: '{"success":false,"message":"No agent with that id"}' }] } }];
    const r = buildThread(refused, { runActive: true }).agents.find((a) => a.id === RESUME1)!;
    expect(r.status).toBe('failed');
    expect(r.summary).toBe('No agent with that id');
  });
});

describe('subagent strip', () => {
  const card = (id: string, status: AgentStatus, model = ''): AgentCard => ({
    id, agentType: 'agent-' + id, description: '', prompt: '', background: false, status, activity: '', lastTool: '', tokens: 0, toolUses: 0,
    durationMs: null, summary: '', steps: 0, depth: 0, items: [], agentId: '', pass: 1, resumed: false, model,
  });

  it('shows every card up to the collapse limit', () => {
    const few = Array.from({ length: STRIP_COLLAPSE_AT }, (_, i) => card(String(i), 'completed'));
    expect(stripAgents(few)).toEqual({ shown: few, hidden: 0 });
  });

  it('past the limit keeps running and failed cards plus the last few, in run order', () => {
    const many = Array.from({ length: 43 }, (_, i) => card(String(i), 'completed'));
    many[2] = card('2', 'failed');
    many[20] = card('20', 'running');
    const { shown, hidden } = stripAgents(many);
    expect(shown.map((a) => a.id)).toEqual(['2', '20', '39', '40', '41', '42']);
    expect(hidden).toBe(37);
  });

  it('summarises by status, leaving out the zeros', () => {
    expect(stripSummary([card('a', 'running'), card('b', 'completed'), card('c', 'completed'), card('d', 'failed')])).toBe('1 running · 2 done · 1 failed');
    expect(stripSummary([card('a', 'completed')])).toBe('1 done');
  });

  it('counts the subagents that ran on open models, per model, and nothing when all were Claude', () => {
    const agents = [
      card('a', 'completed', 'gemma4:12b-ctx64k'), card('b', 'completed', 'claude-haiku-4-5-20251001'),
      card('c', 'completed', 'gemma4:12b-ctx64k'), card('d', 'running', 'qwen3.8:27b'), card('e', 'starting'),
    ];
    expect(openModelSummary(agents)).toBe('2 on gemma4:12b-ctx64k · 1 on qwen3.8:27b');
    expect(openModelSummary([card('a', 'completed', 'claude-opus-5-5'), card('b', 'starting')])).toBe('');
  });
});

describe('subagent model (smart routing)', () => {
  it('records the model that answered each subagent, not the lead model', () => {
    const t = buildThread([
      { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
      { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [
        { type: 'tool_use', id: 'x', name: 'Agent', input: { subagent_type: 'Explore', description: 'Search' } },
        { type: 'tool_use', id: 'r', name: 'Agent', input: { subagent_type: 'reviewer', description: 'Review' } },
      ] } },
      { type: 'assistant', parent_tool_use_id: 'x', message: { model: '<synthetic>', content: [{ type: 'text', text: 'interrupted' }] } },
      { type: 'assistant', parent_tool_use_id: 'x', message: { model: 'gemma4:12b-ctx64k', content: [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' } }] } },
      { type: 'assistant', parent_tool_use_id: 'r', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const [explore, reviewer] = t.agents;
    expect(explore.model).toBe('gemma4:12b-ctx64k');
    expect(isOpenModel(explore.model)).toBe(true);
    expect(reviewer.model).toBe('claude-sonnet-5-5');
    expect(isOpenModel(reviewer.model)).toBe(false);
  });

  it('leaves the model empty until the subagent has answered', () => {
    const t = buildThread([
      { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'x', name: 'Agent', input: { subagent_type: 'Explore' } }] } },
    ]);
    expect(t.agents[0].model).toBe('');
    expect(isOpenModel('')).toBe(false);
  });
});

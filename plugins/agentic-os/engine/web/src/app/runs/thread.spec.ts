import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildThread, stripQuestion, toolLabel, type AgentCard, type ThreadItem } from './thread';

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

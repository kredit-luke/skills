import { describe, expect, it } from 'vitest';
import type { RunEvent, WorkspaceStatus } from '../../../../shared/api';
import { runWorkspace } from './run-workspace';

const ws = (slug: string, path: string, ticketId: string | null = null): WorkspaceStatus =>
  ({ slug, name: slug, path, apps: [], screenshots: [], _ticketId: ticketId });
const MAIN = ws('main', 'C:\\dev\\agentic-workspace');
const ENG294 = ws('ENG-294', 'C:\\dev\\agentic-workspace\\worktrees\\ENG-294', 'ENG-294');
const ENG1 = ws('ENG-1', 'C:\\dev\\agentic-workspace\\worktrees\\ENG-1', 'ENG-1');
const ALL = [MAIN, ENG294, ENG1];

const edit = (...paths: string[]): RunEvent => ({
  type: 'assistant',
  message: { content: paths.map((p) => ({ type: 'tool_use', name: 'Edit', input: { file_path: p } })) },
});

describe('runWorkspace', () => {
  it('moves a run started in main to the worktree it edited', () => {
    expect(runWorkspace({ workspace: 'main' }, ALL, [edit('C:\\dev\\agentic-workspace\\worktrees\\ENG-294\\API\\src\\a.cs')])).toBe(ENG294);
  });
  it('ignores case and slash style', () => {
    expect(runWorkspace({ workspace: 'main' }, ALL, [edit('c:/DEV/agentic-workspace/worktrees/eng-294/API/a.cs')])).toBe(ENG294);
  });
  it('picks the worktree with the most edits', () => {
    const ev = [edit('C:\\dev\\agentic-workspace\\worktrees\\ENG-1\\x.ts', 'C:\\dev\\agentic-workspace\\worktrees\\ENG-294\\a', 'C:\\dev\\agentic-workspace\\worktrees\\ENG-294\\b')];
    expect(runWorkspace({ workspace: 'main' }, ALL, ev)).toBe(ENG294);
  });
  it('keeps a run started in a worktree', () => {
    expect(runWorkspace({ workspace: 'ENG-1' }, ALL, [edit('C:\\dev\\agentic-workspace\\worktrees\\ENG-294\\a')], 'ENG-294')).toBe(ENG1);
  });
  it('before any edits, uses the worktree named after the ticket', () => {
    expect(runWorkspace({ workspace: 'main' }, ALL, [], 'eng-294')).toBe(ENG294);
  });
  it('stays in main for main-only edits or no match', () => {
    expect(runWorkspace({ workspace: 'main' }, ALL, [edit('C:\\dev\\agentic-workspace\\dashboard\\x.ts')], 'ENG-9')).toBe(MAIN);
    expect(runWorkspace({ workspace: 'main' }, ALL, [])).toBe(MAIN);
  });
  it('does not match a sibling that merely shares a prefix', () => {
    expect(runWorkspace({ workspace: 'main' }, ALL, [edit('C:\\dev\\agentic-workspace\\worktrees\\ENG-2940\\a')])).toBe(MAIN);
  });
});

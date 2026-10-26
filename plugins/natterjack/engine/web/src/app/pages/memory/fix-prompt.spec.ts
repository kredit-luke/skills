import { describe, expect, it } from 'vitest';
import { fixPrompt } from './fix-prompt';

describe('memory fix prompt', () => {
  it('lists each file with its issues', () => {
    const p = fixPrompt('/home/a/.claude/projects/x/memory', [
      { file: 'a.md', issues: ['Mentions `src/a.ts`, which no longer exists in the workspace.'] },
      { file: 'b.md', issues: ['Not listed in MEMORY.md, so sessions never see it.', 'Mentions `b/`, which no longer exists in the workspace.'] },
    ]);
    expect(p).toContain('these 2 memory files in /home/a/.claude/projects/x/memory');
    expect(p).toContain('- a.md\n  - Mentions `src/a.ts`');
    expect(p).toContain('- b.md\n  - Not listed in MEMORY.md, so sessions never see it.\n  - Mentions `b/`');
  });
  it('says "this memory file" for one', () => {
    expect(fixPrompt('/m', [{ file: 'a.md', issues: ['x'] }])).toContain('flagged this memory file in /m');
  });
});

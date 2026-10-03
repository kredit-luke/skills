import { describe, expect, it } from 'vitest';
import { editDiff, editStat } from './edit-diff';

describe('editDiff', () => {
  it('turns an Edit into a hunk, keeping shared lines as context', () => {
    const d = editDiff('Edit', { file_path: 'C:\\w\\API\\a.cs', old_string: 'a\nb\nc\n', new_string: 'a\nB\nc\n' })!;
    expect(d).toContain('--- a/C:/w/API/a.cs');
    expect(d).toContain('+++ b/C:/w/API/a.cs');
    expect(d).toContain('\n a\n-b\n+B\n c\n');
    expect(editStat('Edit', { file_path: 'x', old_string: 'a\nb', new_string: 'a\nB' })).toBe('+1 −1');
  });

  it('shows a Write as a new file', () => {
    const d = editDiff('Write', { file_path: '/w/new.ts', content: 'one\ntwo\n' })!;
    expect(d.startsWith('--- /dev/null\n+++ b/w/new.ts\n')).toBe(true);
    expect(d).toContain('@@ -0,0 +1,2 @@');
    expect(d).toContain('+one\n+two');
  });

  it('makes one hunk per MultiEdit edit', () => {
    const d = editDiff('MultiEdit', { file_path: '/w/a', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] })!;
    expect(d.match(/@@/g)!.length).toBe(4);
  });

  it('caps very large writes', () => {
    const big = Array.from({ length: 1000 }, (_, i) => 'line ' + i).join('\n');
    const d = editDiff('Write', { file_path: '/w/big', content: big })!;
    expect(d).toContain('more lines not shown');
    expect(d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length).toBe(400);
  });

  it('ignores tools that are not edits', () => {
    expect(editDiff('Read', { file_path: '/w/a' })).toBeNull();
    expect(editStat('Bash', { command: 'ls' })).toBe('');
  });
});

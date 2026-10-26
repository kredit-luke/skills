import type { MemoryItem } from '../../../../../shared/api';

/** How many flagged memories one "Fix all" run takes; the rest wait for the next. */
export const FIX_BATCH = 20;

/**
 * The prompt for a run that fixes flagged memories: checks each one against the
 * workspace as it is now, then updates, deletes or indexes it.
 */
export function fixPrompt(dir: string, memories: Pick<MemoryItem, 'file' | 'issues'>[]): string {
  const list = memories.map((m) => `- ${m.file}\n${m.issues.map((i) => `  - ${i}`).join('\n')}`).join('\n');
  const one = memories.length === 1;
  return `The dashboard's Memory page flagged ${one ? 'this memory file' : `these ${memories.length} memory files`} in ${dir}:

${list}

For each one:
1. Read it and check what it says against the workspace as it is now. For a path that's gone, find where it went (\`git log --follow\` or \`git log -S\` in the repo it was in, or search for the file name).
2. If the fact still holds and only a path or name moved, update the memory. If the fact no longer holds, delete the file and its MEMORY.md line. If it isn't in MEMORY.md, add a one-line pointer in the same style as the other lines.
3. Leave memories that aren't listed here alone.

End with one line per file: updated, deleted, indexed or left as is, and why.`;
}

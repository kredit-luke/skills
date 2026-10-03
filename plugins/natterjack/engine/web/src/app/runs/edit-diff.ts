/**
 * A unified diff for one edit-tool call, straight from its input: Edit
 * (old_string → new_string), MultiEdit (each edit a hunk), Write (the whole file
 * as added), NotebookEdit (the cell's new source). Exact and available the
 * moment the call streams in, attributed to the step that made it. Line numbers
 * are unknown here, so hunks are numbered from 1; the Changes tab has the real ones.
 */

const MAX_LINES = 400;

export function editDiff(name: string, input: Record<string, any> | null | undefined): string | null {
  const i = input || {};
  const file = String(i.file_path || i.notebook_path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!file) return null;
  const header = (from: string) => `--- ${from}\n+++ b/${file}\n`;
  switch (name) {
    case 'Edit':
      if (typeof i.old_string !== 'string' || typeof i.new_string !== 'string') return null;
      return header(`a/${file}`) + hunk(i.old_string, i.new_string);
    case 'MultiEdit': {
      const edits = Array.isArray(i.edits) ? i.edits.filter((e: any) => typeof e?.old_string === 'string' && typeof e?.new_string === 'string') : [];
      return edits.length ? header(`a/${file}`) + edits.map((e: any) => hunk(e.old_string, e.new_string)).join('') : null;
    }
    case 'Write':
      if (typeof i.content !== 'string') return null;
      return header('/dev/null') + hunk('', i.content);
    case 'NotebookEdit':
      if (typeof i.new_source !== 'string') return null;
      return header(`a/${file}`) + hunk('', i.new_source);
    default:
      return null;
  }
}

function lines(s: string): string[] {
  if (!s) return [];
  const out = s.replace(/\r\n/g, '\n').split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/** One hunk: removed lines then added lines, trimming the lines they share at both ends as context. */
function hunk(oldText: string, newText: string): string {
  let a = lines(oldText), b = lines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ctxBefore = a.slice(Math.max(0, head - 3), head);
  const ctxAfter = a.slice(a.length - tail, Math.min(a.length, a.length - tail + 3));
  const del = a.slice(head, a.length - tail);
  let add = b.slice(head, b.length - tail);
  let note = '';
  if (del.length + add.length > MAX_LINES) {
    note = ` ${del.length + add.length - MAX_LINES} more lines not shown`;
    add = add.slice(0, Math.max(0, MAX_LINES - del.length));
  }
  const oldCount = ctxBefore.length + del.length + ctxAfter.length;
  const newCount = ctxBefore.length + add.length + ctxAfter.length;
  const start = Math.max(1, head - ctxBefore.length + 1);
  return `@@ -${oldCount ? start : 0},${oldCount} +${newCount ? start : 0},${newCount} @@${note}\n` +
    [...ctxBefore.map((l) => ' ' + l), ...del.map((l) => '-' + l), ...add.map((l) => '+' + l), ...ctxAfter.map((l) => ' ' + l)].join('\n') + '\n';
}

/** "+3 −1" for a tool row, or '' when the call isn't an edit. */
export function editStat(name: string, input: Record<string, any> | null | undefined): string {
  const d = editDiff(name, input);
  if (!d) return '';
  let add = 0, del = 0;
  for (const l of d.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) add++; else if (l.startsWith('-')) del++;
  }
  return `+${add} −${del}`;
}

import type { SearchResult } from '../../../../shared/api';

/**
 * The prompt for an "Ask Claude" run: the question plus up to three search matches
 * as starting points, so Claude reads the right files first instead of hunting.
 */
export function askPrompt(query: string, results: SearchResult[], primary: SearchResult | null = null): string {
  const q = query.trim();
  const refs: SearchResult[] = [];
  if (primary && primary.ref) refs.push(primary);
  for (const r of results) {
    if (refs.length >= 3) break;
    if (r.ref && !refs.some((x) => x.id === r.id)) refs.push(r);
  }
  let p = q || (primary ? 'Tell me about ' + primary.title + '.' : '');
  if (p && refs.length) {
    p += '\n\nWorkspace search suggests starting from:\n' +
      refs.map((r) => '- ' + r.ref + (r.section ? ' (section "' + r.section + '")' : '')).join('\n');
  }
  return p;
}

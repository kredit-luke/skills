/**
 * Which tracker ticket a run is about. `sure` is false for a ticket-shaped token
 * merely mentioned in the title or prompt (could be "UTF-8"): the caller hides
 * those quietly when the tracker doesn't know them.
 */
export interface RunTicket { id: string; sure: boolean }

// `/implement X`, or a plugin's `/multirepo:implement X`. "Explain Linear issue X" is how
// older runs were worded. Any tracker's id shape (ENG-12, api#42): these two prompts only
// ever carry a ticket id.
const EXPLICIT = [/^\/(?:[\w.-]+:)?implement\s+([^\s"']+)/, /^Explain (?:Linear )?issue (\S+?):/];
const LOOSE = /\b([A-Z][A-Z0-9]{1,5}-\d{1,6})\b/;

/**
 * A ticket argument as its id: a pasted tracker URL becomes the id in it (multirepo's
 * implement.mjs does the same): a GitHub issue/pull URL → "owner/repo#n"; any other URL → the
 * key in Jira's ?selectedIssue=, after /issue/ or /browse/, or any path segment. Not a URL → as given.
 */
export function canonicalTicket(arg: string): string {
  const raw = String(arg || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  let url: URL;
  try { url = new URL(raw); } catch { return raw; }
  const segs = url.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (/^(www\.)?github\.com$/i.test(url.hostname)) {
    const [owner, repo, kind, num] = segs;
    return owner && repo && /^(issues|pull)$/.test(kind ?? '') && /^\d+$/.test(num ?? '') ? `${owner}/${repo}#${num}` : raw;
  }
  const after = (key: string) => { const i = segs.findIndex((s) => s.toLowerCase() === key); return i >= 0 ? segs[i + 1] : null; };
  for (const c of [url.searchParams.get('selectedIssue'), after('issue'), after('browse'), ...segs]) {
    const m = c && /^([A-Za-z][A-Za-z0-9]{0,9}-\d+)$/.exec(c);
    if (m) return m[1].toUpperCase();
  }
  return raw;
}

/** The ticket an Implement or Explain prompt was started for (a URL as its id), or null for any other prompt. */
export function implementTicket(prompt?: string | null): string | null {
  const text = String(prompt || '').trim();
  for (const re of EXPLICIT) { const m = re.exec(text); if (m) return canonicalTicket(m[1]); }
  return null;
}

export function runTicket(run: { label?: string | null; prompt?: string | null }, worktreeTicketId?: string | null): RunTicket | null {
  if (worktreeTicketId) return { id: worktreeTicketId.toUpperCase(), sure: true };
  const prompt = String(run.prompt || '').trim();
  const id = implementTicket(prompt);
  if (id) return { id, sure: true };
  const m = LOOSE.exec(String(run.label || '')) || LOOSE.exec(prompt);
  return m ? { id: m[1], sure: false } : null;
}

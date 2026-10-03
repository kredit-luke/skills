/**
 * Which tracker ticket a run is about. `sure` is false for a ticket-shaped token
 * merely mentioned in the title or prompt (could be "UTF-8"): the caller hides
 * those quietly when the tracker doesn't know them.
 */
export interface RunTicket { id: string; sure: boolean }

// "Explain Linear issue X" is how older runs were worded.
// Any tracker's id shape (ENG-12, api#42): these two prompts only ever carry a ticket id.
const EXPLICIT = [/^\/implement\s+([^\s"']+)/, /^Explain (?:Linear )?issue (\S+?):/];
const LOOSE = /\b([A-Z][A-Z0-9]{1,5}-\d{1,6})\b/;

export function runTicket(run: { label?: string | null; prompt?: string | null }, worktreeTicketId?: string | null): RunTicket | null {
  if (worktreeTicketId) return { id: worktreeTicketId.toUpperCase(), sure: true };
  const prompt = String(run.prompt || '').trim();
  for (const re of EXPLICIT) { const m = re.exec(prompt); if (m) return { id: m[1], sure: true }; }
  const m = LOOSE.exec(String(run.label || '')) || LOOSE.exec(prompt);
  return m ? { id: m[1], sure: false } : null;
}

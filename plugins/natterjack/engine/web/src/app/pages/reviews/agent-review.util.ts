import type { AgentFinding, AgentFindingCategory } from '../../../../../shared/api';

/** The groups in the order the page shows them. */
export const CATEGORIES: { id: AgentFindingCategory; label: string; one: string }[] = [
  { id: 'bug', label: 'Bugs', one: 'Bug' },
  { id: 'performance', label: 'Performance', one: 'Performance' },
  { id: 'security', label: 'Security', one: 'Security' },
  { id: 'nitpick', label: 'Nitpicks', one: 'Nitpick' },
];

/** The findings by category, in page order; empty groups left out. */
export function groupFindings(findings: AgentFinding[]): { id: AgentFindingCategory; label: string; items: AgentFinding[] }[] {
  return CATEGORIES.map((c) => ({ id: c.id, label: c.label, items: findings.filter((f) => f.category === c.id) })).filter((g) => g.items.length);
}

/** Picked to post at first: everything but nitpicks. */
export function initialPicks(findings: AgentFinding[]): Set<string> {
  return new Set(findings.filter((f) => f.category !== 'nitpick').map((f) => f.id));
}

/** A finding as a PR comment: its category and title, the (maybe edited) text, and which agent found it. */
export function commentBody(f: AgentFinding, text: string, agentLabel: string): string {
  const one = CATEGORIES.find((c) => c.id === f.category)?.one || 'Note';
  const sev = f.category === 'nitpick' ? '' : ` (${f.severity})`;
  return [`**${one}${sev}: ${f.title}**`, text.trim(), `<sub>Found by ${agentLabel} in an agent review.</sub>`].filter(Boolean).join('\n\n');
}

/** "src/db.ts:42", the file alone, or '' for the whole PR. */
export function placeOf(f: AgentFinding): string {
  return f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : '';
}

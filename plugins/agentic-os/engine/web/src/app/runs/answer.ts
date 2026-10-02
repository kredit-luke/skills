import type { Question } from '../../../../shared/api';

/**
 * Readable reply for picked options and typed "Other" answers:
 * "Q: <header or question>\nA: <labels, then the typed answer>" per answered question.
 */
export function answerText(questions: Question[], picks: Record<number, string[]>, notes: Record<number, string> = {}): string {
  return questions
    .map((q, i) => ({ q, a: [...(picks[i] || []), ...(notes[i]?.trim() ? [notes[i].trim()] : [])] }))
    .filter((x) => x.a.length)
    .map((x) => 'Q: ' + (x.q.header || x.q.question) + '\nA: ' + x.a.join(', '))
    .join('\n\n');
}

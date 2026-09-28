import type { Question } from '../../../../shared/api';

/** Readable reply for picked options: "Q: <header or question>\nA: <labels>" per answered question. */
export function answerText(questions: Question[], picks: Record<number, string[]>): string {
  return questions
    .map((q, i) => ({ q, a: picks[i] || [] }))
    .filter((x) => x.a.length)
    .map((x) => 'Q: ' + (x.q.header || x.q.question) + '\nA: ' + x.a.join(', '))
    .join('\n\n');
}

import { describe, expect, it } from 'vitest';
import { answerText } from './answer';
import { markTerms, renderMd } from '../core/markdown';

describe('answerText', () => {
  const qs = [
    { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    { question: 'Which features?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
  ];
  it('formats each answered question', () => {
    expect(answerText(qs, { 0: ['Postgres'], 1: ['A', 'B'] })).toBe('Q: Database\nA: Postgres\n\nQ: Which features?\nA: A, B');
  });
  it('skips unanswered questions', () => {
    expect(answerText(qs, { 1: ['B'] })).toBe('Q: Which features?\nA: B');
  });
  it('uses a typed answer on its own', () => {
    expect(answerText(qs, { 0: ['Postgres'] }, { 1: ' Neither, use C ' })).toBe('Q: Database\nA: Postgres\n\nQ: Which features?\nA: Neither, use C');
  });
  it('adds a typed answer after the picks', () => {
    expect(answerText(qs, { 1: ['A'] }, { 1: 'and C later' })).toBe('Q: Which features?\nA: A, and C later');
  });
  it('skips a blank typed answer', () => {
    expect(answerText(qs, { 0: ['SQLite'] }, { 1: '   ' })).toBe('Q: Database\nA: SQLite');
  });
});

describe('markdown', () => {
  it('escapes HTML and renders headings with section ids', () => {
    const html = renderMd('## Two <b>\n\ntext <script>x</script>');
    expect(html).toContain('<h3 data-sec="two-b">Two &lt;b&gt;</h3>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('renders Linear-style angle-bracket links', () => {
    expect(renderMd('see [ENG-1](<https://linear.app/x/issue/ENG-1>)')).toContain('<a href="https://linear.app/x/issue/ENG-1" target="_blank" rel="noopener">ENG-1</a>');
  });
  it('renders a run result: paragraph, table, then a list with inline code and bold', () => {
    const html = renderMd('The stack is up:\n\n| Service | URL |\n|---|---|\n| API | https://localhost:7103 |\n\nThings to know:\n- **Nuvei setup:** set `provider` to `nuvei`');
    expect(html).toContain('<p>The stack is up:</p>');
    expect(html).toContain('<tr><th>Service</th><th>URL</th></tr><tr><td>API</td><td>https://localhost:7103</td></tr>');
    expect(html).not.toContain('---');
    expect(html).toContain('<li><b>Nuvei setup:</b> set <code>provider</code> to <code>nuvei</code></li>');
  });
  it('highlights word-start matches only', () => {
    expect(markTerms('postgres and post <x>', ['post'])).toBe('<mark>postgres</mark> and <mark>post</mark> &lt;x&gt;');
  });
});

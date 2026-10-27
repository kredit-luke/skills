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
    expect(html).toContain('<tr><th>Service</th><th>URL</th></tr><tr><td>API</td><td><a href="https://localhost:7103" target="_blank" rel="noopener">https://localhost:7103</a></td></tr>');
    expect(html).not.toContain('---');
    expect(html).toContain('<li><b>Nuvei setup:</b> set <code>provider</code> to <code>nuvei</code></li>');
  });
  it('links bare URLs and <url> autolinks, leaving trailing punctuation and code alone', () => {
    const a = (u: string) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`;
    expect(renderMd('Open http://localhost:26201/swagger.')).toBe(`<p>Open ${a('http://localhost:26201/swagger')}.</p>`);
    expect(renderMd('(see https://x.io/a?b=1&c=2), then <https://y.io/z>')).toBe(`<p>(see ${a('https://x.io/a?b=1&amp;c=2')}), then ${a('https://y.io/z')}</p>`);
    expect(renderMd('run `curl http://localhost:1`')).toBe('<p>run <code>curl http://localhost:1</code></p>');
    expect(renderMd('[docs](https://x.io/d) and https://x.io/e')).toBe(`<p><a href="https://x.io/d" target="_blank" rel="noopener">docs</a> and ${a('https://x.io/e')}</p>`);
    expect(renderMd('http://x.io/"><script>')).not.toContain('<script>');
  });
  it('keeps balanced brackets and trailing underscores in bare URLs', () => {
    const a = (u: string) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`;
    expect(renderMd('See https://en.wikipedia.org/wiki/Function_(mathematics).')).toBe(`<p>See ${a('https://en.wikipedia.org/wiki/Function_(mathematics)')}.</p>`);
    expect(renderMd('(https://en.wikipedia.org/wiki/Function_(mathematics))')).toBe(`<p>(${a('https://en.wikipedia.org/wiki/Function_(mathematics)')})</p>`);
    expect(renderMd('on http://[::1]:8080/ and http://[::1]')).toBe(`<p>on ${a('http://[::1]:8080/')} and ${a('http://[::1]')}</p>`);
    expect(renderMd('get https://example.com/file_')).toBe(`<p>get ${a('https://example.com/file_')}</p>`);
  });
  it('highlights word-start matches only', () => {
    expect(markTerms('postgres and post <x>', ['post'])).toBe('<mark>postgres</mark> and <mark>post</mark> &lt;x&gt;');
  });
});

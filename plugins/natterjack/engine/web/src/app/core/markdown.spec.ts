import { describe, expect, it } from 'vitest';
import { inlineMd, linkMdPaths, renderMd } from './markdown';

describe('linkMdPaths', () => {
  const paths = (md: string) => [...linkMdPaths(renderMd(md)).matchAll(/data-md-path="([^"]*)"/g)].map((m) => m[1]);

  it('marks inline-code markdown paths, and only those', () => {
    expect(paths('Plan (`~/.claude/plans/ENG-1-retries.md`): see `docs/HANDOFF.md`, `C:\\work\\PRD.markdown` and `./a.md`.'))
      .toEqual(['~/.claude/plans/ENG-1-retries.md', 'docs/HANDOFF.md', 'C:\\work\\PRD.markdown', './a.md']);
    expect(paths('`ng test`, `a.ts`, `notes.md.bak`, `my plan.md`, `https://x.io/a.md`, `a|b.md`')).toEqual([]);
  });

  it('leaves fenced blocks alone', () => {
    expect(paths('```\nPLAN.md\n```')).toEqual([]);
  });

  it('keeps the path escaped in the attribute', () => {
    const html = linkMdPaths(renderMd('`docs/a&b.md`'));
    expect(html).toBe('<p><code class="md-path" role="button" tabindex="0" title="Open docs/a&amp;b.md" data-md-path="docs/a&amp;b.md">docs/a&amp;b.md</code></p>');
    expect(paths('`x"onmouseover=alert(1).md`')).toEqual([]);
  });
});

describe('inlineMd', () => {
  it('renders links, code and bare URLs inside bold', () => {
    expect(inlineMd('I created **[ENG-12](https://example.com/ENG-12)** today'))
      .toBe('I created <b><a href="https://example.com/ENG-12" target="_blank" rel="noopener">ENG-12</a></b> today');
    expect(inlineMd('**see `a.ts`**')).toBe('<b>see <code>a.ts</code></b>');
    expect(inlineMd('**https://example.com/x**'))
      .toBe('<b><a href="https://example.com/x" target="_blank" rel="noopener">https://example.com/x</a></b>');
  });

  it('still escapes text inside bold', () => {
    expect(inlineMd('**<img src=x>**')).toBe('<b>&lt;img src=x&gt;</b>');
  });
});

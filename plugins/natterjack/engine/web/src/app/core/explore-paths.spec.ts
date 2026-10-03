import { describe, expect, it } from 'vitest';
import { ancestors, dirOf, joinRel, languageOf, previewOf, rawUrl } from './explore-paths';
import { renderMd } from './markdown';

describe('joinRel', () => {
  it('resolves relative URLs against the document folder', () => {
    expect(joinRel('API/docs', 'img/a.png')).toBe('API/docs/img/a.png');
    expect(joinRel('API/docs', './a.md#setup')).toBe('API/docs/a.md');
    expect(joinRel('API/docs', '../README.md?x=1')).toBe('API/README.md');
    expect(joinRel('API/docs', '/CLAUDE.md')).toBe('CLAUDE.md');
    expect(joinRel('', 'my%20file.md')).toBe('my file.md');
  });
  it('refuses absolute URLs, anchors and paths above the root', () => {
    expect(joinRel('a', 'https://x.io/i.png')).toBeNull();
    expect(joinRel('a', 'mailto:x@y')).toBeNull();
    expect(joinRel('a', 'data:image/png;base64,xx')).toBeNull();
    expect(joinRel('a', '#top')).toBeNull();
    expect(joinRel('a', '../../etc/passwd')).toBeNull();
  });
});

describe('paths', () => {
  it('splits and encodes', () => {
    expect(dirOf('a/b/c.md')).toBe('a/b');
    expect(dirOf('c.md')).toBe('');
    expect(ancestors('a/b/c.md')).toEqual(['a', 'a/b']);
    expect(rawUrl('a b/c#.png')).toBe('/api/explore/raw/a%20b/c%23.png');
  });
  it('maps file types to languages and previews', () => {
    expect(languageOf('x/a.cs')).toBe('csharp');
    expect(languageOf('a.component.ts')).toBe('typescript');
    expect(languageOf('main.go')).toBe('go');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('LICENSE')).toBeNull();
    expect(previewOf('README.md')).toBe('markdown');
    expect(previewOf('index.HTML')).toBe('html');
    expect(previewOf('logo.svg')).toBe('image');
    expect(previewOf('md')).toBeNull();
  });
});

describe('renderMd with urls', () => {
  const urls = {
    image: (src: string) => { const p = joinRel('docs', src); return p == null ? null : rawUrl(p); },
    link: (href: string) => { const p = joinRel('docs', href); return p == null ? null : '/explore?path=' + encodeURIComponent(p); },
  };
  it('shows images and makes relative links navigable', () => {
    const html = renderMd('![Flow](img/flow.png) and [setup](../SETUP.md)', urls);
    expect(html).toContain('<img src="/api/explore/raw/docs/img/flow.png" alt="Flow" loading="lazy">');
    expect(html).toContain('<a href="/explore?path=SETUP.md" data-rel="../SETUP.md">setup</a>');
  });
  it('escapes image attributes', () => {
    expect(renderMd('![a"><script>](x.png)', urls)).not.toContain('<script>');
  });
  it('is unchanged without urls', () => {
    expect(renderMd('![Flow](img/flow.png) [setup](SETUP.md)')).toBe('<p>!<span class="rl" title="img/flow.png">Flow</span> <span class="rl" title="SETUP.md">setup</span></p>');
  });
});

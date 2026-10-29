import { describe, expect, it } from 'vitest';
import { inlineMd } from './markdown';

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

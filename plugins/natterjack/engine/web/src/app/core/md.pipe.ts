import { Pipe, PipeTransform } from '@angular/core';
import { linkMdPaths, renderMd } from './markdown';

/**
 * Markdown → escaped HTML (pure, so each text is rendered once). Pair with `| trustedHtml`.
 * `| md:'paths'` also marks inline-code markdown paths for the run page's file viewer.
 */
@Pipe({ name: 'md' })
export class MdPipe implements PipeTransform {
  transform(text: string | null | undefined, mode?: 'paths'): string {
    const html = renderMd(text);
    return mode === 'paths' ? linkMdPaths(html) : html;
  }
}

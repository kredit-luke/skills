import { Pipe, PipeTransform } from '@angular/core';
import { renderMd } from './markdown';

/** Markdown → escaped HTML (pure, so each text is rendered once). Pair with `| trustedHtml`. */
@Pipe({ name: 'md' })
export class MdPipe implements PipeTransform {
  transform(text: string | null | undefined): string {
    return renderMd(text);
  }
}

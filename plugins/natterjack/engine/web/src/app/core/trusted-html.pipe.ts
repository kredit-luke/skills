import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * For HTML we built ourselves from escaped text (markdown.ts, markTerms). Angular's
 * sanitizer would strip the data-sec attributes the section jump relies on.
 * Never pass third-party HTML through this.
 */
@Pipe({ name: 'trustedHtml' })
export class TrustedHtmlPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);
  transform(html: string | null | undefined): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html || '');
  }
}

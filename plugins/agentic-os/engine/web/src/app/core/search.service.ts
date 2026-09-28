import { Injectable, signal } from '@angular/core';

export interface SearchOpenOptions { q?: string; source?: string; site?: string; siteName?: string }

/** Opens the Ctrl+K palette from anywhere (sidebar, Apps "Browse", keyboard). */
@Injectable({ providedIn: 'root' })
export class SearchService {
  readonly request = signal<(SearchOpenOptions & { n: number }) | null>(null);
  private n = 0;

  open(opts: SearchOpenOptions = {}): void { this.request.set({ ...opts, n: ++this.n }); }
  close(): void { this.request.set(null); }
  isOpen(): boolean { return this.request() !== null; }
}

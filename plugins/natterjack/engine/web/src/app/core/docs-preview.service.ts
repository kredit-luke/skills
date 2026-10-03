import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';
import { DataService } from './data.service';
import { ToastService } from './toast.service';

/** "Preview local" for the docs sites: starts the site's static server, then opens the page. */
@Injectable({ providedIn: 'root' })
export class DocsPreviewService {
  private readonly api = inject(ApiService);
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  async open(site: string, pagePath = '', anchor = ''): Promise<void> {
    // Open the tab now (inside the click) so it isn't treated as a popup, then point it at the server.
    const w = window.open('about:blank', '_blank');
    try {
      const r = await this.api.post<{ url: string }>('/api/docs/preview', { site });
      const url = r.url + (pagePath || '') + (anchor ? '#' + anchor : '');
      if (w) w.location.href = url; else window.open(url, '_blank');
      this.data.loadDocs();
    } catch (e) {
      if (w) w.close();
      this.toast.error((e as Error).message);
    }
  }
}

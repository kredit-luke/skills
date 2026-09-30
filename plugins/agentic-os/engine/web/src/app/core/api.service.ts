import { Injectable, computed, signal } from '@angular/core';
import type { Boot } from '../../../../shared/api';

/**
 * Thin fetch wrapper. GETs are open; POSTs carry the per-install token from
 * GET /api/boot (the server only answers same-origin, loopback requests).
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly boot = signal<Boot | null>(null);
  /** False after a request fails at the network level (server restarting). */
  readonly connected = signal(true);
  private bootPromise: Promise<Boot | null> | null = null;

  loadBoot(): Promise<Boot | null> {
    if (!this.bootPromise) {
      this.bootPromise = fetch('/api/boot')
        .then(async (r) => (r.ok ? ((await r.json()) as Boot) : null))
        .catch(() => null)
        .then((b) => {
          // No /api/boot (server restarting): POSTs go without a token until a reload.
          this.boot.set(b || {
            token: '', platform: navigator.platform.toLowerCase().startsWith('win') ? 'win32' : 'darwin', workspaceRoot: '', version: '', port: 0,
            workspace: { name: '', title: 'Workspace Dashboard', logo: null, logoAlt: '', favicon: null, copy: {} },
            issues: { kind: 'none', label: 'Issues', configured: false, ticketPattern: '^[A-Z][A-Z0-9]*-\\d+$', urlTemplate: null },
            profile: { current: 'developer', hiddenPages: [] },
          });
          return b;
        });
    }
    return this.bootPromise;
  }

  /** The workspace's name, title and brand (workspace.json). */
  readonly workspace = computed(() => this.boot()?.workspace || null);
  /** The issue tracker's name for labels: "Linear", "Jira", ... */
  readonly trackerLabel = computed(() => this.boot()?.issues?.label || 'Issues');

  /** A browser URL for an issue id, from the tracker adapter's template (null if it has none). */
  issueUrl(id: string | null | undefined): string | null {
    const t = this.boot()?.issues?.urlTemplate;
    return t && id ? t.split('{id}').join(encodeURIComponent(id)) : null;
  }

  /** A wording override from workspace.json copy, or the default. */
  copy<T = string>(key: string, fallback: T): T {
    const v = this.boot()?.workspace?.copy?.[key];
    return v === undefined || v === null || v === '' ? fallback : (v as T);
  }

  async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(path);
    } catch (e) {
      this.connected.set(false);
      throw new Error('Dashboard server is not reachable.');
    }
    // Through the dev proxy a stopped server shows up as 502/504 rather than a network error.
    const gateway = res.status === 502 || res.status === 503 || res.status === 504;
    this.connected.set(!gateway);
    if (gateway) throw new Error('Dashboard server is not reachable.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && (data as { error?: string }).error) || res.statusText);
    return data as T;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const boot = await this.loadBoot();
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dash-Token': (boot && boot.token) || this.boot()?.token || '' },
        body: JSON.stringify(body || {}),
      });
    } catch {
      this.connected.set(false);
      throw new Error('Dashboard server is not reachable.');
    }
    const data = await res.json().catch(() => ({}));
    // .status lets a caller tell e.g. a 409 conflict from other failures.
    if (!res.ok) throw Object.assign(new Error((data && (data as { error?: string }).error) || res.statusText), { status: res.status });
    return data as T;
  }

  /** POST a file's raw bytes (not JSON), e.g. to /api/attachments?name=… */
  async upload<T>(path: string, file: Blob): Promise<T> {
    const boot = await this.loadBoot();
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Dash-Token': (boot && boot.token) || this.boot()?.token || '' },
        body: file,
      });
    } catch {
      this.connected.set(false);
      throw new Error('Dashboard server is not reachable.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && (data as { error?: string }).error) || res.statusText);
    return data as T;
  }
}

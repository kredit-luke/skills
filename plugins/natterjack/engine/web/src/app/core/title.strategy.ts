import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { ApiService } from './api.service';
import { titlePrefix } from './attention';

/**
 * Page titles as "<route title> · <dashboard title> · <workspace name>" (workspace.json),
 * with "(n) " in front while n runs wait for your answer (AttentionService).
 * Doesn't inject Router: the Router itself depends on the TitleStrategy (NG0200 cycle).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly api = inject(ApiService);
  private last: RouterStateSnapshot | null = null;
  private waiting = 0;

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.last = snapshot;
    const ws = this.api.workspace();
    const parts = [this.buildTitle(snapshot), ws?.title || 'Workspace Dashboard', ws?.name].filter(Boolean);
    this.title.setTitle(titlePrefix(this.waiting) + parts.join(' · '));
  }

  /** Re-apply once boot has loaded the workspace's name. */
  refresh(): void {
    if (this.last) this.updateTitle(this.last);
  }

  setWaiting(n: number): void {
    if (n === this.waiting) return;
    this.waiting = n;
    this.refresh();
  }
}

import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { ApiService } from './api.service';

/**
 * Page titles as "<route title> · <dashboard title> · <workspace name>" (workspace.json).
 * Doesn't inject Router: the Router itself depends on the TitleStrategy (NG0200 cycle).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly api = inject(ApiService);
  private last: RouterStateSnapshot | null = null;

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.last = snapshot;
    const ws = this.api.workspace();
    const parts = [this.buildTitle(snapshot), ws?.title || 'Workspace Dashboard', ws?.name].filter(Boolean);
    this.title.setTitle(parts.join(' · '));
  }

  /** Re-apply once boot has loaded the workspace's name. */
  refresh(): void {
    if (this.last) this.updateTitle(this.last);
  }
}

import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import type { ProfileInfo, RoleInfo } from '../../../../shared/api';
import { ApiService } from '../core/api.service';
import { ToastService } from '../core/toast.service';

/**
 * The first-start question: which of the team's roles (workspace.json roles) this person
 * is. Shown while boot.profile.ask is true; the answer is saved in their ledger and can
 * be changed in Settings. "Not now" hides it until the next visit.
 */
@Component({
  selector: 'dash-role-prompt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (roles(); as roles) {
      <div class="modal">
        <div class="modal-card" role="dialog" aria-labelledby="role-q">
          <h3 id="role-q">What's your role?</h3>
          <div class="desc">Claude answers you in a way that suits it, and the dashboard shows what you need. You can change it in Settings.</div>
          <div class="roles">
            @for (r of roles; track r.id) {
              <button type="button" class="role" [disabled]="saving()" (click)="pick(r)">
                <span class="t">{{ r.label }}</span>
                @if (r.description) { <span class="d">{{ r.description }}</span> }
              </button>
            }
          </div>
          <div class="foot"><button type="button" class="btn ghost sm" (click)="later()">Not now</button></div>
        </div>
      </div>
    }
  `,
  styles: [`
    .roles { display: flex; flex-direction: column; gap: 6px; padding: 0 1.2rem; }
    .role { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); cursor: pointer; }
    .role:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-bg); }
    .role .t { font-size: 14px; font-weight: 650; }
    .role .d { font-size: 12.5px; color: var(--ink-soft); line-height: 1.4; }
    .foot { display: flex; justify-content: flex-end; padding: 0.8rem 1.2rem 1rem; }
  `],
})
export class RolePromptComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly roles = signal<RoleInfo[] | null>(null);
  readonly saving = signal(false);

  constructor() {
    effect(() => {
      if (!this.api.boot()?.profile?.ask || sessionStorage.getItem('dash.role.later')) return;
      this.api.get<ProfileInfo>('/api/profile').then((p) => this.roles.set(p.roles.length ? p.roles : null), () => {});
    });
  }

  async pick(r: RoleInfo): Promise<void> {
    this.saving.set(true);
    try {
      await this.api.post<ProfileInfo>('/api/profile', { role: r.id });
      // The nav and every page read the role at load.
      location.reload();
    } catch (e) {
      this.toast.error((e as Error).message);
      this.saving.set(false);
    }
  }

  later(): void {
    sessionStorage.setItem('dash.role.later', '1');
    this.roles.set(null);
  }
}

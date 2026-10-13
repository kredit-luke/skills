import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import type { MeetingsStatus } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { PageHeaderComponent } from '../../shared/page-header.component';

/**
 * The team's meetings from its meeting tool (.claude/dashboard/meetings.json), with their
 * summaries and action items. For now it only says what's coming: reading meetings and
 * asking Claude whether an action item should become a ticket.
 */
@Component({
  selector: 'dash-meetings',
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dash-page-header eyebrow="Company" title="Meetings" [sub]="sub()" />

    @if (error()) { <div class="warn-note">{{ error() }}</div> }
    @else if (!status()) { <div class="empty">Loading…</div> }
    @else if (status()!.comingSoon) {
      <div class="panel soon">
        <h2>Coming soon <span class="tag">{{ label() }}</span></h2>
        <p>This page will list your team's meetings from {{ label() }}, each with its summary and action items.
          For any action item you'll be able to ask Claude whether it should become a ticket, based on the code.</p>
      </div>
    } @else {
      <div class="panel soon">
        <h2>Meetings aren't available</h2>
        <p>{{ status()!.message }}</p>
      </div>
    }
  `,
  styles: [`
    .soon { padding: 1.6rem 2rem; max-width: 760px; }
    .soon h2 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
    .soon p { margin: 0; color: var(--ink-soft); line-height: 1.5; }
  `],
})
export class MeetingsComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly status = signal<MeetingsStatus | null>(null);
  readonly error = signal<string | null>(null);
  readonly label = computed(() => this.status()?.label || this.api.boot()?.meetings?.label || 'your meeting tool');
  readonly sub = computed(() => this.api.copy('meetingsSub', `Your team's meetings from ${this.label()}: summaries and action items.`));

  async ngOnInit(): Promise<void> {
    try { this.status.set(await this.api.get<MeetingsStatus>('/api/meetings/status')); }
    catch (e) { this.error.set((e as Error).message); }
  }
}

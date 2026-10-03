import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AppStatus } from '../../../../shared/api';
import { DataService } from '../core/data.service';
import { LaunchService } from '../core/launch.service';
import { LogsService } from './logs-dialog.component';

/** Start/Stop/Restart/Logs/Make changes for one app in one workspace (Apps + Workspaces pages). */
@Component({
  selector: 'dash-app-buttons',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-actions' },
  template: `
    @let a = app();
    @if (!a.available) {
      <span class="ty">not cloned</span>
    } @else {
      @if (a.busy) {
        <span class="busy-label"><span class="spin"></span>{{ a.busy }}</span>
      } @else if (a.running) {
        <button class="btn sm" (click)="act('restart')">Restart</button>
        <button class="btn danger sm" (click)="act('stop')">Stop</button>
      } @else {
        <button class="btn primary sm" (click)="act('start')">Start</button>
      }
      <button class="btn ghost sm" (click)="logs()">Logs</button>
      <button class="btn ghost sm" (click)="changes()" title="Start a Claude run to change this app's code">Make changes</button>
      @if (a.blockedBy.length && !a.running) {
        <a class="blocked" routerLink="/machine">Needs {{ a.blockedBy.join(', ') }} →</a>
      }
    }
  `,
})
export class AppButtonsComponent {
  private readonly data = inject(DataService);
  private readonly launch = inject(LaunchService);
  private readonly logsSvc = inject(LogsService);
  readonly app = input.required<AppStatus>();
  readonly workspace = input.required<string>();

  act(action: 'start' | 'stop' | 'restart'): void {
    this.data.appAction({ action, workspace: this.workspace(), app: this.app().key });
  }
  logs(): void {
    this.logsSvc.open({ title: this.app().name, workspace: this.workspace(), app: this.app().key });
  }
  changes(): void {
    // Code work in that app's repo, in the workspace the card belongs to (a worktree tile → its branch).
    this.launch.open({
      prompt: 'Working in repo ' + (this.app().repo || this.app().name) + ': ',
      workspace: this.workspace(), focusPrompt: true, title: 'Make changes · ' + this.app().name,
    });
  }
}

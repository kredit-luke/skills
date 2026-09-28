import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly current = signal<{ msg: string; err: boolean } | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  show(msg: string, err = false): void {
    this.current.set({ msg, err });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.current.set(null), 4500);
  }
  error(msg: string): void { this.show(msg, true); }
}

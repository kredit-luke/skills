import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { RunMeta } from '../../../../shared/api';
import { newlyWaiting } from './attention';
import { DataService } from './data.service';
import { WorkspaceTitleStrategy } from './title.strategy';
import { lsGet, lsSet } from './util';

/** While the tab is hidden the event stream is closed (DataService): refresh the runs this often instead. */
const HIDDEN_POLL_MS = 30000;

type Permission = NotificationPermission | 'unsupported';

/**
 * Tells you when a run needs your answer: the count on the installed app's icon
 * (navigator.setAppBadge) and in the tab title, always; a soft chime and a system
 * notification when a run starts waiting while you're not looking, if you turn them
 * on (Settings, saved in this browser).
 */
@Injectable({ providedIn: 'root' })
export class AttentionService {
  private readonly data = inject(DataService);
  private readonly titles = inject(WorkspaceTitleStrategy);
  readonly sound = signal(lsGet('dash.alert.sound') === '1');
  readonly notify = signal(lsGet('dash.alert.notify') === '1');
  readonly permission = signal<Permission>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  private seen: Set<string> | null = null;
  private audio: AudioContext | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const n = this.data.activityWaiting();
      untracked(() => { this.titles.setWaiting(n); setBadge(n); });
    });
    effect(() => {
      const waiting = this.data.activityRuns().filter((r) => this.data.needsAnswer(r));
      untracked(() => this.onWaiting(waiting));
    });
    document.addEventListener('visibilitychange', () => this.hiddenPoll());
    this.hiddenPoll();
    // Browsers only let a page play sound after you've interacted with it: get the audio ready on the first click or key.
    const unlock = () => { this.ctx(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  setSound(on: boolean): void {
    this.sound.set(on);
    lsSet('dash.alert.sound', on ? '1' : '');
    if (on) this.chime();
  }

  /** Turning it on asks the browser for permission; it stays off if that's refused. */
  async setNotify(on: boolean): Promise<void> {
    if (on && this.permission() === 'default') this.permission.set(await Notification.requestPermission());
    const ok = on && this.permission() === 'granted';
    this.notify.set(ok);
    lsSet('dash.alert.notify', ok ? '1' : '');
  }

  /** A soft two-note chime. */
  chime(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const at = t + i * 0.14;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.08, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    }
  }

  private onWaiting(runs: RunMeta[]): void {
    const ids = runs.map((r) => r.id);
    const fresh = newlyWaiting(this.seen, ids);
    this.seen = new Set(ids);
    // Only when you're not looking at the dashboard: on it, the Activity pill already shows it.
    if (!fresh.length || (!document.hidden && document.hasFocus())) return;
    if (this.sound()) this.chime();
    if (this.notify() && this.permission() === 'granted') {
      for (const r of runs.filter((x) => fresh.includes(x.id)).slice(0, 3)) void showNotification(r);
    }
  }

  private hiddenPoll(): void {
    if (document.hidden && !this.poll) this.poll = setInterval(() => this.data.loadRuns(), HIDDEN_POLL_MS);
    else if (!document.hidden && this.poll) { clearInterval(this.poll); this.poll = null; }
  }

  private ctx(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    this.audio ??= new AudioContext();
    if (this.audio.state === 'suspended') void this.audio.resume().catch(() => {});
    return this.audio;
  }
}

function setBadge(n: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (n > 0) nav.setAppBadge?.(n)?.catch(() => {});
    else nav.clearAppBadge?.()?.catch(() => {});
  } catch { /* not supported here */ }
}

/** Through the service worker where there is one (phones only show those); clicking it opens the run (sw.js). */
async function showNotification(r: RunMeta): Promise<void> {
  const title = 'Needs your answer';
  const opts: NotificationOptions = { body: r.label, tag: 'run-' + r.id, data: { url: '/runs/' + r.id } };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) return await reg.showNotification(title, opts);
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); location.assign('/runs/' + r.id); n.close(); };
  } catch { /* blocked or unsupported */ }
}

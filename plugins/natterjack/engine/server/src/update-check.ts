/**
 * Is there a newer Natterjack release? Reads https://asknatterjack.com/version.json
 * ({ "version": "x.y.z", "notes"?: "<https url>" }) a little after start and twice a
 * day, and the sidebar shows "x.y.z available" when it's newer than this engine.
 *
 * A plain GET with nothing about the workspace or the person in it. Off with
 * workspace.json `dashboard.updateCheck: false` or NATTERJACK_UPDATE_CHECK=0, and never
 * in a hosted container (its engine comes with the image, so nobody there can upgrade it).
 * Offline or a bad answer just keeps the last result.
 */

import type { UpdateInfo } from "../../shared/api.ts";

export const UPDATE_URL = "https://asknatterjack.com/version.json";
const FIRST_CHECK_MS = 15_000;
const INTERVAL_MS = 12 * 60 * 60_000;
const TIMEOUT_MS = 8_000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Is x.y.z a newer version than `than`? */
export function newer(version: string, than: string): boolean {
  const a = version.split(".").map(Number), b = String(than).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (a[i] !== (b[i] || 0)) return a[i] > (b[i] || 0);
  return false;
}

export interface UpdateCheckOptions {
  current: string;
  /** Read on every check, so turning it off in workspace.json needs no restart. */
  enabled: () => boolean;
  url?: string;
  fetch?: typeof fetch;
}

/** NATTERJACK_UPDATE_CHECK=0 (or off, false, no) turns the check off for this machine. */
export function updateCheckAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(String(env.NATTERJACK_UPDATE_CHECK || "").trim());
}

/** The version and notes link from a version.json body, or null when it isn't one. */
export function parseVersionFile(body: unknown): { version: string; notes: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const { version, notes } = body as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION_RE.test(version.trim())) return null;
  const link = typeof notes === "string" && /^https:\/\/[^\s"<>]+$/.test(notes) ? notes : null;
  return { version: version.trim(), notes: link };
}

export class UpdateCheck {
  private latest: string | null = null;
  private notes: string | null = null;
  private checkedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: UpdateCheckOptions;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: UpdateCheckOptions) {
    this.opts = opts;
    this.url = opts.url || UPDATE_URL;
    this.fetchImpl = opts.fetch || fetch;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => { void this.check(); this.timer = setTimeout(tick, INTERVAL_MS); this.timer.unref?.(); };
    this.timer = setTimeout(tick, FIRST_CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (!this.opts.enabled()) return;
    try {
      const res = await this.fetchImpl(this.url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return;
      const parsed = parseVersionFile(await res.json());
      if (!parsed) return;
      this.latest = parsed.version;
      this.notes = parsed.notes;
      this.checkedAt = new Date().toISOString();
    } catch {}
  }

  info(): UpdateInfo {
    const enabled = this.opts.enabled();
    const latest = enabled ? this.latest : null;
    return {
      enabled,
      current: this.opts.current,
      latest,
      available: !!latest && newer(latest, this.opts.current),
      notes: latest ? this.notes : null,
      checkedAt: enabled ? this.checkedAt : null,
    };
  }
}

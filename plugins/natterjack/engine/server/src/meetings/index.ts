/**
 * Meeting tools. The Meetings page goes through one MeetingSource, chosen by
 * .claude/dashboard/meetings.json `source` (and an optional `label`). Adding a tool =
 * one file here implementing MeetingSource, registered in SOURCES. Without
 * meetings.json there is no Meetings page: boot.meetings is null and the nav leaves it out.
 *
 * Normalized shapes (shared/api.ts): Meeting for lists, MeetingDetail for one meeting
 * (its summary and action items). Phase 1: every source is a placeholder that says
 * it's coming soon; listing meetings comes with each tool's API adapter.
 */

import { readConfigFile } from "../config.ts";
import type { Meeting, MeetingDetail, MeetingFilter, MeetingsBoot, MeetingsStatus } from "../../../shared/api.ts";
import { RoamMeetings } from "./roam.ts";

export interface MeetingsConfig {
  source: string;
  /** Shown in the UI ("Roam", ...). */
  label: string;
  /** meetings.json is broken or names no source. */
  error: string | null;
}

export interface SourceStatus { configured: boolean; connected: boolean; comingSoon?: boolean; message: string }

export interface MeetingSource {
  kind: string;
  label: string;
  status(): SourceStatus;
  listMeetings(filter: MeetingFilter): Promise<Meeting[]>;
  meeting(id: string): Promise<MeetingDetail>;
  /** A browser URL for a meeting id, or null. */
  meetingUrl(id: string): string | null;
}

/** meetings.json names a source the engine has no adapter for (or is broken): the page says so. */
class NoSource implements MeetingSource {
  kind: string;
  label: string;
  private readonly problem: string;
  constructor(cfg: MeetingsConfig) {
    this.kind = cfg.source || "none";
    this.label = cfg.label;
    this.problem = cfg.error || `"${cfg.source}" meetings aren't supported yet (known: ${supportedSources().join(", ")}).`;
  }
  status(): SourceStatus { return { configured: true, connected: false, message: this.problem }; }
  async listMeetings(): Promise<Meeting[]> { throw new Error(this.problem); }
  async meeting(): Promise<MeetingDetail> { throw new Error(this.problem); }
  meetingUrl() { return null; }
}

// A named type, not an inline one: validate.mjs reads the keys of the SOURCES literal.
type Source = { label: string; make: (cfg: MeetingsConfig) => MeetingSource };
const SOURCES: Record<string, Source> = {
  roam: { label: "Roam", make: (cfg) => new RoamMeetings(cfg) },
};

export function supportedSources() { return Object.keys(SOURCES); }

/** meetings.json with defaults filled in; null when there's no meetings.json. */
export function meetingsConfig(dir?: string): MeetingsConfig | null {
  const { data, error } = readConfigFile("meetings.json", dir);
  if (!data && !error) return null;
  const raw = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const source = typeof raw.source === "string" ? raw.source.trim().toLowerCase() : "";
  const label = (typeof raw.label === "string" && raw.label.trim()) || SOURCES[source]?.label || source || "Meetings";
  return { source, label, error: error || (source ? null : 'meetings.json: "source" names the meeting tool, e.g. "roam".') };
}

/**
 * The configured meeting tool. Re-reads meetings.json each call and keeps one
 * instance per settings, so edits apply without a restart.
 */
export class Meetings {
  dir: string | undefined;
  current: { sig: string; source: MeetingSource } | null = null;

  constructor(dir?: string) { this.dir = dir; }

  /** null when the workspace has no meetings.json. */
  get(): MeetingSource | null {
    const cfg = meetingsConfig(this.dir);
    if (!cfg) { this.current = null; return null; }
    const sig = JSON.stringify(cfg);
    if (this.current && this.current.sig === sig) return this.current.source;
    const entry = !cfg.error && SOURCES[cfg.source];
    const source = entry ? entry.make(cfg) : new NoSource(cfg);
    this.current = { sig, source };
    return source;
  }

  /** What the nav needs: which tool, or null for no Meetings page. */
  boot(): MeetingsBoot | null {
    const s = this.get();
    return s ? { source: s.kind, label: s.label } : null;
  }

  /** GET /api/meetings/status */
  status(): MeetingsStatus {
    const s = this.get();
    if (!s) return { source: "none", label: "Meetings", configured: false, supported: false, connected: false, comingSoon: false, message: "No meeting tool is configured (.claude/dashboard/meetings.json)." };
    const st = s.status();
    return { source: s.kind, label: s.label, configured: st.configured, supported: !!SOURCES[s.kind], connected: st.connected, comingSoon: !!st.comingSoon, message: st.message };
  }
}

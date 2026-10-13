/**
 * Roam (https://developer.ro.am/): meetings with their summaries and action items.
 * Placeholder for now: it says it's coming soon and reads nothing. The API adapter
 * fills in listMeetings, meeting and meetingUrl.
 */

import type { Meeting, MeetingDetail } from "../../../shared/api.ts";
import type { MeetingSource, MeetingsConfig, SourceStatus } from "./index.ts";

export class RoamMeetings implements MeetingSource {
  kind = "roam";
  label: string;

  constructor(cfg: MeetingsConfig) { this.label = cfg.label; }

  status(): SourceStatus {
    return { configured: true, connected: false, comingSoon: true, message: `${this.label} meetings are coming soon.` };
  }

  async listMeetings(): Promise<Meeting[]> { throw this.notYet(); }
  async meeting(): Promise<MeetingDetail> { throw this.notYet(); }
  meetingUrl() { return null; }

  private notYet() { return new Error(`Reading meetings from ${this.label} isn't available yet.`); }
}

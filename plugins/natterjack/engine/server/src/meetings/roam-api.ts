/**
 * Roam's HTTP API (https://developer.ro.am/docs), the calls the Meetings page needs.
 * Every call takes the bearer token as its first argument: where the token comes from
 * (sign-in or a pasted personal access token, refreshed or not) is roam-auth.ts's business.
 *
 * Roam answers errors as { ok: false, error: "<code>" } (plus `needed` for missing_scope);
 * they come back here as a RoamError with the HTTP status, the code and, on 429, how many
 * seconds Retry-After asked for. The to* functions turn Roam's shapes into shared/api.ts's.
 */

import type { ActionItem, Meeting, MeetingDetail, MeetingPage } from "../../../shared/api.ts";

export const ROAM_API = "https://api.ro.am/v1";
/** The API version this adapter was written against (Roam-Version header). */
export const ROAM_VERSION = "2026-08-25";
const TIMEOUT_MS = 20_000;
/** Roam caps a page at 10 when it includes summaries or action items. */
const PAGE_SIZE = 10;
/** Participants meeting.info names inline; beyond that it sets participantsOmitted. */
const MAX_PARTICIPANTS = 50;

export type RoamFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

// ---- Roam's shapes (only the fields read here)

export interface RoamParticipant { type: "member" | "guest"; id: string; name: string; email?: string }
export interface RoamActionItem { title: string; description?: string; complete?: boolean; suggestedAssigneeName?: string }
export interface RoamMeeting {
  id: string; title: string; start: string; end?: string; participantCount: number;
  host?: RoamParticipant; summary?: string; actionItems?: RoamActionItem[];
  participants?: RoamParticipant[]; participantsOmitted?: boolean;
}
export interface RoamCue { speakerId?: string; text: string; start: number; end: number }
export interface RoamTokenInfo { viewer: string | null; scopes: string[] }

export class RoamError extends Error {
  status: number;
  /** Roam's error code (invalid_token, token_revoked, missing_scope, ratelimited, ...), or "unreachable". */
  code: string;
  /** Seconds to wait, from Retry-After on a 429; null otherwise. */
  retryAfter: number | null;
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = "RoamError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After is seconds, or (rarely) an HTTP date. */
function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** The RoamError for an error response: status, Roam's body (parsed or not) and the Retry-After header. */
export function roamError(status: number, body: any, retryAfterHeader: string | null = null): RoamError {
  const code = body && typeof body.error === "string" ? body.error : `http_${status}`;
  switch (code) {
    case "not_authed":
      return new RoamError(status, code, "No Roam token was sent: connect again.");
    case "invalid_token":
      return new RoamError(status, code, "Roam didn't accept the token (unknown or expired): connect again.");
    case "token_revoked":
      return new RoamError(status, code, "Roam revoked access: connect again.");
    case "missing_scope": {
      const needed = Array.isArray(body?.needed) && body.needed.length ? body.needed.join(" or ") : "another";
      return new RoamError(status, code, `The Roam token doesn't have the ${needed} scope. Connect again with it.`);
    }
    case "ratelimited": {
      const wait = retryAfterSeconds(retryAfterHeader);
      return new RoamError(status, code, `Roam is limiting requests: try again ${wait !== null ? `in ${wait} second${wait === 1 ? "" : "s"}` : "shortly"}.`, wait);
    }
    default:
      return new RoamError(status, code, `Roam said ${code} (HTTP ${status}).`);
  }
}

export class RoamApi {
  private readonly fetcher: RoamFetch;
  private readonly timeoutMs: number;

  constructor(opts: { fetcher?: RoamFetch; timeoutMs?: number } = {}) {
    this.fetcher = opts.fetcher || (fetch as unknown as RoamFetch);
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /** One call: GET with query params, or POST with a JSON body. Returns Roam's body ({} when it sent none). */
  async call(token: string, method: "GET" | "POST", endpoint: string, params: Record<string, string | number | undefined> = {}): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Roam-Version": ROAM_VERSION, Accept: "application/json" };
    let url = `${ROAM_API}/${endpoint}`;
    let body: string | undefined;
    const defined = Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string | number][];
    if (method === "GET") {
      if (defined.length) url += `?${new URLSearchParams(defined.map(([k, v]) => [k, String(v)])).toString()}`;
    } else if (defined.length) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(Object.fromEntries(defined));
    }
    const unreachable = (e: any) => {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      return new RoamError(0, "unreachable", timedOut ? `Roam didn't answer within ${Math.round(this.timeoutMs / 1000)} seconds.` : `Couldn't reach Roam: ${e?.message || e}`);
    };
    let res: Awaited<ReturnType<RoamFetch>>;
    try {
      res = await this.fetcher(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw unreachable(e);
    }
    // The body can fail too (the timeout firing mid-read, a reset): on a 2xx that's no answer,
    // not an empty one. An error status says enough without its body.
    let text = "";
    try { text = await res.text(); } catch (e) { if (res.ok) throw unreachable(e); }
    let data: any = {};
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!res.ok || data?.ok === false) throw roamError(res.status, data, res.headers.get("retry-after"));
    if (data === null) throw new RoamError(res.status, "bad_response", `Roam's ${endpoint} answer wasn't JSON.`);
    return data;
  }

  /** meeting.list: newest first, with summaries and action items; cursor is the previous page's nextCursor. */
  async listMeetings(token: string, cursor?: string): Promise<MeetingPage> {
    return toMeetingPage(await this.call(token, "GET", "meeting.list", { expand: "summary,actionItems", limit: PAGE_SIZE, cursor }));
  }

  /** meeting.info: one meeting with up to 50 participants named. */
  async meeting(token: string, id: string): Promise<MeetingDetail> {
    return toMeetingDetail(await this.call(token, "GET", "meeting.info", { id, maxParticipants: MAX_PARTICIPANTS }));
  }

  /** meeting.transcript: the cues in order. Roam answers 404 transcript_pending / transcript_unavailable when there's none. */
  async transcript(token: string, id: string): Promise<RoamCue[]> {
    const body = await this.call(token, "GET", "meeting.transcript", { id });
    return Array.isArray(body?.cues) ? body.cues : [];
  }

  /** meeting.shareLink: get-or-create, so Roam makes a share link the first time it's asked for one. Only an https: link counts. */
  async shareLink(token: string, id: string): Promise<string | null> {
    const body = await this.call(token, "POST", "meeting.shareLink", { id });
    return typeof body?.url === "string" && /^https:\/\//i.test(body.url) ? body.url : null;
  }

  /** token.info: who the token reads as, and its scopes. */
  async tokenInfo(token: string): Promise<RoamTokenInfo> {
    const body = await this.call(token, "GET", "token.info");
    return { viewer: typeof body?.user?.name === "string" ? body.user.name : null, scopes: Array.isArray(body?.scopes) ? body.scopes : [] };
  }

  /** token.revoke: ends an OAuth grant (its refresh token too). Roam refuses API keys with a 400. */
  async revoke(token: string): Promise<void> {
    await this.call(token, "POST", "token.revoke");
  }
}

// ---- Roam's shapes → shared/api.ts

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const person = (p: RoamParticipant) => ({ name: String(p.name ?? ""), type: p.type === "guest" ? "guest" as const : "member" as const });

/** Roam omits `complete` when false. */
export function toActionItem(a: RoamActionItem): ActionItem {
  return { text: String(a.title ?? ""), description: str(a.description), complete: a.complete === true, suggestedOwner: str(a.suggestedAssigneeName) };
}

/** summary and actionItems stay null unless the call expanded them (and Roam had them). */
export function toMeeting(m: RoamMeeting): Meeting {
  return {
    id: String(m.id), title: str(m.title) || "Untitled meeting",
    startedAt: String(m.start ?? ""), endedAt: str(m.end),
    participantCount: Number.isFinite(m.participantCount) ? m.participantCount : 0,
    host: m.host ? person(m.host) : null,
    summary: typeof m.summary === "string" ? m.summary : null,
    actionItems: Array.isArray(m.actionItems) ? m.actionItems.map(toActionItem) : null,
    // Filled in by the routes (meetings/tickets.ts).
    tickets: [],
  };
}

export function toMeetingDetail(m: RoamMeeting): MeetingDetail {
  return {
    ...toMeeting(m),
    participants: (Array.isArray(m.participants) ? m.participants : []).map((p) => ({ id: String(p.id), ...person(p) })),
    participantsOmitted: m.participantsOmitted === true,
  };
}

export function toMeetingPage(body: { meetings?: RoamMeeting[]; nextCursor?: string }): MeetingPage {
  return { meetings: (Array.isArray(body?.meetings) ? body.meetings : []).map(toMeeting), nextCursor: str(body?.nextCursor) };
}

/**
 * The transcript as "Name: what they said" paragraphs, one per turn: consecutive cues from
 * the same speaker merge. Speakers are named from `names` (participant id → name), else "Speaker".
 */
export function transcriptText(cues: RoamCue[], names: Map<string, string>): string {
  const turns: { speaker: string | undefined; text: string[] }[] = [];
  for (const c of cues) {
    const text = String(c?.text ?? "").trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === c.speakerId) last.text.push(text);
    else turns.push({ speaker: c.speakerId, text: [text] });
  }
  return turns.map((t) => `${(t.speaker && names.get(t.speaker)) || "Speaker"}: ${t.text.join(" ")}`).join("\n\n");
}

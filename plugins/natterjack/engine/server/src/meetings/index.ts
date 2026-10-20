/**
 * Meeting tools. The Meetings page goes through one MeetingSource, chosen by
 * .claude/dashboard/meetings.json `source` (and an optional `label`). Adding a tool =
 * one file here implementing MeetingSource, registered in SOURCES. Without
 * meetings.json there is no Meetings page: boot.meetings is null and the nav leaves it out.
 *
 * Normalized shapes (shared/api.ts): Meeting for lists (MeetingPage, paged by an opaque
 * cursor), MeetingDetail for one meeting (who was there). Each person connects their own
 * account, by browser sign-in (when meetings.json has an OAuth `clientId`) or by pasting a
 * personal access token; the token stays in the ledger and never reaches the browser.
 */

import type http from "node:http";
import { LEDGER_DIR, readConfigFile } from "../config.ts";
import type {
  MeetingConnectHelp, MeetingDetail, MeetingListRequest, MeetingPage, MeetingsBoot, MeetingSignInStart,
  MeetingSignInStatus, MeetingsStatus,
} from "../../../shared/api.ts";
import { loopbackRedirectProblem } from "../oauth-signin.ts";
import { NOT_CONNECTED } from "./roam-auth.ts";
import { RoamMeetings } from "./roam.ts";

/** Where browser sign-in comes back to, unless meetings.json says otherwise. */
export const DEFAULT_REDIRECT_URI = "http://localhost:31417/roam/callback";

export interface MeetingsConfig {
  source: string;
  /** Shown in the UI ("Roam", ...). */
  label: string;
  /** The tool's OAuth app (a public client, so not a secret); null = token paste only. */
  clientId: string | null;
  /** The OAuth redirect: http, a loopback host and an explicit port (the dashboard listens there). */
  redirectUri: string;
  /** meetings.json is broken or names no source: there's no source to use. */
  error: string | null;
  /** clientId or redirectUri is wrong: sign-in is off, but pasting a token still works. */
  signInProblem: string | null;
}

/**
 * Where a source keeps its token (the ledger), and whether this is a hosted dashboard (no
 * loopback listener). publicOrigin: a hosted dashboard's own address, where sign-in comes
 * back to (oauth-signin.ts hostedCallbackUri); without it a hosted sign-in is pasted back.
 */
export interface MeetingsContext { ledgerDir: string; hosted: boolean; publicOrigin?: string | null }

export interface SourceStatus {
  configured: boolean; connected: boolean;
  viewer?: string | null; via?: "oauth" | "token" | null; signIn?: boolean; signInProblem?: string | null;
  message: string;
}

export interface MeetingSource {
  kind: string;
  label: string;
  status(): SourceStatus;
  /** How to make a personal access token. */
  connectHelp(): MeetingConnectHelp;
  /** Connect with a pasted personal access token (checked with the tool first). */
  connect(token: string): Promise<SourceStatus>;
  /** Forget the token (revoking it where the tool allows); note says what's left to do by hand. */
  disconnect(): Promise<SourceStatus & { note?: string }>;
  signInStart(): Promise<MeetingSignInStart>;
  signInStatus(): MeetingSignInStatus;
  /** Finish a sign-in from the redirect address the person pasted back. */
  signInFinish(pasted: string): Promise<MeetingSignInStatus>;
  /** A hosted dashboard: the browser came back to its own callback address; finish and answer with the page it lands on. */
  signInCallback?(target: URL, res: http.ServerResponse, back: string): Promise<void>;
  signInCancel(): void;
  listMeetings(req: MeetingListRequest): Promise<MeetingPage>;
  meeting(id: string): Promise<MeetingDetail>;
  /** A browser URL for the meeting, or null. May create one in the tool, so call it only when asked. */
  shareLink(id: string): Promise<string | null>;
  /** The transcript as plain text, speakers named from `names` (participant id → name); null when there's none. */
  transcript(id: string, names: Map<string, string>): Promise<string | null>;
}

/** meetings.json names a source the engine has no adapter for (or is broken): the page says so. */
export class NoSource implements MeetingSource {
  kind: string;
  label: string;
  private readonly problem: string;
  constructor(cfg: MeetingsConfig) {
    this.kind = cfg.source || "none";
    this.label = cfg.label;
    this.problem = cfg.error || `"${cfg.source}" meetings aren't supported yet (known: ${supportedSources().join(", ")}).`;
  }
  status(): SourceStatus { return { configured: true, connected: false, message: this.problem }; }
  connectHelp(): MeetingConnectHelp { return { title: this.label, steps: [], placeholder: "" }; }
  async connect(): Promise<SourceStatus> { throw new Error(this.problem); }
  async disconnect(): Promise<SourceStatus & { note?: string }> { return this.status(); }
  async signInStart(): Promise<MeetingSignInStart> { throw new Error(this.problem); }
  signInStatus(): MeetingSignInStatus { return { pending: false, done: false, ok: false, message: this.problem }; }
  async signInFinish(): Promise<MeetingSignInStatus> { throw new Error(this.problem); }
  signInCancel() { /* nothing pending */ }
  async listMeetings(): Promise<MeetingPage> { throw new Error(this.problem); }
  async meeting(): Promise<MeetingDetail> { throw new Error(this.problem); }
  async shareLink() { return null; }
  async transcript() { return null; }
}

// A named type, not an inline one: validate.mjs reads the keys of the SOURCES literal.
type Source = { label: string; make: (cfg: MeetingsConfig, ctx: MeetingsContext) => MeetingSource };
const SOURCES: Record<string, Source> = {
  roam: { label: "Roam", make: (cfg, ctx) => new RoamMeetings(cfg, ctx) },
};

export function supportedSources() { return Object.keys(SOURCES); }

/** A meeting id as the routes accept it (Roam's are UUIDs). */
export const MEETING_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * What a source throws when the tool answers with an error (RoamError is one): `status` the
 * tool's HTTP status (0 when it wasn't reached) and `code` its error code, with NOT_CONNECTED,
 * "missing_scope" and "ratelimited" meaning what meetingsErrorStatus says.
 */
export interface MeetingError extends Error { status: number; code: string }

/** Whether `e` is a MeetingError: any Error with a numeric status and a string code. */
export function isMeetingError(e: unknown): e is MeetingError {
  return e instanceof Error && typeof (e as any).status === "number" && typeof (e as any).code === "string";
}

/**
 * The HTTP status a meeting tool's error goes back to the page with: 401 connect again,
 * 403 the token lacks a scope, 404 no such meeting, 400 the tool refused the request,
 * 429 slow down, 502 anything else from the tool (or not reaching it at all).
 * null: not a MeetingError (bad input etc. carry their own status).
 */
export function meetingsErrorStatus(e: unknown): number | null {
  if (!isMeetingError(e)) return null;
  if (e.code === NOT_CONNECTED) return 401;
  if (e.code === "missing_scope") return 403;
  if (e.code === "ratelimited") return 429;
  if (e.status === 404 || e.status === 400) return e.status;
  return 502;
}

/** What's wrong with a redirectUri, or null. It must be http on a loopback host with an explicit port. */
const redirectProblem = (uri: string) => loopbackRedirectProblem(uri, 'meetings.json: "redirectUri"', DEFAULT_REDIRECT_URI);

/** meetings.json with defaults filled in; null when there's no meetings.json. */
export function meetingsConfig(dir?: string): MeetingsConfig | null {
  const { data, error } = readConfigFile("meetings.json", dir);
  if (!data && !error) return null;
  const raw = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const source = typeof raw.source === "string" ? raw.source.trim().toLowerCase() : "";
  const label = (typeof raw.label === "string" && raw.label.trim()) || SOURCES[source]?.label || source || "Meetings";
  const clientId = typeof raw.clientId === "string" && raw.clientId.trim() ? raw.clientId.trim() : null;
  const redirectUri = typeof raw.redirectUri === "string" && raw.redirectUri.trim() ? raw.redirectUri.trim() : DEFAULT_REDIRECT_URI;
  const problem = error || (source ? null : 'meetings.json: "source" names the meeting tool, e.g. "roam".');
  // Sign-in settings only turn sign-in off. One rule for both: null or a blank string counts as
  // left out (no clientId = no sign-in; no redirectUri = the default); any other non-string is wrong.
  const signInProblem = (raw.clientId != null && typeof raw.clientId !== "string" ? 'meetings.json: "clientId" must be the OAuth app\'s client ID (a string), or left out.' : null)
    || (raw.redirectUri != null && typeof raw.redirectUri !== "string" ? 'meetings.json: "redirectUri" must be a string.' : null)
    || redirectProblem(redirectUri);
  return { source, label, clientId, redirectUri, error: problem, signInProblem };
}

/**
 * The configured meeting tool. Re-reads meetings.json each call and keeps one
 * instance per settings, so edits apply without a restart.
 */
export class Meetings {
  dir: string | undefined;
  ctx: MeetingsContext;
  current: { sig: string; source: MeetingSource } | null = null;

  constructor(dir?: string, ctx?: Partial<MeetingsContext>) {
    this.dir = dir;
    this.ctx = { ledgerDir: ctx?.ledgerDir || LEDGER_DIR, hosted: !!ctx?.hosted, publicOrigin: ctx?.publicOrigin || null };
  }

  /** null when the workspace has no meetings.json. */
  get(): MeetingSource | null {
    const cfg = meetingsConfig(this.dir);
    if (!cfg) { this.current?.source.signInCancel(); this.current = null; return null; }
    const sig = JSON.stringify(cfg);
    if (this.current && this.current.sig === sig) return this.current.source;
    // A settings change replaces the source: drop the old one's pending sign-in (and its listener).
    this.current?.source.signInCancel();
    const entry = !cfg.error && SOURCES[cfg.source];
    const source = entry ? entry.make(cfg, this.ctx) : new NoSource(cfg);
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
    if (!s) return { source: "none", label: "Meetings", configured: false, supported: false, connected: false, viewer: null, via: null, signIn: false, signInProblem: null, message: "No meeting tool is configured (.claude/dashboard/meetings.json)." };
    const st = s.status();
    // A known tool with a broken meetings.json is still a NoSource: the page says it isn't available.
    return {
      source: s.kind, label: s.label, configured: st.configured, supported: !!SOURCES[s.kind] && !(s instanceof NoSource), connected: st.connected,
      viewer: st.viewer ?? null, via: st.via ?? null, signIn: !!st.signIn,
      signInProblem: st.signInProblem ?? null, message: st.message,
    };
  }
}

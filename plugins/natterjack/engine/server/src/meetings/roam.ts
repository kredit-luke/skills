/**
 * Roam (https://developer.ro.am/): meetings with their summaries and action items.
 * roam-auth.ts connects the person's own account (sign-in or a pasted personal access token)
 * and keeps the token; roam-api.ts makes the calls. Every read goes through auth.withToken,
 * so an expired sign-in is refreshed once and a dead one reads as "connect again".
 */

import type http from "node:http";
import type { MeetingConnectHelp, MeetingDetail, MeetingListRequest, MeetingPage, MeetingSignInStart, MeetingSignInStatus } from "../../../shared/api.ts";
import type { MeetingSource, MeetingsConfig, MeetingsContext, SourceStatus } from "./index.ts";
import { RoamApi, RoamError, transcriptText, type RoamFetch } from "./roam-api.ts";
import { hostedCallbackUri } from "../oauth-signin.ts";
import { ROAM_SCOPES, RoamAuth, type RoamAuthOptions } from "./roam-auth.ts";

/** What tests swap in: Roam itself (fetcher, shared by the API calls and sign-in) and the listener. */
export type RoamDeps = Partial<Omit<RoamAuthOptions, "hosted" | "callbackUri">> & { fetcher?: RoamFetch };

/** meeting.transcript's "there's none (yet)" answers. */
const NO_TRANSCRIPT = new Set(["transcript_pending", "transcript_unavailable"]);

export class RoamMeetings implements MeetingSource {
  kind = "roam";
  label: string;
  readonly auth: RoamAuth;
  private readonly api: RoamApi;
  private readonly signIn: boolean;
  private readonly signInProblem: string | null;

  constructor(cfg: MeetingsConfig, ctx: MeetingsContext, deps: RoamDeps = {}) {
    this.label = cfg.label;
    this.signInProblem = cfg.signInProblem;
    this.signIn = !!cfg.clientId && !cfg.signInProblem;
    this.api = new RoamApi({ fetcher: deps.fetcher });
    const callbackUri = ctx.hosted && ctx.publicOrigin ? hostedCallbackUri(ctx.publicOrigin, "roam") : null;
    this.auth = new RoamAuth(ctx.ledgerDir, cfg, { ...deps, hosted: ctx.hosted, callbackUri });
  }

  status(): SourceStatus {
    const c = this.auth.connection();
    return {
      configured: true, connected: !!c, viewer: c?.viewer ?? null, via: c?.via ?? null,
      signIn: this.signIn, signInProblem: this.signInProblem,
      message: c
        ? `Connected to ${this.label}${c.viewer ? ` as ${c.viewer}` : ""}.`
        : `Connect your ${this.label} account to see your meetings.`,
    };
  }

  connectHelp(): MeetingConnectHelp {
    const steps = [
      `In ${this.label}, open **User Settings → Developer** and create a personal access token with the \`${ROAM_SCOPES.join("` and `")}\` scopes.`,
      "Copy the token and paste it below. It stays on this dashboard, in `.claude/ledger/`, and is never shown again.",
    ];
    if (this.signIn) steps.push(`Or sign in with ${this.label} instead: when ${this.label} asks how to connect, choose **Personal access**.`);
    return { title: `Connect ${this.label}`, steps, placeholder: `${this.label} personal access token` };
  }

  async connect(token: string): Promise<SourceStatus> {
    await this.auth.connectToken(token);
    return this.status();
  }

  async disconnect(): Promise<SourceStatus & { note?: string }> {
    const { note } = await this.auth.disconnect();
    return note ? { ...this.status(), note } : this.status();
  }

  signInStart(): Promise<MeetingSignInStart> { return this.auth.signInStart(); }
  signInStatus(): MeetingSignInStatus { return this.auth.signInStatus(); }
  signInFinish(pasted: string): Promise<MeetingSignInStatus> { return this.auth.signInFinish(pasted); }
  signInCallback(target: URL, res: http.ServerResponse, back: string): Promise<void> { return this.auth.signInCallback(target, res, back); }
  signInCancel() { this.auth.signInCancel(); }

  listMeetings(req: MeetingListRequest): Promise<MeetingPage> {
    return this.auth.withToken((t) => this.api.listMeetings(t, req.cursor || undefined));
  }

  meeting(id: string): Promise<MeetingDetail> {
    return this.auth.withToken((t) => this.api.meeting(t, id));
  }

  shareLink(id: string): Promise<string | null> {
    return this.auth.withToken((t) => this.api.shareLink(t, id));
  }

  async transcript(id: string, names: Map<string, string>): Promise<string | null> {
    try {
      const cues = await this.auth.withToken((t) => this.api.transcript(t, id));
      return transcriptText(cues, names) || null;
    } catch (e) {
      if (e instanceof RoamError && e.status === 404 && NO_TRANSCRIPT.has(e.code)) return null;
      throw e;
    }
  }
}

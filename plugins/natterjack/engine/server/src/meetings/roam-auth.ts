/**
 * Connecting a person's own Roam account: browser sign-in (OAuth with PKCE, as a public
 * client, so there's no secret) or a pasted personal access token. Either way the token
 * lands in <ledger>/roam-token.json (owner-only, written to a temp file and renamed, so a
 * rotated refresh token is never half-written) and never reaches the browser.
 *
 * The sign-in itself (state, the pending sign-in, catching the browser coming back) is
 * oauth-signin.ts. Locally it comes back to `redirectUri` (http on a loopback host), which
 * the dashboard listens on while a sign-in is pending; if that port is taken, the page falls
 * back to a paste box. A hosted dashboard with a public address (`callbackUri`) has the
 * browser come back to the dashboard itself; one without falls back to pasting.
 *
 * Access tokens last a week: accessToken() refreshes one with under 10 minutes left, one
 * refresh at a time (Roam rotates the refresh token, so a second refresh with the old one
 * would fail). withToken() runs a call and, on invalid_token, refreshes once and retries.
 * When the person has to connect again, calls fail with a RoamError coded `not_connected`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { MeetingSignInStart, MeetingSignInStatus } from "../../../shared/api.ts";
import { OAuthSignIn, type Listen } from "../oauth-signin.ts";
import { RoamApi, RoamError, type RoamFetch } from "./roam-api.ts";

export { pkceChallenge, pkceVerifier, signInErrorMessage, type Listen } from "../oauth-signin.ts";

export const ROAM_AUTHORIZE = "https://ro.am/oauth/authorize";
export const ROAM_TOKEN = "https://ro.am/oauth/token";
/** What sign-in asks for: read meetings, and who you are (for "Connected as ..."). */
export const ROAM_SCOPES = ["meetings:read", "user:read"];
/** The scope a pasted token must have. */
const NEEDED_SCOPE = "meetings:read";
/** RoamError code for "there's no usable token: connect again". */
export const NOT_CONNECTED = "not_connected";
/** Refresh an access token with less than this left. */
const REFRESH_MARGIN_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;

/** The token file. expiresAt is epoch milliseconds; null for a personal access token. */
export interface RoamToken {
  via: "oauth" | "token";
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  viewer: string | null;
  scopes: string[];
}

/** The settings RoamAuth reads from meetings.json (MeetingsConfig has them). */
export interface RoamAuthConfig { label: string; clientId: string | null; redirectUri: string; signInProblem: string | null }

export interface RoamAuthOptions {
  /** A hosted dashboard: never listen on a loopback port. */
  hosted: boolean;
  /**
   * Hosted: the dashboard's own callback address (oauth-signin.ts hostedCallbackUri), used as
   * the redirect instead of `redirectUri`, and main.ts finishes the sign-in when the browser
   * arrives there. Left out, a hosted sign-in is pasted back.
   */
  callbackUri?: string | null;
  fetcher?: RoamFetch;
  listen?: Listen;
  /** Listen here instead of redirectUri's port (tests pass 0). */
  listenPort?: number;
  now?: () => number;
  /** How long an unfinished sign-in waits (tests pass a few milliseconds). */
  pendingMs?: number;
}

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });
const disconnected = (message: string) => new RoamError(401, NOT_CONNECTED, message);

export class RoamAuth {
  readonly file: string;
  private readonly cfg: RoamAuthConfig;
  private readonly fetcher: RoamFetch;
  private readonly api: RoamApi;
  private readonly now: () => number;
  private readonly signIn: OAuthSignIn;
  private refreshing: Promise<RoamToken> | null = null;
  /**
   * Bumped on every save or delete. The real check that a refresh didn't race a disconnect or a new sign-in is
   * comparing its refresh token with the one in the file before writing; this is a belt-and-braces guard
   * within this instance on top of that.
   */
  private generation = 0;

  constructor(ledgerDir: string, cfg: RoamAuthConfig, opts: RoamAuthOptions) {
    this.file = path.join(ledgerDir, "roam-token.json");
    this.cfg = cfg;
    this.fetcher = opts.fetcher || (fetch as unknown as RoamFetch);
    this.api = new RoamApi({ fetcher: this.fetcher });
    this.now = opts.now || Date.now;
    const routed = opts.hosted && !!opts.callbackUri;
    this.signIn = new OAuthSignIn({
      label: cfg.label,
      redirectUri: routed ? opts.callbackUri! : cfg.redirectUri,
      mode: routed ? "route" : opts.hosted ? "paste" : "listen",
      listen: opts.listen, listenPort: opts.listenPort, pendingMs: opts.pendingMs,
    });
  }

  // ---- the token file

  /** The stored token, or null (none, or unreadable). */
  read(): RoamToken | null {
    let t: any;
    try { t = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return null; }
    if (!t || typeof t.accessToken !== "string" || !t.accessToken || (t.via !== "oauth" && t.via !== "token")) return null;
    return {
      via: t.via, accessToken: t.accessToken,
      refreshToken: typeof t.refreshToken === "string" && t.refreshToken ? t.refreshToken : null,
      expiresAt: typeof t.expiresAt === "number" ? t.expiresAt : null,
      viewer: typeof t.viewer === "string" ? t.viewer : null,
      scopes: Array.isArray(t.scopes) ? t.scopes.filter((s: unknown) => typeof s === "string") : [],
    };
  }

  /** Who's connected and how, without the token itself (what the page may see). */
  connection(): { via: "oauth" | "token"; viewer: string | null; scopes: string[] } | null {
    const t = this.read();
    return t ? { via: t.via, viewer: t.viewer, scopes: t.scopes } : null;
  }

  private save(t: RoamToken) {
    this.generation++;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n", { mode: 0o600 });
    try { fs.renameSync(tmp, this.file); } catch { fs.copyFileSync(tmp, this.file); fs.unlinkSync(tmp); }
  }

  private forget() {
    this.generation++;
    try { fs.unlinkSync(this.file); } catch {}
  }

  /** Forget the stored token only if it's still `token`: one connected meanwhile (a pasted token, a new sign-in) stays. */
  private forgetIf(token: string) {
    if (this.read()?.accessToken === token) this.forget();
  }

  // ---- using the token

  /** A current access token, refreshed first when it has under 10 minutes left. */
  async accessToken(): Promise<string> {
    const t = this.read();
    if (!t) throw disconnected(`${this.cfg.label} isn't connected.`);
    if (t.via === "oauth" && t.expiresAt !== null && t.expiresAt - this.now() < REFRESH_MARGIN_MS) {
      try {
        return (await this.refresh()).accessToken;
      } catch (e) {
        // Roam's token endpoint down: the old token still has a few minutes, so use it.
        if (e instanceof RoamError && e.code === NOT_CONNECTED) throw e;
        if (t.expiresAt > this.now()) return t.accessToken;
        throw e;
      }
    }
    return t.accessToken;
  }

  /**
   * Run one Roam call with the token. invalid_token: refresh once and retry (a personal access
   * token can't be refreshed, so it's disconnected). token_revoked: forget it, connect again.
   * Only the token that failed is forgotten: if another was stored meanwhile (a refresh by
   * another call, a pasted token, a new sign-in), the call is retried once with that instead.
   */
  async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    try {
      return await fn(token);
    } catch (e) {
      if (!(e instanceof RoamError) || (e.code !== "invalid_token" && e.code !== "token_revoked")) throw e;
      const t = this.read();
      let next: string;
      if (t && t.accessToken !== token) next = t.accessToken;
      else if (e.code === "token_revoked") { this.forgetIf(token); throw disconnected(`${this.cfg.label} revoked access, connect again.`); }
      else if (!t || t.via === "token") { this.forgetIf(token); throw disconnected(`${this.cfg.label} didn't accept the token, connect again.`); }
      else next = (await this.refresh()).accessToken;
      try {
        return await fn(next);
      } catch (e2) {
        if (e2 instanceof RoamError && (e2.code === "invalid_token" || e2.code === "token_revoked")) {
          this.forgetIf(next);
          throw disconnected(`${this.cfg.label} didn't accept the token, connect again.`);
        }
        throw e2;
      }
    }
  }

  /** Refresh the OAuth token: one at a time; the rotated refresh token is saved before this resolves. */
  refresh(): Promise<RoamToken> {
    if (!this.refreshing) this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<RoamToken> {
    const t = this.read();
    if (!t) throw disconnected(`${this.cfg.label} isn't connected.`);
    if (t.via !== "oauth" || !t.refreshToken || !this.cfg.clientId) {
      this.forget();
      throw disconnected(`${this.cfg.label} sign-in expired, connect again.`);
    }
    const gen = this.generation;
    let body: any;
    try {
      body = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: this.cfg.clientId });
    } catch (e) {
      // Roam turned the refresh token down: it's no use any more. (Unreachable or a 5xx: keep it and try later.)
      if (e instanceof RoamError && (e.status === 400 || e.status === 401 || e.code === "invalid_grant")) {
        // Another dashboard on this ledger may have just rotated it (so ours was spent): use theirs.
        const now = this.read();
        if (now && now.refreshToken !== t.refreshToken) return now;
        this.forget();
        const why = e.code === "invalid_grant" ? "" : ` (${this.cfg.label} said ${e.code})`;
        throw disconnected(`${this.cfg.label} sign-in expired, connect again${why}.`);
      }
      throw e;
    }
    const next: RoamToken = {
      via: "oauth", accessToken: body.access_token,
      // Roam usually rotates the refresh token; keep the old one when it doesn't send a new one.
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : t.refreshToken,
      expiresAt: this.expiresAt(body), viewer: t.viewer,
      scopes: typeof body.scope === "string" && body.scope.trim() ? body.scope.trim().split(/\s+/) : t.scopes,
    };
    // Disconnected (or connected anew) while this was in flight: don't bring the old grant back.
    // A new connection is what to use now; with none, there's nothing to use.
    // The generation only counts this instance's saves: another RoamAuth on the same ledger (the
    // one a meetings.json edit swapped in, another dashboard) may have disconnected or connected
    // anew. So save only if the file still holds the refresh token this request spent.
    const stored = this.read();
    if (this.generation !== gen || !stored || stored.refreshToken !== t.refreshToken) {
      if (stored) return stored;
      throw disconnected(`${this.cfg.label} isn't connected.`);
    }
    this.save(next);
    return next;
  }

  private expiresAt(body: any): number | null {
    const s = Number(body?.expires_in);
    return Number.isFinite(s) && s > 0 ? this.now() + s * 1000 : null;
  }

  /** POST to Roam's token endpoint (form-encoded, no client secret: a public client). */
  private async tokenRequest(params: Record<string, string>): Promise<any> {
    let res: Awaited<ReturnType<RoamFetch>>;
    try {
      res = await this.fetcher(ROAM_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e: any) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw new RoamError(0, "unreachable", timedOut ? `${this.cfg.label} didn't answer within ${TIMEOUT_MS / 1000} seconds.` : `Couldn't reach ${this.cfg.label}: ${e?.message || e}`);
    }
    let data: any = null;
    try { data = JSON.parse(await res.text()); } catch {}
    if (!res.ok || !data || data.ok === false || typeof data.access_token !== "string" || !data.access_token) {
      // OAuth's { error, error_description }, or Roam's { ok: false, error }.
      const code = typeof data?.error === "string" ? data.error : res.ok ? "bad_response" : `http_${res.status}`;
      const desc = typeof data?.error_description === "string" ? `: ${data.error_description}` : "";
      throw new RoamError(res.ok ? 502 : res.status, code, `${this.cfg.label} turned the sign-in down (${code}${desc}).`);
    }
    return data;
  }

  // ---- personal access token

  /** Check a pasted personal access token with token.info, then keep it. */
  async connectToken(pat: string): Promise<RoamToken> {
    const token = String(pat ?? "").trim();
    if (!token) throw badRequest(`Paste a ${this.cfg.label} personal access token.`);
    let info;
    try {
      info = await this.api.tokenInfo(token);
    } catch (e) {
      if (e instanceof RoamError && ["invalid_token", "token_revoked", "not_authed"].includes(e.code)) {
        throw badRequest(`${this.cfg.label} didn't accept that token. Check you copied all of it, or make a new one.`);
      }
      throw e;
    }
    if (!info.scopes.includes(NEEDED_SCOPE)) {
      throw badRequest(`That token doesn't have the ${NEEDED_SCOPE} scope. Make a new one in ${this.cfg.label} with ${ROAM_SCOPES.join(" and ")}.`);
    }
    this.signInCancel();
    const t: RoamToken = { via: "token", accessToken: token, refreshToken: null, expiresAt: null, viewer: info.viewer, scopes: info.scopes };
    this.save(t);
    return t;
  }

  /**
   * Revoke the token with Roam where it allows, and forget it either way. The note says what's
   * left to do by hand when Roam refused (it doesn't revoke personal access tokens).
   */
  async disconnect(): Promise<{ note?: string }> {
    this.signInCancel();
    const t = this.read();
    if (!t) return {};
    let token = t.accessToken;
    if (t.via === "oauth") {
      try {
        token = await this.accessToken();
      } catch (e) {
        // Roam had already turned the sign-in down: there's nothing left to revoke.
        if (e instanceof RoamError && e.code === NOT_CONNECTED) { this.forget(); return {}; }
        /* otherwise revoke with what we have */
      }
    }
    let note: string | undefined;
    try {
      await this.api.revoke(token);
    } catch {
      const what = t.via === "token" ? "the personal access token" : "this app's access";
      note = `${this.cfg.label} didn't revoke ${what}, so it still works. Delete it in ${this.cfg.label}: User Settings → Developer.`;
    }
    this.forget();
    return note ? { note } : {};
  }

  // ---- browser sign-in

  /** Start a sign-in (dropping an unfinished one): the page to open, and whether this dashboard catches the redirect. */
  async signInStart(): Promise<MeetingSignInStart> {
    if (this.cfg.signInProblem) throw badRequest(`${this.cfg.label} sign-in is off: ${this.cfg.signInProblem}`);
    if (!this.cfg.clientId) throw badRequest(`${this.cfg.label} sign-in isn't set up (meetings.json has no "clientId"). Paste a personal access token instead.`);
    const clientId = this.cfg.clientId;
    const redirectUri = this.signIn.redirectUri;
    // Spaces as %20, not "+", the way Roam's own example has the scope.
    const authorizeUrl = ({ state, challenge }: { state: string; challenge: string | null }) => `${ROAM_AUTHORIZE}?${Object.entries({
      response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: ROAM_SCOPES.join(" "),
      state, code_challenge: challenge!, code_challenge_method: "S256",
    }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
    return this.signIn.start(authorizeUrl, (code, verifier, current) => this.exchange(code, verifier!, current), true);
  }

  signInStatus(): MeetingSignInStatus { return this.signIn.status(); }

  /** Finish from the address the browser ended on (pasted into the page). */
  signInFinish(pasted: string): Promise<MeetingSignInStatus> { return this.signIn.finish(pasted); }

  /** The browser arrived at a hosted dashboard's callback: finish and answer with the page it lands on. */
  signInCallback(target: URL, res: http.ServerResponse, back: string): Promise<void> { return this.signIn.callback(target, res, back); }

  /** Drop a pending sign-in and close its listener. */
  signInCancel() { this.signIn.cancel(); }

  /** The port the sign-in listener is on (127.0.0.1), or null. */
  listenerPort(): number | null { return this.signIn.listenerPort(); }

  /**
   * authorization_code → tokens, then token.info for who it is. null when the sign-in was
   * cancelled meanwhile (disconnect, a pasted token, a new sign-in): nothing is saved then.
   * Every one of those cancels the pending sign-in first, so that's the check (a refresh of
   * the old token meanwhile mustn't throw this one away).
   */
  private async exchange(code: string, verifier: string, current: () => boolean): Promise<string | null> {
    const body = await this.tokenRequest({
      grant_type: "authorization_code", code, redirect_uri: this.signIn.redirectUri, client_id: this.cfg.clientId!, code_verifier: verifier,
    });
    const t: RoamToken = {
      via: "oauth", accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
      expiresAt: this.expiresAt(body), viewer: null,
      scopes: typeof body.scope === "string" && body.scope.trim() ? body.scope.trim().split(/\s+/) : [],
    };
    try {
      const info = await this.api.tokenInfo(t.accessToken);
      t.viewer = info.viewer;
      if (info.scopes.length) t.scopes = info.scopes;
    } catch { /* connected all the same; the name shows up as unknown */ }
    if (!current()) {
      // Nobody will use this grant: end it with Roam (best effort) rather than leave it live.
      this.api.revoke(t.accessToken).catch(() => {});
      return null;
    }
    this.save(t);
    return `Connected to ${this.cfg.label}${t.viewer ? ` as ${t.viewer}` : ""}.`;
  }
}

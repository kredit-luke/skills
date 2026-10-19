/**
 * Connecting a person's own Roam account: browser sign-in (OAuth with PKCE, as a public
 * client, so there's no secret) or a pasted personal access token. Either way the token
 * lands in <ledger>/roam-token.json (owner-only, written to a temp file and renamed, so a
 * rotated refresh token is never half-written) and never reaches the browser.
 *
 * Sign-in comes back to `redirectUri` (http on a loopback host). A local dashboard listens
 * there while a sign-in is pending and finishes it when the browser arrives. A hosted one
 * never listens: "localhost" in the person's browser is their own computer, so the last page
 * doesn't load and they paste its address into the page (signInFinish). If the port is taken
 * locally, the page falls back to the paste box too. `state` is checked either way.
 *
 * Access tokens last a week: accessToken() refreshes one with under 10 minutes left, one
 * refresh at a time (Roam rotates the refresh token, so a second refresh with the old one
 * would fail). withToken() runs a call and, on invalid_token, refreshes once and retries.
 * When the person has to connect again, calls fail with a RoamError coded `not_connected`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { MeetingSignInStart, MeetingSignInStatus } from "../../../shared/api.ts";
import { callbackTarget } from "../mcp-login.ts";
import { RoamApi, RoamError, type RoamFetch } from "./roam-api.ts";

export const ROAM_AUTHORIZE = "https://ro.am/oauth/authorize";
export const ROAM_TOKEN = "https://ro.am/oauth/token";
/** What sign-in asks for: read meetings, and who you are (for "Connected as ..."). */
export const ROAM_SCOPES = ["meetings:read", "user:read"];
/** The scope a pasted token must have. */
const NEEDED_SCOPE = "meetings:read";
/** RoamError code for "there's no usable token: connect again". */
export const NOT_CONNECTED = "not_connected";
/** An unfinished sign-in is dropped after this long (as in mcp-login.ts). */
const PENDING_MS = 10 * 60_000;
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

/** Bind `server` to host:port (rejects with the listen error, e.g. EADDRINUSE). Injectable for tests. */
export type Listen = (server: http.Server, port: number, host: string) => Promise<void>;

export interface RoamAuthOptions {
  /** A hosted dashboard: never listen; the person pastes the address back. */
  hosted: boolean;
  fetcher?: RoamFetch;
  listen?: Listen;
  /** Listen here instead of redirectUri's port (tests pass 0). */
  listenPort?: number;
  now?: () => number;
  /** How long an unfinished sign-in waits (tests pass a few milliseconds). */
  pendingMs?: number;
}

interface Pending {
  state: string;
  verifier: string;
  servers: http.Server[];
  expiry: NodeJS.Timeout;
  /** The listener being started, so a cancel can wait for its port to be let go. */
  started: Promise<boolean> | null;
  /** Set once a callback with the right state arrives (by the listener or a paste), so it finishes once. */
  finishing: Promise<MeetingSignInStatus> | null;
}

const base64url = (b: Buffer) => b.toString("base64url");

/** A PKCE code verifier: 32 random bytes, base64url (43 characters). */
export function pkceVerifier(): string { return base64url(crypto.randomBytes(32)); }
/** The S256 code challenge for a verifier (RFC 7636 4.2). */
export function pkceChallenge(verifier: string): string { return base64url(crypto.createHash("sha256").update(verifier, "ascii").digest()); }

const defaultListen: Listen = (server, port, host) => new Promise((resolve, reject) => {
  const onError = (e: Error) => reject(e);
  server.once("error", onError);
  server.listen(port, host, () => { server.off("error", onError); resolve(); });
});

/** Close a server and its connections; resolves once its port is let go (or it never had one). */
const closeServer = (s: http.Server) => new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });
const disconnected = (message: string) => new RoamError(401, NOT_CONNECTED, message);

/** Same strings, compared in constant time. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** What the person reads when Roam sends the browser back with ?error=. */
export function signInErrorMessage(label: string, error: string, description: string | null): string {
  const said = description ? ` (${description})` : "";
  // Only wording about an admin or a pending approval: "the user did not approve" is a plain no.
  if (/admin|pending approval|waiting for/i.test(`${error} ${description || ""}`)) {
    return `A ${label} admin has to approve this app for you first${said}. Ask them, then connect again.`;
  }
  if (error === "access_denied") {
    return `${label} didn't grant access${said}. If you declined, start again and allow it; if your ${label} admin approves apps, an admin may have to approve this one first.`;
  }
  return `${label} sign-in failed: ${error}${said}.`;
}

/** The small page the browser lands on locally. */
function callbackPage(ok: boolean, message: string): string {
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = ok ? "Connected" : "Not connected";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">`
    + `<h1 style="font-size:1.25rem">${title}</h1><p>${esc}</p><p>Go back to the dashboard.</p></body></html>`;
}

export class RoamAuth {
  readonly file: string;
  private readonly cfg: RoamAuthConfig;
  private readonly hosted: boolean;
  private readonly fetcher: RoamFetch;
  private readonly api: RoamApi;
  private readonly listen: Listen;
  private readonly listenPort: number | undefined;
  private readonly now: () => number;
  private readonly pendingMs: number;
  private pending: Pending | null = null;
  /** Resolves once the last cancelled sign-in's listener has let its port go. */
  private released: Promise<unknown> = Promise.resolve();
  /** The last finished sign-in, until signInStatus() reports it. */
  private result: MeetingSignInStatus | null = null;
  private refreshing: Promise<RoamToken> | null = null;
  /** Bumped on every save or delete, so a refresh that raced a disconnect doesn't write the token back. */
  private generation = 0;

  constructor(ledgerDir: string, cfg: RoamAuthConfig, opts: RoamAuthOptions) {
    this.file = path.join(ledgerDir, "roam-token.json");
    this.cfg = cfg;
    this.hosted = opts.hosted;
    this.fetcher = opts.fetcher || (fetch as unknown as RoamFetch);
    this.api = new RoamApi({ fetcher: this.fetcher });
    this.listen = opts.listen || defaultListen;
    this.listenPort = opts.listenPort;
    this.now = opts.now || Date.now;
    this.pendingMs = opts.pendingMs ?? PENDING_MS;
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
    if (this.generation !== gen) {
      const stored = this.read();
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
    this.signInCancel();
    this.result = null;
    const verifier = pkceVerifier();
    const state = base64url(crypto.randomBytes(32));
    // Once the code is being exchanged, let that finish and report rather than drop it.
    const p: Pending = { state, verifier, servers: [], started: null, finishing: null, expiry: setTimeout(() => { if (!p.finishing) this.cancelPending(p); }, this.pendingMs) };
    p.expiry.unref();
    this.pending = p;
    // Spaces as %20, not "+", the way Roam's own example has the scope.
    const query = Object.entries({
      response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, scope: ROAM_SCOPES.join(" "),
      state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
    }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    let listening = false;
    if (!this.hosted) {
      // A sign-in started just before this one may still hold the port: wait for it to let go.
      await this.released;
      if (this.pending === p) listening = await (p.started = this.startListener(p));
    }
    return { url: `${ROAM_AUTHORIZE}?${query}`, callback: this.cfg.redirectUri, listening };
  }

  signInStatus(): MeetingSignInStatus {
    if (this.pending) return { pending: true, done: false, ok: false, message: "Waiting for you to finish in the browser." };
    if (this.result) { const r = this.result; this.result = null; return r; }
    return { pending: false, done: false, ok: false, message: "No sign-in is waiting." };
  }

  /** Finish from the address the browser ended on (pasted into the page). */
  async signInFinish(pasted: string): Promise<MeetingSignInStatus> {
    const p = this.pending;
    if (!p) {
      if (this.result) return this.signInStatus();
      return { pending: false, done: false, ok: false, message: "No sign-in is waiting. Start again." };
    }
    let target: URL;
    try { target = callbackTarget(pasted, this.cfg.redirectUri); } catch (e: any) { throw badRequest(e.message); }
    return this.complete(p, target);
  }

  /** Drop a pending sign-in and close its listener. */
  signInCancel() {
    if (this.pending) this.cancelPending(this.pending);
  }

  /** The port the sign-in listener is on (127.0.0.1), or null. */
  listenerPort(): number | null {
    const addr = this.pending?.servers[0]?.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  private cancelPending(p: Pending) {
    if (this.pending !== p) return;
    this.pending = null;
    clearTimeout(p.expiry);
    // Accumulates: a sign-in cancelled before its listener started (started still null) must
    // not let the next one skip waiting for an earlier listener that's still letting go.
    this.released = Promise.all([this.released, p.started, ...p.servers.map(closeServer)]);
  }

  /** A callback with the right state (from the listener or a paste): exchange the code, once. */
  private complete(p: Pending, target: URL): Promise<MeetingSignInStatus> {
    const state = target.searchParams.get("state") || "";
    if (!sameSecret(state, p.state)) throw badRequest("That address is from a different sign-in (its state doesn't match). Start again.");
    if (!p.finishing) p.finishing = this.finish(p, target);
    return p.finishing;
  }

  private async finish(p: Pending, target: URL): Promise<MeetingSignInStatus> {
    const error = target.searchParams.get("error");
    const code = target.searchParams.get("code");
    let status: MeetingSignInStatus;
    if (error || !code) {
      status = { pending: false, done: true, ok: false, message: signInErrorMessage(this.cfg.label, error || "no_code", target.searchParams.get("error_description")) };
    } else {
      try {
        const t = await this.exchange(code, p);
        status = t
          ? { pending: false, done: true, ok: true, message: `Connected to ${this.cfg.label}${t.viewer ? ` as ${t.viewer}` : ""}.` }
          : { pending: false, done: true, ok: false, message: `${this.cfg.label} sign-in was cancelled.` };
      } catch (e: any) {
        status = { pending: false, done: true, ok: false, message: `${this.cfg.label} sign-in failed: ${e?.message || e}` };
      }
    }
    if (this.pending === p) {
      this.pending = null;
      clearTimeout(p.expiry);
      // Let the browser's own request finish; stop taking new ones.
      for (const s of p.servers) { s.close(); s.closeIdleConnections(); }
      this.result = status;
    }
    return status;
  }

  /**
   * authorization_code → tokens, then token.info for who it is. null when the sign-in was
   * cancelled meanwhile (disconnect, a pasted token, a new sign-in): nothing is saved then.
   * Every one of those cancels the pending sign-in first, so that's the check (a refresh of
   * the old token meanwhile mustn't throw this one away).
   */
  private async exchange(code: string, p: Pending): Promise<RoamToken | null> {
    const body = await this.tokenRequest({
      grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri, client_id: this.cfg.clientId!, code_verifier: p.verifier,
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
    if (this.pending !== p) {
      // Nobody will use this grant: end it with Roam (best effort) rather than leave it live.
      this.api.revoke(t.accessToken).catch(() => {});
      return null;
    }
    this.save(t);
    return t;
  }

  /** Listen on the redirect's port (127.0.0.1, and ::1 if it can). false = taken or not allowed: the page shows the paste box. */
  private async startListener(p: Pending): Promise<boolean> {
    const want = new URL(this.cfg.redirectUri);
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => this.onCallback(p, want.pathname, req, res);
    const v4 = http.createServer(handler);
    try {
      await this.listen(v4, this.listenPort ?? Number(want.port), "127.0.0.1");
    } catch {
      // EADDRINUSE (another dashboard or app has it), EACCES (not allowed): paste it back instead.
      await closeServer(v4);
      return false;
    }
    if (this.pending !== p) { await closeServer(v4); return false; }
    p.servers.push(v4);
    const port = (v4.address() as { port: number }).port;
    const v6 = http.createServer(handler);
    try {
      await this.listen(v6, port, "::1");
      if (this.pending === p) p.servers.push(v6); else await closeServer(v6);
    } catch { await closeServer(v6); /* no IPv6 loopback, or the port's taken there: 127.0.0.1 will do */ }
    return this.pending === p;
  }

  private onCallback(p: Pending, pathname: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, ok: boolean, message: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
      res.end(callbackPage(ok, message));
    };
    let target: URL;
    try { target = new URL(req.url || "/", "http://localhost"); } catch { send(400, false, "That isn't a sign-in address."); return; }
    if (req.method !== "GET" || target.pathname !== pathname) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    if (this.pending !== p && !p.finishing) { send(410, false, "This sign-in isn't waiting any more. Start again from the dashboard."); return; }
    let done: Promise<MeetingSignInStatus>;
    try { done = this.complete(p, target); } catch (e: any) { send(400, false, e.message); return; }
    done.then((s) => send(s.ok ? 200 : 400, s.ok, s.message), (e) => send(500, false, String(e?.message || e)));
  }
}

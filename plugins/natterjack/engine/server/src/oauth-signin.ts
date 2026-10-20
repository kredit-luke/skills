/**
 * Browser sign-in (OAuth 2.0 authorization code) for a person's own account with a tool:
 * the part that's the same whichever tool it is. The tool's own file builds the authorize
 * URL and exchanges the code (meetings/roam-auth.ts, atlassian-auth.ts); this keeps the
 * sign-in in progress and catches the browser coming back.
 *
 * Where the browser comes back to (`redirectUri`) decides how it's caught:
 * - "listen": a local dashboard. An http loopback address on a fixed port, listened on only
 *   while a sign-in is pending. If the port is taken, the page falls back to "paste".
 * - "paste": nothing catches it. The last page doesn't load (it's "localhost" on the person's
 *   own computer), so they paste its address into the page (finish).
 * - "route": a hosted dashboard. An address on the dashboard's own public URL
 *   (hostedCallbackUri), which reaches this container through the router like any other
 *   page: main.ts hands the request to callback(). It's a redirect in the person's own
 *   browser, so it passes the login proxy like everything else, with nothing to open up.
 *
 * `state` is checked every way. An unfinished sign-in is dropped after 10 minutes; once the
 * code is being exchanged, that finishes and is reported rather than dropped.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { McpLoginStatus } from "../../shared/api.ts";
import { callbackTarget } from "./mcp-login.ts";

/** POST <tool>/sign-in { action: 'start' }: the page to open, where it comes back, and whether this dashboard catches that itself. */
export interface SignInStart { url: string; callback: string; listening: boolean }
export type SignInStatus = McpLoginStatus;
export type SignInMode = "listen" | "paste" | "route";

/** Bind `server` to host:port (rejects with the listen error, e.g. EADDRINUSE). Injectable for tests. */
export type Listen = (server: http.Server, port: number, host: string) => Promise<void>;

/** An unfinished sign-in is dropped after this long (as in mcp-login.ts). */
const PENDING_MS = 10 * 60_000;

/** The callback path on a hosted dashboard for `provider` ("atlassian", "roam"). */
export const hostedCallbackPath = (provider: string) => `/api/oauth/${provider}/callback`;
/** The callback address a hosted dashboard registers with the tool: its public URL plus hostedCallbackPath. */
export const hostedCallbackUri = (publicOrigin: string, provider: string) => `${publicOrigin.replace(/\/+$/, "")}${hostedCallbackPath(provider)}`;

/**
 * What's wrong with a local redirect address, or null. It must be http on a loopback host with
 * an explicit port (the dashboard listens there). `what` names the setting in the message
 * (`meetings.json: "redirectUri"`); `example` is the default, offered as an example.
 */
export function loopbackRedirectProblem(uri: string, what: string, example: string): string | null {
  let u: URL;
  try { u = new URL(uri); } catch { return `${what} isn't a URL: ${uri}`; }
  if (u.protocol !== "http:") return `${what} must start with http:// (the dashboard catches the sign-in on this machine): ${uri}`;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return `${what} must be on localhost, 127.0.0.1 or [::1]: ${uri}`;
  // URL drops :80 (http's default), so check what was written before calling the port missing.
  if (!u.port && /^http:\/\/[^/?#]*:0*80(?:[/?#]|$)/i.test(uri)) return `${what} can't use port 80 (listening there needs admin rights); pick another, e.g. ${example}: ${uri}`;
  if (!u.port) return `${what} needs an explicit port, e.g. ${example}: ${uri}`;
  if (u.port === "0") return `${what} needs a real port, not 0, e.g. ${example}: ${uri}`;
  return null;
}

const base64url = (b: Buffer) => b.toString("base64url");

/** A PKCE code verifier: 32 random bytes, base64url (43 characters). */
export function pkceVerifier(): string { return base64url(crypto.randomBytes(32)); }
/** The S256 code challenge for a verifier (RFC 7636 4.2). */
export function pkceChallenge(verifier: string): string { return base64url(crypto.createHash("sha256").update(verifier, "ascii").digest()); }

/** Same strings, compared in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

/** What the person reads when the tool sends the browser back with ?error=. */
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

/**
 * The small page the browser lands on. `back`: the dashboard's address, linked (hosted: the
 * sign-in opened in its own tab, which is closed if the browser lets a page do that).
 */
export function callbackPage(ok: boolean, message: string, back?: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = ok ? "Connected" : "Not connected";
  const tail = back
    ? `<p><a href="${esc(back)}">Go back to the dashboard</a>, or close this tab.</p>${ok ? "<script>setTimeout(function(){window.close()},1500)</script>" : ""}`
    : "<p>Go back to the dashboard.</p>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">`
    + `<h1 style="font-size:1.25rem">${title}</h1><p>${esc(message)}</p>${tail}</body></html>`;
}

/** Send the callback page as the answer to the browser's request. */
export function sendCallbackPage(res: http.ServerResponse, status: number, ok: boolean, message: string, back?: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Connection: "close" });
  res.end(callbackPage(ok, message, back));
}

const defaultListen: Listen = (server, port, host) => new Promise((resolve, reject) => {
  const onError = (e: Error) => reject(e);
  server.once("error", onError);
  server.listen(port, host, () => { server.off("error", onError); resolve(); });
});

/** Close a server and its connections; resolves once its port is let go (or it never had one). */
const closeServer = (s: http.Server) => new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });

/**
 * Turn the code into a connection and save it: the "Connected ..." message, or null when the
 * sign-in was dropped meanwhile (`current()` is false: a disconnect, a pasted key, a new
 * sign-in), in which case nothing may be saved. Throws when the tool turns it down.
 */
export type Exchange = (code: string, verifier: string | null, current: () => boolean) => Promise<string | null>;

export interface OAuthSignInOptions {
  /** Shown in messages ("Roam", "Atlassian"). */
  label: string;
  redirectUri: string;
  mode: SignInMode;
  listen?: Listen;
  /** Listen here instead of redirectUri's port (tests pass 0). */
  listenPort?: number;
  /** How long an unfinished sign-in waits (tests pass a few milliseconds). */
  pendingMs?: number;
}

interface Pending {
  state: string;
  verifier: string | null;
  exchange: Exchange;
  servers: http.Server[];
  expiry: NodeJS.Timeout;
  /** The listener being started, so a cancel can wait for its port to be let go. */
  started: Promise<boolean> | null;
  /** Set once a callback with the right state arrives (by the listener, a paste or the route), so it finishes once. */
  finishing: Promise<SignInStatus> | null;
}

export class OAuthSignIn {
  readonly redirectUri: string;
  readonly mode: SignInMode;
  private readonly label: string;
  private readonly listenFn: Listen;
  private readonly listenPort: number | undefined;
  private readonly pendingMs: number;
  private pending: Pending | null = null;
  /** Resolves once the last cancelled sign-in's listener has let its port go. */
  private released: Promise<unknown> = Promise.resolve();
  /** The last finished sign-in, until status() reports it. */
  private result: SignInStatus | null = null;

  constructor(opts: OAuthSignInOptions) {
    this.label = opts.label;
    this.redirectUri = opts.redirectUri;
    this.mode = opts.mode;
    this.listenFn = opts.listen || defaultListen;
    this.listenPort = opts.listenPort;
    this.pendingMs = opts.pendingMs ?? PENDING_MS;
  }

  /**
   * Start a sign-in (dropping an unfinished one). `authorizeUrl` builds the tool's page from
   * the state and, with `pkce`, the S256 challenge; `exchange` finishes it when the browser
   * comes back.
   */
  async start(authorizeUrl: (p: { state: string; challenge: string | null }) => string, exchange: Exchange, pkce: boolean): Promise<SignInStart> {
    this.cancel();
    this.result = null;
    const verifier = pkce ? pkceVerifier() : null;
    const state = base64url(crypto.randomBytes(32));
    // Once the code is being exchanged, let that finish and report rather than drop it.
    const p: Pending = { state, verifier, exchange, servers: [], started: null, finishing: null, expiry: setTimeout(() => { if (!p.finishing) this.cancelPending(p); }, this.pendingMs) };
    p.expiry.unref();
    this.pending = p;
    const url = authorizeUrl({ state, challenge: verifier ? pkceChallenge(verifier) : null });
    let listening = this.mode === "route";
    if (this.mode === "listen") {
      // A sign-in started just before this one may still hold the port: wait for it to let go.
      await this.released;
      if (this.pending === p) listening = await (p.started = this.startListener(p));
    }
    return { url, callback: this.redirectUri, listening };
  }

  status(): SignInStatus {
    if (this.pending) return { pending: true, done: false, ok: false, message: "Waiting for you to finish in the browser." };
    if (this.result) { const r = this.result; this.result = null; return r; }
    return { pending: false, done: false, ok: false, message: "No sign-in is waiting." };
  }

  isPending(): boolean { return !!this.pending; }

  /** Finish from the address the browser ended on (pasted into the page). */
  async finish(pasted: string): Promise<SignInStatus> {
    const p = this.pending;
    if (!p) {
      if (this.result) return this.status();
      return { pending: false, done: false, ok: false, message: "No sign-in is waiting. Start again." };
    }
    if (this.mode === "route") throw badRequest("This dashboard finishes sign-in by itself: start again and finish in the browser.");
    let target: URL;
    try { target = callbackTarget(pasted, this.redirectUri); } catch (e: any) { throw badRequest(e.message); }
    return this.complete(p, target);
  }

  /**
   * The browser arrived at a hosted dashboard's callback (mode "route"): finish the sign-in and
   * answer with the page it lands on. `back` is the dashboard's own address.
   */
  async callback(target: URL, res: http.ServerResponse, back: string): Promise<void> {
    const p = this.pending;
    if (this.mode !== "route" || !p) {
      // Already finished (a reload of this page, or a second tab): say how it went.
      if (this.result && this.mode === "route") return sendCallbackPage(res, this.result.ok ? 200 : 400, this.result.ok, this.result.message, back);
      return sendCallbackPage(res, 410, false, `This ${this.label} sign-in isn't waiting any more. Start again from the dashboard.`, back);
    }
    let done: Promise<SignInStatus>;
    try { done = this.complete(p, target); } catch (e: any) { return sendCallbackPage(res, 400, false, e.message, back); }
    try {
      const s = await done;
      sendCallbackPage(res, s.ok ? 200 : 400, s.ok, s.message, back);
    } catch (e: any) {
      sendCallbackPage(res, 500, false, String(e?.message || e), back);
    }
  }

  /** Drop a pending sign-in and close its listener. */
  cancel() {
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

  /** A callback with the right state (from the listener, a paste or the route): exchange the code, once. */
  private complete(p: Pending, target: URL): Promise<SignInStatus> {
    const state = target.searchParams.get("state") || "";
    if (!sameSecret(state, p.state)) throw badRequest("That address is from a different sign-in (its state doesn't match). Start again.");
    if (!p.finishing) p.finishing = this.finishPending(p, target);
    return p.finishing;
  }

  private async finishPending(p: Pending, target: URL): Promise<SignInStatus> {
    const error = target.searchParams.get("error");
    const code = target.searchParams.get("code");
    let status: SignInStatus;
    if (error || !code) {
      status = { pending: false, done: true, ok: false, message: signInErrorMessage(this.label, error || "no_code", target.searchParams.get("error_description")) };
    } else {
      try {
        const message = await p.exchange(code, p.verifier, () => this.pending === p);
        status = message
          ? { pending: false, done: true, ok: true, message }
          : { pending: false, done: true, ok: false, message: `${this.label} sign-in was cancelled.` };
      } catch (e: any) {
        status = { pending: false, done: true, ok: false, message: `${this.label} sign-in failed: ${e?.message || e}` };
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

  /** Listen on the redirect's port (127.0.0.1, and ::1 if it can). false = taken or not allowed: the page shows the paste box. */
  private async startListener(p: Pending): Promise<boolean> {
    const want = new URL(this.redirectUri);
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => this.onListenerRequest(p, want.pathname, req, res);
    const v4 = http.createServer(handler);
    try {
      await this.listenFn(v4, this.listenPort ?? Number(want.port), "127.0.0.1");
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
      await this.listenFn(v6, port, "::1");
      if (this.pending === p) p.servers.push(v6); else await closeServer(v6);
    } catch { await closeServer(v6); /* no IPv6 loopback, or the port's taken there: 127.0.0.1 will do */ }
    return this.pending === p;
  }

  private onListenerRequest(p: Pending, pathname: string, req: http.IncomingMessage, res: http.ServerResponse) {
    let target: URL;
    try { target = new URL(req.url || "/", "http://localhost"); } catch { sendCallbackPage(res, 400, false, "That isn't a sign-in address."); return; }
    if (req.method !== "GET" || target.pathname !== pathname) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    if (this.pending !== p && !p.finishing) { sendCallbackPage(res, 410, false, "This sign-in isn't waiting any more. Start again from the dashboard."); return; }
    let done: Promise<SignInStatus>;
    try { done = this.complete(p, target); } catch (e: any) { sendCallbackPage(res, 400, false, e.message); return; }
    done.then((s) => sendCallbackPage(res, s.ok ? 200 : 400, s.ok, s.message), (e) => sendCallbackPage(res, 500, false, String(e?.message || e)));
  }
}

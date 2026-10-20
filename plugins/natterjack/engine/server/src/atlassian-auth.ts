/**
 * Connect to Atlassian: a person signs in with their own Atlassian account (OAuth 2.0 3LO)
 * and the dashboard reads Jira and Confluence as them, with no API token to make and paste.
 * The token lands in <ledger>/atlassian-token.json (owner-only, written to a temp file and
 * renamed) and never reaches the browser. A pasted API token keeps working as before;
 * where both are there, the sign-in is used.
 *
 * workspace.json:
 *
 *   "atlassian": { "clientId": "<the team's OAuth 2.0 (3LO) app>",
 *                  "redirectUri": "http://localhost:31418/atlassian/callback",   (optional)
 *                  "scopes": ["read:jira-work", ...] }                            (optional)
 *
 * Unlike Roam, Atlassian has no public-client (PKCE) option: the code exchange and every
 * refresh send the app's client secret. It's never in a repository: ATLASSIAN_CLIENT_SECRET,
 * else <ledger>/atlassian-client-secret. The secret alone reads nothing: every person still
 * has to sign in and agree.
 *
 * The site is the one the workspace already names (workspace.json issues.site for Jira,
 * else the first Confluence source in docs.json). After sign-in, accessible-resources gives
 * its cloud id; every call goes through the API gateway (api.atlassian.com/ex/<product>/<cloudId>)
 * with the Bearer token, the only place an OAuth token is accepted.
 *
 * Access tokens last an hour: accessToken() refreshes one with under 5 minutes left, one
 * refresh at a time (Atlassian rotates the refresh token, and a refresh token unused for 90
 * days expires). withToken() runs a call and, on a 401, refreshes once and retries. 3LO has
 * no revoke endpoint: disconnecting forgets the token, and the person can remove the app
 * from their account at id.atlassian.com → Connected apps.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { AtlassianSignInStatus, AtlassianStatus } from "../../shared/api.ts";
import { removeKeyFile } from "./atlassian.ts";
import { readConfigFile, workspaceConfig } from "./config.ts";
import { OAuthSignIn, hostedCallbackUri, loopbackRedirectProblem, type Listen, type SignInStart, type SignInStatus } from "./oauth-signin.ts";

export const ATLASSIAN_AUTHORIZE = "https://auth.atlassian.com/authorize";
export const ATLASSIAN_TOKEN = "https://auth.atlassian.com/oauth/token";
export const ACCESSIBLE_RESOURCES = "https://api.atlassian.com/oauth/token/accessible-resources";
export const ATLASSIAN_ME = "https://api.atlassian.com/me";
/** Where a local sign-in comes back to, unless workspace.json says otherwise (Roam's is 31417). */
export const DEFAULT_ATLASSIAN_REDIRECT = "http://localhost:31418/atlassian/callback";
/** Where people remove the app from their own account. */
export const CONNECTED_APPS_URL = "https://id.atlassian.com/manage-profile/apps";
/** What the Issues page reads (search, issues, who you are). */
export const JIRA_SCOPES = ["read:jira-work", "read:jira-user"];
/** What the Docs page reads (search, spaces, pages, who you are). */
export const CONFLUENCE_SCOPES = ["read:confluence-content.all", "search:confluence", "read:confluence-space.summary", "read:confluence-user"];
/** Without it there's no refresh token, and the sign-in ends after an hour. */
export const OFFLINE_SCOPE = "offline_access";
export const SECRET_ENV = "ATLASSIAN_CLIENT_SECRET";
export const SECRET_FILE = "atlassian-client-secret";
/** Refresh an access token with less than this left (they last an hour). */
const REFRESH_MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;

/** The token file. expiresAt is epoch milliseconds. */
export interface AtlassianToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  /** The site it was granted for, and its cloud id (the gateway needs it). */
  site: string;
  cloudId: string;
  viewer: string | null;
  scopes: string[];
}

/** The workspace's Atlassian settings, with defaults filled in. */
export interface AtlassianConfig {
  /** The workspace reads Atlassian at all: a Jira tracker or a Confluence docs source. */
  used: boolean;
  /** acme.atlassian.net, from issues.site or the first Confluence source; null when there's neither. */
  site: string | null;
  clientId: string | null;
  redirectUri: string;
  scopes: string[];
  /** What's wrong with the sign-in settings (sign-in is off, API tokens still work), or null. */
  problem: string | null;
}

/** A failed Atlassian call: `status` is the HTTP status (0 when it wasn't reached), `code` the OAuth error when there is one. */
export class AtlassianError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/** The code for "there's no usable sign-in: connect again". */
export const NOT_CONNECTED = "not_connected";
const disconnected = (message: string) => new AtlassianError(401, NOT_CONNECTED, message);
const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

/** The subset of fetch this uses, so tests can stand in for Atlassian. */
export type AtlassianFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const hostOf = (s: unknown): string | null => {
  const raw = String(s ?? "").trim();
  if (!raw) return null;
  try {
    const h = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    return /^[\w.-]+$/.test(h) ? h : null;
  } catch { return null; }
};

/** The scopes sign-in asks for when workspace.json doesn't list them: what the configured pages read. */
export function defaultScopes(jira: boolean, confluence: boolean): string[] {
  return [...(jira ? JIRA_SCOPES : []), ...(confluence ? CONFLUENCE_SCOPES : []), OFFLINE_SCOPE];
}

/** workspace.json `atlassian`, with the site and the scopes worked out from issues and docs.json. */
export function atlassianConfig(dir?: string): AtlassianConfig {
  const raw = readConfigFile("workspace.json", dir).data?.atlassian;
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const issues = dir ? (readConfigFile("workspace.json", dir).data?.issues || {}) : workspaceConfig().issues;
  const sources = readConfigFile("docs.json", dir).data?.sources;
  const wikiSites = (Array.isArray(sources) ? sources : [])
    .filter((s: any) => s && s.kind === "external" && s.provider === "confluence")
    .map((s: any) => hostOf(s.url)).filter((h: string | null): h is string => !!h);
  const jiraSite = issues.kind === "jira" ? hostOf(issues.site) : null;
  const site = jiraSite || wikiSites[0] || null;
  const clientId = typeof a.clientId === "string" && a.clientId.trim() ? a.clientId.trim() : null;
  const redirectUri = typeof a.redirectUri === "string" && a.redirectUri.trim() ? a.redirectUri.trim() : DEFAULT_ATLASSIAN_REDIRECT;
  const listed = Array.isArray(a.scopes) ? a.scopes.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim()) : null;
  // offline_access is what makes it last: always asked for.
  const scopes = listed && listed.length ? [...new Set([...listed, OFFLINE_SCOPE])] : defaultScopes(!!jiraSite, !!site && wikiSites.includes(site));
  const problem = (a.clientId != null && typeof a.clientId !== "string" ? 'workspace.json: "atlassian.clientId" must be the OAuth app\'s client ID (a string), or left out.' : null)
    || (a.redirectUri != null && typeof a.redirectUri !== "string" ? 'workspace.json: "atlassian.redirectUri" must be a string.' : null)
    || (a.scopes != null && !Array.isArray(a.scopes) ? 'workspace.json: "atlassian.scopes" must be a list of scope names.' : null)
    || loopbackRedirectProblem(redirectUri, 'workspace.json: "atlassian.redirectUri"', DEFAULT_ATLASSIAN_REDIRECT);
  return { used: !!site, site, clientId, redirectUri, scopes, problem };
}

/**
 * The app's client secret: ATLASSIAN_CLIENT_SECRET, else <ledger>/atlassian-client-secret; null when
 * neither (or blank). The file holds the secret alone, or `ATLASSIAN_CLIENT_SECRET=<secret>`.
 */
export function clientSecret(ledgerDir: string): string | null {
  const env = String(process.env[SECRET_ENV] || "").trim();
  if (env) return env;
  let raw: string;
  try { raw = fs.readFileSync(path.join(ledgerDir, SECRET_FILE), "utf-8"); } catch { return null; }
  const line = raw.replace(/^﻿/, "").trim();
  const value = line.startsWith(`${SECRET_ENV}=`) ? line.slice(SECRET_ENV.length + 1) : line;
  return value.trim().replace(/^(["'])(.*)\1$/, "$2") || null;
}

export interface AtlassianAuthOptions {
  /** A hosted dashboard: never listen on a loopback port. */
  hosted: boolean;
  /** Hosted: the dashboard's own callback address (oauth-signin.ts hostedCallbackUri). Left out, a hosted sign-in is pasted back. */
  callbackUri?: string | null;
  fetcher?: AtlassianFetch;
  listen?: Listen;
  listenPort?: number;
  now?: () => number;
  pendingMs?: number;
}

export class AtlassianAuth {
  readonly file: string;
  readonly cfg: AtlassianConfig;
  private readonly ledgerDir: string;
  private readonly fetcher: AtlassianFetch;
  private readonly now: () => number;
  private readonly signIn: OAuthSignIn;
  private refreshing: Promise<AtlassianToken> | null = null;
  /** Bumped on every save or delete (as in roam-auth.ts); the refresh-token comparison is the real check. */
  private generation = 0;

  constructor(ledgerDir: string, cfg: AtlassianConfig, opts: AtlassianAuthOptions) {
    this.ledgerDir = ledgerDir;
    this.file = path.join(ledgerDir, "atlassian-token.json");
    this.cfg = cfg;
    this.fetcher = opts.fetcher || (fetch as unknown as AtlassianFetch);
    this.now = opts.now || Date.now;
    const routed = opts.hosted && !!opts.callbackUri;
    this.signIn = new OAuthSignIn({
      label: "Atlassian",
      redirectUri: routed ? opts.callbackUri! : cfg.redirectUri,
      mode: routed ? "route" : opts.hosted ? "paste" : "listen",
      listen: opts.listen, listenPort: opts.listenPort, pendingMs: opts.pendingMs,
    });
  }

  // ---- the token file

  /** The stored token, or null (none, or unreadable). */
  read(): AtlassianToken | null {
    let t: any;
    try { t = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return null; }
    if (!t || typeof t.accessToken !== "string" || !t.accessToken || typeof t.site !== "string" || typeof t.cloudId !== "string" || !t.cloudId) return null;
    return {
      accessToken: t.accessToken,
      refreshToken: typeof t.refreshToken === "string" && t.refreshToken ? t.refreshToken : null,
      expiresAt: typeof t.expiresAt === "number" ? t.expiresAt : null,
      site: t.site, cloudId: t.cloudId,
      viewer: typeof t.viewer === "string" ? t.viewer : null,
      scopes: Array.isArray(t.scopes) ? t.scopes.filter((s: unknown) => typeof s === "string") : [],
    };
  }

  /** The stored sign-in, only if it's for the site the workspace uses now (one for another site is no use here). */
  current(): AtlassianToken | null {
    const t = this.read();
    return t && this.cfg.site && t.site === this.cfg.site ? t : null;
  }

  /** Signed in for this workspace's site. */
  connected(): boolean { return !!this.current(); }

  private save(t: AtlassianToken) {
    this.generation++;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n", { mode: 0o600 });
    try { fs.renameSync(tmp, this.file); } catch { fs.copyFileSync(tmp, this.file); fs.unlinkSync(tmp); }
  }

  /** Delete the token file. Already gone is fine; any other failure is thrown, never passed off as forgotten. */
  private forget() {
    this.generation++;
    removeKeyFile(this.file);
  }

  /** What the page sees: whether sign-in is offered, and who's signed in (never the token). main.ts adds `jira`. */
  status(): Omit<AtlassianStatus, "jira"> {
    const t = this.current();
    const secret = !!clientSecret(this.ledgerDir);
    const problem = this.cfg.problem
      || (!this.cfg.used ? null : !this.cfg.clientId ? null
        : !secret ? `The Atlassian app's client secret isn't set on this dashboard (${SECRET_ENV}, or .claude/ledger/${SECRET_FILE}).` : null);
    return {
      used: this.cfg.used, site: this.cfg.site,
      signIn: this.cfg.used && !!this.cfg.clientId && !problem,
      signInProblem: problem,
      connected: !!t, viewer: t?.viewer ?? null,
    };
  }

  // ---- using the token

  /** A current access token and its cloud id, refreshed first when it has under 5 minutes left. */
  async accessToken(): Promise<{ token: string; cloudId: string }> {
    const t = this.current();
    if (!t) throw disconnected("Atlassian isn't connected.");
    if (t.expiresAt !== null && t.expiresAt - this.now() < REFRESH_MARGIN_MS) {
      try {
        const n = await this.refresh();
        return { token: n.accessToken, cloudId: n.cloudId };
      } catch (e) {
        // The token endpoint down: the old token still has a few minutes, so use it.
        if (e instanceof AtlassianError && e.code === NOT_CONNECTED) throw e;
        if (t.expiresAt > this.now()) return { token: t.accessToken, cloudId: t.cloudId };
        throw e;
      }
    }
    return { token: t.accessToken, cloudId: t.cloudId };
  }

  /**
   * Run one call with the token. A 401 (status on the thrown error): refresh once and retry,
   * unless another token was stored meanwhile, which is used instead. A second 401 is passed
   * on as it is: Atlassian also answers 401 for a scope the app wasn't granted, and that
   * mustn't throw a working sign-in away.
   */
  async withToken<T>(fn: (token: string, cloudId: string) => Promise<T>): Promise<T> {
    const first = await this.accessToken();
    try {
      return await fn(first.token, first.cloudId);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) throw e;
      const t = this.current();
      if (!t) throw disconnected("Atlassian isn't connected.");
      const next = t.accessToken !== first.token ? t : await this.refresh();
      return fn(next.accessToken, next.cloudId);
    }
  }

  /** Refresh: one at a time; the rotated refresh token is saved before this resolves. */
  refresh(): Promise<AtlassianToken> {
    if (!this.refreshing) this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<AtlassianToken> {
    const t = this.current();
    if (!t) throw disconnected("Atlassian isn't connected.");
    const secret = clientSecret(this.ledgerDir);
    if (!t.refreshToken || !this.cfg.clientId || !secret) {
      // Can't refresh at all (no offline_access, or the app's settings are gone): it ends with the access token.
      if (t.expiresAt !== null && t.expiresAt > this.now()) return t;
      this.forget();
      throw disconnected("Atlassian sign-in expired, connect again.");
    }
    const gen = this.generation;
    let body: any;
    try {
      body = await this.tokenRequest({ grant_type: "refresh_token", client_id: this.cfg.clientId, client_secret: secret, refresh_token: t.refreshToken });
    } catch (e) {
      // Atlassian turned the refresh token down (expired after 90 days unused, already rotated, the app's access
      // removed): it's no use any more. Unreachable or a 5xx: keep it and try later.
      if (e instanceof AtlassianError && (e.status === 400 || e.status === 401 || e.status === 403 || e.code === "invalid_grant")) {
        // Another dashboard on this ledger may have just rotated it (so ours was spent): use theirs.
        const now = this.read();
        if (now && now.refreshToken !== t.refreshToken) return now;
        this.forget();
        throw disconnected(`Atlassian sign-in expired, connect again${e.code === "invalid_grant" ? "" : ` (Atlassian said ${e.code})`}.`);
      }
      throw e;
    }
    const next: AtlassianToken = {
      ...t,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : t.refreshToken,
      expiresAt: this.expiresAt(body),
      scopes: typeof body.scope === "string" && body.scope.trim() ? body.scope.trim().split(/\s+/) : t.scopes,
    };
    // Disconnected or connected anew while this was in flight: don't bring the old grant back (as in roam-auth.ts).
    const stored = this.read();
    if (this.generation !== gen || !stored || stored.refreshToken !== t.refreshToken) {
      if (stored) return stored;
      throw disconnected("Atlassian isn't connected.");
    }
    this.save(next);
    return next;
  }

  private expiresAt(body: any): number | null {
    const s = Number(body?.expires_in);
    return Number.isFinite(s) && s > 0 ? this.now() + s * 1000 : null;
  }

  /** POST to the token endpoint (JSON, with the client secret). */
  private async tokenRequest(params: Record<string, string>): Promise<any> {
    const data = await this.call(ATLASSIAN_TOKEN, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(params) }, "turned the sign-in down");
    if (!data || typeof data.access_token !== "string" || !data.access_token) throw new AtlassianError(502, "bad_response", "Atlassian sent no access token.");
    return data;
  }

  /** One request to Atlassian: the parsed JSON, or an AtlassianError with the status and OAuth error code. */
  private async call(url: string, init: { method: string; headers: Record<string, string>; body?: string }, failed: string): Promise<any> {
    let res: Awaited<ReturnType<AtlassianFetch>>;
    try {
      res = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e: any) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw new AtlassianError(0, "unreachable", timedOut ? `Atlassian didn't answer within ${TIMEOUT_MS / 1000} seconds.` : `Couldn't reach Atlassian: ${e?.message || e}`);
    }
    let data: any = null;
    try { data = JSON.parse(await res.text()); } catch {}
    if (!res.ok) {
      const code = typeof data?.error === "string" ? data.error : `http_${res.status}`;
      const desc = typeof data?.error_description === "string" ? `: ${data.error_description}` : typeof data?.message === "string" ? `: ${data.message}` : "";
      throw new AtlassianError(res.status, code, `Atlassian ${failed} (${code}${desc}).`);
    }
    return data;
  }

  // ---- disconnect

  /** Forget the sign-in. 3LO can't be revoked from here: the note says where the person removes the app themselves. */
  disconnect(): { note?: string } {
    this.signInCancel();
    const had = !!this.read();
    this.forget();
    return had ? { note: `The dashboard has forgotten your Atlassian sign-in. To remove its access from your Atlassian account as well, open ${CONNECTED_APPS_URL}.` } : {};
  }

  // ---- browser sign-in

  /** Start a sign-in (dropping an unfinished one): the page to open, and whether this dashboard catches the redirect. */
  async signInStart(): Promise<SignInStart> {
    const st = this.status();
    if (!this.cfg.used || !this.cfg.site) throw badRequest("This workspace doesn't read Atlassian (no Jira site in workspace.json and no Confluence source in docs.json).");
    if (!this.cfg.clientId) throw badRequest('Atlassian sign-in isn\'t set up (workspace.json has no "atlassian.clientId"). Paste an API token instead.');
    if (st.signInProblem) throw badRequest(`Atlassian sign-in is off: ${st.signInProblem}`);
    const clientId = this.cfg.clientId;
    const redirectUri = this.signIn.redirectUri;
    const scope = this.cfg.scopes.join(" ");
    const authorizeUrl = ({ state }: { state: string }) => `${ATLASSIAN_AUTHORIZE}?${new URLSearchParams({
      audience: "api.atlassian.com", client_id: clientId, scope, redirect_uri: redirectUri, state, response_type: "code", prompt: "consent",
    }).toString().replace(/\+/g, "%20")}`;
    return this.signIn.start(authorizeUrl, (code, _v, current) => this.exchange(code, current), false);
  }

  signInStatus(): AtlassianSignInStatus { return this.signIn.status(); }

  /** Finish from the address the browser ended on (pasted into the page). */
  signInFinish(pasted: string): Promise<SignInStatus> { return this.signIn.finish(pasted); }

  /** The browser arrived at a hosted dashboard's callback: finish and answer with the page it lands on. */
  signInCallback(target: URL, res: http.ServerResponse, back: string): Promise<void> { return this.signIn.callback(target, res, back); }

  signInCancel() { this.signIn.cancel(); }

  /** The port the sign-in listener is on (127.0.0.1), or null. */
  listenerPort(): number | null { return this.signIn.listenerPort(); }

  /**
   * authorization_code → tokens; accessible-resources → the cloud id of this workspace's site
   * (the person may have picked another site on Atlassian's page); then who they are, best effort.
   * null when the sign-in was dropped meanwhile: nothing is saved then.
   */
  private async exchange(code: string, current: () => boolean): Promise<string | null> {
    const secret = clientSecret(this.ledgerDir);
    if (!secret) throw new Error(`the app's client secret isn't set (${SECRET_ENV}).`);
    const body = await this.tokenRequest({ grant_type: "authorization_code", client_id: this.cfg.clientId!, client_secret: secret, code, redirect_uri: this.signIn.redirectUri });
    const bearer = { Authorization: `Bearer ${body.access_token}`, Accept: "application/json" };
    const resources = await this.call(ACCESSIBLE_RESOURCES, { method: "GET", headers: bearer }, "wouldn't list your sites");
    const site = this.cfg.site!;
    const match = (Array.isArray(resources) ? resources : []).find((r: any) => r && typeof r.id === "string" && hostOf(r.url) === site);
    if (!match) throw new Error(`your sign-in doesn't include ${site}. Start again and choose ${site} when Atlassian asks which site to use.`);
    const t: AtlassianToken = {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
      expiresAt: this.expiresAt(body),
      site, cloudId: match.id, viewer: null,
      scopes: typeof body.scope === "string" && body.scope.trim() ? body.scope.trim().split(/\s+/) : [],
    };
    t.viewer = await this.whoIs(t, bearer);
    if (!current()) return null;
    this.save(t);
    return `Connected to Atlassian${t.viewer ? ` as ${t.viewer}` : ""} (${site}).`;
  }

  /** The person's name: /me needs read:me, which the app may not have, so Jira's or Confluence's own "me" next. */
  private async whoIs(t: AtlassianToken, headers: Record<string, string>): Promise<string | null> {
    const tries = [
      ATLASSIAN_ME,
      t.scopes.includes("read:jira-user") ? `https://api.atlassian.com/ex/jira/${t.cloudId}/rest/api/3/myself` : null,
      t.scopes.includes("read:confluence-user") ? `https://api.atlassian.com/ex/confluence/${t.cloudId}/wiki/rest/api/user/current` : null,
    ].filter((u): u is string => !!u);
    for (const url of tries) {
      try {
        const me = await this.call(url, { method: "GET", headers }, "wouldn't say who you are");
        const name = me?.name || me?.displayName || me?.publicName || me?.email || me?.emailAddress;
        if (typeof name === "string" && name) return name;
      } catch { /* try the next */ }
    }
    return null;
  }
}

/**
 * The workspace's Atlassian sign-in. Re-reads workspace.json and docs.json each call and keeps
 * one AtlassianAuth per settings, so edits apply without a restart.
 */
export class Atlassian {
  private readonly ledgerDir: string;
  private readonly opts: AtlassianAuthOptions;
  private readonly dir: string | undefined;
  private current: { sig: string; auth: AtlassianAuth } | null = null;

  constructor(ledgerDir: string, opts: Omit<AtlassianAuthOptions, "callbackUri"> & { publicOrigin?: string | null }, dir?: string) {
    this.ledgerDir = ledgerDir;
    this.dir = dir;
    const { publicOrigin, ...rest } = opts;
    this.opts = { ...rest, callbackUri: opts.hosted && publicOrigin ? hostedCallbackUri(publicOrigin, "atlassian") : null };
  }

  get(): AtlassianAuth {
    const cfg = atlassianConfig(this.dir);
    const sig = JSON.stringify(cfg);
    if (this.current && this.current.sig === sig) return this.current.auth;
    // A settings change replaces it: drop the old one's pending sign-in (and its listener).
    this.current?.auth.signInCancel();
    const auth = new AtlassianAuth(this.ledgerDir, cfg, this.opts);
    this.current = { sig, auth };
    return auth;
  }
}

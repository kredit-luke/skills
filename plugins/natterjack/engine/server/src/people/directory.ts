/**
 * Who could have a hosted dashboard: everyone in the company's domain, or one part of it
 * (a Google OU, an Entra department or administrative unit). Neither gcloud nor az lists
 * directory users well, so each borrows a token from the engineer's own CLI sign-in and
 * calls the directory API itself: Google's Admin SDK, or Microsoft Graph.
 */

import type { DirectoryConfig } from "./config.ts";
import { cliError, notInstalled, runReading, type Runner } from "./cli.ts";

export interface DirectoryPerson { email: string; name: string; active: boolean }
export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export const GOOGLE_SCOPES = "https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/cloud-platform";
/** Google blocks the directory scope for gcloud's own OAuth client, so it signs in with the team's internal one (hosting.md). */
export const GOOGLE_LOGIN = `gcloud auth application-default login --client-id-file=<your OAuth client JSON> --scopes="${GOOGLE_SCOPES}"`;
const MAX_PAGES = 100;

/**
 * Directory tokens, kept per runner: gcloud takes seconds to start and fetches a new token
 * each time, and its tokens (and az's) last an hour. Kept for less than that, and dropped
 * when the directory refuses one (signed out, or signed in again with other scopes).
 */
const TOKEN_TTL = 45 * 60_000;
const tokens = new WeakMap<Runner, Map<string, { token: string; at: number }>>();

async function cachedToken(run: Runner, kind: string, get: () => Promise<string>): Promise<string> {
  let mine = tokens.get(run);
  if (!mine) tokens.set(run, (mine = new Map()));
  const hit = mine.get(kind);
  if (hit && Date.now() - hit.at < TOKEN_TTL) return hit.token;
  const token = await get();
  mine.set(kind, { token, at: Date.now() });
  return token;
}
const forgetToken = (run: Runner, kind: string) => tokens.get(run)?.delete(kind);

/** Run `list` with a kept token; if the directory says it's no good (401), once more with a new one. */
async function withToken<T>(run: Runner, kind: string, get: () => Promise<string>, list: (token: string) => Promise<T>): Promise<T> {
  const kept = tokens.get(run)?.has(kind);
  try { return await list(await cachedToken(run, kind, get)); }
  catch (e) {
    if (!e?.staleToken) throw e;
    forgetToken(run, kind);
    if (kept) return list(await cachedToken(run, kind, get));
    throw e;
  }
}

export interface Directory { label: string; list(): Promise<DirectoryPerson[]> }

export function makeDirectory(cfg: DirectoryConfig, run: Runner, fetcher: Fetcher = fetch as unknown as Fetcher): Directory {
  if (cfg.type === "google") return new GoogleDirectory(cfg, run, fetcher);
  if (cfg.type === "entra") return new EntraDirectory(cfg, run, fetcher);
  return { label: "Added by hand", list: async () => [] };
}

const fail = (message: string, fix?: string) => Object.assign(new Error(message), { status: 502, fix });

class GoogleDirectory implements Directory {
  label: string;
  private readonly cfg: DirectoryConfig;
  private readonly run: Runner;
  private readonly fetcher: Fetcher;
  constructor(cfg: DirectoryConfig, run: Runner, fetcher: Fetcher) {
    this.cfg = cfg; this.run = run; this.fetcher = fetcher;
    this.label = `Google Workspace: ${cfg.domain}${cfg.orgUnit ? ` ${cfg.orgUnit}` : ""}`;
  }

  list(): Promise<DirectoryPerson[]> { return withToken(this.run, "google", () => this.token(), (token) => this.listWith(token)); }

  private async token(): Promise<string> {
    const r = await runReading(this.run, "gcloud", ["auth", "application-default", "print-access-token"], { timeout: 30_000 });
    if (notInstalled(r)) throw fail("The Google Cloud CLI (gcloud) isn't installed.", "Install it from https://cloud.google.com/sdk/docs/install, then sign in");
    if (!r.ok) throw cliError("gcloud couldn't give a directory token", r, `run: ${GOOGLE_LOGIN}`);
    return r.stdout.trim();
  }

  private async listWith(token: string): Promise<DirectoryPerson[]> {
    const out: DirectoryPerson[] = [];
    let page = "";
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = new URLSearchParams({ domain: this.cfg.domain!, maxResults: "500", projection: "basic", fields: "nextPageToken,users(primaryEmail,name/fullName,suspended,archived)" });
      if (this.cfg.orgUnit) q.set("query", `orgUnitPath='${this.cfg.orgUnit.replace(/'/g, "\\'")}'`);
      if (page) q.set("pageToken", page);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (this.cfg.project) headers["x-goog-user-project"] = this.cfg.project;
      const res = await this.fetcher(`https://admin.googleapis.com/admin/directory/v1/users?${q}`, { headers });
      if (!res.ok) throw await googleError(res);
      const body = await res.json();
      for (const u of body.users || []) {
        if (!u.primaryEmail) continue;
        out.push({ email: String(u.primaryEmail).toLowerCase(), name: u.name?.fullName || u.primaryEmail, active: !u.suspended && !u.archived });
      }
      page = body.nextPageToken || "";
      if (!page) break;
    }
    return out;
  }
}

async function googleError(res: { status: number; text(): Promise<string> }) {
  const text = await res.text().catch(() => "");
  let msg = text;
  try { msg = JSON.parse(text).error?.message || text; } catch {}
  if (res.status === 401 || /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) {
    return Object.assign(fail("Your gcloud sign-in can't read the Workspace directory.", `run: ${GOOGLE_LOGIN}`), { staleToken: true });
  }
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(text)) {
    return fail(`The Admin SDK API isn't enabled for your gcloud project: ${msg.slice(0, 200)}`, 'enable "Admin SDK API" in that project, or set "directory.project" in hosting.json to one where it is');
  }
  if (res.status === 403) return fail(`Google refused to list users: ${msg.slice(0, 200)}`, "you need a Workspace admin role that can read users (a custom role with Users → Read is enough)");
  return fail(`Google's directory answered ${res.status}: ${msg.slice(0, 200)}`);
}

class EntraDirectory implements Directory {
  label: string;
  private readonly cfg: DirectoryConfig;
  private readonly run: Runner;
  private readonly fetcher: Fetcher;
  constructor(cfg: DirectoryConfig, run: Runner, fetcher: Fetcher) {
    this.cfg = cfg; this.run = run; this.fetcher = fetcher;
    const part = cfg.department ? ` ${cfg.department}` : cfg.adminUnit ? " (administrative unit)" : "";
    this.label = `Microsoft Entra ID: ${cfg.domain}${part}`;
  }

  list(): Promise<DirectoryPerson[]> { return withToken(this.run, "graph", () => this.token(), (token) => this.listWith(token)); }

  private async token(): Promise<string> {
    const r = await runReading(this.run, "az", ["account", "get-access-token", "--resource-type", "ms-graph", "--query", "accessToken", "-o", "tsv"], { timeout: 30_000 });
    if (notInstalled(r)) throw fail("The Azure CLI (az) isn't installed.", "install it, then run: az login");
    if (!r.ok) throw cliError("az couldn't give a Microsoft Graph token", r, "run: az login");
    return r.stdout.trim();
  }

  private async listWith(token: string): Promise<DirectoryPerson[]> {
    const select = "$select=mail,userPrincipalName,displayName,accountEnabled,department&$top=999";
    let url: string | null = this.cfg.adminUnit
      ? `https://graph.microsoft.com/v1.0/directory/administrativeUnits/${encodeURIComponent(this.cfg.adminUnit)}/members/microsoft.graph.user?${select}`
      : `https://graph.microsoft.com/v1.0/users?${select}`;
    const out: DirectoryPerson[] = [];
    const suffix = `@${this.cfg.domain}`;
    const dept = this.cfg.department?.toLowerCase();
    for (let i = 0; url && i < MAX_PAGES; i++) {
      const res = await this.fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 401) throw Object.assign(fail("Your az sign-in has expired.", "run: az login"), { staleToken: true });
        if (res.status === 403) throw fail("Microsoft Graph refused to list users.", "your account needs to be able to read the directory (members can by default; guests can't)");
        throw fail(`Microsoft Graph answered ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = await res.json();
      for (const u of body.value || []) {
        const email = String(u.mail || u.userPrincipalName || "").toLowerCase();
        if (!email.endsWith(suffix) || email.includes("#ext#")) continue;
        if (dept && String(u.department || "").toLowerCase() !== dept) continue;
        out.push({ email, name: u.displayName || email, active: u.accountEnabled !== false });
      }
      url = body["@odata.nextLink"] || null;
    }
    return out;
  }
}

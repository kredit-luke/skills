/**
 * The People page's Google Workspace sign-in, done from the Machine page. Google blocks the
 * directory scope for gcloud's own OAuth client, so a team makes an internal Desktop app
 * client once (hosting.md, "Setting it up") and every engineer who manages people signs in
 * with it:
 *
 *   gcloud auth application-default login --client-id-file=<the client JSON> --scopes=<directory,cloud-platform>
 *
 * The Machine page takes the client file once and keeps it in the ledger (never committed;
 * snapshots are `git archive`, so it never reaches a hosted dashboard either). Then its
 * Sign in button opens a terminal running that command, built here: nobody types the path or
 * the scopes, and on Windows nobody hits cmd.exe splitting the scopes at the comma.
 *
 * The check asks gcloud for a token and Google which scopes it has, so it says "ok" only when
 * the sign-in can really read the directory, whichever way it was made.
 */

import fs from "node:fs";
import path from "node:path";
import { GOOGLE_SCOPES } from "./directory.ts";

export const CLIENT_FILE_NAME = "google-oauth-client.json";
const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";

export interface GoogleClient { clientId: string; projectId: string | null }
type OsKey = "win" | "mac" | "linux";
type Probe = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ ok: boolean; out: string; err: string }>;
export type TokenInfoFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json(): Promise<any> }>;

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

export function clientFile(ledgerDir: string): string { return path.join(ledgerDir, CLIENT_FILE_NAME); }

/** A Desktop app client's JSON ({ "installed": { client_id, client_secret, ... } }), checked. */
export function parseClient(text: string): GoogleClient {
  let d: any;
  try { d = JSON.parse(text); } catch { throw bad("That isn't a JSON file. Download the client's JSON from Google Auth Platform → Clients."); }
  if (d?.web) throw bad("That's a Web application client. Create a Desktop app client (Google Auth Platform → Clients → Create client → Desktop app) and use its JSON.");
  const c = d?.installed;
  if (!c || typeof c.client_id !== "string" || !c.client_id.endsWith(".apps.googleusercontent.com") || typeof c.client_secret !== "string" || !c.client_secret) {
    throw bad('That isn\'t a Google OAuth client file: it needs an "installed" client with a client_id and client_secret (a Desktop app client\'s JSON).');
  }
  return { clientId: c.client_id, projectId: typeof c.project_id === "string" && c.project_id ? c.project_id : null };
}

export function readClient(ledgerDir: string): GoogleClient | null {
  try { return parseClient(fs.readFileSync(clientFile(ledgerDir), "utf-8")); } catch { return null; }
}

/** Keep the uploaded client file in the ledger, readable only by this user. */
export function saveClient(ledgerDir: string, text: string): GoogleClient {
  const client = parseClient(text);
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(clientFile(ledgerDir), text, { mode: 0o600 });
  return client;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The sign-in, for the terminal the Machine page opens (PowerShell on Windows, a shell elsewhere).
 * On Windows gcloud is gcloud.cmd, which PowerShell runs through cmd.exe, and cmd.exe splits an
 * argument at its commas once PowerShell has dropped the quotes: so cmd gets the whole line.
 */
export function loginCommand(file: string, osKey: OsKey): string {
  if (osKey === "win") {
    const line = `gcloud auth application-default login --client-id-file="${file}" --scopes="${GOOGLE_SCOPES}"`;
    return `cmd /c '${line.replace(/'/g, "''")}'`;
  }
  return `gcloud auth application-default login --client-id-file=${shQuote(file)} --scopes=${shQuote(GOOGLE_SCOPES)}`;
}

/** The scopes Google says a token has; null when it couldn't be asked (offline, or Google said no). */
export async function tokenScopes(token: string, fetcher: TokenInfoFetch): Promise<string[] | null> {
  try {
    // POSTed, so the token isn't in a URL anything might log.
    const res = await fetcher(TOKENINFO, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: token }).toString() });
    if (!res.ok) return null;
    const body = await res.json();
    return String(body?.scope || "").split(/\s+/).filter(Boolean);
  } catch { return null; }
}

const GCLOUD_INSTALL: Record<OsKey, string | null> = {
  win: "winget install --id Google.CloudSDK -e",
  mac: "brew install --cask google-cloud-sdk",
  linux: null,
};

/** A Machine page check (machine.ts), the fields this one sets. */
export interface GoogleDirectoryCheck {
  id: string; kind: string; group: string; label: string; apps: string[];
  status: "ok" | "warn"; detail: string; version?: string | null; fix?: string;
  install?: { label: string; cmd: string; cwd: string | null };
  upload?: "google-client";
}

/**
 * The Machine page's "Google Workspace directory" check, for a hosting.json whose directory is
 * Google. `upload` tells the page to offer the client file picker.
 */
export async function googleDirectoryCheck(o: { probe: Probe; ledgerDir: string; osKey: OsKey; project: string | null; fetcher?: TokenInfoFetch }): Promise<GoogleDirectoryCheck> {
  const base = { id: "google-directory", kind: "google-directory", group: "People page", label: "Google Workspace directory", apps: [] as string[], upload: "google-client" as const };
  const gcloud = await o.probe("gcloud", ["--version"]);
  if (!gcloud.ok) {
    const cmd = GCLOUD_INSTALL[o.osKey];
    return {
      ...base, status: "warn", upload: undefined,
      detail: "The People page reads your Google Workspace directory through the Google Cloud CLI (gcloud), which isn't installed.",
      ...(cmd ? { install: { label: "Install", cmd, cwd: null } } : {}),
      fix: cmd || "See https://cloud.google.com/sdk/docs/install",
    };
  }
  const version = (/(\d+\.\d+\.\d+)/.exec(gcloud.out) || [])[1] || null;

  const tok = await o.probe("gcloud", ["auth", "application-default", "print-access-token"], { timeout: 30_000 });
  let wrongScope = false;
  if (tok.ok && tok.out.trim()) {
    const scopes = await tokenScopes(tok.out.trim().split(/\r?\n/).pop()!.trim(), o.fetcher || (fetch as unknown as TokenInfoFetch));
    if (scopes?.includes(DIRECTORY_SCOPE)) return { ...base, version, status: "ok", detail: "Signed in: the People page can read the directory." };
    if (!scopes) return { ...base, version, status: "warn", detail: "gcloud is signed in, but Google didn't say what the sign-in can read (offline?). Re-check when you're online." };
    wrongScope = true;
  }

  const client = readClient(o.ledgerDir);
  const why = wrongScope
    ? "Your gcloud application-default sign-in can't read the directory (it was made without the directory scope)."
    : "Not signed in for the directory yet.";
  if (!client) {
    return {
      ...base, version, status: "warn",
      detail: `${why} Choose your team's Google OAuth client file once (a Desktop app client's JSON; hosting.md, "Setting it up", says how to make one), then sign in.`,
    };
  }
  const elsewhere = client.projectId && o.project && client.projectId !== o.project
    ? ` This client is from project ${client.projectId}; hosting.json bills the directory to ${o.project}.`
    : "";
  return {
    ...base, version, status: "warn",
    detail: `${why} Sign in opens a terminal and then your browser: sign in with your Workspace account, then Re-check.${elsewhere}`,
    install: { label: "Sign in", cmd: loginCommand(clientFile(o.ledgerDir), o.osKey), cwd: null },
  };
}

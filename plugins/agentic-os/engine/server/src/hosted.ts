/**
 * Hosted mode: the dashboard running in one person's container on the company's own
 * infrastructure, behind a login proxy, instead of on that person's machine. It's for
 * people without a dev machine; everyone else keeps running it locally.
 *
 * Set by the deployment's environment, never by workspace.json, because the same
 * workspace is still run locally by the people who have a machine for it:
 *
 *   DASHBOARD_HOSTED=1
 *   DASHBOARD_PUBLIC_URL=https://dashboard.example.com   the address people open
 *   DASHBOARD_PROXY_SECRET=<32+ chars>                   the proxy sends it on every request
 *   DASHBOARD_OWNER=person@example.com                   optional: the one person this container serves
 *   DASHBOARD_IDENTITY_HEADER=x-forwarded-email          optional: where the proxy puts the signed-in email
 *   DASHBOARD_BIND=0.0.0.0                               optional: the address to listen on
 *
 * Nothing here is tied to a cloud. All it assumes is a reverse proxy in front that signs
 * people in (oauth2-proxy with Google, Entra ID, Okta, Cognito, Keycloak...; or a cloud's
 * identity-aware proxy) and forwards to this container with the secret and the email.
 * The secret is what makes the email header trustworthy: without it, anything that can
 * reach the container could claim to be anyone.
 */

import crypto from "node:crypto";

export interface HostedConfig {
  bind: string;
  /** "https://dashboard.example.com": the only Origin a browser request may carry. */
  publicOrigin: string;
  /** Host headers accepted: the public one, plus DASHBOARD_ALLOWED_HOSTS for a proxy that rewrites Host. */
  hosts: Set<string>;
  identityHeader: string;
  proxySecret: string;
  /** Lowercased email, or null when the router alone decides who reaches this container. */
  owner: string | null;
}

export const SECRET_HEADER = "x-dashboard-proxy-secret";
const MIN_SECRET = 32;

/** The hosted settings from the environment; null when not hosted. Throws on a setup that would be unsafe. */
export function hostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig | null {
  if (!/^(1|true|yes)$/i.test(String(env.DASHBOARD_HOSTED || "").trim())) return null;
  const problems: string[] = [];
  let url: URL | null = null;
  try { url = new URL(String(env.DASHBOARD_PUBLIC_URL || "")); } catch {}
  if (!url || !/^https?:$/.test(url.protocol)) problems.push("DASHBOARD_PUBLIC_URL must be the address people open, e.g. https://dashboard.example.com");
  const proxySecret = String(env.DASHBOARD_PROXY_SECRET || "");
  if (proxySecret.length < MIN_SECRET) problems.push(`DASHBOARD_PROXY_SECRET must be at least ${MIN_SECRET} characters (the login proxy sends it as ${SECRET_HEADER})`);
  if (problems.length) throw new Error(`Hosted mode (DASHBOARD_HOSTED) isn't set up:\n  - ${problems.join("\n  - ")}`);
  const extra = String(env.DASHBOARD_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return {
    bind: String(env.DASHBOARD_BIND || "").trim() || "0.0.0.0",
    publicOrigin: url!.origin,
    hosts: new Set([url!.host.toLowerCase(), ...extra]),
    identityHeader: (String(env.DASHBOARD_IDENTITY_HEADER || "").trim() || "x-forwarded-email").toLowerCase(),
    proxySecret,
    owner: String(env.DASHBOARD_OWNER || "").trim().toLowerCase() || null,
  };
}

export type HostedVerdict = { ok: true; user: string } | { ok: false; status: number; message: string };

const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v || "").trim();
};

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * May this request in? Replaces the local mode's loopback-only Host and Origin checks:
 * the proxy secret first (so nothing about the request is believed without it), then
 * Host, Origin, the signed-in email, and that it's this container's owner.
 */
export function checkHostedRequest(cfg: HostedConfig, headers: Record<string, string | string[] | undefined>): HostedVerdict {
  if (!sameSecret(header(headers, SECRET_HEADER), cfg.proxySecret)) {
    return { ok: false, status: 401, message: "Open the dashboard through its sign-in address." };
  }
  if (!cfg.hosts.has(header(headers, "host").toLowerCase())) return { ok: false, status: 421, message: "Misdirected request" };
  const origin = header(headers, "origin");
  if (origin && origin !== cfg.publicOrigin) return { ok: false, status: 403, message: "Cross-origin request refused" };
  const user = header(headers, cfg.identityHeader).toLowerCase();
  if (!user) return { ok: false, status: 401, message: "The sign-in proxy didn't say who you are." };
  if (cfg.owner && user !== cfg.owner) return { ok: false, status: 403, message: "This dashboard belongs to someone else. Sign out and sign in as yourself." };
  return { ok: true, user };
}

/** Pages that need the person's own machine: starting apps, and worktrees. */
export const HOSTED_HIDDEN_PAGES = ["apps", "workspaces"];

/** The error for a feature that opens something on the server's own screen or ports. */
export const NOT_HOSTED = "That isn't available in the hosted dashboard: it needs the dashboard running on your own computer.";

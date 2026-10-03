/**
 * The router's settings, from its environment (references/hosting.md, "One address for
 * everyone"). The router sits behind the company's login proxy at the one address
 * everyone opens, and sends each signed-in person to their own dashboard container.
 *
 *   ROUTER_PUBLIC_URL=https://dashboard.example.com    the address people open
 *   ROUTER_PROXY_SECRET=<32+ chars>                    the login proxy sends it to the router
 *   ROUTER_BACKEND_SECRET=<32+ chars>                  the router sends it to every dashboard
 *                                                      (their DASHBOARD_PROXY_SECRET)
 *   ROUTER_BACKEND=static | kubernetes                 how it finds (and starts) each person's container
 *   ROUTER_IDLE_MINUTES=60                             optional: stop a container this long after
 *                                                      its last request, unless a run is going
 */

import type { HostedConfig } from "../../engine/server/src/hosted.ts";

export interface RouterConfig {
  port: number;
  bind: string;
  /** The checks on what the login proxy sends (hosted.ts's, with no single owner). */
  front: HostedConfig;
  backendSecret: string;
  /** Where the dashboards expect the email: their DASHBOARD_IDENTITY_HEADER. */
  backendIdentityHeader: string;
  /** 0 = never stop containers. */
  idleMinutes: number;
  /** Who to ask for a dashboard, shown to someone who doesn't have one yet. */
  admin: string | null;
  backend: "static" | "kubernetes";
  /** static: a JSON file of { "<email>": "<dashboard URL>" }. */
  staticFile: string;
  kubernetes: {
    /** The API server; in a pod, the in-cluster address and its service-account token. */
    api: string;
    tokenFile: string;
    caFile: string | null;
    namespace: string;
    /** Which StatefulSets are dashboards; each names its person in the natterjack/owner annotation. */
    selector: string;
    /** How to reach a dashboard: {service}, {namespace} and {port} are filled in. */
    urlTemplate: string;
    port: number;
  };
}

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const MIN_SECRET = 32;

export function routerConfig(env: NodeJS.ProcessEnv = process.env, readFile: (f: string) => string | null = () => null): RouterConfig {
  const problems: string[] = [];
  let url: URL | null = null;
  try { url = new URL(String(env.ROUTER_PUBLIC_URL || "")); } catch {}
  if (!url || !/^https?:$/.test(url.protocol)) problems.push("ROUTER_PUBLIC_URL must be the address people open, e.g. https://dashboard.example.com");
  const proxySecret = String(env.ROUTER_PROXY_SECRET || "");
  if (proxySecret.length < MIN_SECRET) problems.push(`ROUTER_PROXY_SECRET must be at least ${MIN_SECRET} characters (the login proxy sends it as X-Dashboard-Proxy-Secret)`);
  const backendSecret = String(env.ROUTER_BACKEND_SECRET || "");
  if (backendSecret.length < MIN_SECRET) problems.push(`ROUTER_BACKEND_SECRET must be at least ${MIN_SECRET} characters (every dashboard's DASHBOARD_PROXY_SECRET)`);
  const backend = String(env.ROUTER_BACKEND || "").trim();
  if (backend !== "static" && backend !== "kubernetes") problems.push("ROUTER_BACKEND must be static or kubernetes");
  const staticFile = String(env.ROUTER_STATIC_FILE || "").trim();
  if (backend === "static" && !staticFile) problems.push("ROUTER_STATIC_FILE must name the JSON file of { \"<email>\": \"<dashboard URL>\" }");
  const idle = Number(env.ROUTER_IDLE_MINUTES || 0);
  if (!(idle >= 0)) problems.push("ROUTER_IDLE_MINUTES must be a number of minutes (0 = never stop)");
  if (problems.length) throw new Error(`The router isn't set up:\n  - ${problems.join("\n  - ")}`);

  const extra = String(env.ROUTER_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const api = String(env.ROUTER_K8S_API || "").trim()
    || (env.KUBERNETES_SERVICE_HOST ? `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT || 443}` : "https://kubernetes.default.svc");
  return {
    port: parseInt(String(env.ROUTER_PORT || ""), 10) || 8080,
    bind: String(env.ROUTER_BIND || "").trim() || "0.0.0.0",
    front: {
      bind: "",
      publicOrigin: url!.origin,
      hosts: new Set([url!.host.toLowerCase(), ...extra]),
      identityHeader: (String(env.ROUTER_IDENTITY_HEADER || "").trim() || "x-forwarded-email").toLowerCase(),
      proxySecret,
      owner: null,
    },
    backendSecret,
    backendIdentityHeader: (String(env.ROUTER_BACKEND_IDENTITY_HEADER || "").trim() || "x-forwarded-email").toLowerCase(),
    idleMinutes: idle,
    admin: String(env.ROUTER_ADMIN || "").trim() || null,
    backend: backend as "static" | "kubernetes",
    staticFile,
    kubernetes: {
      api,
      tokenFile: String(env.ROUTER_K8S_TOKEN_FILE || "").trim() || `${SA}/token`,
      caFile: env.ROUTER_K8S_CA_FILE !== undefined ? (String(env.ROUTER_K8S_CA_FILE).trim() || null) : `${SA}/ca.crt`,
      namespace: String(env.ROUTER_K8S_NAMESPACE || "").trim() || (readFile(`${SA}/namespace`) || "").trim() || "default",
      selector: String(env.ROUTER_K8S_SELECTOR || "").trim() || "app=natterjack-dashboard",
      urlTemplate: String(env.ROUTER_K8S_URL_TEMPLATE || "").trim() || "http://{service}.{namespace}.svc:{port}",
      port: parseInt(String(env.ROUTER_K8S_PORT || ""), 10) || 3333,
    },
  };
}

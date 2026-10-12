/**
 * Where each person's dashboard container is, and (where the platform allows) how to
 * start and stop it. Add a platform by implementing Backend and adding it to
 * makeBackend(): ECS, Azure Container Apps, App Service and the like are all "find
 * this person's service URL; set its desired count to 1 or 0".
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { SECRET_HEADER } from "../../engine/server/src/hosted.ts";
import type { RouterConfig } from "./config.ts";

export interface Target {
  /** The dashboard's base URL, e.g. http://dashboard-ana.dashboards.svc:3333 */
  url: string;
  /** false: it's stopped or still starting; the router shows a "starting" page. */
  ready: boolean;
  /** The router may start it (and stop it when idle). */
  canStart: boolean;
  /** Send this Host instead of the browser's (App Service routes by Host); the dashboard lists it in DASHBOARD_ALLOWED_HOSTS. */
  host?: string;
}

export interface Backend {
  /** This person's dashboard, or null when they don't have one. Emails are lowercase. */
  find(email: string): Promise<Target | null>;
  start?(email: string): Promise<void>;
  stop?(email: string): Promise<void>;
  /** Emails whose containers are running now (so idle ones are stopped even after a router restart). */
  running?(): Promise<string[]>;
}

/**
 * The dashboard URL for a request: always the backend's scheme, host and port, with only
 * the request's path and query. (Resolving the request target against the base would let
 * a protocol-relative one like //elsewhere.example/x replace the host, and the backend
 * secret and the person's email would go there.)
 */
export function backendUrl(base: string, reqUrl: string): URL {
  const inbound = new URL(reqUrl || "/", "http://router.invalid");
  const target = new URL(base);
  target.pathname = target.pathname.replace(/\/+$/, "") + inbound.pathname;
  target.search = inbound.search;
  target.hash = "";
  return target;
}

export const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Headers for the dashboard: the client's, minus anything identity-like it sent, plus ours. */
export function backendHeaders(cfg: Pick<RouterConfig, "front" | "backendSecret" | "backendIdentityHeader">, inbound: http.IncomingHttpHeaders, email: string, host?: string): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(inbound)) {
    if (HOP.has(k) || k === SECRET_HEADER || k === cfg.front.identityHeader || k === cfg.backendIdentityHeader) continue;
    out[k] = v;
  }
  out[SECRET_HEADER] = cfg.backendSecret;
  out[cfg.backendIdentityHeader] = email;
  // Host and Origin pass through: each dashboard's DASHBOARD_PUBLIC_URL is this one address.
  // Except where the platform routes by Host (App Service): then the backend's, which the dashboard allows.
  if (host) out.host = host;
  return out;
}

export function makeBackend(cfg: RouterConfig): Backend {
  if (cfg.backend === "kubernetes") return new KubernetesBackend(cfg.kubernetes);
  if (cfg.backend === "azure-app-service") return new AppServiceBackend(cfg.azure);
  return new StaticBackend(cfg.staticFile);
}

// ------------------------------------------------------------------ static

/**
 * A JSON file of { "<email>": "<dashboard URL>" } (re-read when it changes), for
 * containers someone else keeps running: a VM with Docker, App Service, ECS services...
 * The router never starts or stops them.
 */
export class StaticBackend implements Backend {
  private file: string;
  private cache: { mtimeMs: number; map: Map<string, string> } | null = null;

  constructor(file: string) { this.file = file; }

  private map(): Map<string, string> {
    let st: fs.Stats;
    try { st = fs.statSync(this.file); } catch { return new Map(); }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs) return this.cache.map;
    const map = new Map<string, string>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      for (const [email, url] of Object.entries(raw || {})) {
        if (email.startsWith("$") || typeof url !== "string") continue;
        map.set(email.trim().toLowerCase(), url.replace(/\/+$/, ""));
      }
    } catch (e) { console.error(`${this.file}: ${e.message}`); }
    this.cache = { mtimeMs: st.mtimeMs, map };
    return map;
  }

  async find(email: string): Promise<Target | null> {
    const url = this.map().get(email);
    return url ? { url, ready: true, canStart: false } : null;
  }
}

// ------------------------------------------------------------------ kubernetes

interface Dashboard { name: string; service: string; replicas: number; ready: boolean }

/**
 * One StatefulSet per person (templates/hosted/kubernetes-router.yaml), labelled for the
 * selector and naming its person in the natterjack/owner annotation, so the names are
 * whatever the admin likes. Starting and stopping is scaling it between 0 and 1, which
 * keeps the person's volume. Needs list on statefulsets and patch on
 * statefulsets/scale in the namespace, nothing else.
 */
export class KubernetesBackend implements Backend {
  private cfg: RouterConfig["kubernetes"];
  private cache: { at: number; byEmail: Map<string, Dashboard> } | null = null;
  private inflight: Promise<Map<string, Dashboard>> | null = null;

  constructor(cfg: RouterConfig["kubernetes"]) { this.cfg = cfg; }

  private api(method: string, p: string, body?: object): Promise<any> {
    const u = new URL(p, this.cfg.api);
    const lib = u.protocol === "https:" ? https : http;
    let token = "";
    try { token = fs.readFileSync(this.cfg.tokenFile, "utf-8").trim(); } catch {} // re-read: projected tokens rotate
    let ca: Buffer | undefined;
    if (this.cfg.caFile) try { ca = fs.readFileSync(this.cfg.caFile); } catch {}
    const data = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = lib.request(u, {
        method,
        ca,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { "Content-Type": "application/merge-patch+json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: 10000,
      }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("error", reject);
        res.on("end", () => {
          if ((res.statusCode || 0) >= 300) return reject(new Error(`Kubernetes API ${method} ${u.pathname}: ${res.statusCode} ${text.slice(0, 200)}`));
          try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error(`Kubernetes API ${u.pathname}: not JSON`)); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("Kubernetes API timed out")));
      req.on("error", reject);
      req.end(data);
    });
  }

  private async dashboards(force = false): Promise<Map<string, Dashboard>> {
    if (!force && this.cache && Date.now() - this.cache.at < 5000) return this.cache.byEmail;
    if (!this.inflight) {
      const ns = encodeURIComponent(this.cfg.namespace);
      this.inflight = this.api("GET", `/apis/apps/v1/namespaces/${ns}/statefulsets?labelSelector=${encodeURIComponent(this.cfg.selector)}`)
        .then((list) => {
          const byEmail = new Map<string, Dashboard>();
          for (const s of list.items || []) {
            const notes = s.metadata?.annotations || {};
            const owner = String(notes["natterjack/owner"] || notes["agentic-os/owner"] || "").trim().toLowerCase(); // agentic-os/: before the rename
            if (!owner) continue;
            byEmail.set(owner, {
              name: s.metadata.name,
              service: s.spec?.serviceName || s.metadata.name,
              replicas: Number(s.spec?.replicas ?? 1),
              ready: Number(s.status?.readyReplicas || 0) > 0,
            });
          }
          this.cache = { at: Date.now(), byEmail };
          return byEmail;
        })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  async find(email: string): Promise<Target | null> {
    const d = (await this.dashboards()).get(email);
    if (!d) return null;
    const url = this.cfg.urlTemplate
      .replaceAll("{service}", d.service).replaceAll("{namespace}", this.cfg.namespace).replaceAll("{port}", String(this.cfg.port));
    return { url, ready: d.replicas > 0 && d.ready, canStart: true };
  }

  private async scale(email: string, replicas: number) {
    const d = (await this.dashboards()).get(email);
    if (!d || d.replicas === replicas) return;
    await this.api("PATCH", `/apis/apps/v1/namespaces/${encodeURIComponent(this.cfg.namespace)}/statefulsets/${encodeURIComponent(d.name)}/scale`, { spec: { replicas } });
    this.cache = null;
  }

  start(email: string) { return this.scale(email, 1); }
  stop(email: string) { return this.scale(email, 0); }

  async running(): Promise<string[]> {
    return [...(await this.dashboards()).entries()].filter(([, d]) => d.replicas > 0).map(([e]) => e);
  }
}

// ------------------------------------------------------------------ Azure App Service

interface Site { name: string; host: string; running: boolean }
const ARM_API = "2023-12-01";

/**
 * One Web App per person in a resource group (templates/hosted/app-service-person.bicep),
 * naming them in the natterjack-owner tag. The router reaches each at its own
 * <app>.azurewebsites.net address, with that as the Host (App Service routes by it), and
 * starts and stops it. Signs in with the router app's managed identity, which needs
 * Reader and Website Contributor on the resource group, nothing else.
 */
export class AppServiceBackend implements Backend {
  private cfg: RouterConfig["azure"];
  private token: { value: string; until: number } | null = null;
  private cache: { at: number; byEmail: Map<string, Site> } | null = null;
  private inflight: Promise<Map<string, Site>> | null = null;

  constructor(cfg: RouterConfig["azure"]) { this.cfg = cfg; }

  private async bearer(): Promise<string> {
    if (this.cfg.token) return this.cfg.token;
    if (this.token && Date.now() < this.token.until) return this.token.value;
    if (!this.cfg.identityEndpoint || !this.cfg.identityHeader) throw new Error("No managed identity: turn on the router app's system-assigned identity (IDENTITY_ENDPOINT isn't set).");
    const u = `${this.cfg.identityEndpoint}?resource=${encodeURIComponent("https://management.azure.com/")}&api-version=2019-08-01`;
    const res = await fetch(u, { headers: { "X-IDENTITY-HEADER": this.cfg.identityHeader }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Managed identity token: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body: any = await res.json();
    const expires = Number(body.expires_on) * 1000 || Date.now() + 30 * 60_000;
    this.token = { value: body.access_token, until: expires - 5 * 60_000 };
    return this.token.value;
  }

  private async arm(method: string, p: string): Promise<any> {
    const url = p.startsWith("http") ? p : `${this.cfg.arm}${p}`;
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await this.bearer()}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Azure ${method} ${new URL(url).pathname}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  private group(): string {
    return `/subscriptions/${encodeURIComponent(this.cfg.subscription)}/resourceGroups/${encodeURIComponent(this.cfg.resourceGroup)}/providers/Microsoft.Web/sites`;
  }

  private async sites(force = false): Promise<Map<string, Site>> {
    if (!force && this.cache && Date.now() - this.cache.at < 5000) return this.cache.byEmail;
    if (!this.inflight) {
      this.inflight = (async () => {
        const byEmail = new Map<string, Site>();
        let next: string | null = `${this.group()}?api-version=${ARM_API}`;
        for (let i = 0; next && i < 50; i++) {
          const page = await this.arm("GET", next);
          for (const s of page.value || []) {
            const owner = ownerOf(s.tags || {});
            if (!owner || !s.properties?.defaultHostName) continue;
            byEmail.set(owner, { name: s.name, host: String(s.properties.defaultHostName).toLowerCase(), running: s.properties.state === "Running" });
          }
          next = page.nextLink || null;
        }
        this.cache = { at: Date.now(), byEmail };
        return byEmail;
      })().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  async find(email: string): Promise<Target | null> {
    const s = (await this.sites()).get(email);
    return s ? { url: `https://${s.host}`, host: s.host, ready: s.running, canStart: true } : null;
  }

  private async power(email: string, action: "start" | "stop") {
    const s = (await this.sites()).get(email);
    if (!s || s.running === (action === "start")) return;
    await this.arm("POST", `${this.group()}/${encodeURIComponent(s.name)}/${action}?api-version=${ARM_API}`);
    this.cache = null;
  }

  start(email: string) { return this.power(email, "start"); }
  stop(email: string) { return this.power(email, "stop"); }

  async running(): Promise<string[]> {
    return [...(await this.sites()).entries()].filter(([, s]) => s.running).map(([e]) => e);
  }
}

/** natterjack-owner; or, for one set up by hand before the People page, owner on a hosted-workspace-dashboard. */
export function ownerOf(tags: Record<string, string>): string | null {
  const t = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const owner = t["natterjack-owner"] || (t.purpose === "hosted-workspace-dashboard" ? t.owner : "");
  return owner ? owner.trim().toLowerCase() : null;
}

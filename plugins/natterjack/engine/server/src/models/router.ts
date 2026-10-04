/**
 * Smart routing: Opus (or any Claude model) leads a run, and a local or team open model does
 * the code searching and reading as a subagent (Explore, on the open model). Claude Code sends every
 * request to one base URL, so a run with routing on points it at this router, on 127.0.0.1:
 *
 *   - a request for the explorer's model goes to that model's server (Ollama, a team endpoint),
 *     with the person's Claude credentials taken off (they never leave for a model server);
 *   - everything else goes on to Anthropic (or the gateway ANTHROPIC_BASE_URL already named)
 *     byte for byte, credentials included: Claude's turns run on the person's own sign-in.
 *
 * A local server answers one request at a time, so the explorer's requests wait in a queue
 * here (one at a time per server). A streamed request gets its response headers at once and
 * an SSE ping every 15 s while it waits, so Claude Code doesn't give up on it and retry.
 * Ollama has no token-counting endpoint: count_tokens for the explorer's model is estimated.
 *
 * Off unless the person turns it on (Models page); runs.ts adds the subagent and the base URL.
 */

import http from "node:http";
import https from "node:https";
import { allRoutes, type Route } from "./routes.ts";

const PING_MS = 15_000;

export interface RouterStats { local: number; claude: number; queued: number }

/** The route whose server-side model name a request asked for (the explorer's), or null. */
export function routeForModel(model: unknown): Route | null {
  return typeof model === "string" ? allRoutes().find((r) => r.model === model) || null : null;
}

/** Headers for a model server: no Claude credentials (or hop-by-hop ones); its own token if it has one. */
export function backendHeaders(h: http.IncomingHttpHeaders, r: Route, length: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v == null || /^(host|authorization|x-api-key|cookie|connection|content-length|transfer-encoding|anthropic-beta)$/i.test(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  const token = r.backend.token || "ollama";
  out.authorization = `Bearer ${token}`;
  out["x-api-key"] = token;
  out["content-length"] = String(length);
  return out;
}

class Queue {
  private busy = 0;
  private waiting: (() => void)[] = [];
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  get length() { return this.waiting.length; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.busy++;
    try { return await fn(); } finally { this.busy--; this.waiting.shift()?.(); }
  }
}

export class ModelRouter {
  private server: http.Server | null = null;
  private queues = new Map<string, Queue>();
  readonly stats: RouterStats = { local: 0, claude: 0, queued: 0 };
  /** Where Claude's own requests go: the gateway the environment named, else Anthropic. */
  private readonly upstream: URL;

  private readonly pingMs: number;

  constructor(upstream = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com", opts: { pingMs?: number } = {}) {
    this.upstream = new URL(upstream);
    this.pingMs = opts.pingMs || PING_MS;
  }

  get url(): string | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? `http://127.0.0.1:${a.port}` : null;
  }

  /** Listen on a free port on 127.0.0.1 (once). */
  start(): Promise<string> {
    if (this.url) return Promise.resolve(this.url);
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => this.handle(req, res).catch((e) => {
        if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(e.message || e) } })); }
        else res.end();
      }));
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => { this.server = s; resolve(this.url!); });
    });
  }

  stop(): void { this.server?.close(); this.server = null; }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    let json: any = null;
    if (body.length && /json/i.test(String(req.headers["content-type"] || ""))) { try { json = JSON.parse(body.toString("utf-8")); } catch {} }
    const route = req.method === "POST" && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(req.url || "") ? routeForModel(json?.model) : null;
    if (!route) { this.stats.claude++; return this.passThrough(req, res, body); }
    this.stats.local++;
    if (/count_tokens/.test(req.url || "")) {
      // Ollama can't count; Claude Code only uses this to size things. About 4 characters a token.
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) }));
    }
    return this.toBackend(req, res, body, json, route);
  }

  /** Claude's own request: on to Anthropic (or the gateway) unchanged, and its answer back unchanged. */
  private passThrough(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const headers = { ...req.headers, host: this.upstream.host } as Record<string, any>;
      delete headers["content-length"];
      if (body.length) headers["content-length"] = String(body.length);
      const base = this.upstream.pathname.replace(/\/+$/, "");
      const mod = this.upstream.protocol === "http:" ? http : https;
      const up = mod.request({ protocol: this.upstream.protocol, hostname: this.upstream.hostname, port: this.upstream.port || undefined, path: base + (req.url || "/"), method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
        r.on("end", resolve);
      });
      up.on("error", (e) => {
        if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `Couldn't reach ${this.upstream.origin}: ${e.message}` } })); }
        resolve();
      });
      req.on("close", () => { if (!res.writableEnded) up.destroy(); });
      up.end(body);
    });
  }

  /** The explorer's request: queued per server, sent without Claude credentials, kept alive while it waits. */
  private async toBackend(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, json: any, route: Route): Promise<void> {
    const stream = !!json?.stream;
    let ping: ReturnType<typeof setInterval> | null = null;
    let gone = false;
    req.on("close", () => { gone = !res.writableEnded; });
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      ping = setInterval(() => res.write("event: ping\ndata: {\"type\":\"ping\"}\n\n"), this.pingMs);
    }
    const key = route.backend.id;
    if (!this.queues.has(key)) this.queues.set(key, new Queue(1));
    const q = this.queues.get(key)!;
    this.stats.queued = q.length + 1;
    try {
      await q.run(async () => {
        if (gone) return;
        const r = await fetch(`${route.backend.baseUrl}${req.url}`, { method: "POST", headers: backendHeaders(req.headers, route, body.length), body: new Uint8Array(body) });
        if (ping) { clearInterval(ping); ping = null; }
        if (!stream) {
          res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
          return void res.end(Buffer.from(await r.arrayBuffer()));
        }
        if (!r.ok || !r.body) {
          const text = await r.text().catch(() => "");
          return void res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `${route.backend.label} answered ${r.status}: ${text.slice(0, 300)}` } })}\n\n`);
        }
        for await (const c of r.body as any as AsyncIterable<Uint8Array>) { if (gone) break; res.write(c); }
        res.end();
      });
    } finally {
      if (ping) clearInterval(ping);
      this.stats.queued = q.length;
      if (!res.writableEnded) res.end();
    }
  }
}

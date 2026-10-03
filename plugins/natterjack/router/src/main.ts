/**
 * The agentic-os router: one address for everyone's hosted dashboard.
 *
 *   node --disable-warning=ExperimentalWarning router/src/main.ts
 *
 * Behind the company's login proxy (which adds the person's email and ROUTER_PROXY_SECRET),
 * it finds that person's dashboard container (backends.ts), starts it if it's stopped,
 * and passes their requests through, run streams included, with ROUTER_BACKEND_SECRET
 * and their email. Each dashboard still checks both (DASHBOARD_PROXY_SECRET,
 * DASHBOARD_OWNER), so a misrouted request is refused rather than served.
 * Settings: config.ts. Plain Node, no packages.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { SECRET_HEADER, checkHostedRequest } from "../../engine/server/src/hosted.ts";
import { routerConfig } from "./config.ts";
import { backendUrl, makeBackend, type Backend } from "./backends.ts";

const cfg = (() => {
  try { return routerConfig(process.env, (f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return null; } }); }
  catch (e) { console.error(e.message); process.exit(1); }
})();
const backend: Backend = makeBackend(cfg);

// Per person: when they last made a request, and how many are still open (a run's stream
// stays open while its page is). Idle = nothing open and nothing for ROUTER_IDLE_MINUTES.
const activity = new Map<string, { last: number; open: number }>();
const touch = (email: string, d: number) => {
  const a = activity.get(email) || { last: 0, open: 0 };
  a.last = Date.now();
  a.open = Math.max(0, a.open + d);
  activity.set(email, a);
};

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: http.ServerResponse, status: number, title: string, text: string, refresh = false) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...(refresh ? { "Retry-After": "5" } : {}) });
  res.end(`<!doctype html><meta charset="utf-8">${refresh ? '<meta http-equiv="refresh" content="4">' : ""}<title>${esc(title)}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:20vh auto;padding:0 1rem;color:#222">
<h1 style="font-size:1.3rem">${esc(title)}</h1><p>${esc(text)}</p></body>`);
}

/** Stopped or still starting: a page that reloads itself, or a 503 for the app's own API calls. */
function starting(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === "GET" && /text\/html/.test(String(req.headers.accept || ""))) {
    return page(res, 503, "Starting your dashboard…", "This takes a few seconds (a minute or two the very first time). The page reloads by itself.", true);
  }
  res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
  res.end(JSON.stringify({ error: "Your dashboard is starting. Try again in a moment." }));
}

const startsInFlight = new Map<string, Promise<void>>();
function startOnce(email: string) {
  if (!backend.start || startsInFlight.has(email)) return;
  const p = backend.start(email)
    .catch((e) => console.error(`Couldn't start ${email}'s dashboard: ${e.message}`))
    .finally(() => setTimeout(() => startsInFlight.delete(email), 5000));
  startsInFlight.set(email, p);
}

/** Headers for the dashboard: the client's, minus anything identity-like it sent, plus ours. */
function backendHeaders(req: http.IncomingMessage, email: string): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || k === SECRET_HEADER || k === cfg.front.identityHeader || k === cfg.backendIdentityHeader) continue;
    out[k] = v;
  }
  out[SECRET_HEADER] = cfg.backendSecret;
  out[cfg.backendIdentityHeader] = email;
  return out; // Host and Origin pass through: each dashboard's DASHBOARD_PUBLIC_URL is this one address.
}

function proxy(req: http.IncomingMessage, res: http.ServerResponse, base: string, email: string) {
  const target = backendUrl(base, req.url || "/");
  const lib = target.protocol === "https:" ? https : http;
  touch(email, +1);
  let done = false;
  const finish = () => { if (!done) { done = true; touch(email, -1); } };
  res.on("close", finish);

  const up = lib.request(target, { method: req.method, headers: backendHeaders(req, email) }, (r) => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) headers[k] = v;
    res.writeHead(r.statusCode || 502, headers);
    res.flushHeaders(); // a run's event stream must reach the browser before its first event
    // A dashboard that stops mid-response (restarted, OOM-killed): end this response, not the router.
    r.on("error", () => res.destroy());
    r.pipe(res);
  });
  req.on("error", () => up.destroy()); // the browser went away mid-upload
  up.on("error", (e: NodeJS.ErrnoException) => {
    if (res.headersSent) return res.destroy();
    // Not answering yet: a container that's starting (or was just stopped).
    if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN"].includes(e.code || "")) {
      if (backend.start) startOnce(email);
      return starting(req, res);
    }
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("The dashboard didn't answer.");
  });
  res.on("close", () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  const verdict = checkHostedRequest(cfg.front, req.headers);
  if (verdict.ok === false) { res.writeHead(verdict.status, { "Content-Type": "text/plain; charset=utf-8" }); return res.end(verdict.message); }
  const email = verdict.user;
  let target;
  try { target = await backend.find(email); }
  catch (e) {
    console.error(`Looking up ${email}'s dashboard: ${e.message}`);
    return page(res, 502, "Couldn't find your dashboard", "The router couldn't reach the platform that runs the dashboards. Try again in a minute.");
  }
  if (!target) {
    return page(res, 403, "No dashboard for you yet", `There's no dashboard set up for ${email}.${cfg.admin ? ` Ask ${cfg.admin} to add you.` : " Ask whoever runs the dashboards to add you."}`);
  }
  if (!target.ready && target.canStart) { touch(email, 0); startOnce(email); return starting(req, res); }
  proxy(req, res, target.url, email);
});
// Run streams stay open as long as their page; don't time out a quiet one.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

// ------------------------------------------------------------------ idle stop

/** Is a Claude run going in this person's dashboard? (A run waiting for an answer can stop: it resumes.) */
async function hasRunningRun(base: string, email: string): Promise<boolean> {
  const target = backendUrl(base, "/api/runs?limit=50");
  const lib = target.protocol === "https:" ? https : http;
  const headers = { [SECRET_HEADER]: cfg.backendSecret, [cfg.backendIdentityHeader]: email, host: [...cfg.front.hosts][0], accept: "application/json" };
  return new Promise((resolve) => {
    const req = lib.request(target, { headers, timeout: 10000 }, (r) => {
      let text = "";
      r.on("data", (d) => (text += d));
      r.on("error", () => resolve(true)); // cut off: can't tell, leave it running
      r.on("end", () => {
        try { resolve((JSON.parse(text).runs || []).some((x) => x.status === "running")); }
        catch { resolve(true); } // can't tell: leave it running
      });
    });
    // Slow to answer: can't tell (a busy dashboard is slow), so leave it running.
    req.on("timeout", () => { resolve(true); req.destroy(); });
    // Nothing listening: there's no run to keep alive.
    req.on("error", (e: NodeJS.ErrnoException) => resolve(!["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN"].includes(e.code || "")));
    req.end();
  });
}

async function sweep() {
  const idleMs = cfg.idleMinutes * 60_000;
  // Containers this router didn't see start (it restarted) count as active from now.
  if (backend.running) {
    try { for (const email of await backend.running()) if (!activity.has(email)) activity.set(email, { last: Date.now(), open: 0 }); } catch {}
  }
  for (const [email, a] of activity) {
    if (a.open > 0 || Date.now() - a.last < idleMs) continue;
    try {
      const t = await backend.find(email);
      if (!t || !t.canStart) { activity.delete(email); continue; }
      if (await hasRunningRun(t.url, email)) continue;
      await backend.stop!(email);
      activity.delete(email);
      console.log(`Stopped ${email}'s dashboard after ${cfg.idleMinutes} idle minutes.`);
    } catch (e) { console.error(`Idle check for ${email}: ${e.message}`); }
  }
}

if (cfg.idleMinutes > 0 && backend.stop) {
  const every = Math.max(500, Math.min(60_000, (cfg.idleMinutes * 60_000) / 2));
  let busy = false;
  setInterval(() => { if (busy) return; busy = true; sweep().finally(() => { busy = false; }); }, every).unref();
}

server.listen(cfg.port, cfg.bind, () => {
  console.log(`agentic-os router on ${cfg.bind}:${cfg.port} for ${cfg.front.publicOrigin} (${cfg.backend} backend${cfg.idleMinutes ? `, idle stop after ${cfg.idleMinutes} min` : ""})`);
});
// Open run streams would hold close() forever; the browser reconnects to the next router.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });

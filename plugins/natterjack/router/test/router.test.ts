// The router end to end: a real hosted dashboard (engine main.ts) behind it, a fake
// dashboard that streams, a dead port, and a fake Kubernetes API for start/stop.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { routerConfig } from "../src/config.ts";
import { backendUrl } from "../src/backends.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_MAIN = path.join(HERE, "..", "src", "main.ts");
const ENGINE_MAIN = path.join(HERE, "..", "..", "engine", "server", "src", "main.ts");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-router-")));
const HOST = "dash.example.com";
const FRONT = "f".repeat(40), BACK = "b".repeat(40);
const base = 40000 + Math.floor(Math.random() * 900) * 10;
const P = { dash: base, stream: base + 1, dead: base + 2, k8s: base + 3, routerStatic: base + 4, routerK8s: base + 5, busy: base + 6, evil: base + 7, crashy: base + 8 };
const kids: ChildProcess[] = [];
let evilHits = 0;
const servers: http.Server[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("backendUrl: only the request's path and query; the host is always the backend's", () => {
  assert.equal(backendUrl("http://127.0.0.1:3333", "/api/runs?limit=5").href, "http://127.0.0.1:3333/api/runs?limit=5");
  assert.equal(backendUrl("http://dash:3333", "//evil.example/collect?x=1").href, "http://dash:3333/collect?x=1");
  assert.equal(backendUrl("http://dash:3333/base/", "/a").href, "http://dash:3333/base/a");
});

test("routerConfig: refuses an unsafe or incomplete setup", () => {
  assert.throws(() => routerConfig({}), /ROUTER_PUBLIC_URL[\s\S]*ROUTER_PROXY_SECRET[\s\S]*ROUTER_BACKEND_SECRET[\s\S]*ROUTER_BACKEND/);
  const ok = { ROUTER_PUBLIC_URL: `https://${HOST}`, ROUTER_PROXY_SECRET: FRONT, ROUTER_BACKEND_SECRET: BACK };
  assert.throws(() => routerConfig({ ...ok, ROUTER_BACKEND: "static" }), /ROUTER_STATIC_FILE/);
  const k = routerConfig({ ...ok, ROUTER_BACKEND: "kubernetes" }, (f) => (f.endsWith("namespace") ? "dashboards\n" : null));
  assert.equal(k.kubernetes.namespace, "dashboards");
  assert.equal(k.kubernetes.selector, "app=agentic-dashboard");
  assert.equal(k.front.owner, null);
  assert.deepEqual([...k.front.hosts], [HOST]);
});

function request(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode || 0, text, type: String(res.headers["content-type"] || "") }));
    });
    req.on("error", reject);
    req.end();
  });
}
/** What the login proxy sends for a signed-in person. */
const as = (email: string, extra: Record<string, string> = {}) => ({ host: HOST, "x-dashboard-proxy-secret": FRONT, "x-forwarded-email": email, ...extra });

async function up(port: number) {
  for (let i = 0; i < 120; i++) {
    try { if ((await request(port, "/healthz")).status === 200) return; } catch {}
    await sleep(250);
  }
  throw new Error(`nothing on :${port}`);
}
function node(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], { env: { ...process.env, ...env }, stdio: "ignore" });
  kids.push(c);
  return c;
}

// Fake Kubernetes API: one dashboard StatefulSet for ana, stopped.
const k8s = { replicas: 0, ready: 0, patches: [] as number[], busyPatches: [] as number[] };

before(async () => {
  // A real hosted dashboard for ana, set up the way the router expects.
  const ws = path.join(TMP, "ws");
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "workspace.json"), JSON.stringify({ name: "Shop", codeHost: { kind: "none" } }));
  node(ENGINE_MAIN, {
    WORKSPACE_ROOT: ws, DASHBOARD_LEDGER_DIR: path.join(ws, ".claude", "ledger"), DASHBOARD_PORT: "",
    DASHBOARD_HOSTED: "1", DASHBOARD_PUBLIC_URL: `https://${HOST}`, DASHBOARD_PROXY_SECRET: BACK,
    DASHBOARD_OWNER: "ana@example.com", DASHBOARD_BIND: "127.0.0.1", DASHBOARD_CLAUDE_BIN: path.join(TMP, "no-claude"),
  }, ["--port", String(P.dash)]);

  // A dashboard that streams: one event, then holds the response open.
  const stream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify({ secret: req.headers["x-dashboard-proxy-secret"], email: req.headers["x-forwarded-email"] })}\n\n`);
  });
  stream.listen(P.stream, "127.0.0.1");
  servers.push(stream);

  // bo's dashboard, mid-run: the router must never stop it, however idle.
  const busy = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url!.startsWith("/api/runs") ? { runs: [{ id: "r1", status: "running" }] } : {}));
  });
  busy.listen(P.busy, "127.0.0.1");
  servers.push(busy);

  // Somewhere a request must never reach: it would get the backend secret and an email.
  const evil = http.createServer((req, res) => { evilHits++; res.end("got it"); });
  evil.listen(P.evil, "127.0.0.1");
  servers.push(evil);

  // A dashboard that dies mid-response (restart, OOM kill).
  const crashy = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: 1\n\n");
    setTimeout(() => req.socket.destroy(), 50);
  });
  crashy.listen(P.crashy, "127.0.0.1");
  servers.push(crashy);

  const api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url!.startsWith("/apis/apps/v1/namespaces/dashboards/statefulsets?labelSelector=")) {
        // serviceName doubles as host:port here (ROUTER_K8S_URL_TEMPLATE is http://{service}).
        return res.end(JSON.stringify({ items: [{
          metadata: { name: "dashboard-ana", annotations: { "agentic-os/owner": "Ana@Example.com" } },
          spec: { replicas: k8s.replicas, serviceName: `127.0.0.1:${P.dash}` },
          status: { readyReplicas: k8s.ready },
        }, {
          metadata: { name: "dashboard-bo", annotations: { "agentic-os/owner": "bo@example.com" } },
          spec: { replicas: 1, serviceName: `127.0.0.1:${P.busy}` },
          status: { readyReplicas: 1 },
        }] }));
      }
      if (req.method === "PATCH" && req.url === "/apis/apps/v1/namespaces/dashboards/statefulsets/dashboard-ana/scale") {
        assert.equal(req.headers.authorization, "Bearer k8s-token");
        k8s.replicas = JSON.parse(body).spec.replicas;
        k8s.patches.push(k8s.replicas);
        return res.end("{}");
      }
      if (req.method === "PATCH" && req.url!.endsWith("/statefulsets/dashboard-bo/scale")) {
        k8s.busyPatches.push(JSON.parse(body).spec.replicas);
        return res.end("{}");
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  api.listen(P.k8s, "127.0.0.1");
  servers.push(api);

  const routing = path.join(TMP, "dashboards.json");
  fs.writeFileSync(routing, JSON.stringify({
    $comment: "email → dashboard",
    "ana@example.com": `http://127.0.0.1:${P.dash}`,
    "bo@example.com": `http://127.0.0.1:${P.stream}`,
    "cy@example.com": `http://127.0.0.1:${P.dead}`,
    "fay@example.com": `http://127.0.0.1:${P.crashy}`,
    // A mistake: eve pointed at ana's dashboard. Ana's dashboard must refuse her.
    "eve@example.com": `http://127.0.0.1:${P.dash}`,
  }));
  const common = { ROUTER_PUBLIC_URL: `https://${HOST}`, ROUTER_PROXY_SECRET: FRONT, ROUTER_BACKEND_SECRET: BACK, ROUTER_BIND: "127.0.0.1", ROUTER_ADMIN: "the platform team" };
  node(ROUTER_MAIN, { ...common, ROUTER_PORT: String(P.routerStatic), ROUTER_BACKEND: "static", ROUTER_STATIC_FILE: routing });
  fs.writeFileSync(path.join(TMP, "token"), "k8s-token\n");
  node(ROUTER_MAIN, {
    ...common, ROUTER_PORT: String(P.routerK8s), ROUTER_BACKEND: "kubernetes", ROUTER_IDLE_MINUTES: "0.15",
    ROUTER_K8S_API: `http://127.0.0.1:${P.k8s}`, ROUTER_K8S_TOKEN_FILE: path.join(TMP, "token"), ROUTER_K8S_CA_FILE: "",
    ROUTER_K8S_NAMESPACE: "dashboards", ROUTER_K8S_URL_TEMPLATE: "http://{service}",
  });
  await Promise.all([up(P.dash), up(P.routerStatic), up(P.routerK8s)]);
});

after(() => {
  for (const c of kids) c.kill();
  for (const s of servers) s.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("router: only what comes through the login proxy gets in", async () => {
  assert.equal((await request(P.routerStatic, "/api/boot", { host: HOST, "x-forwarded-email": "ana@example.com" })).status, 401);
  assert.equal((await request(P.routerStatic, "/api/boot", as("ana@example.com", { host: "evil.example" }))).status, 421);
});

test("router: sends each person to their own dashboard, which accepts the router's headers", async () => {
  const r = await request(P.routerStatic, "/api/boot", as("Ana@Example.com"));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text).hosted, { user: "ana@example.com" });
});

test("router: a misrouted person is refused by the dashboard itself", async () => {
  const r = await request(P.routerStatic, "/api/boot", as("eve@example.com"));
  assert.equal(r.status, 403);
  assert.match(r.text, /belongs to someone else/);
});

test("router: someone without a dashboard is told so", async () => {
  const r = await request(P.routerStatic, "/", as("dee@example.com", { accept: "text/html" }));
  assert.equal(r.status, 403);
  assert.match(r.text, /no dashboard set up for dee@example\.com[\s\S]*the platform team/);
});

test("router: streams pass through as they come, with the backend secret and email", async () => {
  const first = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: P.routerStatic, path: "/api/events", headers: as("bo@example.com") }, (res) => {
      res.once("data", (d) => { resolve(String(d)); req.destroy(); });
    });
    req.on("error", reject);
    setTimeout(() => reject(new Error("the first event never arrived")), 3000);
    req.end();
  });
  assert.deepEqual(JSON.parse(first.replace(/^data: /, "")), { secret: BACK, email: "bo@example.com" });
});

test("router: a protocol-relative request target can't send the request (and secret) elsewhere", async () => {
  await request(P.routerStatic, `//127.0.0.1:${P.evil}/collect`, as("ana@example.com"));
  assert.equal(evilHits, 0);
});

test("router: a dashboard dying mid-stream ends that response, not the router", async () => {
  const ended = await new Promise<boolean>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: P.routerStatic, path: "/api/events", headers: as("fay@example.com") }, (res) => {
      res.on("data", () => {});
      res.on("close", () => resolve(true));
      res.on("error", () => resolve(true));
    });
    req.on("error", () => resolve(true));
    setTimeout(() => { req.destroy(); resolve(false); }, 3000);
    req.end();
  });
  assert.ok(ended, "the browser's response ended when the dashboard died");
  await sleep(200);
  assert.equal((await request(P.routerStatic, "/healthz")).status, 200, "the router is still up");
});

test("router: a dashboard that isn't answering shows the starting page", async () => {
  const html = await request(P.routerStatic, "/", as("cy@example.com", { accept: "text/html" }));
  assert.equal(html.status, 503);
  assert.match(html.text, /Starting your dashboard/);
  const api = await request(P.routerStatic, "/api/status", as("cy@example.com", { accept: "application/json" }));
  assert.equal(api.status, 503);
  assert.match(api.type, /json/);
});

test("router (kubernetes): starts a stopped dashboard, serves it when ready, stops it when idle, but not mid-run", async () => {
  const first = await request(P.routerK8s, "/", as("ana@example.com", { accept: "text/html" }));
  assert.equal(first.status, 503, "stopped: the starting page");
  for (let i = 0; i < 40 && k8s.replicas !== 1; i++) await sleep(100);
  assert.deepEqual(k8s.patches, [1], "scaled to 1");

  k8s.ready = 1;
  await sleep(5200); // past the router's 5 s cache of the StatefulSets
  const r = await request(P.routerK8s, "/api/boot", as("ana@example.com"));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text).hosted, { user: "ana@example.com" });

  // Idle (ROUTER_IDLE_MINUTES 0.15 = 9 s) with no run going: scaled back to 0.
  for (let i = 0; i < 250 && k8s.replicas !== 0; i++) await sleep(100);
  assert.deepEqual(k8s.patches, [1, 0], "scaled to 0 when idle");
  // bo was idle just as long (the router found it running when it started), but a run is going.
  assert.deepEqual(k8s.busyPatches, [], "a dashboard with a run going is never stopped");
});

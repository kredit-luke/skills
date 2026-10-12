// The router's Azure App Service backend against a fake Resource Manager and a fake
// managed identity endpoint: who owns which Web App (by tag), its address and Host,
// starting and stopping it, and the managed identity token.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { routerConfig } from "../src/config.ts";
import { AppServiceBackend, backendHeaders, ownerOf } from "../src/backends.ts";

const SECRETS = { ROUTER_PUBLIC_URL: "https://natterjack.example.com", ROUTER_PROXY_SECRET: "f".repeat(40), ROUTER_BACKEND_SECRET: "b".repeat(40) };
const GROUP = "/subscriptions/sub-1/resourceGroups/dashboard-rg/providers/Microsoft.Web/sites";

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }));
  });
}

test("routerConfig (azure-app-service): needs the subscription and resource group", () => {
  assert.throws(() => routerConfig({ ...SECRETS, ROUTER_BACKEND: "azure-app-service" }), /ROUTER_AZ_SUBSCRIPTION[\s\S]*ROUTER_AZ_RESOURCE_GROUP/);
  const c = routerConfig({ ...SECRETS, ROUTER_BACKEND: "azure-app-service", ROUTER_AZ_SUBSCRIPTION: "sub-1", ROUTER_AZ_RESOURCE_GROUP: "dashboard-rg", IDENTITY_ENDPOINT: "http://id", IDENTITY_HEADER: "h" });
  assert.equal(c.azure.arm, "https://management.azure.com");
  assert.deepEqual([c.azure.identityEndpoint, c.azure.identityHeader, c.azure.token], ["http://id", "h", null]);
});

test("ownerOf: natterjack-owner, or owner on a dashboard set up by hand; nothing else", () => {
  assert.equal(ownerOf({ "natterjack-owner": "Ana@Example.com" }), "ana@example.com");
  assert.equal(ownerOf({ owner: "luke@example.com", purpose: "hosted-workspace-dashboard" }), "luke@example.com");
  assert.equal(ownerOf({ owner: "someone@example.com" }), null, "an unrelated app with an owner tag isn't a dashboard");
});

test("App Service backend: finds each person's Web App by tag, routes by its host, starts and stops it with the managed identity", async () => {
  const sites: Record<string, string> = { "dash-luke": "Stopped", "dash-ana": "Running" };
  const posts: string[] = [];
  let tokens = 0;
  const id = await listen((req, res) => {
    assert.equal(req.headers["x-identity-header"], "id-secret");
    assert.match(req.url!, /resource=https%3A%2F%2Fmanagement\.azure\.com%2F/);
    tokens++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "arm-token", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
  });
  const arm = await listen((req, res) => {
    assert.equal(req.headers.authorization, "Bearer arm-token");
    res.setHeader("content-type", "application/json");
    const u = new URL(req.url!, "http://x");
    if (req.method === "GET" && u.pathname === GROUP && !u.searchParams.get("page")) {
      return res.end(JSON.stringify({
        value: [
          { name: "dash-luke", tags: { owner: "luke@example.com", purpose: "hosted-workspace-dashboard" }, properties: { state: sites["dash-luke"], defaultHostName: "dash-luke.azurewebsites.net" } },
          { name: "some-api", tags: { owner: "luke@example.com" }, properties: { state: "Running", defaultHostName: "some-api.azurewebsites.net" } },
        ],
        nextLink: `http://${req.headers.host}${GROUP}?api-version=2023-12-01&page=2`,
      }));
    }
    if (req.method === "GET" && u.searchParams.get("page") === "2") {
      return res.end(JSON.stringify({ value: [{ name: "dash-ana", tags: { "natterjack-owner": "ana@example.com" }, properties: { state: sites["dash-ana"], defaultHostName: "dash-ana.azurewebsites.net" } }] }));
    }
    const m = /\/sites\/([^/]+)\/(start|stop)$/.exec(u.pathname);
    if (req.method === "POST" && m) {
      posts.push(`${m[1]} ${m[2]}`);
      sites[m[1]] = m[2] === "start" ? "Running" : "Stopped";
      return res.end("");
    }
    res.statusCode = 404;
    res.end("{}");
  });
  try {
    const cfg = routerConfig({ ...SECRETS, ROUTER_BACKEND: "azure-app-service", ROUTER_AZ_SUBSCRIPTION: "sub-1", ROUTER_AZ_RESOURCE_GROUP: "dashboard-rg", ROUTER_AZ_ARM: arm.url, IDENTITY_ENDPOINT: id.url, IDENTITY_HEADER: "id-secret" });
    const b = new AppServiceBackend(cfg.azure);
    assert.deepEqual(await b.find("luke@example.com"), { url: "https://dash-luke.azurewebsites.net", host: "dash-luke.azurewebsites.net", ready: false, canStart: true });
    assert.deepEqual(await b.find("ana@example.com"), { url: "https://dash-ana.azurewebsites.net", host: "dash-ana.azurewebsites.net", ready: true, canStart: true });
    assert.equal(await b.find("bo@example.com"), null);
    assert.deepEqual(await b.running(), ["ana@example.com"]);

    await b.start("luke@example.com");
    await b.start("ana@example.com"); // already running: nothing to do
    await b.stop("ana@example.com");
    assert.deepEqual(posts, ["dash-luke start", "dash-ana stop"]);
    assert.equal((await b.find("luke@example.com"))!.ready, true);
    assert.equal(tokens, 1, "the token is reused until it nearly expires");
  } finally { id.close(); arm.close(); }
});

test("backendHeaders: an App Service target gets its own Host (it routes by Host); others keep the public one; identity headers are the router's", async () => {
  const cfg = routerConfig({ ...SECRETS, ROUTER_BACKEND: "azure-app-service", ROUTER_AZ_SUBSCRIPTION: "sub-1", ROUTER_AZ_RESOURCE_GROUP: "dashboard-rg", ROUTER_AZ_TOKEN: "arm-token", ROUTER_AZ_ARM: "http://unused" });
  const inbound = { host: "natterjack.example.com", accept: "text/html", connection: "keep-alive", "x-forwarded-email": "eve@example.com", "x-dashboard-proxy-secret": "forged" };
  const b = new AppServiceBackend(cfg.azure);
  (b as any).sites = async () => new Map([["ana@example.com", { name: "dash-ana", host: "dash-ana.azurewebsites.net", running: true }]]);
  const target = (await b.find("ana@example.com"))!;

  const h = backendHeaders(cfg, inbound, "ana@example.com", target.host);
  assert.equal(h.host, "dash-ana.azurewebsites.net", "never the public Host, which App Service would 404");
  assert.equal(h.accept, "text/html");
  assert.equal(h.connection, undefined);
  assert.equal(h[cfg.backendIdentityHeader], "ana@example.com");
  assert.equal(h["x-dashboard-proxy-secret"], cfg.backendSecret);

  assert.equal(backendHeaders(cfg, inbound, "ana@example.com").host, "natterjack.example.com", "no target host: the public one passes through");
});

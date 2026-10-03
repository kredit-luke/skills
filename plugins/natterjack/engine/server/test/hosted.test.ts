// Hosted mode: the config and request gate (hosted.ts) as units, then the real server
// (main.ts) started hosted, with a fake `claude` on PATH for the in-page sign-in.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkHostedRequest, hostedConfig, SECRET_HEADER } from "../src/hosted.ts";

const SECRET = "s".repeat(40);
const ENV = { DASHBOARD_HOSTED: "1", DASHBOARD_PUBLIC_URL: "https://dash.example.com", DASHBOARD_PROXY_SECRET: SECRET };

test("hostedConfig: off unless DASHBOARD_HOSTED is set", () => {
  assert.equal(hostedConfig({}), null);
  assert.equal(hostedConfig({ DASHBOARD_HOSTED: "0", DASHBOARD_PUBLIC_URL: "https://x.example" }), null);
});

test("hostedConfig: refuses to start without a public URL or a long enough proxy secret", () => {
  assert.throws(() => hostedConfig({ DASHBOARD_HOSTED: "1" }), /DASHBOARD_PUBLIC_URL[\s\S]*DASHBOARD_PROXY_SECRET/);
  assert.throws(() => hostedConfig({ ...ENV, DASHBOARD_PROXY_SECRET: "short" }), /at least 32/);
  assert.throws(() => hostedConfig({ ...ENV, DASHBOARD_PUBLIC_URL: "dash.example.com" }), /DASHBOARD_PUBLIC_URL/);
});

test("hostedConfig: defaults and overrides", () => {
  const c = hostedConfig(ENV)!;
  assert.equal(c.bind, "0.0.0.0");
  assert.equal(c.publicOrigin, "https://dash.example.com");
  assert.deepEqual([...c.hosts], ["dash.example.com"]);
  assert.equal(c.identityHeader, "x-forwarded-email");
  assert.equal(c.owner, null);
  const o = hostedConfig({ ...ENV, DASHBOARD_OWNER: " Ana@Example.com ", DASHBOARD_IDENTITY_HEADER: "X-Auth-Request-Email", DASHBOARD_ALLOWED_HOSTS: "dash-ana:3333, 10.0.0.5:3333", DASHBOARD_BIND: "127.0.0.1" })!;
  assert.equal(o.owner, "ana@example.com");
  assert.equal(o.identityHeader, "x-auth-request-email");
  assert.deepEqual([...o.hosts], ["dash.example.com", "dash-ana:3333", "10.0.0.5:3333"]);
  assert.equal(o.bind, "127.0.0.1");
});

test("checkHostedRequest: the secret first, then Host, Origin, identity and owner", () => {
  const c = hostedConfig({ ...ENV, DASHBOARD_OWNER: "ana@example.com" })!;
  const good = { host: "dash.example.com", [SECRET_HEADER]: SECRET, "x-forwarded-email": "Ana@Example.com" };
  assert.deepEqual(checkHostedRequest(c, good), { ok: true, user: "ana@example.com" });
  assert.equal(checkHostedRequest(c, { ...good, [SECRET_HEADER]: undefined }).ok, false);
  const status = (h: object) => { const v = checkHostedRequest(c, h as any); return v.ok === false ? v.status : 200; };
  assert.equal(status({ ...good, [SECRET_HEADER]: "x".repeat(40) }), 401);
  // Without the secret nothing else is believed, not even a matching owner.
  assert.equal(status({ host: "evil.example", "x-forwarded-email": "ana@example.com" }), 401);
  assert.equal(status({ ...good, host: "evil.example" }), 421);
  assert.equal(status({ ...good, origin: "https://evil.example" }), 403);
  assert.equal(status({ ...good, origin: "https://dash.example.com" }), 200);
  assert.equal(status({ ...good, "x-forwarded-email": "" }), 401);
  assert.equal(status({ ...good, "x-forwarded-email": "bo@example.com" }), 403);
});

// ------------------------------------------------------------------ end to end

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-hosted-")));
const ROOT = path.join(TMP, "ws");
const BIN = path.join(TMP, "bin");
const PORT = 39000 + Math.floor(Math.random() * 1000);
const PUBLIC_HOST = "dash.example.com";
let server: ChildProcess | null = null;
let token = "";

// A stand-in for the claude CLI: `auth login` prints a URL, waits for a code, and only
// "good-code#state" signs in; `auth status` reports whether that happened.
const FAKE = `
import fs from "node:fs";
const a = process.argv.slice(2);
const flag = ${JSON.stringify(path.join(TMP, "signed-in"))};
if (a[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (a[0] === "auth" && a[1] === "status") {
  const ok = fs.existsSync(flag);
  console.log(JSON.stringify({ loggedIn: ok, authMethod: ok ? "claude.ai" : "none", apiProvider: "firstParty" }));
  process.exit(0);
}
if (a[0] === "auth" && a[1] === "login") {
  const email = a.includes("--email") ? a[a.indexOf("--email") + 1] : "";
  process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc&login_hint=" + encodeURIComponent(email) + "\\nPaste code here if prompted > ");
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    if (!buf.includes("\\n")) return;
    if (buf.trim() === "good-code#state") { fs.writeFileSync(flag, "1"); console.log("Login successful."); process.exit(0); }
    console.log("Invalid code"); process.exit(1);
  });
} else process.exit(0);
`;

function request(method: string, p: string, headers: Record<string, string> = {}, body?: object): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: { ...headers, ...(data ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode || 0, text }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
const signedIn = { host: PUBLIC_HOST, [SECRET_HEADER]: SECRET, "x-forwarded-email": "ana@example.com" };
const post = (p: string, body: object) => request("POST", p, { ...signedIn, "x-dash-token": token }, body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fs.mkdirSync(path.join(ROOT, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".claude", "dashboard", "workspace.json"), JSON.stringify({ name: "Shop", codeHost: { kind: "none" } }));
  fs.mkdirSync(BIN);
  fs.writeFileSync(path.join(BIN, "fake-claude.mjs"), FAKE);
  const bin = process.platform === "win32" ? path.join(BIN, "claude.cmd") : path.join(BIN, "claude");
  if (process.platform === "win32") fs.writeFileSync(bin, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
  else fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKSPACE_ROOT: ROOT, DASHBOARD_LEDGER_DIR: path.join(ROOT, ".claude", "ledger"), DASHBOARD_PORT: "",
    DASHBOARD_CLAUDE_BIN: bin,
    ...ENV, DASHBOARD_PUBLIC_URL: `https://${PUBLIC_HOST}`, DASHBOARD_OWNER: "ana@example.com",
    // Loopback in the test, so no OS firewall prompt; a container uses the 0.0.0.0 default.
    DASHBOARD_BIND: "127.0.0.1",
  };
  delete env.ANTHROPIC_API_KEY;
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main, "--port", String(PORT)], { env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try { if ((await request("GET", "/healthz")).status === 200) break; } catch {}
    await sleep(250);
  }
  token = JSON.parse((await request("GET", "/api/boot", signedIn)).text).token;
  assert.ok(token, "the server came up");
});

after(() => {
  server?.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test("hosted server: /healthz needs nothing; everything else needs the proxy", async () => {
  assert.equal((await request("GET", "/healthz")).status, 200);
  // Right Host and a believable email, but not through the proxy (no secret): refused.
  assert.equal((await request("GET", "/api/boot", { host: PUBLIC_HOST, "x-forwarded-email": "ana@example.com" })).status, 401);
  assert.equal((await request("GET", "/api/boot", { ...signedIn, "x-forwarded-email": "bo@example.com" })).status, 403);
  // The local mode's own Host is refused: only the public address is served.
  assert.equal((await request("GET", "/api/boot", { ...signedIn, host: `localhost:${PORT}` })).status, 421);
});

test("hosted server: boot says who's signed in and hides the machine-only pages", async () => {
  const boot = JSON.parse((await request("GET", "/api/boot", signedIn)).text);
  assert.deepEqual(boot.hosted, { user: "ana@example.com" });
  for (const page of ["apps", "workspaces"]) assert.ok(boot.profile.hiddenPages.includes(page), page);
});

test("hosted server: features that open things on the server's own machine are refused", async () => {
  for (const [p, body] of [["/api/machine/install", { id: "claude-code" }], ["/api/docs/preview", { site: "x" }], ["/api/apps/action", { action: "stop-all", workspace: "main" }]] as const) {
    const r = await post(p, body);
    assert.equal(r.status, 400, p);
    assert.match(r.text, /hosted dashboard/, p);
  }
});

test("hosted server: Claude sign-in from the page", async () => {
  const start = JSON.parse((await post("/api/claude/login", { action: "start" })).text);
  assert.match(start.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  assert.match(start.url, /login_hint=ana%40example\.com/, "the proxy's email pre-fills the sign-in page");
  const bad = JSON.parse((await post("/api/claude/login", { action: "code", code: "wrong#state" })).text);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Invalid code/);
  // The failed attempt ended that CLI: a code now has nothing to go to.
  assert.equal(JSON.parse((await post("/api/claude/login", { action: "code", code: "good-code#state" })).text).ok, false);

  await post("/api/claude/login", { action: "start" });
  const good = JSON.parse((await post("/api/claude/login", { action: "code", code: "good-code#state" })).text);
  assert.deepEqual(good, { ok: true, message: "Signed in to Claude." });
  assert.ok(fs.existsSync(path.join(TMP, "signed-in")), "the CLI got the code and finished");
});

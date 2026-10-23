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
import { LinkTokens } from "../src/link-tokens.ts";

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
const ONLINE_TEST_MS = 3000;
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

// A stand-in for the GitHub CLI: `auth login --web` prints a device code and "polls" until the
// test approves (a gh-approved file) or denies (gh-denied); the rest answer as a signed-in gh does.
const GH_TOKEN_FILE = path.join(TMP, "gh-token");
const GIT_GLOBAL = path.join(TMP, "gitconfig");
const GH_DIR = path.join(TMP, "gh");
const SIGNING_KEY = path.join(GH_DIR, "signing_ed25519");
const FAKE_GH = `
import fs from "node:fs";
const a = process.argv.slice(2).join(" ");
const dir = ${JSON.stringify(TMP)};
const at = (f) => fs.existsSync(dir + "/" + f);
if (a.startsWith("auth login")) {
  if (!a.includes("--web") || !a.includes("--hostname github.com") || !a.includes("admin:ssh_signing_key")) { console.error("unexpected: " + a); process.exit(2); }
  process.stderr.write("! First copy your one-time code: AB12-CD34\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n");
  // GitHub's first poll comes a moment later, so the code is always read before an answer.
  setTimeout(() => setInterval(() => {
    if (at("gh-denied")) { console.error("error: access_denied"); process.exit(1); }
    if (at("gh-approved")) { fs.writeFileSync(dir + "/gh-token", "1"); console.error("✓ Logged in as ana-gh"); process.exit(0); }
  }, 50), 200);
} else if (a.startsWith("auth setup-git")) {
  fs.writeFileSync(dir + "/gh-setup-git", "1");
  if (at("gh-slow-setup")) setTimeout(() => {}, 500);
} else if (a === "api user") {
  if (at("gh-bad-user")) { console.error("HTTP 502"); process.exit(1); }
  console.log(JSON.stringify({ login: "ana-gh", id: 42, name: "Ana Example" }));
}
else if (a.startsWith("ssh-key add")) {
  // gh-slow-keyadd: the upload takes a while, so a sign-out can arrive while it's in flight.
  fs.writeFileSync(dir + "/gh-keyadd-started", "1");
  const done = () => { fs.writeFileSync(dir + "/gh-ssh-key-add", a); fs.appendFileSync(dir + "/gh-events", "add\\n"); };
  if (at("gh-slow-keyadd")) setTimeout(done, 600); else done();
}
else if (a === "api --paginate --slurp user/ssh_signing_keys") {
  const pub = fs.readFileSync(dir + "/gh/signing_ed25519.pub", "utf8").trim().split(" ").slice(0, 2).join(" ");
  // Two pages, ours on the second.
  console.log(JSON.stringify([[{ id: 6, key: "ssh-ed25519 AAAAsomeoneelse" }], [{ id: 7, key: pub }]]));
}
else if (a.startsWith("api -X DELETE")) { fs.appendFileSync(dir + "/gh-key-deleted", a + "\\n"); fs.appendFileSync(dir + "/gh-events", "delete\\n"); }
else if (a.startsWith("auth logout")) { fs.rmSync(dir + "/gh-token", { force: true }); }
else process.exit(1);
`;

// A stand-in for ssh-keygen: writes the key pair -f names, with -C as the public key's comment.
const FAKE_KEYGEN = `
import fs from "node:fs";
const a = process.argv.slice(2);
const f = a[a.indexOf("-f") + 1], c = a[a.indexOf("-C") + 1];
fs.writeFileSync(f, "PRIVATE KEY");
fs.writeFileSync(f + ".pub", "ssh-ed25519 AAAAdashboardkey " + c + "\\n");
fs.appendFileSync(${JSON.stringify(path.join(TMP, "keygen-runs"))}, "1");
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
/** A request with a body sent as given (bad JSON, or less than its Content-Length says). Ends when the response does. */
function rawRequest(method: string, p: string, headers: Record<string, string>, data: string, end = true): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => { resolve({ status: res.statusCode || 0, text }); req.destroy(); });
    });
    req.on("error", reject);
    if (end) req.end(data); else req.write(data);
  });
}

/** An SSE GET: its frames as they arrive (JSON data), `until` one matches, and `close`. */
function sse(p: string, headers: Record<string, string>) {
  const frames: { event: string; id?: string; data: any }[] = [];
  let buf = "";
  const req = http.request({ host: "127.0.0.1", port: PORT, method: "GET", path: p, headers }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message", id: string | undefined, data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("id: ")) id = line.slice(4);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data) frames.push({ event, id, data: JSON.parse(data) });
      }
    });
  });
  req.on("error", () => {});
  req.end();
  const until = async (pred: (f: (typeof frames)[number]) => boolean, what: string) => {
    for (let i = 0; i < 100; i++) { const f = frames.find(pred); if (f) return f; await sleep(50); }
    assert.fail(`never got ${what}: ${JSON.stringify(frames.map((f) => f.event))}`);
  };
  return { frames, until, close: () => req.destroy() };
}

const signedIn = { host: PUBLIC_HOST, [SECRET_HEADER]: SECRET, "x-forwarded-email": "ana@example.com" };
const post = (p: string, body: object) => request("POST", p, { ...signedIn, "x-dash-token": token }, body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fs.mkdirSync(path.join(ROOT, ".claude", "dashboard"), { recursive: true });
  // Jira with the team's Atlassian app, for Connect to Atlassian (nothing here reaches Atlassian).
  fs.writeFileSync(path.join(ROOT, ".claude", "dashboard", "workspace.json"), JSON.stringify({ name: "Shop", codeHost: { kind: "none" }, issues: { kind: "jira", site: "acme.atlassian.net" }, atlassian: { clientId: "atl-client" } }));
  // The GitHub CLI check is what offers the in-page GitHub sign-in.
  fs.writeFileSync(path.join(ROOT, ".claude", "dashboard", "machine.json"), JSON.stringify({ checks: [{ use: "gh" }] }));
  fs.mkdirSync(BIN);
  fs.writeFileSync(path.join(BIN, "fake-claude.mjs"), FAKE);
  fs.writeFileSync(path.join(BIN, "fake-gh.mjs"), FAKE_GH);
  fs.writeFileSync(path.join(BIN, "fake-keygen.mjs"), FAKE_KEYGEN);
  const bin = process.platform === "win32" ? path.join(BIN, "claude.cmd") : path.join(BIN, "claude");
  if (process.platform === "win32") fs.writeFileSync(bin, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
  else fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKSPACE_ROOT: ROOT, DASHBOARD_LEDGER_DIR: path.join(ROOT, ".claude", "ledger"), DASHBOARD_PORT: "",
    DASHBOARD_CLAUDE_BIN: bin,
    DASHBOARD_GH_BIN: path.join(BIN, "fake-gh.mjs"),
    DASHBOARD_SSH_KEYGEN_BIN: path.join(BIN, "fake-keygen.mjs"),
    GH_CONFIG_DIR: GH_DIR,
    // The sign-in's `git config --global` lands here, never in the developer's own config.
    GIT_CONFIG_GLOBAL: GIT_GLOBAL,
    ATLASSIAN_CLIENT_SECRET: "atl-secret",
    ...ENV, DASHBOARD_PUBLIC_URL: `https://${PUBLIC_HOST}`, DASHBOARD_OWNER: "ana@example.com",
    // Loopback in the test, so no OS firewall prompt; a container uses the 0.0.0.0 default.
    DASHBOARD_BIND: "127.0.0.1",
    // A linked computer counts as offline this long after its last sync (a minute otherwise).
    DASHBOARD_TEST_REMOTE_ONLINE_MS: String(ONLINE_TEST_MS),
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
  for (const page of ["apps", "workspaces", "people"]) assert.ok(boot.profile.hiddenPages.includes(page), page);
});

test("hosted server: features that open things on the server's own machine are refused", async () => {
  for (const [p, body] of [["/api/machine/install", { id: "claude-code" }], ["/api/docs/preview", { site: "x" }], ["/api/apps/action", { action: "stop-all", workspace: "main" }], ["/api/people/action", { action: "provision", email: "bo@example.com" }]] as const) {
    const r = await post(p, body);
    assert.equal(r.status, 400, p);
    assert.match(r.text, /hosted dashboard/, p);
  }
  // The People page drives the engineer's own kubectl and cloud CLIs: not even readable here.
  assert.equal((await request("GET", "/api/people", signedIn)).status, 400);
});

test("hosted server: Connect to Atlassian comes back to the dashboard's own address; the callback needs the proxy too", async () => {
  const st = JSON.parse((await request("GET", "/api/atlassian/status", signedIn)).text);
  assert.deepEqual(st, { used: true, site: "acme.atlassian.net", signIn: true, signInProblem: null, connected: false, viewer: null, jira: false });
  const start = JSON.parse((await post("/api/atlassian/sign-in", { action: "start" })).text);
  const callback = `https://${PUBLIC_HOST}/api/oauth/atlassian/callback`;
  assert.equal(start.listening, true, "nothing to paste: the dashboard catches it");
  assert.equal(start.callback, callback);
  const u = new URL(start.url);
  assert.equal(u.origin, "https://auth.atlassian.com");
  assert.equal(u.searchParams.get("redirect_uri"), callback);
  assert.equal(u.searchParams.get("client_id"), "atl-client");
  assert.match(u.searchParams.get("scope")!, /read:jira-work read:jira-user offline_access/);

  // The browser arriving with the wrong state: a page saying so, and the sign-in still waiting.
  let r = await request("GET", "/api/oauth/atlassian/callback?code=c1&state=wrong", signedIn);
  assert.equal(r.status, 400);
  assert.match(r.text, /<title>Not connected<\/title>/);
  assert.match(r.text, /href="https:\/\/dash\.example\.com\/"/);
  assert.equal(JSON.parse((await post("/api/atlassian/sign-in", { action: "status" })).text).pending, true);
  // Not through the proxy: refused like any other page.
  assert.equal((await request("GET", "/api/oauth/atlassian/callback?code=c1&state=wrong", { host: PUBLIC_HOST })).status, 401);

  await post("/api/atlassian/sign-in", { action: "cancel" });
  r = await request("GET", `/api/oauth/atlassian/callback?code=c1&state=${u.searchParams.get("state")}`, signedIn);
  assert.equal(r.status, 410);
  assert.match(r.text, /isn&#39;t waiting any more/);
  // No meeting tool here, and no such tool at all.
  assert.equal((await request("GET", "/api/oauth/roam/callback?code=c1&state=x", signedIn)).status, 404);
  assert.equal((await request("GET", "/api/oauth/nope/callback", signedIn)).status, 404);
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

test("hosted server: GitHub sign-in from the page (device flow)", async () => {
  const status = async () => JSON.parse((await post("/api/github/login", { action: "status" })).text);
  const until = async (state: string) => {
    for (let i = 0; i < 100; i++) { const s = await status(); if (s.state === state) return s; await sleep(100); }
    assert.fail(`never reached ${state}: ${JSON.stringify(await status())}`);
  };

  // Denied on GitHub: the page hears it failed.
  const first = JSON.parse((await post("/api/github/login", { action: "start" })).text);
  assert.deepEqual(first, { state: "pending", code: "AB12-CD34", url: "https://github.com/login/device" });
  fs.writeFileSync(path.join(TMP, "gh-denied"), "1");
  assert.match((await until("failed")).message, /access_denied/);
  fs.rmSync(path.join(TMP, "gh-denied"));

  // Cancelled: back to idle, and nothing signed in.
  await post("/api/github/login", { action: "start" });
  await post("/api/github/login", { action: "cancel" });
  assert.equal((await status()).state, "idle");

  // Approved: git is set up and the commit identity is the GitHub name and the proxy's email.
  await post("/api/github/login", { action: "start" });
  assert.equal((await status()).state, "pending");
  fs.writeFileSync(path.join(TMP, "gh-approved"), "1");
  const done = await until("done");
  assert.equal(done.login, "ana-gh");
  assert.ok(fs.existsSync(GH_TOKEN_FILE));
  assert.ok(fs.existsSync(path.join(TMP, "gh-setup-git")), "gh auth setup-git ran");
  const cfg = fs.readFileSync(GIT_GLOBAL, "utf8");
  assert.match(cfg, /name = Ana Example/);
  assert.match(cfg, /email = ana@example\.com/);
  // Hosted, commits are signed: a key made beside gh's config, added to the account as a signing key.
  assert.match(cfg, /format = ssh/);
  assert.match(cfg, /gpgsign = true/);
  assert.ok(cfg.includes("signingkey = " + SIGNING_KEY.replaceAll("\\", "\\\\")) || cfg.includes("signingkey = " + SIGNING_KEY), cfg);
  assert.match(fs.readFileSync(SIGNING_KEY + ".pub", "utf8"), /Natterjack dashboard \(dash\.example\.com\)/);
  const added = fs.readFileSync(path.join(TMP, "gh-ssh-key-add"), "utf8");
  assert.match(added, /--type signing/);
  assert.ok(added.includes(SIGNING_KEY + ".pub"), added);

  // Signing in again (after a restart, say) reuses the key rather than making another.
  fs.rmSync(path.join(TMP, "gh-approved"));
  await post("/api/github/login", { action: "start" });
  fs.writeFileSync(path.join(TMP, "gh-approved"), "1");
  await until("done");
  assert.equal(fs.readFileSync(path.join(TMP, "keygen-runs"), "utf8"), "1", "one key, made once");

  // Signing out takes this dashboard's key (only) off the account and stops signing.
  assert.equal(JSON.parse((await post("/api/github/login", { action: "logout" })).text).ok, true);
  assert.ok(!fs.existsSync(GH_TOKEN_FILE), "signing out deletes the token");
  assert.deepEqual(fs.readFileSync(path.join(TMP, "gh-key-deleted"), "utf8").trim().split("\n"), ["api -X DELETE user/ssh_signing_keys/7"], "only this dashboard's key");
  assert.doesNotMatch(fs.readFileSync(GIT_GLOBAL, "utf8"), /gpgsign/);
  assert.equal((await post("/api/github/login", { action: "nope" })).status, 400);
});

test("hosted server: GitHub sign-in reports a missing identity, and a cancelled finish changes nothing", async () => {
  const status = async () => JSON.parse((await post("/api/github/login", { action: "status" })).text);
  const until = async (state: string) => {
    for (let i = 0; i < 100; i++) { const s = await status(); if (s.state === state) return s; await sleep(25); }
    assert.fail(`never reached ${state}: ${JSON.stringify(await status())}`);
  };
  fs.writeFileSync(path.join(TMP, "gh-approved"), "1");

  // GitHub doesn't say who signed in: failed, not a "done" with no commit identity.
  fs.writeFileSync(path.join(TMP, "gh-bad-user"), "1");
  await post("/api/github/login", { action: "start" });
  assert.match((await until("failed")).message, /didn't say who you are/);
  fs.rmSync(path.join(TMP, "gh-bad-user"));

  // Cancelled while setup-git is still running: the old finish must not write an identity or say done.
  fs.rmSync(GIT_GLOBAL, { force: true });
  fs.writeFileSync(path.join(TMP, "gh-slow-setup"), "1");
  await post("/api/github/login", { action: "start" });
  await until("finishing");
  await post("/api/github/login", { action: "cancel" });
  // Long enough for the stale finish to have run api user and both git config writes.
  await sleep(2500);
  assert.equal((await status()).state, "idle");
  assert.ok(!fs.existsSync(GIT_GLOBAL), "no commit identity from a cancelled sign-in");
  fs.rmSync(path.join(TMP, "gh-slow-setup"));

  // Signing out while the key upload is still in flight: the sign-out waits for it, then removes
  // the key, and the stale finish never turns signing back on.
  fs.rmSync(path.join(TMP, "gh-events"), { force: true });
  fs.writeFileSync(path.join(TMP, "gh-slow-keyadd"), "1");
  fs.rmSync(path.join(TMP, "gh-keyadd-started"), { force: true });
  await post("/api/github/login", { action: "start" });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(TMP, "gh-keyadd-started")); i++) await sleep(25);
  assert.ok(fs.existsSync(path.join(TMP, "gh-keyadd-started")), "gh ssh-key add is running");
  assert.equal(JSON.parse((await post("/api/github/login", { action: "logout" })).text).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(TMP, "gh-events"), "utf8").trim().split("\n"), ["add", "delete"], "the upload finished before the cleanup ran");
  await sleep(500);
  assert.doesNotMatch(fs.readFileSync(GIT_GLOBAL, "utf8"), /gpgsign/, "signing stays off after sign-out");
  assert.equal((await status()).state, "idle");
  fs.rmSync(path.join(TMP, "gh-slow-keyadd"));
  fs.rmSync(path.join(TMP, "gh-approved"));
});

test("hosted server: a role whose checks leave out the GitHub CLI can't start a GitHub sign-in", async () => {
  const machine = path.join(ROOT, ".claude", "dashboard", "machine.json");
  const was = fs.readFileSync(machine, "utf8");
  // Only engineers get the GitHub CLI check; this dashboard's person has no such role.
  fs.writeFileSync(machine, JSON.stringify({ checks: [{ use: "gh", when: { role: "engineering" } }] }));
  try {
    const r = await post("/api/github/login", { action: "start" });
    assert.equal(r.status, 403);
    assert.match(JSON.parse(r.text).error, /role doesn't sign in to GitHub/);
  } finally {
    fs.writeFileSync(machine, was);
  }
});

test("hosted server: Remote control routes (link stream, sync, mirrored run listed and commanded)", async () => {
  const made = await post("/api/remote-links", { action: "create", label: "Work laptop" });
  assert.equal(made.status, 201);
  const linkToken = JSON.parse(made.text).token;
  const asLink = { ...signedIn, authorization: `Bearer ${linkToken}` };

  // The link stream: 200 text/event-stream, hello first, with the protocol.
  const { contentType, hello, close } = await new Promise<{ contentType: string; hello: any; close: () => void }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "GET", path: "/api/remote/link", headers: asLink }, (res) => {
      assert.equal(res.statusCode, 200);
      let buf = "";
      res.on("data", (d) => {
        buf += d;
        const m = buf.match(/event: hello\ndata: (.*)\n\n/);
        if (m) resolve({ contentType: String(res.headers["content-type"]), hello: JSON.parse(m[1]), close: () => req.destroy() });
      });
    });
    req.on("error", reject);
    req.end();
  });
  try {
    assert.equal(contentType, "text/event-stream");
    assert.equal(hello.protocol, 1);
    assert.equal(hello.label, "Work laptop");

    const run = { id: "laptop-run-1", label: "On the laptop", status: "running", startedAt: new Date().toISOString() };
    const synced = await request("POST", "/api/remote/sync", asLink, { protocol: 1, runs: [run], events: [{ runId: run.id, from: 0, events: [{ type: "user", uuid: "u0" }] }] });
    assert.equal(synced.status, 200, synced.text);
    assert.deepEqual(JSON.parse(synced.text).have, { [run.id]: 1 });

    const list = JSON.parse((await request("GET", "/api/runs", signedIn)).text);
    assert.ok(!list.runs.some((r: any) => r.id === run.id), "not in runs (the router's idle check reads that)");
    assert.ok(list.remote.some((r: any) => r.id === run.id && r.remote.label === "Work laptop"));

    const reply = await post(`/api/runs/${run.id}/reply`, { text: "carry on" });
    assert.equal(reply.status, 202, reply.text);
    assert.equal(JSON.parse(reply.text).run.remote.pending[0].kind, "reply");
    assert.equal((await post(`/api/runs/${run.id}/rename`, { label: "x" })).status, 409);
    assert.equal((await request("GET", `/api/runs/${run.id}/changes`, signedIn)).status, 409);
    // Files stay on the computer.
    const attached = await post(`/api/runs/${run.id}/reply`, { text: "see this", attachments: [{ name: "a.txt" }] });
    assert.equal(attached.status, 400);
    assert.match(attached.text, /Attach files on your computer/);

    // The mirrored run's page: the synced events and no outputs; ?events=0 leaves the events out.
    const page = JSON.parse((await request("GET", `/api/runs/${run.id}`, signedIn)).text);
    assert.equal(page.run.id, run.id);
    assert.deepEqual(page.events, [{ type: "user", uuid: "u0" }]);
    assert.deepEqual(page.outputs, []);
    assert.deepEqual(JSON.parse((await request("GET", `/api/runs/${run.id}?events=0`, signedIn)).text).events, []);

    // Its stream: replays only the events after Last-Event-ID (or ?after), then the meta.
    const more = await request("POST", "/api/remote/sync", asLink, { protocol: 1, runs: [], events: [{ runId: run.id, from: 1, events: [{ type: "assistant", uuid: "u1" }, { type: "assistant", uuid: "u2" }] }] });
    assert.deepEqual(JSON.parse(more.text).have, { [run.id]: 3 });
    for (const [p, h] of [[`/api/runs/${run.id}/stream`, { ...signedIn, "last-event-id": "1" }], [`/api/runs/${run.id}/stream?after=1`, signedIn]] as const) {
      const s = sse(p, h);
      try {
        await s.until((f) => f.event === "meta", `the meta from ${p}`);
        assert.deepEqual(s.frames.filter((f) => f.event === "event").map((f) => [f.id, f.data.uuid]), [["2", "u2"]], p);
      } finally {
        s.close();
      }
    }
    // ...and then a further sync's event, live.
    const stream = sse(`/api/runs/${run.id}/stream`, { ...signedIn, "last-event-id": "2" });
    try {
      await stream.until((f) => f.event === "meta", "the meta");
      assert.equal(stream.frames.filter((f) => f.event === "event").length, 0, "nothing after 2 yet");
      await request("POST", "/api/remote/sync", asLink, { protocol: 1, runs: [], events: [{ runId: run.id, from: 3, events: [{ type: "assistant", uuid: "u3" }] }] });
      const live = await stream.until((f) => f.event === "event", "the live event");
      assert.equal(live!.id, "3");
      assert.equal(live!.data.uuid, "u3");
    } finally {
      stream.close();
    }

    // A sync that isn't JSON: 400. One whose Content-Length is over the limit: 413, without the body being read.
    const bad = await rawRequest("POST", "/api/remote/sync", { ...asLink, "content-type": "application/json" }, "{nope");
    assert.equal(bad.status, 400);
    assert.match(bad.text, /Invalid JSON/);
    const big = await rawRequest("POST", "/api/remote/sync", { ...asLink, "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) }, "{}", false);
    assert.equal(big.status, 413);
    assert.match(big.text, /A sync can be up to 2 MB\./);

    // An id this pod also has as its own run: the pod's run wins, so the mirror's change isn't
    // published as the `run` event (the other, mirror-only run is, and the runs list refreshes).
    const shared = { id: "shared-run-1", label: "Mirrored twin", status: "running", startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(ROOT, ".claude", "ledger", "runs", `${shared.id}.json`), JSON.stringify({ ...shared, label: "On the pod", status: "done" }));
    const events = sse("/api/events", signedIn);
    try {
      await events.until((f) => f.event === "runs", "the first runs load");
      const second = { id: "laptop-run-2", label: "Also on the laptop", status: "running", startedAt: new Date().toISOString() };
      assert.equal((await request("POST", "/api/remote/sync", asLink, { protocol: 1, runs: [shared, second] })).status, 200);
      await events.until((f) => f.event === "run" && f.data.id === second.id, "the mirror-only run's event");
      const listed = await events.until((f) => f.event === "runs" && (f.data.remote || []).some((r: any) => r.id === second.id), "the runs list with the new mirrored run");
      assert.ok(!listed!.data.remote.some((r: any) => r.id === shared.id), "the shared id isn't listed as remote");
      assert.ok(!events.frames.some((f) => f.event === "run" && f.data.id === shared.id), "no run event for the shared id");
    } finally {
      events.close();
    }
  } finally {
    close();
  }
});

test("hosted server: a run's reply, queue, plan-mode and cancel POSTs keep their statuses and messages (the shared run actions)", async () => {
  const id = "pod-run-actions";
  fs.writeFileSync(path.join(ROOT, ".claude", "ledger", "runs", `${id}.json`), JSON.stringify({ id, label: "On the pod", prompt: "p", cwd: ROOT, status: "succeeded", startedAt: new Date().toISOString(), queued: [] }));
  const expect = async (p: string, body: object, status: number, error?: string) => {
    const r = await post(p, body);
    assert.equal(r.status, status, `${p}: ${r.text}`);
    if (error) assert.equal(JSON.parse(r.text).error, error);
    return JSON.parse(r.text);
  };
  await expect(`/api/runs/${id}/reply`, { text: "x", model: "Not A Model!" }, 400, "Unknown model Not A Model!");
  await expect(`/api/runs/${id}/queue`, { text: "  " }, 400, "The message is empty.");
  await expect(`/api/runs/${id}/queue-edit`, { id: "gone", text: "x" }, 409, "That message was already sent.");
  await expect(`/api/runs/${id}/queue-remove`, { id: "gone" }, 409, "That message was already sent.");
  await expect("/api/runs/no-such-run/queue-auto", { on: true }, 404, "Unknown run");
  await expect("/api/runs/no-such-run/plan-mode", { on: true }, 404, "Unknown run");
  assert.equal((await expect(`/api/runs/${id}/plan-mode`, { on: true }, 200)).run.planMode, true);
  await expect(`/api/runs/${id}/cancel`, {}, 409, "Nothing to cancel: the run isn't working or waiting.");
});

test("hosted server: queue-send on a run with nothing queued is refused (409) and leaves the run as it was", async () => {
  // Signed in to Claude, so launchBlocker passes and sendQueued answers. Self-contained (it also
  // runs alone): the flag the fake CLI reads, and a sign-in, whose finish refreshes the cached
  // sign-in state at once (launchBlocker reads that cache, refreshed only once it's a minute old).
  fs.writeFileSync(path.join(TMP, "signed-in"), "1");
  await post("/api/claude/login", { action: "start" });
  assert.equal(JSON.parse((await post("/api/claude/login", { action: "code", code: "good-code#state" })).text).ok, true);
  const id = "pod-run-nothing-queued";
  const meta = { id, label: "On the pod", prompt: "p", cwd: ROOT, status: "succeeded", startedAt: new Date().toISOString(), queued: [] };
  const file = path.join(ROOT, ".claude", "ledger", "runs", `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(meta));
  const r = await post(`/api/runs/${id}/queue-send`, {});
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(JSON.parse(r.text), { error: "Nothing is queued." });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), meta);
});

// ------------------------------------------------------------------ Remote control: auth and end to end

/** A link stream (GET /api/remote/link): its status, its frames as they come, and whether it has ended. */
function linkStream(headers: Record<string, string>) {
  return new Promise<{ status: number; contentType: string; text: string; frames: { event: string; data: any }[]; ended: () => boolean; close: () => void }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "GET", path: "/api/remote/link", headers }, (res) => {
      const frames: { event: string; data: any }[] = [];
      let buf = "", text = "", ended = false;
      const out = { status: res.statusCode || 0, contentType: String(res.headers["content-type"]), text: "", frames, ended: () => ended, close: () => req.destroy() };
      res.setEncoding("utf8");
      const done = () => { ended = true; out.text = text; if (out.status !== 200) resolve(out); };
      res.on("end", done);
      res.on("close", done);
      res.on("data", (d: string) => {
        text += d;
        buf += d;
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = block.match(/^event: (.*)$/m)?.[1], data = block.match(/^data: (.*)$/m)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
        }
        if (out.status === 200 && frames.some((f) => f.event === "hello")) resolve(out);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Open the link stream, waiting out another link still counted online from an earlier test (409). */
async function openLink(headers: Record<string, string>) {
  for (let i = 0; ; i++) {
    const s = await linkStream(headers);
    if (s.status !== 409 || i > 40) return s;
    await sleep(250);
  }
}

const makeLink = async (label: string) => {
  const made = await post("/api/remote-links", { action: "create", label });
  assert.equal(made.status, 201, made.text);
  const { token, link } = JSON.parse(made.text);
  return { id: link.id as string, token: token as string, headers: { ...signedIn, authorization: `Bearer ${token}` } };
};

test("hosted server: /api/remote/link, sync and ack refuse (401) no token, another dashboard's token, another owner's token, and a revoked one", async () => {
  // Bo's link, made by another dashboard's LinkTokens: not one of this dashboard's links.
  const elsewhere = new LinkTokens(fs.mkdtempSync(path.join(TMP, "bo-")));
  const boToken = elsewhere.create("bo@example.com", "Bo's laptop").token;
  // Bo's link in this dashboard's own store (never made by its owner): the owner check refuses it.
  const boHere = new LinkTokens(path.join(ROOT, ".claude", "ledger")).create("bo@example.com", "Bo here");
  // Ana's own link, revoked.
  const revoked = await makeLink("Old laptop");
  assert.equal((await post("/api/remote-links", { action: "revoke", id: revoked.id })).status, 200);
  try {
    // Bo's link really is in the store the server reads, so only the owner check can refuse it.
    const stored = JSON.parse((await request("GET", "/api/remote-links", signedIn)).text).links;
    assert.ok(stored.some((l: any) => l.id === boHere.link.id && l.label === "Bo here"), JSON.stringify(stored));
    const cases: [string, Record<string, string>][] = [
      ["no token", signedIn],
      ["a token from another dashboard (bo@)", { ...signedIn, authorization: `Bearer ${boToken}` }],
      ["bo@'s token in this dashboard's store", { ...signedIn, authorization: `Bearer ${boHere.token}` }],
      ["ana's revoked token", revoked.headers],
    ];
    for (const [what, h] of cases) {
      const link = await linkStream(h);
      assert.equal(link.status, 401, `GET /api/remote/link, ${what}: ${link.text}`);
      assert.match(link.text, /link token isn't valid here/);
      const sync = await request("POST", "/api/remote/sync", h, { protocol: 1, runs: [{ id: "should-not-land", status: "running", startedAt: new Date().toISOString() }], events: [] });
      assert.equal(sync.status, 401, `POST /api/remote/sync, ${what}: ${sync.text}`);
      const ack = await request("POST", "/api/remote/ack", h, { id: "c-1", ok: true });
      assert.equal(ack.status, 401, `POST /api/remote/ack, ${what}: ${ack.text}`);
    }
    const list = JSON.parse((await request("GET", "/api/runs", signedIn)).text);
    assert.ok(!(list.remote || []).some((r: any) => r.id === "should-not-land"), "no refused sync reached the mirror");
  } finally {
    // Leave room under the link limit for the next tests.
    assert.equal((await post("/api/remote-links", { action: "revoke", id: boHere.link.id })).status, 200);
  }
});

test("hosted server: Remote control end to end (pod run wins, list split, reply, offline, off, revoke)", async () => {
  const ana = await makeLink("Work laptop");
  const stream = await openLink(ana.headers);
  assert.equal(stream.status, 200, stream.text);
  try {
    assert.equal(stream.contentType, "text/event-stream");
    const hello = stream.frames.find((f) => f.event === "hello")!.data;
    assert.equal(hello.protocol, 1);
    assert.equal(hello.linkId, ana.id);
    const sync = (body: object) => request("POST", "/api/remote/sync", ana.headers, { protocol: 1, runs: [], events: [], ...body });

    // A mirror-only run and one whose id this pod also has as its own run (Sent to hosted keeps ids).
    const mirrorOnly = { id: "e2e-laptop-run", label: "On the laptop", status: "running", startedAt: new Date().toISOString() };
    const twin = { id: "e2e-twin-run", label: "Laptop's copy", status: "running", startedAt: new Date().toISOString() };
    const podTwin = { id: twin.id, label: "Pod's own", prompt: "p", cwd: ROOT, status: "succeeded", startedAt: new Date().toISOString(), queued: [] };
    fs.writeFileSync(path.join(ROOT, ".claude", "ledger", "runs", `${twin.id}.json`), JSON.stringify(podTwin));
    const synced = await sync({ runs: [mirrorOnly, twin], events: [{ runId: mirrorOnly.id, from: 0, events: [{ type: "user", uuid: "e0" }] }, { runId: twin.id, from: 0, events: [{ type: "user", uuid: "t0" }] }] });
    assert.equal(synced.status, 200, synced.text);
    assert.deepEqual(JSON.parse(synced.text).have, { [mirrorOnly.id]: 1, [twin.id]: 1 });

    // The pod's own run is served, not the mirrored one.
    const page = JSON.parse((await request("GET", `/api/runs/${twin.id}`, signedIn)).text);
    assert.equal(page.run.label, "Pod's own");
    assert.equal(page.run.remote, undefined);
    assert.ok(!page.events.some((e: any) => e.uuid === "t0"), "not the mirror's events");

    // The list: the mirror-only run under `remote` only (the router's idle check reads `runs`), the twin under `runs` only.
    const list = JSON.parse((await request("GET", "/api/runs", signedIn)).text);
    assert.ok(list.remote.some((r: any) => r.id === mirrorOnly.id), "mirror-only run under remote");
    assert.ok(!list.runs.some((r: any) => r.id === mirrorOnly.id), "mirror-only run not under runs");
    assert.ok(list.runs.some((r: any) => r.id === twin.id && r.label === "Pod's own"), "twin under runs, as the pod's");
    assert.ok(!list.remote.some((r: any) => r.id === twin.id), "twin not under remote");

    // Online: a reply is held for the computer (202, pending) and goes down the link.
    const reply = await post(`/api/runs/${mirrorOnly.id}/reply`, { text: "carry on" });
    assert.equal(reply.status, 202, reply.text);
    const pending = JSON.parse(reply.text).run.remote.pending;
    assert.deepEqual(pending.map((c: any) => [c.kind, c.text]), [["reply", "carry on"]]);
    for (let i = 0; i < 40 && !stream.frames.some((f) => f.event === "command"); i++) await sleep(50);
    assert.equal(stream.frames.find((f) => f.event === "command")?.data.id, pending[0].id, "the command reached the computer");
    assert.equal((await request("POST", "/api/remote/ack", ana.headers, { id: pending[0].id, ok: true })).status, 200);

    // Offline (no sync for ONLINE_MS, the stream still open): a reply is refused, a queued message waits.
    await sleep(ONLINE_TEST_MS + 300);
    const late = await post(`/api/runs/${mirrorOnly.id}/reply`, { text: "are you there?" });
    assert.equal(late.status, 409, late.text);
    assert.match(late.text, /offline/);
    const queued = await post(`/api/runs/${mirrorOnly.id}/queue`, { text: "when you're back" });
    assert.equal(queued.status, 202, queued.text);
    assert.equal(JSON.parse(queued.text).run.remote.pending.at(-1).kind, "queue");

    // Back, then Remote control switched off on the computer: a reply is refused.
    assert.equal((await sync({})).status, 200);
    assert.equal((await post(`/api/runs/${mirrorOnly.id}/cancel`, {})).status, 202, "online again");
    assert.equal((await sync({ off: true })).status, 200);
    const off = await post(`/api/runs/${mirrorOnly.id}/reply`, { text: "still there?" });
    assert.equal(off.status, 409, off.text);

    // Revoked on the hosted dashboard with the stream open: the stream closes and the mirror goes.
    assert.equal(stream.ended(), false);
    assert.equal((await post("/api/remote-links", { action: "revoke", id: ana.id })).status, 200);
    for (let i = 0; i < 40 && !stream.ended(); i++) await sleep(50);
    assert.equal(stream.ended(), true, "the link stream closed");
    const after = JSON.parse((await request("GET", "/api/runs", signedIn)).text);
    assert.ok(!(after.remote || []).some((r: any) => r.id === mirrorOnly.id), "its mirrored run is gone");
    assert.equal((await linkStream(ana.headers)).status, 401);
  } finally {
    stream.close();
  }
});

test("hosted server: a heartbeat doesn't change the runs list; each link's online state and last sighting go on the remote-links topic", async () => {
  const ana = await makeLink("Liveness laptop");
  const stream = await openLink(ana.headers);
  assert.equal(stream.status, 200, stream.text);
  const events = sse("/api/events", signedIn);
  let desk: Awaited<ReturnType<typeof makeLink>> | null = null;
  let other: Awaited<ReturnType<typeof linkStream>> | null = null;
  try {
    const sync = (body: object) => request("POST", "/api/remote/sync", ana.headers, { protocol: 1, runs: [], events: [], ...body });
    const run = { id: "liveness-run", label: "Quiet", status: "succeeded", startedAt: new Date().toISOString() };
    assert.equal((await sync({ runs: [run] })).status, 200);
    const mine = (links: any[]) => links.find((l) => l.linkId === ana.id);

    // The list carries the run's link, not its online state; the topic carries that.
    const listed = await events.until((f) => f.event === "runs" && (f.data.remote || []).some((r: any) => r.id === run.id), "the runs list with the run");
    const entry = listed!.data.remote.find((r: any) => r.id === run.id);
    assert.equal(entry.remote.linkId, ana.id);
    assert.ok(!("online" in entry.remote) && !("lastSeenAt" in entry.remote), JSON.stringify(entry.remote));
    assert.equal(listed!.data.remoteLinks, undefined, "the runs topic leaves the links to their own topic");
    const before = JSON.parse((await request("GET", "/api/runs", signedIn)).text);
    const seen = mine(before.remoteLinks).lastSeenAt;
    const first = await events.until((f) => f.event === "remote-links" && mine(f.data)?.lastSeenAt === seen, "the link online");
    assert.deepEqual(mine(first!.data), { linkId: ana.id, label: "Liveness laptop", enabled: true, online: true, lastSeenAt: seen });

    // A heartbeat (a sync with nothing in it): a newer sighting on the topic, the same runs list.
    const runsFrames = events.frames.filter((f) => f.event === "runs").length;
    await sleep(20);
    assert.equal((await sync({})).status, 200);
    const after = JSON.parse((await request("GET", "/api/runs", signedIn)).text);
    const beat = mine(after.remoteLinks).lastSeenAt;
    assert.ok(beat > seen, "GET /api/runs carries the links, with the newer sighting");
    assert.deepEqual(after.remote, before.remote, "the list is the same");
    const next = await events.until((f) => f.event === "remote-links" && mine(f.data)?.lastSeenAt === beat, "the newer sighting");
    assert.equal(mine(next!.data).online, true);
    await sleep(300);
    assert.equal(events.frames.filter((f) => f.event === "runs").length, runsFrames, "no runs frame for the heartbeat");

    // Quiet for ONLINE_MS: offline. Another computer linking now sends the topic again.
    await sleep(ONLINE_TEST_MS + 300);
    assert.equal(mine(JSON.parse((await request("GET", "/api/runs", signedIn)).text).remoteLinks).online, false);
    desk = await makeLink("Liveness desktop");
    other = await openLink(desk.headers);
    assert.equal(other.status, 200, other.text);
    const off = await events.until((f) => f.event === "remote-links" && mine(f.data)?.online === false && f.data.some((l: any) => l.linkId === desk!.id && l.online), "offline, and the other online");
    assert.equal(mine(off!.data).lastSeenAt, mine(next!.data).lastSeenAt, "last seen stays the last sync");
  } finally {
    events.close();
    stream.close();
    other?.close();
    for (const id of [ana.id, desk?.id]) if (id) await post("/api/remote-links", { action: "revoke", id });
  }
});

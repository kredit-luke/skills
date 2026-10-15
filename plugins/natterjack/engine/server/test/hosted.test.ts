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
else if (a.startsWith("ssh-key add")) { fs.writeFileSync(dir + "/gh-ssh-key-add", a); }
else if (a === "api user/ssh_signing_keys") {
  const pub = fs.readFileSync(dir + "/gh/signing_ed25519.pub", "utf8").trim().split(" ").slice(0, 2).join(" ");
  console.log(JSON.stringify([{ id: 6, key: "ssh-ed25519 AAAAsomeoneelse" }, { id: 7, key: pub }]));
}
else if (a.startsWith("api -X DELETE")) { fs.appendFileSync(dir + "/gh-key-deleted", a + "\\n"); }
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
const signedIn = { host: PUBLIC_HOST, [SECRET_HEADER]: SECRET, "x-forwarded-email": "ana@example.com" };
const post = (p: string, body: object) => request("POST", p, { ...signedIn, "x-dash-token": token }, body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fs.mkdirSync(path.join(ROOT, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".claude", "dashboard", "workspace.json"), JSON.stringify({ name: "Shop", codeHost: { kind: "none" } }));
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
  fs.rmSync(path.join(TMP, "gh-approved"));
});

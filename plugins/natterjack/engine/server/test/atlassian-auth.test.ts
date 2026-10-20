// Connect to Atlassian (atlassian-auth.ts): the settings, the authorize URL, the code exchange
// with the client secret, accessible-resources picking the site, refresh with rotation,
// withToken's retry, disconnect, and a hosted dashboard catching the redirect itself
// (oauth-signin.ts "route"), Roam's included. A stub fetcher stands in for Atlassian.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { atlassianCall } from "../src/atlassian.ts";
import {
  ACCESSIBLE_RESOURCES, ATLASSIAN_AUTHORIZE, ATLASSIAN_ME, ATLASSIAN_TOKEN, AtlassianAuth, CONFLUENCE_SCOPES, DEFAULT_ATLASSIAN_REDIRECT,
  JIRA_SCOPES, NOT_CONNECTED, OFFLINE_SCOPE, SECRET_ENV, SECRET_FILE, atlassianConfig, clientSecret,
  type AtlassianAuthOptions, type AtlassianConfig, type AtlassianFetch, type AtlassianToken,
} from "../src/atlassian-auth.ts";
import { JiraTracker } from "../src/issues/jira.ts";
import { ConfluenceProvider } from "../src/docs-providers/confluence.ts";
import { RoamAuth } from "../src/meetings/roam-auth.ts";
import { hostedCallbackUri } from "../src/oauth-signin.ts";

const SITE = "acme.atlassian.net";
const CLOUD = "11111111-2222-3333-4444-555555555555";
const CFG: AtlassianConfig = { used: true, site: SITE, clientId: "client-1", redirectUri: DEFAULT_ATLASSIAN_REDIRECT, scopes: [...JIRA_SCOPES, OFFLINE_SCOPE], problem: null };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Answer = [number, unknown];

function stub(answer: (c: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const fetcher: AtlassianFetch = async (url, init) => {
    const c = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(c);
    const [status, body] = await answer(c);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { calls, fetcher };
}

const json = (c: Call) => JSON.parse(c.body || "{}");
const tokenCalls = (calls: Call[]) => calls.filter((c) => c.url === ATLASSIAN_TOKEN);

/** Atlassian: a1/r1 for a code, a2/r2 (a3/r3, ...) for a refresh; acme and another site granted; /me says Ada. */
function atlassian(opts: { sites?: { id: string; url: string }[]; me?: Answer } = {}) {
  let n = 1;
  return stub((c) => {
    if (c.url === ATLASSIAN_TOKEN) {
      const b = json(c);
      if (b.grant_type === "authorization_code") return [200, { access_token: "a1", expires_in: 3600, refresh_token: "r1", scope: "read:jira-work read:jira-user offline_access", token_type: "Bearer" }];
      n++;
      return [200, { access_token: `a${n}`, expires_in: 3600, refresh_token: `r${n}`, scope: "read:jira-work read:jira-user offline_access", token_type: "Bearer" }];
    }
    if (c.url === ACCESSIBLE_RESOURCES) return [200, opts.sites || [{ id: "other-cloud", url: "https://other.atlassian.net" }, { id: CLOUD, url: `https://${SITE}` }]];
    if (c.url === ATLASSIAN_ME) return opts.me || [200, { account_id: "x", name: "Ada Lovelace", email: "ada@acme.com" }];
    return [404, {}];
  });
}

const ledger = (secret = true) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-atl-auth-"));
  if (secret) fs.writeFileSync(path.join(dir, SECRET_FILE), "shh-secret\n");
  return dir;
};
const tokenFile = (dir: string) => path.join(dir, "atlassian-token.json");
const readToken = (dir: string): AtlassianToken => JSON.parse(fs.readFileSync(tokenFile(dir), "utf8"));
const writeToken = (dir: string, t: Partial<AtlassianToken> = {}) =>
  fs.writeFileSync(tokenFile(dir), JSON.stringify({ accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 3600_000, site: SITE, cloudId: CLOUD, viewer: "Ada", scopes: JIRA_SCOPES, ...t }));

function auth(dir: string, opts: Partial<AtlassianAuthOptions> = {}, cfg: Partial<AtlassianConfig> = {}) {
  return new AtlassianAuth(dir, { ...CFG, ...cfg }, { hosted: true, ...opts });
}

/** A ServerResponse stand-in that keeps what was sent. */
function fakeRes() {
  const r = { status: 0, headers: {} as Record<string, any>, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, any>) { r.status = status; r.headers = headers; return res; },
    end(body?: string) { r.body = body || ""; },
  } as unknown as http.ServerResponse;
  return { r, res };
}

/** A config folder (what .claude/dashboard is) holding these files. */
function workspace(files: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-atl-cfg-"));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  return dir;
}

test("atlassianConfig: the site and default scopes follow Jira and Confluence; listed scopes keep offline_access", () => {
  const jira = atlassianConfig(workspace({ "workspace.json": { issues: { kind: "jira", site: "https://acme.atlassian.net/" }, atlassian: { clientId: " cid " } } }));
  assert.deepEqual(jira, { used: true, site: SITE, clientId: "cid", redirectUri: DEFAULT_ATLASSIAN_REDIRECT, scopes: [...JIRA_SCOPES, OFFLINE_SCOPE], problem: null });

  const both = atlassianConfig(workspace({
    "workspace.json": { issues: { kind: "jira", site: SITE }, atlassian: { clientId: "cid" } },
    "docs.json": { sources: [{ key: "wiki", kind: "external", provider: "confluence", url: `https://${SITE}/wiki` }] },
  }));
  assert.deepEqual(both.scopes, [...JIRA_SCOPES, ...CONFLUENCE_SCOPES, OFFLINE_SCOPE]);

  const wikiOnly = atlassianConfig(workspace({
    "workspace.json": { issues: { kind: "linear" } },
    "docs.json": { sources: [{ key: "wiki", kind: "external", provider: "confluence", url: "https://wiki.atlassian.net/wiki" }] },
  }));
  assert.equal(wikiOnly.site, "wiki.atlassian.net");
  assert.deepEqual(wikiOnly.scopes, [...CONFLUENCE_SCOPES, OFFLINE_SCOPE]);
  assert.equal(wikiOnly.clientId, null);

  const listed = atlassianConfig(workspace({ "workspace.json": { issues: { kind: "jira", site: SITE }, atlassian: { clientId: "cid", scopes: ["read:jira-work", "read:me"] } } }));
  assert.deepEqual(listed.scopes, ["read:jira-work", "read:me", OFFLINE_SCOPE]);

  const none = atlassianConfig(workspace({ "workspace.json": { issues: { kind: "github", repos: ["a/b"] } } }));
  assert.equal(none.used, false);
  assert.equal(none.site, null);
});

test("atlassianConfig: bad settings turn sign-in off with a reason", () => {
  const ws = (atlassian: unknown) => atlassianConfig(workspace({ "workspace.json": { issues: { kind: "jira", site: SITE }, atlassian } })).problem;
  assert.match(ws({ clientId: 42 })!, /atlassian\.clientId" must be/);
  assert.match(ws({ clientId: "c", scopes: "read:jira-work" })!, /atlassian\.scopes" must be a list/);
  assert.match(ws({ clientId: "c", redirectUri: "https://example.com/cb" })!, /atlassian\.redirectUri" must start with http:\/\//);
  assert.match(ws({ clientId: "c", redirectUri: "http://localhost/cb" })!, /needs an explicit port/);
  assert.equal(ws({ clientId: "c", redirectUri: "http://127.0.0.1:4100/atlassian/callback" }), null);
});

test("clientSecret: the env var wins, else the ledger file, else none", () => {
  const dir = ledger();
  const saved = process.env[SECRET_ENV];
  try {
    delete process.env[SECRET_ENV];
    assert.equal(clientSecret(dir), "shh-secret");
    assert.equal(clientSecret(ledger(false)), null);
    // KEY=value works too; left blank, there's no secret.
    const kv = ledger(false);
    fs.writeFileSync(path.join(kv, SECRET_FILE), `${SECRET_ENV}=\n`);
    assert.equal(clientSecret(kv), null);
    fs.writeFileSync(path.join(kv, SECRET_FILE), `${SECRET_ENV}= "kv-secret"\r\n`);
    assert.equal(clientSecret(kv), "kv-secret");
    process.env[SECRET_ENV] = "  from-env ";
    assert.equal(clientSecret(dir), "from-env");
  } finally {
    if (saved === undefined) delete process.env[SECRET_ENV]; else process.env[SECRET_ENV] = saved;
  }
});

test("status: sign-in is offered only with a client id and the secret; no client id is no problem, just no sign-in", () => {
  const saved = process.env[SECRET_ENV];
  delete process.env[SECRET_ENV];
  try {
    assert.deepEqual(auth(ledger()).status(), { used: true, site: SITE, signIn: true, signInProblem: null, connected: false, viewer: null });
    assert.deepEqual(auth(ledger(), {}, { clientId: null }).status(), { used: true, site: SITE, signIn: false, signInProblem: null, connected: false, viewer: null });
    const noSecret = auth(ledger(false)).status();
    assert.equal(noSecret.signIn, false);
    assert.match(noSecret.signInProblem!, /client secret isn't set/);
    assert.equal(auth(ledger(), {}, { problem: "bad" }).status().signInProblem, "bad");
  } finally {
    if (saved !== undefined) process.env[SECRET_ENV] = saved;
  }
});

test("signInStart: Atlassian's authorize URL (audience, scopes with %20, consent), no PKCE; refused when it isn't set up", async () => {
  const a = auth(ledger());
  const start = await a.signInStart();
  assert.equal(start.listening, false);
  assert.equal(start.callback, DEFAULT_ATLASSIAN_REDIRECT);
  const u = new URL(start.url);
  assert.equal(`${u.origin}${u.pathname}`, ATLASSIAN_AUTHORIZE);
  assert.equal(u.searchParams.get("audience"), "api.atlassian.com");
  assert.equal(u.searchParams.get("client_id"), "client-1");
  assert.equal(u.searchParams.get("scope"), "read:jira-work read:jira-user offline_access");
  assert.match(start.url, /scope=read%3Ajira-work%20read%3Ajira-user%20offline_access/);
  assert.equal(u.searchParams.get("redirect_uri"), DEFAULT_ATLASSIAN_REDIRECT);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.ok((u.searchParams.get("state") || "").length >= 40);
  assert.equal(u.searchParams.get("code_challenge"), null);
  a.signInCancel();

  await assert.rejects(auth(ledger(), {}, { clientId: null }).signInStart(), /no "atlassian.clientId"/);
  await assert.rejects(auth(ledger(), {}, { used: false, site: null }).signInStart(), /doesn't read Atlassian/);
  const saved = process.env[SECRET_ENV];
  delete process.env[SECRET_ENV];
  try { await assert.rejects(auth(ledger(false)).signInStart(), /client secret isn't set/); }
  finally { if (saved !== undefined) process.env[SECRET_ENV] = saved; }
});

test("signInFinish: the code is exchanged with the secret, the site's cloud id kept, the token file owner-only", async () => {
  const dir = ledger();
  const { calls, fetcher } = atlassian();
  const a = auth(dir, { fetcher, now: () => 1_000_000 });
  const state = new URL((await a.signInStart()).url).searchParams.get("state");
  const s = await a.signInFinish(`${DEFAULT_ATLASSIAN_REDIRECT}?code=c1&state=${state}`);
  assert.deepEqual(s, { pending: false, done: true, ok: true, message: `Connected to Atlassian as Ada Lovelace (${SITE}).` });

  const [tok] = tokenCalls(calls);
  assert.equal(tok.headers["Content-Type"], "application/json");
  assert.deepEqual(json(tok), { grant_type: "authorization_code", client_id: "client-1", client_secret: "shh-secret", code: "c1", redirect_uri: DEFAULT_ATLASSIAN_REDIRECT });
  const res = calls.find((c) => c.url === ACCESSIBLE_RESOURCES)!;
  assert.equal(res.headers.Authorization, "Bearer a1");

  assert.deepEqual(readToken(dir), { accessToken: "a1", refreshToken: "r1", expiresAt: 1_000_000 + 3600_000, site: SITE, cloudId: CLOUD, viewer: "Ada Lovelace", scopes: ["read:jira-work", "read:jira-user", "offline_access"] });
  assert.deepEqual(fs.readdirSync(dir).sort(), [SECRET_FILE, "atlassian-token.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(tokenFile(dir)).mode & 0o777, 0o600);
  assert.equal(a.status().connected, true);
  assert.equal(a.status().viewer, "Ada Lovelace");
  // Nothing the page sees carries the token.
  assert.ok(!JSON.stringify(a.status()).includes("a1"));
});

test("signInFinish: without read:me the name comes from Jira's myself; and a sign-in that left out the site is refused", async () => {
  const dir = ledger();
  const { fetcher } = stub((c) => {
    if (c.url === ATLASSIAN_TOKEN) return [200, { access_token: "a1", expires_in: 3600, refresh_token: "r1", scope: "read:jira-user offline_access" }];
    if (c.url === ACCESSIBLE_RESOURCES) return [200, [{ id: CLOUD, url: `https://${SITE}` }]];
    if (c.url === ATLASSIAN_ME) return [403, { message: "scope does not match" }];
    if (c.url === `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`) return [200, { displayName: "Ada from Jira" }];
    return [404, {}];
  });
  const a = auth(dir, { fetcher });
  let state = new URL((await a.signInStart()).url).searchParams.get("state");
  assert.equal((await a.signInFinish(`${DEFAULT_ATLASSIAN_REDIRECT}?code=c1&state=${state}`)).message, `Connected to Atlassian as Ada from Jira (${SITE}).`);

  const other = ledger();
  const b = auth(other, { fetcher: atlassian({ sites: [{ id: "x", url: "https://elsewhere.atlassian.net" }] }).fetcher });
  state = new URL((await b.signInStart()).url).searchParams.get("state");
  const s = await b.signInFinish(`${DEFAULT_ATLASSIAN_REDIRECT}?code=c1&state=${state}`);
  assert.equal(s.ok, false);
  assert.match(s.message, /doesn't include acme\.atlassian\.net/);
  assert.equal(fs.existsSync(tokenFile(other)), false);
});

test("signInFinish: Atlassian's error or a refused exchange comes back plainly, nothing stored", async () => {
  const dir = ledger();
  const a = auth(dir, { fetcher: stub(() => [403, { error: "unauthorized_client", error_description: "bad secret" }]).fetcher });
  let state = new URL((await a.signInStart()).url).searchParams.get("state");
  let s = await a.signInFinish(`${DEFAULT_ATLASSIAN_REDIRECT}?code=c1&state=${state}`);
  assert.equal(s.ok, false);
  assert.match(s.message, /Atlassian sign-in failed: Atlassian turned the sign-in down \(unauthorized_client: bad secret\)/);

  state = new URL((await a.signInStart()).url).searchParams.get("state");
  s = await a.signInFinish(`${DEFAULT_ATLASSIAN_REDIRECT}?error=access_denied&state=${state}`);
  assert.match(s.message, /Atlassian didn't grant access/);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
});

test("a sign-in for another site isn't used (the workspace moved to a new site)", () => {
  const dir = ledger();
  writeToken(dir, { site: "old.atlassian.net" });
  const a = auth(dir);
  assert.equal(a.connected(), false);
  assert.equal(a.status().connected, false);
});

test("accessToken: under 5 minutes left refreshes with the secret, rotates and persists; two at once share it", async () => {
  const dir = ledger();
  writeToken(dir, { expiresAt: 1_000_000 + 60_000 });
  const { calls, fetcher } = atlassian();
  const a = auth(dir, { fetcher, now: () => 1_000_000 });
  const [x, y] = await Promise.all([a.accessToken(), a.accessToken()]);
  assert.deepEqual(x, { token: "a2", cloudId: CLOUD });
  assert.deepEqual(y, x);
  assert.equal(tokenCalls(calls).length, 1);
  assert.deepEqual(json(tokenCalls(calls)[0]), { grant_type: "refresh_token", client_id: "client-1", client_secret: "shh-secret", refresh_token: "r1" });
  assert.equal(readToken(dir).refreshToken, "r2");
  assert.equal(readToken(dir).cloudId, CLOUD);

  // Plenty left: no request.
  writeToken(dir, { expiresAt: 1_000_000 + 3600_000 });
  assert.deepEqual(await a.accessToken(), { token: "a1", cloudId: CLOUD });
  assert.equal(tokenCalls(calls).length, 1);
});

test("refresh turned down: the sign-in goes and it says connect again; rotated by another dashboard, theirs is used", async () => {
  const dir = ledger();
  writeToken(dir, { expiresAt: 0 });
  const a = auth(dir, { fetcher: stub(() => [403, { error: "invalid_grant", error_description: "Unknown or invalid refresh token." }]).fetcher });
  await assert.rejects(a.accessToken(), (e: any) => e.code === NOT_CONNECTED && /sign-in expired, connect again\./.test(e.message));
  assert.equal(fs.existsSync(tokenFile(dir)), false);

  // Another dashboard on this ledger refreshed first: the file has its rotated token.
  const dir2 = ledger();
  writeToken(dir2, { expiresAt: 0 });
  const b = auth(dir2, { fetcher: stub(() => { writeToken(dir2, { accessToken: "theirs", refreshToken: "r9" }); return [403, { error: "invalid_grant" }]; }).fetcher });
  assert.equal((await b.accessToken()).token, "theirs");
  assert.equal(readToken(dir2).refreshToken, "r9");

  // The token endpoint down with minutes left: the old token is used.
  const dir3 = ledger();
  writeToken(dir3, { expiresAt: 1_000_000 + 120_000 });
  const c = auth(dir3, { now: () => 1_000_000, fetcher: async () => { throw new Error("ECONNRESET"); } });
  assert.equal((await c.accessToken()).token, "a1");
});

test("withToken: a 401 refreshes once and retries; a second 401 is passed on and the sign-in kept", async () => {
  const dir = ledger();
  writeToken(dir);
  const { fetcher } = atlassian();
  const a = auth(dir, { fetcher });
  const seen: string[] = [];
  const out = await a.withToken(async (t, cloud) => {
    seen.push(`${t}@${cloud}`);
    if (t === "a1") throw Object.assign(new Error("expired"), { status: 401 });
    return "ok";
  });
  assert.equal(out, "ok");
  assert.deepEqual(seen, [`a1@${CLOUD}`, `a2@${CLOUD}`]);

  await assert.rejects(a.withToken(async () => { throw Object.assign(new Error("scope does not match"), { status: 401 }); }), /scope does not match/);
  assert.ok(fs.existsSync(tokenFile(dir)), "a scope 401 doesn't throw the sign-in away");
  // Other failures pass straight through, no refresh.
  await assert.rejects(a.withToken(async () => { throw Object.assign(new Error("gone"), { status: 404 }); }), /gone/);
});

test("disconnect: forgets the sign-in with a note on removing the app; nothing to forget, no note", () => {
  const dir = ledger();
  writeToken(dir);
  const a = auth(dir);
  const out = a.disconnect();
  assert.match(out.note!, /id\.atlassian\.com\/manage-profile\/apps/);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
  assert.deepEqual(a.disconnect(), {});
});

test("code exchange racing a disconnect: nothing is saved and it says cancelled", async () => {
  const dir = ledger();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const base = atlassian();
  const a = auth(dir, { fetcher: async (url, init) => { if (url === ATLASSIAN_TOKEN) await held; return base.fetcher(url, init); } });
  const state = new URL((await a.signInStart()).url).searchParams.get("state");
  const finishing = a.signInFinish(`${DEFAULT_ATLASSIAN_REDIRECT}?code=c1&state=${state}`);
  a.disconnect();
  release();
  const s = await finishing;
  assert.equal(s.ok, false);
  assert.match(s.message, /cancelled/);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
});

test("hosted with a public address: the browser comes back to the dashboard, which finishes the sign-in (no paste)", async () => {
  const dir = ledger();
  const { calls, fetcher } = atlassian();
  const callbackUri = hostedCallbackUri("https://agents.example.com/", "atlassian");
  assert.equal(callbackUri, "https://agents.example.com/api/oauth/atlassian/callback");
  const a = auth(dir, { fetcher, callbackUri });
  const start = await a.signInStart();
  assert.equal(start.listening, true);
  assert.equal(start.callback, callbackUri);
  assert.equal(new URL(start.url).searchParams.get("redirect_uri"), callbackUri);
  const state = new URL(start.url).searchParams.get("state");
  await assert.rejects(a.signInFinish(`http://localhost:1/x?code=c1&state=${state}`), /finishes sign-in by itself/);

  // A wrong state: turned away, still waiting.
  let { r, res } = fakeRes();
  await a.signInCallback(new URL(`${callbackUri}?code=c1&state=nope`), res, "https://agents.example.com/");
  assert.equal(r.status, 400);
  assert.match(r.body, /state doesn&#39;t match/);
  assert.equal(a.signInStatus().pending, true);

  ({ r, res } = fakeRes());
  await a.signInCallback(new URL(`${callbackUri}?code=c1&state=${state}`), res, "https://agents.example.com/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.match(r.body, /Connected to Atlassian as Ada Lovelace/);
  assert.match(r.body, /href="https:\/\/agents\.example\.com\/"/);
  assert.equal(json(tokenCalls(calls)[0]).redirect_uri, callbackUri);
  assert.equal(readToken(dir).accessToken, "a1");

  // The page polls once and hears it; a reload of the callback after that says it's not waiting.
  assert.equal(a.signInStatus().ok, true);
  ({ r, res } = fakeRes());
  await a.signInCallback(new URL(`${callbackUri}?code=c1&state=${state}`), res, "https://agents.example.com/");
  assert.equal(r.status, 410);
});

test("Roam on a hosted dashboard with a public address uses the same callback route", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-roam-route-"));
  const callbackUri = hostedCallbackUri("https://agents.example.com", "roam");
  const { fetcher } = stub((c) => {
    if (c.url === "https://ro.am/oauth/token") return [200, { access_token: "ra", refresh_token: "rr", expires_in: 604800, scope: "meetings:read user:read" }];
    if (c.url.endsWith("/token.info")) return [200, { ok: true, user: { name: "Ada" }, scopes: ["meetings:read", "user:read"] }];
    return [200, { ok: true }];
  });
  const roam = new RoamAuth(dir, { label: "Roam", clientId: "rc", redirectUri: "http://localhost:31417/roam/callback", signInProblem: null }, { hosted: true, callbackUri, fetcher: fetcher as any });
  const start = await roam.signInStart();
  assert.equal(start.listening, true);
  assert.equal(new URL(start.url).searchParams.get("redirect_uri"), callbackUri);
  const { r, res } = fakeRes();
  await roam.signInCallback(new URL(`${callbackUri}?code=c1&state=${new URL(start.url).searchParams.get("state")}`), res, "https://agents.example.com/");
  assert.equal(r.status, 200);
  assert.match(r.body, /Connected to Roam as Ada/);
  assert.equal(roam.connection()?.via, "oauth");
});

test("atlassianCall: a sign-in goes straight to the gateway with Bearer; an API token keeps Basic at the site", async () => {
  const dir = ledger();
  writeToken(dir);
  const a = auth(dir);
  const seen: [string, string][] = [];
  await atlassianCall("confluence", SITE, { kind: "signin", auth: a }, "/wiki/rest/api/space", async (url, h) => { seen.push([url, h]); return {}; });
  await atlassianCall("jira", SITE, { kind: "token", cred: "me@acme.com:tok" }, "/rest/api/3/myself", async (url, h) => { seen.push([url, h]); return {}; });
  assert.deepEqual(seen, [
    [`https://api.atlassian.com/ex/confluence/${CLOUD}/wiki/rest/api/space`, "Bearer a1"],
    [`https://${SITE}/rest/api/3/myself`, `Basic ${Buffer.from("me@acme.com:tok").toString("base64")}`],
  ]);
});

test("Jira and Confluence: a sign-in for their site comes first; the API token is the fallback", () => {
  const dir = ledger();
  fs.writeFileSync(path.join(dir, "jira-api-token"), "me@acme.com:jira-token-123");
  const a = auth(dir);
  const jira = new JiraTracker(dir, { kind: "jira", label: "Jira", site: SITE, implementStates: [], ticketPattern: "" } as any, () => a);
  jira.docsSources = () => [];
  assert.deepEqual(jira.status(), { connected: true, source: "file", viewer: null });
  assert.equal(jira._auth()!.kind, "token");
  assert.equal(jira.connectHelp()!.signIn, "atlassian");

  writeToken(dir);
  assert.deepEqual(jira.status(), { connected: true, source: "signin", viewer: "Ada" });
  assert.equal(jira._auth()!.kind, "signin");
  assert.equal(jira._cred(), "me@acme.com:jira-token-123", "the API token is still there as the fallback");

  const wiki = new ConfluenceProvider({ key: "wiki", name: "Wiki", kind: "external", provider: "confluence", url: `https://${SITE}/wiki` } as any, { ledgerDir: dir, issues: { kind: "jira", site: SITE }, atlassian: () => a });
  assert.deepEqual(wiki.status(), { connected: true, source: "signin", removable: true, viewer: "Ada" });
  assert.equal(wiki._auth("checking@acme.com:key")!.kind, "token", "a key being checked is used as given");

  // Another site's tracker doesn't use this sign-in.
  const elsewhere = new JiraTracker(dir, { kind: "jira", label: "Jira", site: "other.atlassian.net", implementStates: [], ticketPattern: "" } as any, () => a);
  elsewhere.docsSources = () => [];
  assert.equal(elsewhere._signIn(), null);

  a.disconnect();
  assert.deepEqual(jira.status(), { connected: true, source: "file", viewer: null });
});

test("review: Confluence scopes come from any Confluence source on the sign-in's site, not just the first", () => {
  const cfg = atlassianConfig(workspace({
    "workspace.json": { issues: { kind: "jira", site: SITE }, atlassian: { clientId: "cid" } },
    "docs.json": { sources: [
      { key: "other", kind: "external", provider: "confluence", url: "https://other.atlassian.net/wiki" },
      { key: "wiki", kind: "external", provider: "confluence", url: `https://${SITE}/wiki` },
    ] },
  }));
  assert.deepEqual(cfg.scopes, [...JIRA_SCOPES, ...CONFLUENCE_SCOPES, OFFLINE_SCOPE]);
});

test("review: a token file that can't be deleted makes disconnect fail instead of claiming it's forgotten", () => {
  const dir = ledger();
  fs.mkdirSync(tokenFile(dir)); // unlink on a directory fails (EPERM/EISDIR), not ENOENT
  assert.throws(() => auth(dir).disconnect());
  fs.rmdirSync(tokenFile(dir));
  assert.doesNotThrow(() => auth(dir).disconnect(), "already gone is fine");
});

test("review: Confluence offers Connect to Atlassian only when the sign-in is for its own site", () => {
  const dir = ledger();
  const a = auth(dir);
  const ctx = { ledgerDir: dir, issues: { kind: "jira", site: SITE }, atlassian: () => a };
  const same = new ConfluenceProvider({ key: "w", name: "W", kind: "external", provider: "confluence", url: `https://${SITE}/wiki` } as any, ctx);
  const other = new ConfluenceProvider({ key: "o", name: "O", kind: "external", provider: "confluence", url: "https://other.atlassian.net/wiki" } as any, ctx);
  assert.equal(same.connectHelp()!.signIn, "atlassian");
  assert.equal(other.connectHelp()!.signIn, undefined);
});

test("review: Jira forgets the viewer and the board when the credential in use changes (sign-in expired → API token)", () => {
  const dir = ledger();
  fs.writeFileSync(path.join(dir, "jira-api-token"), "bo@acme.com:jira-token-123");
  writeToken(dir);
  const a = auth(dir);
  const jira = new JiraTracker(dir, { kind: "jira", label: "Jira", site: SITE, implementStates: [], ticketPattern: "" } as any, () => a);
  jira.docsSources = () => [];
  assert.equal(jira._auth()!.kind, "signin");
  jira.viewer = "Ada";
  jira.cache = { issues: [{ id: "ENG-1" }] } as any;
  assert.equal(jira._auth()!.kind, "signin");
  assert.equal(jira.viewer, "Ada", "same credential: kept");
  fs.unlinkSync(tokenFile(dir)); // the sign-in expired and was forgotten
  assert.equal(jira._auth()!.kind, "token");
  assert.equal(jira.viewer, null);
  assert.equal(jira.cache, null);
  assert.deepEqual(jira.status(), { connected: true, source: "file", viewer: null });
});

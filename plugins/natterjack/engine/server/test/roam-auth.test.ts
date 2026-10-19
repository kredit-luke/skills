// Roam sign-in and the token file (roam-auth.ts): PKCE, the authorize URL, the loopback
// listener and paste-back, the code exchange, refresh with rotation, withToken's retry,
// personal access tokens and disconnect. A stub fetcher stands in for Roam; listeners use port 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Meetings } from "../src/meetings/index.ts";
import { RoamError, type RoamFetch } from "../src/meetings/roam-api.ts";
import {
  NOT_CONNECTED, ROAM_AUTHORIZE, ROAM_TOKEN, RoamAuth, pkceChallenge, pkceVerifier, signInErrorMessage,
  type RoamAuthConfig, type RoamAuthOptions, type RoamToken,
} from "../src/meetings/roam-auth.ts";

const REDIRECT = "http://localhost:31417/roam/callback";
const CFG: RoamAuthConfig = { label: "Roam", clientId: "client-1", redirectUri: REDIRECT, signInProblem: null };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Answer = [number, unknown];

/** A fetcher that records each call and answers from `answer(call)` (JSON bodies). */
function stub(answer: (c: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const fetcher: RoamFetch = async (url, init) => {
    const c = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(c);
    const [status, body] = await answer(c);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { calls, fetcher };
}

const tokenCalls = (calls: Call[]) => calls.filter((c) => c.url === ROAM_TOKEN);
const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body || ""));
const ledger = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-roam-auth-"));
const tokenFile = (dir: string) => path.join(dir, "roam-token.json");
const readToken = (dir: string): RoamToken => JSON.parse(fs.readFileSync(tokenFile(dir), "utf8"));
const writeToken = (dir: string, t: Partial<RoamToken>) =>
  fs.writeFileSync(tokenFile(dir), JSON.stringify({ via: "oauth", accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 3600_000, viewer: "Ada", scopes: ["meetings:read"], ...t }));

/** Roam that hands out a1/r1 for a code, a2/r2 (then a3/r3, ...) for a refresh, and says who the token is. */
function roam(opts: { delayMs?: number } = {}) {
  let n = 1;
  return stub(async (c) => {
    if (c.url === ROAM_TOKEN) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const f = form(c);
      if (f.grant_type === "authorization_code") return [200, { access_token: "a1", token_type: "Bearer", expires_in: 604800, refresh_token: "r1", scope: "meetings:read user:read" }];
      n++;
      return [200, { access_token: `a${n}`, token_type: "Bearer", expires_in: 604800, refresh_token: `r${n}`, scope: "meetings:read user:read" }];
    }
    if (c.url.endsWith("/token.info")) return [200, { ok: true, user: { name: "Ada" }, scopes: ["meetings:read", "user:read"] }];
    return [200, { ok: true }];
  });
}

function auth(dir: string, opts: Partial<RoamAuthOptions> = {}, cfg: Partial<RoamAuthConfig> = {}) {
  return new RoamAuth(dir, { ...CFG, ...cfg }, { hosted: true, ...opts });
}

/** Whether the port can be bound on host: true/false, or null when host isn't there (no IPv6 loopback). */
const bindable = (port: number, host: string) => new Promise<boolean | null>((resolve) => {
  const s = net.createServer();
  s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRINUSE" || e.code === "EACCES" ? false : null));
  s.listen(port, host, () => s.close(() => resolve(true)));
});

/** Whether nothing is listening on port, on 127.0.0.1 and (where there is one) ::1; retries briefly while a close lands. */
async function portFree(port: number, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await bindable(port, "127.0.0.1") && await bindable(port, "::1") !== false) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** A free port to use as a fixed listen port. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

/** A promise the test opens when it's ready. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}

/** Wait (up to ~2s) for cond to hold. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), "timed out waiting");
}

/** Roam whose token endpoint waits for `g` (a1/r1 for a code, a2/r2 for a refresh); everything else answers at once. */
function gatedRoam(g: { opened: Promise<void> }) {
  return stub(async (c) => {
    if (c.url === ROAM_TOKEN) {
      await g.opened;
      const refresh = form(c).grant_type === "refresh_token";
      return [200, { access_token: refresh ? "a2" : "a1", token_type: "Bearer", expires_in: 604800, refresh_token: refresh ? "r2" : "r1", scope: "meetings:read user:read" }];
    }
    if (c.url.endsWith("/token.info")) {
      const pat = c.headers.Authorization === "Bearer pat-1";
      return [200, { ok: true, user: { name: pat ? "Pat" : "Ada" }, scopes: ["meetings:read", "user:read"] }];
    }
    return [200, { ok: true }];
  });
}

test("PKCE: the RFC 7636 Appendix B vector, and a fresh 43-character verifier", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const v = pkceVerifier();
  assert.match(v, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(v, pkceVerifier());
});

test("signInStart: the authorize URL carries the client, redirect, scopes, state and an S256 challenge", async () => {
  const a = auth(ledger());
  const start = await a.signInStart();
  assert.equal(start.listening, false);
  assert.equal(start.callback, REDIRECT);
  assert.ok(start.url.startsWith(`${ROAM_AUTHORIZE}?`));
  assert.match(start.url, /scope=meetings%3Aread%20user%3Aread/);
  const q = new URL(start.url).searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "client-1");
  assert.equal(q.get("redirect_uri"), REDIRECT);
  assert.equal(q.get("scope"), "meetings:read user:read");
  assert.match(q.get("state") || "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get("code_challenge") || "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(a.signInStatus().pending, true);
  a.signInCancel();
  assert.equal(a.signInStatus().pending, false);
});

test("signInStart refuses without a clientId, or with a sign-in problem", async () => {
  await assert.rejects(auth(ledger(), {}, { clientId: null }).signInStart(), /isn't set up .*"clientId".*personal access token/);
  await assert.rejects(auth(ledger(), {}, { signInProblem: 'meetings.json: "redirectUri" needs an explicit port' }).signInStart(), /sign-in is off: .*explicit port/);
});

test("signInFinish: a wrong state, port or path is turned down and the sign-in keeps waiting", async () => {
  const { calls, fetcher } = roam();
  const a = auth(ledger(), { fetcher });
  const start = await a.signInStart();
  const state = new URL(start.url).searchParams.get("state");
  await assert.rejects(a.signInFinish(`${REDIRECT}?code=c1&state=not-the-state`), /state doesn't match/);
  await assert.rejects(a.signInFinish(`http://localhost:31418/roam/callback?code=c1&state=${state}`), /isn't the address sign-in ended on/);
  await assert.rejects(a.signInFinish(`http://localhost:31417/other?code=c1&state=${state}`), /isn't the address sign-in ended on/);
  await assert.rejects(a.signInFinish("not an address"), /Paste the whole address/);
  assert.equal(calls.length, 0);
  assert.equal(a.signInStatus().pending, true);
  a.signInCancel();
});

test("signInFinish: the code is exchanged (PKCE, no secret) and the token file written owner-only", async () => {
  const dir = ledger();
  const { calls, fetcher } = roam();
  const a = auth(dir, { fetcher, now: () => 1_000_000 });
  const start = await a.signInStart();
  const q = new URL(start.url).searchParams;
  const s = await a.signInFinish(`${REDIRECT}?code=c1&state=${q.get("state")}`);
  assert.deepEqual(s, { pending: false, done: true, ok: true, message: "Connected to Roam as Ada." });

  const [tok] = tokenCalls(calls);
  assert.equal(tok.method, "POST");
  assert.equal(tok.headers["Content-Type"], "application/x-www-form-urlencoded");
  const f = form(tok);
  assert.deepEqual(Object.keys(f).sort(), ["client_id", "code", "code_verifier", "grant_type", "redirect_uri"]);
  assert.equal(f.grant_type, "authorization_code");
  assert.equal(f.code, "c1");
  assert.equal(f.redirect_uri, REDIRECT);
  assert.equal(f.client_id, "client-1");
  assert.equal(pkceChallenge(f.code_verifier), q.get("code_challenge"));
  // Then token.info, with the new token.
  const info = calls.find((c) => c.url.endsWith("/token.info"))!;
  assert.equal(info.headers.Authorization, "Bearer a1");

  assert.deepEqual(readToken(dir), { via: "oauth", accessToken: "a1", refreshToken: "r1", expiresAt: 1_000_000 + 604800_000, viewer: "Ada", scopes: ["meetings:read", "user:read"] });
  assert.deepEqual(fs.readdirSync(dir), ["roam-token.json"]); // no temp file left behind
  if (process.platform !== "win32") assert.equal(fs.statSync(tokenFile(dir)).mode & 0o777, 0o600);
  assert.deepEqual(a.connection(), { via: "oauth", viewer: "Ada", scopes: ["meetings:read", "user:read"] });
  // Reported once, then nothing's waiting.
  assert.equal(a.signInStatus().done, true);
  assert.equal(a.signInStatus().message, "No sign-in is waiting.");
});

test("signInFinish: Roam's error comes back as a plain message, and nothing is stored", async () => {
  const dir = ledger();
  const { calls, fetcher } = roam();
  const a = auth(dir, { fetcher });
  let state = new URL((await a.signInStart()).url).searchParams.get("state");
  let s = await a.signInFinish(`${REDIRECT}?error=access_denied&state=${state}`);
  assert.equal(s.ok, false);
  assert.equal(s.done, true);
  assert.match(s.message, /didn't grant access.*admin may have to approve/);
  state = new URL((await a.signInStart()).url).searchParams.get("state");
  s = await a.signInFinish(`${REDIRECT}?error=access_denied&error_description=${encodeURIComponent("Waiting for admin approval")}&state=${state}`);
  assert.match(s.message, /^A Roam admin has to approve this app for you first/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
  assert.match(signInErrorMessage("Roam", "server_error", null), /Roam sign-in failed: server_error/);
});

test("signInErrorMessage: a plain 'did not approve' is a decline, not admin approval", () => {
  const declined = signInErrorMessage("Roam", "access_denied", "The user did not approve the request");
  assert.doesNotMatch(declined, /^A Roam admin has to approve/);
  assert.match(declined, /^Roam didn't grant access \(The user did not approve the request\)\. If you declined, start again/);
  assert.match(signInErrorMessage("Roam", "access_denied", "Pending approval by your workspace"), /^A Roam admin has to approve/);
  assert.match(signInErrorMessage("Roam", "access_denied", "An admin must allow this app"), /^A Roam admin has to approve/);
});

test("signInFinish: a refused code exchange says so", async () => {
  const dir = ledger();
  const { fetcher } = stub(() => [400, { error: "invalid_grant", error_description: "code expired" }]);
  const a = auth(dir, { fetcher });
  const state = new URL((await a.signInStart()).url).searchParams.get("state");
  const s = await a.signInFinish(`${REDIRECT}?code=c1&state=${state}`);
  assert.equal(s.ok, false);
  assert.match(s.message, /invalid_grant: code expired/);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
});

test("accessToken: under 10 minutes left refreshes, rotates and persists; otherwise no request", async () => {
  const dir = ledger();
  const { calls, fetcher } = roam();
  const now = 5_000_000;
  writeToken(dir, { expiresAt: now + 11 * 60_000 });
  const a = auth(dir, { fetcher, now: () => now });
  assert.equal(await a.accessToken(), "a1");
  assert.equal(calls.length, 0);

  writeToken(dir, { expiresAt: now + 9 * 60_000 });
  assert.equal(await a.accessToken(), "a2");
  const [tok] = tokenCalls(calls);
  assert.deepEqual(form(tok), { grant_type: "refresh_token", refresh_token: "r1", client_id: "client-1" });
  const t = readToken(dir);
  assert.equal(t.accessToken, "a2");
  assert.equal(t.refreshToken, "r2");
  assert.equal(t.expiresAt, now + 604800_000);
  assert.equal(t.viewer, "Ada");
});

test("accessToken: two at once share one refresh (a second would burn the rotated token)", async () => {
  const dir = ledger();
  const { calls, fetcher } = roam({ delayMs: 30 });
  writeToken(dir, { expiresAt: Date.now() - 1 });
  const a = auth(dir, { fetcher });
  const [x, y] = await Promise.all([a.accessToken(), a.accessToken()]);
  assert.equal(x, "a2");
  assert.equal(y, "a2");
  assert.equal(tokenCalls(calls).length, 1);
  assert.equal(readToken(dir).refreshToken, "r2");
});

test("refresh turned down: the token file goes and it says to connect again; Roam down keeps it", async () => {
  const dir = ledger();
  writeToken(dir, { expiresAt: Date.now() - 1 });
  let a = auth(dir, { fetcher: stub(() => [400, { error: "invalid_grant" }]).fetcher });
  await assert.rejects(a.accessToken(), (e: any) => e instanceof RoamError && e.code === NOT_CONNECTED && /Roam sign-in expired, connect again\.$/.test(e.message));
  assert.equal(fs.existsSync(tokenFile(dir)), false);
  await assert.rejects(a.accessToken(), (e: any) => e.code === NOT_CONNECTED);

  writeToken(dir, { expiresAt: Date.now() - 1 });
  a = auth(dir, { fetcher: stub(() => [503, {}]).fetcher });
  await assert.rejects(a.accessToken(), (e: any) => e instanceof RoamError && e.status === 503);
  assert.equal(fs.existsSync(tokenFile(dir)), true);
});

test("withToken: invalid_token refreshes once and retries once", async () => {
  const dir = ledger();
  const { calls, fetcher } = roam();
  writeToken(dir, {});
  const a = auth(dir, { fetcher });
  const seen: string[] = [];
  const out = await a.withToken(async (token) => {
    seen.push(token);
    if (token === "a1") throw new RoamError(401, "invalid_token", "nope");
    return "meetings";
  });
  assert.equal(out, "meetings");
  assert.deepEqual(seen, ["a1", "a2"]);
  assert.equal(tokenCalls(calls).length, 1);
  assert.equal(readToken(dir).refreshToken, "r2");

  // Still refused after the refresh: disconnected, no second refresh.
  seen.length = 0;
  await assert.rejects(a.withToken(async (token) => { seen.push(token); throw new RoamError(401, "invalid_token", "nope"); }), (e: any) => e.code === NOT_CONNECTED);
  assert.deepEqual(seen, ["a2", "a3"]);
  assert.equal(tokenCalls(calls).length, 2);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
});

test("withToken: token_revoked forgets the token; other errors pass through", async () => {
  const dir = ledger();
  const { calls, fetcher } = roam();
  writeToken(dir, {});
  const a = auth(dir, { fetcher });
  await assert.rejects(a.withToken(async () => { throw new RoamError(429, "ratelimited", "slow down"); }), /slow down/);
  assert.equal(fs.existsSync(tokenFile(dir)), true);
  await assert.rejects(a.withToken(async () => { throw new RoamError(401, "token_revoked", "gone"); }),
    (e: any) => e.code === NOT_CONNECTED && /Roam revoked access, connect again/.test(e.message));
  assert.equal(fs.existsSync(tokenFile(dir)), false);
  assert.equal(calls.length, 0);
});

test("a personal access token never refreshes: invalid_token means disconnected", async () => {
  const dir = ledger();
  const { calls, fetcher } = roam();
  writeToken(dir, { via: "token", accessToken: "pat", refreshToken: null, expiresAt: null });
  const a = auth(dir, { fetcher });
  assert.equal(await a.accessToken(), "pat");
  await assert.rejects(a.withToken(async () => { throw new RoamError(401, "invalid_token", "nope"); }), (e: any) => e.code === NOT_CONNECTED);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
});

test("connectToken: checked with token.info; empty, refused or missing meetings:read is turned down", async () => {
  const dir = ledger();
  await assert.rejects(auth(dir).connectToken("  "), (e: any) => e.status === 400 && /Paste a Roam personal access token/.test(e.message));

  let a = auth(dir, { fetcher: stub(() => [401, { ok: false, error: "invalid_token" }]).fetcher });
  await assert.rejects(a.connectToken("bad"), (e: any) => e.status === 400 && /didn't accept that token/.test(e.message));

  a = auth(dir, { fetcher: stub(() => [200, { ok: true, user: { name: "Ada" }, scopes: ["user:read"] }]).fetcher });
  await assert.rejects(a.connectToken("narrow"), (e: any) => e.status === 400 && /doesn't have the meetings:read scope/.test(e.message));
  assert.equal(fs.existsSync(tokenFile(dir)), false);

  const { calls, fetcher } = roam();
  a = auth(dir, { fetcher });
  const t = await a.connectToken(" pat-1 ");
  assert.equal(calls[0].headers.Authorization, "Bearer pat-1");
  assert.deepEqual(readToken(dir), { via: "token", accessToken: "pat-1", refreshToken: null, expiresAt: null, viewer: "Ada", scopes: ["meetings:read", "user:read"] });
  assert.equal(t.via, "token");
});

test("disconnect: revokes, then deletes the file even when Roam refuses (with a note)", async () => {
  const dir = ledger();
  let s = stub(() => [200, { ok: true }]);
  writeToken(dir, {});
  assert.deepEqual(await auth(dir, { fetcher: s.fetcher }).disconnect(), {});
  assert.equal(s.calls.length, 1);
  assert.ok(s.calls[0].url.endsWith("/token.revoke"));
  assert.equal(s.calls[0].method, "POST");
  assert.equal(s.calls[0].headers.Authorization, "Bearer a1");
  assert.equal(fs.existsSync(tokenFile(dir)), false);

  s = stub(() => [400, { ok: false, error: "invalid_request" }]);
  writeToken(dir, { via: "token", accessToken: "pat", refreshToken: null, expiresAt: null });
  const out = await auth(dir, { fetcher: s.fetcher }).disconnect();
  assert.equal(s.calls.length, 1);
  assert.match(out.note || "", /didn't revoke the personal access token.*User Settings → Developer/);
  assert.equal(fs.existsSync(tokenFile(dir)), false);

  // Nothing stored: nothing to do.
  assert.deepEqual(await auth(dir, { fetcher: s.fetcher }).disconnect(), {});
  assert.equal(s.calls.length, 1);
});

test("hosted never listens", async () => {
  let listens = 0;
  const a = auth(ledger(), { hosted: true, listen: async () => { listens++; } });
  assert.equal((await a.signInStart()).listening, false);
  assert.equal(listens, 0);
  assert.equal(a.listenerPort(), null);
  a.signInCancel();
});

test("local: a taken port (EADDRINUSE) or one it may not use (EACCES) → listening:false, paste instead", async () => {
  const taken = http.createServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", () => r()));
  const port = (taken.address() as net.AddressInfo).port;
  try {
    const a = auth(ledger(), { hosted: false, listenPort: port });
    const start = await a.signInStart();
    assert.equal(start.listening, false);
    assert.equal(a.signInStatus().pending, true); // the paste box still works
    a.signInCancel();
  } finally {
    await new Promise((r) => taken.close(r));
  }

  const b = auth(ledger(), { hosted: false, listen: async () => { throw Object.assign(new Error("listen EACCES"), { code: "EACCES" }); } });
  assert.equal((await b.signInStart()).listening, false);
  b.signInCancel();
});

test("local listener end to end: a wrong state is turned away, the right one stores the token and closes it", async () => {
  const dir = ledger();
  const { fetcher } = roam();
  const a = auth(dir, { hosted: false, fetcher, listenPort: 0 });
  const start = await a.signInStart();
  assert.equal(start.listening, true);
  const port = a.listenerPort()!;
  assert.ok(port > 0);
  const state = new URL(start.url).searchParams.get("state");
  const base = `http://127.0.0.1:${port}/roam/callback`;

  let res = await fetch(`${base}?code=c1&state=wrong`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /state doesn&#39;t match/);
  res = await fetch(`http://127.0.0.1:${port}/elsewhere`);
  assert.equal(res.status, 404);
  await res.text();
  assert.equal(a.signInStatus().pending, true);

  res = await fetch(`${base}?code=c1&state=${state}`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /Connected to Roam as Ada\./);
  assert.match(page, /Go back to the dashboard/);
  assert.equal(readToken(dir).accessToken, "a1");
  assert.equal(a.listenerPort(), null);
  assert.equal(await portFree(port), true);
  assert.deepEqual(a.signInStatus(), { pending: false, done: true, ok: true, message: "Connected to Roam as Ada." });
});

test("Meetings: rewriting meetings.json mid sign-in cancels it and frees the listener's port", async () => {
  // A free port for redirectUri (Meetings listens on redirectUri's own port).
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise((r) => probe.close(r));

  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-roam-auth-cfg-"));
  const write = (data: unknown) => {
    const file = path.join(cfgDir, "meetings.json");
    fs.writeFileSync(file, JSON.stringify(data));
    const t = new Date(Date.now() + Math.random() * 1e6);
    fs.utimesSync(file, t, t);
  };
  write({ source: "roam", clientId: "client-1", redirectUri: `http://127.0.0.1:${port}/roam/callback` });
  const m = new Meetings(cfgDir, { ledgerDir: ledger(), hosted: false });
  const source = m.get()!;
  const start = await source.signInStart();
  assert.equal(start.listening, true);
  assert.equal(await portFree(port, 1), false);
  assert.equal(source.signInStatus().pending, true);

  write({ source: "roam", clientId: "client-2", redirectUri: `http://127.0.0.1:${port}/roam/callback` });
  m.status();
  assert.notEqual(m.get(), source);
  assert.equal(source.signInStatus().pending, false);
  assert.equal(await portFree(port), true);
});

test("the token stays out of what the page sees", async () => {
  const dir = ledger();
  writeToken(dir, { accessToken: "secret-a", refreshToken: "secret-r" });
  const shown = JSON.stringify(auth(dir).connection());
  assert.ok(!shown.includes("secret"));
});

test("refresh racing a disconnect: the refreshed token isn't written back", async () => {
  const dir = ledger();
  const g = gate();
  const { calls, fetcher } = gatedRoam(g);
  writeToken(dir, {}); // an hour left: disconnect revokes with it and doesn't join the refresh
  const a = auth(dir, { fetcher });
  // Only the refreshed token works, so nothing but the guard stops it being saved and used.
  const run = a.withToken(async (token) => { if (token === "a1") throw new RoamError(401, "invalid_token", "nope"); return "meetings"; });
  await until(() => tokenCalls(calls).length === 1);
  assert.deepEqual(await a.disconnect(), {});
  assert.equal(fs.existsSync(tokenFile(dir)), false);
  g.open();
  await assert.rejects(run, (e: any) => e instanceof RoamError && e.code === NOT_CONNECTED);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
});

test("refresh refused because another dashboard already rotated it: theirs is used, nothing deleted", async () => {
  const dir = ledger();
  const now = 5_000_000;
  writeToken(dir, { expiresAt: now + 5 * 60_000 });
  const { calls, fetcher } = stub(() => {
    // The other dashboard wins the race and writes r9 before Roam answers us.
    writeToken(dir, { accessToken: "a9", refreshToken: "r9", expiresAt: now + 604800_000 });
    return [400, { error: "invalid_grant" }];
  });
  const a = auth(dir, { fetcher, now: () => now });
  assert.equal(await a.accessToken(), "a9");
  assert.equal(tokenCalls(calls).length, 1);
  assert.equal(readToken(dir).refreshToken, "r9");
});

test("accessToken: the token endpoint down with minutes left uses the old token; expired, it fails", async () => {
  const dir = ledger();
  const now = 5_000_000;
  writeToken(dir, { expiresAt: now + 5 * 60_000 });
  const { calls, fetcher } = stub(() => [503, {}]);
  const a = auth(dir, { fetcher, now: () => now });
  assert.equal(await a.accessToken(), "a1");
  assert.equal(tokenCalls(calls).length, 1);
  assert.equal(readToken(dir).refreshToken, "r1");

  writeToken(dir, { expiresAt: now - 1 });
  await assert.rejects(a.accessToken(), (e: any) => e instanceof RoamError && e.status === 503);
  assert.equal(fs.existsSync(tokenFile(dir)), true);
});

test("disconnect with an expired token: refreshed then revoked; or, the sign-in already dead, no 'still works' note", async () => {
  const dir = ledger();
  writeToken(dir, { expiresAt: Date.now() - 1 });
  const ok = roam();
  assert.deepEqual(await auth(dir, { fetcher: ok.fetcher }).disconnect(), {});
  assert.equal(tokenCalls(ok.calls).length, 1);
  const revoke = ok.calls.find((c) => c.url.endsWith("/token.revoke"))!;
  assert.equal(revoke.headers.Authorization, "Bearer a2");
  assert.equal(fs.existsSync(tokenFile(dir)), false);

  writeToken(dir, { expiresAt: Date.now() - 1 });
  const refused = stub((c) => c.url === ROAM_TOKEN ? [400, { error: "invalid_grant" }] : [400, { ok: false, error: "invalid_token" }]);
  const out = await auth(dir, { fetcher: refused.fetcher }).disconnect();
  assert.deepEqual(out, {});
  assert.equal(refused.calls.filter((c) => c.url.endsWith("/token.revoke")).length, 0);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
});

test("code exchange racing a disconnect: nothing is saved and it says cancelled", async () => {
  const dir = ledger();
  const g = gate();
  const { calls, fetcher } = gatedRoam(g);
  const a = auth(dir, { fetcher });
  const state = new URL((await a.signInStart()).url).searchParams.get("state");
  const finishing = a.signInFinish(`${REDIRECT}?code=c1&state=${state}`);
  await until(() => tokenCalls(calls).length === 1);
  assert.deepEqual(await a.disconnect(), {});
  g.open();
  const s = await finishing;
  assert.equal(s.ok, false);
  assert.match(s.message, /sign-in was cancelled/);
  assert.equal(fs.existsSync(tokenFile(dir)), false);
  assert.equal(a.signInStatus().message, "No sign-in is waiting.");
  // The grant it got is no use to anyone: revoked with Roam (best effort).
  await until(() => calls.some((c) => c.url.endsWith("/token.revoke")));
  assert.equal(calls.find((c) => c.url.endsWith("/token.revoke"))!.headers.Authorization, "Bearer a1");
});

test("code exchange racing a pasted token: the pasted token stays", async () => {
  const dir = ledger();
  const g = gate();
  const { calls, fetcher } = gatedRoam(g);
  const a = auth(dir, { fetcher });
  const state = new URL((await a.signInStart()).url).searchParams.get("state");
  const finishing = a.signInFinish(`${REDIRECT}?code=c1&state=${state}`);
  await until(() => tokenCalls(calls).length === 1);
  await a.connectToken("pat-1");
  g.open();
  assert.equal((await finishing).ok, false);
  assert.deepEqual(readToken(dir), { via: "token", accessToken: "pat-1", refreshToken: null, expiresAt: null, viewer: "Pat", scopes: ["meetings:read", "user:read"] });
});

test("the 10-minute limit passing mid exchange: the sign-in still finishes and is reported", async () => {
  const dir = ledger();
  const g = gate();
  const { calls, fetcher } = gatedRoam(g);
  const a = auth(dir, { fetcher, pendingMs: 20 });
  const state = new URL((await a.signInStart()).url).searchParams.get("state");
  const finishing = a.signInFinish(`${REDIRECT}?code=c1&state=${state}`);
  await until(() => tokenCalls(calls).length === 1);
  await new Promise((r) => setTimeout(r, 60));
  g.open();
  assert.equal((await finishing).ok, true);
  assert.equal(readToken(dir).accessToken, "a1");
  assert.deepEqual(a.signInStatus(), { pending: false, done: true, ok: true, message: "Connected to Roam as Ada." });

  // Without a callback, the limit drops it.
  const b = auth(ledger(), { pendingMs: 20 });
  await b.signInStart();
  await until(() => !b.signInStatus().pending);
});

test("the listener and a paste for the same sign-in exchange the code once and agree", async () => {
  const dir = ledger();
  const g = gate();
  const { calls, fetcher } = gatedRoam(g);
  const a = auth(dir, { hosted: false, fetcher, listenPort: 0 });
  const start = await a.signInStart();
  assert.equal(start.listening, true);
  const state = new URL(start.url).searchParams.get("state");
  const port = a.listenerPort()!;
  const got = fetch(`http://127.0.0.1:${port}/roam/callback?code=c1&state=${state}`);
  await until(() => tokenCalls(calls).length === 1);
  const pasted = a.signInFinish(`${REDIRECT}?code=c1&state=${state}`);
  g.open();
  const res = await got;
  const page = await res.text();
  const s = await pasted;
  assert.equal(tokenCalls(calls).length, 1);
  assert.equal(res.status, 200);
  assert.equal(s.ok, true);
  assert.ok(page.includes(s.message));
  assert.equal(await portFree(port), true);
});

test("two sign-ins started back to back: the second still gets the port", async () => {
  const port = await freePort();
  const a = auth(ledger(), { hosted: false, listenPort: port });
  const [first, second] = await Promise.all([a.signInStart(), a.signInStart()]);
  assert.equal(first.listening, false);
  assert.equal(second.listening, true);
  assert.equal(a.listenerPort(), port);
  // And once more after it's fully up.
  assert.equal((await a.signInStart()).listening, true);
  assert.equal(a.listenerPort(), port);
  a.signInCancel();
  assert.equal(await portFree(port), true);
});

test("withToken: a pasted token stays when a call still in flight with the old one comes back revoked or refused", async () => {
  for (const code of ["token_revoked", "invalid_token"]) {
    const dir = ledger();
    const { fetcher } = roam();
    writeToken(dir, {});
    const a = auth(dir, { fetcher });
    const g = gate();
    const seen: string[] = [];
    const run = a.withToken(async (token) => {
      seen.push(token);
      if (token === "a1") { await g.opened; throw new RoamError(401, code, "nope"); }
      return "meetings";
    });
    await until(() => seen.length === 1);
    await a.connectToken("pat-1");
    g.open();
    // Retried once with what's stored now, and the pasted token isn't forgotten.
    assert.equal(await run, "meetings", code);
    assert.deepEqual(seen, ["a1", "pat-1"], code);
    assert.equal(readToken(dir).accessToken, "pat-1", code);
  }
});

test("refresh losing to a new connect: the new token is used, not 'connect again'", async () => {
  const dir = ledger();
  const g = gate();
  const { calls, fetcher } = gatedRoam(g);
  writeToken(dir, {});
  const a = auth(dir, { fetcher });
  const seen: string[] = [];
  const run = a.withToken(async (token) => { seen.push(token); if (token === "a1") throw new RoamError(401, "invalid_token", "nope"); return "meetings"; });
  await until(() => tokenCalls(calls).length === 1);
  await a.connectToken("pat-1");
  g.open();
  assert.equal(await run, "meetings");
  assert.deepEqual(seen, ["a1", "pat-1"]);
  // The refreshed grant isn't written over the pasted token.
  assert.equal(readToken(dir).accessToken, "pat-1");
  assert.equal(readToken(dir).via, "token");
});

test("refresh racing another RoamAuth on the same ledger (meetings.json edited): its connect or disconnect stands", async () => {
  // Another instance connects a personal access token while this one's refresh is in flight.
  {
    const dir = ledger();
    const g = gate();
    const { calls, fetcher } = gatedRoam(g);
    writeToken(dir, {});
    const old = auth(dir, { fetcher });
    const replacement = auth(dir, { fetcher });
    const refreshing = old.refresh();
    await until(() => tokenCalls(calls).length === 1);
    await replacement.connectToken("pat-1");
    g.open();
    const got = await refreshing;
    const pat = { via: "token", accessToken: "pat-1", refreshToken: null, expiresAt: null, viewer: "Pat", scopes: ["meetings:read", "user:read"] };
    assert.deepEqual(got, pat, "the replacement's connection is what's returned");
    assert.deepEqual(readToken(dir), pat, "not overwritten by the old account's refreshed token");
  }
  // Another instance disconnects while this one's refresh is in flight.
  {
    const dir = ledger();
    const g = gate();
    const { calls, fetcher } = gatedRoam(g);
    writeToken(dir, {});
    const old = auth(dir, { fetcher });
    const replacement = auth(dir, { fetcher });
    const refreshing = old.refresh();
    await until(() => tokenCalls(calls).length === 1);
    assert.deepEqual(await replacement.disconnect(), {});
    g.open();
    await assert.rejects(refreshing, (e: any) => e instanceof RoamError && e.code === NOT_CONNECTED);
    assert.equal(fs.existsSync(tokenFile(dir)), false, "the disconnect isn't undone");
  }
});

test("three sign-ins back to back while the first listener is still starting: the last one gets the port", async () => {
  const port = await freePort();
  const g = gate();
  let listens = 0;
  // The first bind takes the port and then waits: a later start must wait for it to let go.
  const listen = async (server: http.Server, p: number, host: string) => {
    const first = ++listens === 1;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(p, host, () => { server.off("error", reject); resolve(); }); });
    if (first) await g.opened;
  };
  const a = auth(ledger(), { hosted: false, listenPort: port, listen });
  const first = a.signInStart();
  await until(() => listens === 1);
  const second = a.signInStart();
  const third = a.signInStart();
  await new Promise((r) => setTimeout(r, 30));
  g.open();
  const [r1, r2, r3] = await Promise.all([first, second, third]);
  assert.equal(r1.listening, false);
  assert.equal(r2.listening, false);
  assert.equal(r3.listening, true);
  assert.equal(a.listenerPort(), port);
  a.signInCancel();
  assert.equal(await portFree(port), true);
});

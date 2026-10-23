// Remote control's link: tokens made on the hosted dashboard (link-tokens.ts) and the
// local dashboard's client that uses them (hosted-link.ts), against fake hosted
// dashboards, one of them behind mutual TLS with certificates made here with openssl.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { LinkTokens, linkTokenOf, parseLinkToken } from "../src/link-tokens.ts";
import { CONVERT_BY_HAND, HostedLink } from "../src/hosted-link.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-link-"));
const ANA = "ana@example.com";

test("link tokens: made once, verified by hash for their owner only, revoked at once", () => {
  let now = Date.parse("2026-10-22T10:00:00Z");
  const dir = tmp();
  const links = new LinkTokens(dir, () => now);
  const { token, link } = links.create("Ana@Example.com", "  Work   laptop ");
  assert.equal(link.label, "Work laptop");
  assert.deepEqual(parseLinkToken(token)?.email, ANA);
  assert.ok(!fs.readFileSync(path.join(dir, "remote-links.json"), "utf-8").includes(parseLinkToken(token)!.secret), "only the hash is kept");

  assert.equal(links.verify(token, ANA)?.id, link.id);
  assert.equal(links.list()[0].lastUsedAt, "2026-10-22T10:00:00.000Z");
  assert.equal(links.verify(token, "bo@example.com"), null, "not for another owner's dashboard");
  const p = token.split(".");
  assert.equal(links.verify([p[0], p[1], p[2], p[3].slice(0, -2) + "xx"].join("."), ANA), null, "a changed secret");
  assert.equal(links.verify([p[0], Buffer.from("bo@example.com").toString("base64url"), p[2], p[3]].join("."), null), null, "another email on the same id");
  assert.equal(links.verify("nonsense", ANA), null);

  now += 30_000;
  links.verify(token, ANA);
  assert.equal(links.list()[0].lastUsedAt, "2026-10-22T10:00:00.000Z", "lastUsedAt isn't rewritten on every request");

  assert.equal(links.revoke(link.id), true);
  assert.equal(links.verify(token, ANA), null);
  assert.equal(links.revoke(link.id), false);
  assert.throws(() => links.create("", "x"), /owner's email/);
});

test("linkTokenOf: only a Bearer link token on an /api/remote/ path", () => {
  const { token } = new LinkTokens(tmp()).create(ANA, "x");
  assert.equal(linkTokenOf("/api/remote/hello", { authorization: `Bearer ${token}` }), token);
  assert.equal(linkTokenOf("/api/runs", { authorization: `Bearer ${token}` }), null, "a token opens nothing outside /api/remote/");
  assert.equal(linkTokenOf("/api/remote/hello", { authorization: "Bearer abc" }), null);
  assert.equal(linkTokenOf("/api/remote/hello", {}), null);
  // Dot segments resolve outside /api/remote/: the router would forward /api/boot on an unchecked token.
  for (const escape of ["/api/remote/../boot", "/api/remote/%2e%2e/boot", "/api/remote/%2E%2E/boot", "/api/remote/./../runs", "/api/remote/a/../../boot"]) {
    assert.equal(linkTokenOf(escape, { authorization: `Bearer ${token}` }), null, escape);
  }
  assert.equal(linkTokenOf("/api/remote/a/../hello", { authorization: `Bearer ${token}` }), token, "a dot segment that stays inside is fine");
});

function serve(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }));
  });
}

test("hosted link: saves a real token only, sends it, retries a starting dashboard, and says what's wrong", async () => {
  const { token } = new LinkTokens(tmp()).create(ANA, "Work laptop");
  let starting = 2;
  const seen: (string | undefined)[] = [];
  const hosted = await serve((req, res) => {
    seen.push(req.headers.authorization);
    res.setHeader("Content-Type", "application/json");
    if (starting-- > 0) { res.writeHead(503, { "Retry-After": "1" }); return res.end(JSON.stringify({ error: "starting" })); }
    res.end(JSON.stringify({ ok: true, owner: ANA, link: { label: "Work laptop" }, version: "test" }));
  });
  try {
    const link = new HostedLink(tmp(), () => hosted.url, {});
    link.retryMs = 10;
    assert.throws(() => link.saveToken("not-a-token"), /isn't a link token/);
    link.saveToken(token);
    assert.equal(link.status().token.email, ANA);

    const { ok, steps } = await link.check();
    assert.ok(ok, JSON.stringify(steps));
    assert.match(steps.at(-1)!.message, /Linked as "Work laptop" to ana@example\.com's dashboard/);
    assert.equal(seen.length, 3, "two 503s, then the answer");
    assert.ok(seen.every((a) => a === `Bearer ${token}`));
    assert.equal(link.status().lastCheck?.ok, true);

    link.forget();
    const after = await link.check();
    assert.equal(after.ok, false);
    assert.match(after.steps.find((s) => !s.ok)!.message, /Linked computers/);
  } finally { hosted.close(); }

  const refused = await serve((_req, res) => { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "This computer's link token isn't valid here" })); });
  try {
    const link = new HostedLink(tmp(), () => refused.url, {});
    link.saveToken(token);
    const { ok, steps } = await link.check();
    assert.equal(ok, false);
    assert.match(steps.at(-1)!.message, /answered 401: This computer's link token isn't valid here/);
  } finally { refused.close(); }

  const none = new HostedLink(tmp(), () => null, {});
  assert.match((await none.check()).steps[0].message, /hosting\.json/);
  assert.throws(() => none.saveCertificate(Buffer.from("not a p12"), "pw"), /isn't a certificate file/);
});

/** A hosted side that answers every request with an SSE stream `script` writes. */
async function sseServer(script: (res: http.ServerResponse, req: http.IncomingMessage) => void) {
  const seen: http.IncomingHttpHeaders[] = [];
  const s = await serve((req, res) => {
    seen.push(req.headers);
    script(res, req);
  });
  const { token } = new LinkTokens(tmp()).create(ANA, "Work laptop");
  const link = new HostedLink(tmp(), () => s.url, {});
  link.saveToken(token);
  return { ...s, link, token, seen };
}
const sseHead = (res: http.ServerResponse) => res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("stream: frames parsed across chunk splits, several to a chunk, CRLF and multi-line data; pings and bad JSON emit nothing", async () => {
  const s = await sseServer(async (res) => {
    sseHead(res);
    res.write('event: hello\ndata: {"a":1}\n\n: ping\n\nevent: command\nid: 3\ndata: {"x":');
    await wait(20);
    res.write('2}\n\nevent: watch\r\ndata: {"runId":"r1",\r\ndata: "after":4}\r\n\r\nevent: bad\ndata: not json\n\n');
    await wait(20);
    res.write("event: unwatch\ndata: {\"runId\":\"r1\"}\n");
    await wait(20);
    res.end("\n");
  });
  try {
    const got: [string, any, string | null][] = [];
    const r = await s.link.stream("/api/remote/link", (e, d, id) => got.push([e, d, id]));
    assert.equal(r.status, 200);
    assert.deepEqual(got, [
      ["hello", { a: 1 }, null],
      ["command", { x: 2 }, "3"],
      ["watch", { runId: "r1", after: 4 }, "3"],
      ["unwatch", { runId: "r1" }, "3"],
    ]);
    assert.equal(s.seen[0].authorization, `Bearer ${s.token}`);
    assert.equal(s.seen[0].accept, "text/event-stream");
  } finally { s.close(); }
});

test("stream: a non-200 answer resolves with its status and no events", async () => {
  const s = await sseServer((res) => {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Another computer is linked" }) + "\n\nevent: hello\ndata: {}\n\n");
  });
  try {
    const got: string[] = [];
    assert.deepEqual(await s.link.stream("/api/remote/link", (e) => got.push(e)), { status: 409 });
    assert.deepEqual(got, []);
  } finally { s.close(); }

  // Nothing answering at all: status 0 and why, not a throw.
  const gone = await serve(() => {});
  gone.close();
  const link = new HostedLink(tmp(), () => gone.url, { DASHBOARD_LINK_TOKEN: new LinkTokens(tmp()).create(ANA, "x").token });
  const r = await link.stream("/api/remote/link", () => {});
  assert.equal(r.status, 0);
  assert.match(r.error || "", /ECONNREFUSED/);
  await assert.rejects(new HostedLink(tmp(), () => gone.url, {}).stream("/api/remote/link", () => {}), /isn't linked yet/);
});

test("stream: a client certificate that doesn't open resolves status 0 with the reason, not a rejection", async () => {
  const ledger = tmp();
  const bad = path.join(ledger, "bad.p12");
  fs.writeFileSync(bad, "not a p12");
  const link = new HostedLink(ledger, () => "https://127.0.0.1:9", {
    DASHBOARD_LINK_TOKEN: new LinkTokens(tmp()).create(ANA, "x").token,
    DASHBOARD_CLIENT_CERT: bad, DASHBOARD_CLIENT_CERT_PASS: "pw",
  });
  const r = await link.stream("/api/remote/link", () => {});
  assert.equal(r.status, 0);
  assert.ok(r.error, "says why");
  assert.doesNotMatch(r.error!, /ECONNREFUSED/, "it never got as far as connecting");
});

test("stream: an onEvent that throws is logged and the stream goes on", async () => {
  const s = await sseServer((res) => {
    sseHead(res);
    res.end('event: hello\ndata: {"a":1}\n\nevent: watch\ndata: {"b":2}\n\n');
  });
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    const got: string[] = [];
    const r = await s.link.stream("/api/remote/link", (e) => { got.push(e); if (e === "hello") throw new Error("boom"); });
    assert.equal(r.status, 200);
    assert.deepEqual(got, ["hello", "watch"]);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /hello.*boom/);
  } finally { console.error = orig; s.close(); }
});

test("stream: aborting through the signal resolves and closes the connection", async () => {
  let closed: Promise<void> | null = null;
  const s = await sseServer((res, req) => {
    closed = new Promise((r) => req.socket.on("close", () => r()));
    sseHead(res);
    res.write('event: hello\ndata: {"protocol":1}\n\n'); // then held open
  });
  try {
    const ac = new AbortController();
    const got: string[] = [];
    const r = s.link.stream("/api/remote/link", (e) => { got.push(e); ac.abort(); }, ac.signal);
    assert.deepEqual(await r, { status: 200 });
    assert.deepEqual(got, ["hello"]);
    await closed;
    const before = new AbortController();
    before.abort();
    assert.deepEqual(await s.link.stream("/api/remote/link", () => {}, before.signal), { status: 0 }, "already aborted");
    assert.equal(s.seen.length, 1, "and no request made");
  } finally { s.close(); }
});

test("request: aborting through the signal stops the 503 retries and destroys a request in flight; retries503: 0 makes none", async () => {
  // Answering 503: aborted between retries, it rejects at once and tries no more.
  let n503 = 0;
  const starting = await serve((_req, res) => { n503++; res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "starting" })); });
  const { token } = new LinkTokens(tmp()).create(ANA, "x");
  try {
    const link = new HostedLink(tmp(), () => starting.url, { DASHBOARD_LINK_TOKEN: token });
    link.retryMs = 200;
    const ac = new AbortController();
    const r = link.request("POST", "/api/remote/sync", { a: 1 }, 5000, { signal: ac.signal });
    while (n503 < 1) await wait(10);
    const t0 = Date.now();
    ac.abort();
    await assert.rejects(r, (e: any) => e.name === "AbortError");
    assert.ok(Date.now() - t0 < 100, `${Date.now() - t0} ms`);
    await wait(500);
    assert.equal(n503, 1, "no retry after the abort");
    // Already aborted: no request at all.
    await assert.rejects(link.request("POST", "/api/remote/sync", {}, 5000, { signal: ac.signal }), (e: any) => e.name === "AbortError");
    assert.equal(n503, 1);
    // No 503 retry asked for: the 503 itself comes back.
    assert.equal((await link.request("POST", "/api/remote/ack", {}, 5000, { retries503: 0 })).status, 503);
    assert.equal(n503, 2);
  } finally { starting.close(); }

  // Held with no answer: aborted, the request is destroyed (the server sees its connection close).
  let closed: Promise<void> | null = null;
  const held = await serve((req) => { closed = new Promise((ok) => req.socket.on("close", () => ok())); });
  try {
    const link = new HostedLink(tmp(), () => held.url, { DASHBOARD_LINK_TOKEN: token });
    const ac = new AbortController();
    const r = link.request("POST", "/api/remote/sync", { a: 1 }, 5000, { signal: ac.signal });
    while (!closed) await wait(10);
    ac.abort();
    await assert.rejects(r, (e: any) => e.name === "AbortError");
    await closed;
  } finally { held.close(); }
});

test("stream: pings keep it alive; no bytes for the idle limit gives it up", async () => {
  const s = await sseServer(async (res) => {
    sseHead(res);
    for (let i = 0; i < 4; i++) { res.write(": ping\n\n"); await wait(40); }
    // then silent, held open (a laptop lid closed on the other end)
  });
  try {
    s.link.streamIdleMs = 100;
    const t0 = Date.now();
    const got: string[] = [];
    assert.deepEqual(await s.link.stream("/api/remote/link", (e) => got.push(e)), { status: 200 });
    const took = Date.now() - t0;
    assert.ok(took >= 200, `the pings kept it open past one idle limit (${took} ms)`);
    assert.ok(took < 2000, `and silence ended it (${took} ms)`);
    assert.deepEqual(got, []);
  } finally { s.close(); }
});

test("remote control switch: off by default, persisted, forget turns it off; status shows the switch and the client's state", () => {
  const ledger = tmp();
  const link = new HostedLink(ledger, () => "https://hosted.example", {});
  assert.equal(link.remoteControl(), false);
  assert.deepEqual(link.status().remoteControl, { on: false, state: "off", message: null, lastSyncAt: null });

  link.setRemoteControl(true);
  assert.equal(link.remoteControl(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ledger, "hosted-link", "remote-control.json"), "utf-8")), { on: true });
  assert.equal(new HostedLink(ledger, () => null, {}).remoteControl(), true, "read back by a new process");
  assert.deepEqual(link.status().remoteControl, { on: true, state: "connecting", message: null, lastSyncAt: null });

  link.setRemoteState({ state: "connected", message: null, lastSyncAt: "2026-10-23T10:00:00.000Z" });
  assert.deepEqual(link.status().remoteControl, { on: true, state: "connected", message: null, lastSyncAt: "2026-10-23T10:00:00.000Z" });
  link.setRemoteState({ state: "refused", message: "link token refused", lastSyncAt: "2026-10-23T10:00:00.000Z" });
  assert.equal(link.status().remoteControl.state, "refused");
  assert.equal(link.status().remoteControl.message, "link token refused");

  link.setRemoteControl(false);
  assert.equal(link.remoteControl(), false);
  assert.deepEqual(link.status().remoteControl, { on: false, state: "off", message: null, lastSyncAt: null });

  link.setRemoteControl(true);
  link.forget();
  assert.equal(link.remoteControl(), false);
  assert.equal(fs.existsSync(path.join(ledger, "hosted-link", "remote-control.json")), false);
  assert.equal(link.status().remoteControl.state, "off");
});

/** A CA, a server certificate for 127.0.0.1 and a client .p12 signed by the CA; null without openssl. */
function makeCerts(dir: string): { ca: string; serverKey: string; serverCert: string; p12: Buffer; spaced: Buffer; legacy: Buffer | null } | null {
  const ssl = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  try { ssl("version"); } catch { return null; }
  fs.writeFileSync(path.join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  fs.writeFileSync(path.join(dir, "client.ext"), "extendedKeyUsage=clientAuth\n");
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Test Client CA", "-days", "1");
  for (const who of ["server", "client"]) {
    ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${who}.key`, "-out", `${who}.csr`, "-subj", `/CN=${who}`);
    ssl("x509", "-req", "-in", `${who}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${who}.crt`, "-days", "1", "-extfile", `${who}.ext`);
  }
  ssl("pkcs12", "-export", "-in", "client.crt", "-inkey", "client.key", "-out", "client.p12", "-passout", "pass:pw");
  // A passphrase with spaces at both ends: kept exactly as typed.
  ssl("pkcs12", "-export", "-in", "client.crt", "-inkey", "client.key", "-out", "client-spaced.p12", "-passout", "pass: pw ");
  // The legacy format (RC2/3DES) phones need and older tools make, which Node can't read.
  let legacy: Buffer | null = null;
  try {
    ssl("pkcs12", "-export", "-legacy", "-in", "client.crt", "-inkey", "client.key", "-out", "client-legacy.p12", "-passout", "pass:pw");
    legacy = fs.readFileSync(path.join(dir, "client-legacy.p12"));
  } catch { /* an openssl without -legacy (1.1, LibreSSL) makes the legacy format by default; skipped then */ }
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf-8");
  return { ca: read("ca.crt"), serverKey: read("server.key"), serverCert: read("server.crt"), p12: fs.readFileSync(path.join(dir, "client.p12")), spaced: fs.readFileSync(path.join(dir, "client-spaced.p12")), legacy };
}

test("hosted link: a legacy .p12 (RC2/3DES) is converted with the machine's openssl; without one, it says how", (t) => {
  const certs = makeCerts(tmp());
  if (!certs?.legacy) { t.skip("openssl with -legacy isn't available"); return; }
  assert.throws(() => tls.createSecureContext({ pfx: certs.legacy!, passphrase: "pw" }), /Unsupported PKCS12/, "Node can't read it as is");

  const ledger = tmp();
  const link = new HostedLink(ledger, () => null, process.env);
  assert.throws(() => link.saveCertificate(certs.legacy!, "wrong"), /passphrase doesn't open/);
  assert.deepEqual(link.saveCertificate(certs.legacy!, "pw"), { converted: true });
  const stored = fs.readFileSync(path.join(ledger, "hosted-link", "client.p12"));
  tls.createSecureContext({ pfx: stored, passphrase: "pw" }); // opens now
  assert.deepEqual(pfxSubject(stored, "pw"), pfxSubject(certs.p12, "pw"), "the same certificate, re-packed");
  assert.deepEqual(link.saveCertificate(certs.p12, "pw"), { converted: false }, "a modern one is kept as it is");
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("natterjack-p12-")), [], "no unpacked key left behind");

  // The steps by hand work as written: run each quoted openssl command (passphrases given on the command line here).
  const work = tmp();
  fs.writeFileSync(path.join(work, "old.pfx"), certs.legacy!);
  const commands = [...CONVERT_BY_HAND.matchAll(/`openssl ([^`]+)`/g)].map((m) => m[1].split(" "));
  assert.equal(commands.length, 2);
  execFileSync("openssl", [...commands[0], "-passin", "pass:pw"], { cwd: work, stdio: "pipe" });
  execFileSync("openssl", [...commands[1], "-passout", "pass:pw"], { cwd: work, stdio: "pipe" });
  tls.createSecureContext({ pfx: fs.readFileSync(path.join(work, "laptop.p12")), passphrase: "pw" });

  // No openssl to be found: the steps to do it by hand.
  const none = { DASHBOARD_OPENSSL_BIN: path.join(tmp(), "no-openssl"), PATH: "", Path: "", ProgramFiles: tmp(), "ProgramFiles(x86)": tmp(), LOCALAPPDATA: tmp() };
  assert.throws(() => new HostedLink(tmp(), () => null, none).saveCertificate(certs.legacy!, "pw"), /no openssl here to convert it[\s\S]*openssl pkcs12 -legacy/);
});

/** A .p12's certificate subject, read with openssl (Node has no PKCS#12 parser of its own). */
function pfxSubject(pfx: Buffer, pass: string): string {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "x.p12"), pfx);
  return execFileSync("openssl", ["pkcs12", "-in", "x.p12", "-nokeys", "-clcerts", "-passin", `pass:${pass}`], { cwd: dir, encoding: "utf-8" }).match(/subject=.*/)?.[0] || "";
}

test("hosted link: through mutual TLS with a client certificate, and a clear message without one", async (t) => {
  const dir = tmp();
  const certs = makeCerts(dir);
  if (!certs) { t.skip("openssl isn't available"); return; }
  const { token } = new LinkTokens(tmp()).create(ANA, "Work laptop");
  const server = https.createServer({ key: certs.serverKey, cert: certs.serverCert, ca: certs.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const peer = (req.socket as any).getPeerCertificate?.();
    res.end(JSON.stringify({ ok: true, owner: ANA, link: { label: `cert ${peer?.subject?.CN}` }, version: "test" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `https://127.0.0.1:${(server.address() as any).port}`;
  try {
    const env = { DASHBOARD_HOSTED_CA: path.join(dir, "ca.crt") };
    const link = new HostedLink(tmp(), () => url, env);
    link.saveToken(token);

    const without = await link.check();
    assert.equal(without.ok, false);
    assert.match(without.steps.at(-1)!.message, /TLS handshake|Couldn't connect/);

    assert.throws(() => link.saveCertificate(certs.p12, "wrong"), /passphrase doesn't open/);
    link.saveCertificate(certs.p12, "pw");
    const withCert = await link.check();
    assert.ok(withCert.ok, JSON.stringify(withCert.steps));
    assert.match(withCert.steps.at(-1)!.message, /Linked as "cert client"/);

    // Saved with a passphrase that starts and ends with spaces, it still opens when it's used.
    link.saveCertificate(certs.spaced, " pw ");
    const spaced = await link.check();
    assert.ok(spaced.ok, JSON.stringify(spaced.steps));
  } finally { server.close(); }
});

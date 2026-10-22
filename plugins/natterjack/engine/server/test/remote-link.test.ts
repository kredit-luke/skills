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
import { HostedLink } from "../src/hosted-link.ts";

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

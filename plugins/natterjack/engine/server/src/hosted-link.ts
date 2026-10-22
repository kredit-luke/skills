/**
 * The link from a person's own dashboard to their hosted one (Remote control), on the
 * local side: requests to the hosted dashboard's /api/remote/* without a browser.
 *
 * Two credentials, both kept in <ledger>/hosted-link/ (owner-only files):
 *   - a link token, made on the hosted dashboard (Settings › Linked computers, link-tokens.ts),
 *     sent as `Authorization: Bearer`;
 *   - a client certificate (.p12 and its passphrase), when the hosted dashboard's ingress
 *     asks for one (mutual TLS). A certificate in the operating system's store can't be used:
 *     Node only presents one it can read from a file.
 * DASHBOARD_CLIENT_CERT, DASHBOARD_CLIENT_CERT_PASS and DASHBOARD_LINK_TOKEN override the files;
 * DASHBOARD_HOSTED_CA (a PEM file) trusts a hosted address whose certificate the system doesn't.
 */

import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { HostedLinkStatus, LinkCheckStep } from "../../shared/api.ts";
import { parseLinkToken } from "./link-tokens.ts";

export interface RemoteResponse { status: number; json: any; retryAfter: number | null }

const RETRIES_503 = 12;

/** The steps by hand, for when there's no openssl to do it here (Git Bash, macOS and Linux all have one). */
const CONVERT_BY_HAND = "In a terminal: `openssl pkcs12 -legacy -in old.pfx -nodes -out tmp.pem`, then `openssl pkcs12 -export -in tmp.pem -out laptop.p12`, then delete tmp.pem, and add laptop.p12 here.";

/** openssl to try, in order: DASHBOARD_OPENSSL_BIN, then PATH, then Git for Windows' copies. */
function opensslCandidates(env: NodeJS.ProcessEnv): string[] {
  const out = [env.DASHBOARD_OPENSSL_BIN, "openssl"].filter(Boolean) as string[];
  if (process.platform === "win32") {
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]) {
      if (base) out.push(path.join(base, "Git", "usr", "bin", "openssl.exe"), path.join(base, "Git", "mingw64", "bin", "openssl.exe"));
    }
  }
  return out;
}

/**
 * A legacy PKCS#12 (RC2/3DES encrypted) re-packed as AES-256 with the same passphrase, using the
 * machine's openssl. The passphrase goes through the environment (never the command line), and
 * the unpacked key only ever sits in a private temporary folder that is removed afterwards.
 * Throws (400) with what to do when it can't.
 */
export function modernPkcs12(pfx: Buffer, passphrase: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const run = (bin: string, args: string[], extraEnv: Record<string, string> = {}) =>
    execFileSync(bin, args, { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true });
  const bin = opensslCandidates(env).find((b) => { try { run(b, ["version"]); return true; } catch { return false; } });
  if (!bin) throw httpErr(400, `That certificate uses the older encryption (RC2/3DES) phones need, which this dashboard can't read, and there's no openssl here to convert it. ${CONVERT_BY_HAND}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "natterjack-p12-"));
  try { fs.chmodSync(dir, 0o700); } catch {}
  const old = path.join(dir, "old.p12"), pem = path.join(dir, "key.pem"), out = path.join(dir, "new.p12");
  const pass = { NATTERJACK_P12_PASS: passphrase };
  try {
    fs.writeFileSync(old, pfx, { mode: 0o600 });
    // OpenSSL 3 needs -legacy to read RC2; OpenSSL 1.1 and LibreSSL (macOS) read it as is and don't know -legacy.
    const unpack = (legacy: boolean) => run(bin, ["pkcs12", ...(legacy ? ["-legacy"] : []), "-in", old, "-nodes", "-out", pem, "-passin", "env:NATTERJACK_P12_PASS"], pass);
    try { unpack(true); }
    catch (e) {
      const why = String((e as any).stderr || (e as Error).message);
      if (/mac verify|invalid password|bad decrypt/i.test(why)) throw httpErr(400, "The passphrase doesn't open that certificate.");
      try { unpack(false); }
      catch (e2) {
        const why2 = String((e2 as any).stderr || (e2 as Error).message);
        throw httpErr(400, /mac verify|invalid password|bad decrypt/i.test(why2) ? "The passphrase doesn't open that certificate." : `That certificate uses the older encryption (RC2/3DES), and openssl couldn't convert it (${why2.trim().split(/\r?\n/)[0]}). ${CONVERT_BY_HAND}`);
      }
    }
    // Explicit ciphers, so OpenSSL 1.1 and LibreSSL (whose defaults are the legacy ones) make a modern file too.
    try {
      run(bin, ["pkcs12", "-export", "-in", pem, "-out", out, "-keypbe", "AES-256-CBC", "-certpbe", "AES-256-CBC", "-macalg", "sha256", "-passout", "env:NATTERJACK_P12_PASS"], pass);
    } catch (e) {
      throw httpErr(400, `openssl couldn't re-pack the certificate (${String((e as any).stderr || (e as Error).message).trim().split(/\r?\n/)[0]}). ${CONVERT_BY_HAND}`);
    }
    const modern = fs.readFileSync(out);
    try { tls.createSecureContext({ pfx: modern, passphrase }); }
    catch (e) { throw httpErr(400, `The converted certificate still doesn't open (${(e as Error).message}). ${CONVERT_BY_HAND}`); }
    return modern;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readText = (f: string) => { try { return fs.readFileSync(f, "utf-8").trim(); } catch { return null; } };
const httpErr = (status: number, message: string) => Object.assign(new Error(message), { status });

export class HostedLink {
  private dir: string;
  private url: () => string | null;
  private env: NodeJS.ProcessEnv;
  private lastCheck: HostedLinkStatus["lastCheck"] = null;
  /** Wait between 503 retries (a stopped hosted dashboard starting); shortened in tests. */
  retryMs = 5000;

  constructor(ledgerDir: string, hostedUrl: () => string | null, env: NodeJS.ProcessEnv = process.env) {
    this.dir = path.join(ledgerDir, "hosted-link");
    this.url = hostedUrl;
    this.env = env;
  }

  private certFile() { return this.env.DASHBOARD_CLIENT_CERT || path.join(this.dir, "client.p12"); }
  /** As saved, untrimmed: a passphrase can begin or end with spaces. */
  private passphrase() {
    if (this.env.DASHBOARD_CLIENT_CERT_PASS !== undefined) return this.env.DASHBOARD_CLIENT_CERT_PASS;
    try { return fs.readFileSync(path.join(this.dir, "client.pass"), "utf-8"); } catch { return ""; }
  }
  private token() { return this.env.DASHBOARD_LINK_TOKEN || readText(path.join(this.dir, "token")); }

  private write(name: string, data: Buffer | string) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), data, { mode: 0o600 });
  }

  status(): HostedLinkStatus {
    const token = this.token();
    return {
      url: this.url(),
      certificate: { present: fs.existsSync(this.certFile()), fromEnv: !!this.env.DASHBOARD_CLIENT_CERT },
      token: { present: !!token, fromEnv: !!this.env.DASHBOARD_LINK_TOKEN, email: parseLinkToken(token)?.email || null },
      lastCheck: this.lastCheck,
    };
  }

  /** Keep a client certificate (.p12/.pfx) once it opens with `passphrase`. */
  /**
   * Keep a client certificate (.p12/.pfx) once it opens with `passphrase`. One in the legacy
   * format (RC2/3DES, what phones need and older tools still make) is re-packed as AES-256 with
   * the machine's openssl, since Node can't read it; `converted` says so.
   */
  saveCertificate(pfx: Buffer, passphrase: string): { converted: boolean } {
    if (!pfx.length) throw httpErr(400, "That certificate file is empty.");
    let converted = false;
    try { tls.createSecureContext({ pfx, passphrase }); }
    catch (e) {
      const msg = String((e as Error).message || e);
      if (!/unsupported pkcs12/i.test(msg)) {
        throw httpErr(400, /mac verify|password|decrypt/i.test(msg) ? "The passphrase doesn't open that certificate." : `That isn't a certificate file this can use (.p12 or .pfx with its key): ${msg}`);
      }
      pfx = modernPkcs12(pfx, passphrase, this.env);
      converted = true;
    }
    this.write("client.p12", pfx);
    this.write("client.pass", passphrase);
    this.lastCheck = null;
    return { converted };
  }

  /** Keep the link token made on the hosted dashboard. */
  saveToken(token: string) {
    token = String(token || "").trim();
    if (!parseLinkToken(token)) throw httpErr(400, "That isn't a link token. Copy it from your hosted dashboard's Settings › Linked computers.");
    this.write("token", token);
    this.lastCheck = null;
  }

  /** Forget both credentials (those from the environment stay). */
  forget() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.lastCheck = null;
  }

  private tlsOptions(): { pfx: Buffer; passphrase: string } | null {
    try { return { pfx: fs.readFileSync(this.certFile()), passphrase: this.passphrase() }; } catch { return null; }
  }

  /** The hosted address's own CA, when it isn't one the system trusts (DASHBOARD_HOSTED_CA: a PEM file). */
  private serverCa(): { ca: Buffer } | null {
    const f = this.env.DASHBOARD_HOSTED_CA;
    if (!f) return null;
    try { return { ca: fs.readFileSync(f) }; } catch { return null; }
  }

  /**
   * A request to the hosted dashboard's `p` (an /api/remote/ path) with the link's
   * credentials. A 503 (the hosted dashboard is starting) is retried for about a minute.
   */
  async request(method: string, p: string, body?: unknown, timeoutMs = 30_000): Promise<RemoteResponse> {
    const base = this.url();
    if (!base) throw httpErr(400, "No hosted dashboard is set: add its address as \"url\" in .claude/dashboard/hosting.json.");
    const token = this.token();
    if (!token) throw httpErr(400, "This computer isn't linked yet: paste a link token from your hosted dashboard's Settings.");
    for (let attempt = 0; ; attempt++) {
      const r = await this.once(method, new URL(p, base), token, body, timeoutMs);
      if (r.status !== 503 || attempt >= RETRIES_503) return r;
      await new Promise((ok) => setTimeout(ok, r.retryAfter ? Math.min(r.retryAfter * 1000, this.retryMs) : this.retryMs));
    }
  }

  private once(method: string, target: URL, token: string, body: unknown, timeoutMs: number): Promise<RemoteResponse> {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const secure = target.protocol === "https:";
    const lib = secure ? https : http;
    const headers: http.OutgoingHttpHeaders = { authorization: `Bearer ${token}`, accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) };
    return new Promise((resolve, reject) => {
      const req = lib.request(target, { method, headers, timeout: timeoutMs, ...(secure ? { ...(this.tlsOptions() || {}), ...(this.serverCa() || {}) } : {}) }, (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
          resolve({ status: res.statusCode || 0, json, retryAfter: parseInt(String(res.headers["retry-after"] || ""), 10) || null });
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("The hosted dashboard took too long to answer."), { code: "ETIMEDOUT" })));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** Every link step, in order, with what to do about the first that fails. */
  async check(): Promise<{ ok: boolean; steps: LinkCheckStep[] }> {
    const steps: LinkCheckStep[] = [];
    const done = () => {
      const ok = steps.every((s) => s.ok);
      this.lastCheck = { at: new Date().toISOString(), ok, steps };
      return { ok, steps };
    };
    const url = this.url();
    steps.push(url ? { name: "Hosted address", ok: true, message: url } : { name: "Hosted address", ok: false, message: "Add the hosted dashboard's address as \"url\" in .claude/dashboard/hosting.json." });
    if (!url) return done();

    const secure = url.startsWith("https:");
    const cert = this.tlsOptions();
    if (cert) {
      try { tls.createSecureContext(cert); steps.push({ name: "Client certificate", ok: true, message: "Loads with its passphrase." }); }
      catch (e) { steps.push({ name: "Client certificate", ok: false, message: `It doesn't open: ${(e as Error).message}. Add it again with its passphrase.` }); return done(); }
    } else {
      steps.push({ name: "Client certificate", ok: true, message: secure ? "None added: fine unless the hosted dashboard asks for one." : "Not needed for this address." });
    }

    const token = parseLinkToken(this.token());
    if (!token) { steps.push({ name: "Link token", ok: false, message: "Make one in your hosted dashboard's Settings › Linked computers and paste it here." }); return done(); }
    steps.push({ name: "Link token", ok: true, message: `For ${token.email}.` });

    try {
      const r = await this.request("GET", "/api/remote/hello");
      if (r.status === 200 && r.json?.ok) {
        steps.push({ name: "Reach your hosted dashboard", ok: true, message: `Linked as "${r.json.link?.label}" to ${r.json.owner}'s dashboard (version ${r.json.version}).` });
      } else if (r.status === 503) {
        steps.push({ name: "Reach your hosted dashboard", ok: false, message: "It's still starting. Try again in a minute." });
      } else {
        steps.push({ name: "Reach your hosted dashboard", ok: false, message: `It answered ${r.status}: ${r.json?.error || "no reason given"}` });
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const tlsRefused = /certificate|handshake|alert/i.test(`${err.code} ${err.message}`);
      steps.push({
        name: "Reach your hosted dashboard", ok: false,
        message: tlsRefused
          ? `The connection was refused at the TLS handshake (${err.message}). The hosted dashboard probably needs a client certificate: add one above.`
          : `Couldn't connect: ${err.message}`,
      });
    }
    return done();
  }
}

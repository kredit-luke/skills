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

export interface RemoteRequestOptions {
  /** Aborting it destroys the request in flight and drops any 503 retry still to come. */
  signal?: AbortSignal;
  /** How many times a 503 is retried (default 12, about a minute); 0 for none. */
  retries503?: number;
}

/** What request() rejects with when its signal is aborted. */
const abortError = () => Object.assign(new Error("The request was aborted."), { name: "AbortError", code: "ABORT_ERR" });

type RemoteControlStatus = HostedLinkStatus["remoteControl"];
/** What the Remote control client (remote-link.ts) last said about its link. */
export type RemoteControlState = Omit<RemoteControlStatus, "on">;

const RETRIES_503 = 12;
/** No bytes at all (the hosted side pings every 25 s) for this long: the stream is dead. */
const STREAM_IDLE_MS = 60_000;

/**
 * The steps by hand, for when there's no openssl to do it here (Git Bash, macOS and Linux all have
 * one). The same options as the automatic conversion: `-legacy` only where it's known (OpenSSL 3;
 * 1.1 and LibreSSL refuse it and read the old format without it), and explicit AES-256/SHA-256 on
 * the export, since 1.1's and LibreSSL's defaults are the legacy ones.
 */
export const CONVERT_BY_HAND = "In a terminal: `openssl pkcs12 -legacy -in old.pfx -nodes -out tmp.pem` (if it says -legacy is unknown, run it again without -legacy), then `openssl pkcs12 -export -in tmp.pem -out laptop.p12 -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256`, then delete tmp.pem, and add laptop.p12 here.";

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

/**
 * Server-sent events, fed in chunks as they arrive: `field: value` lines, a blank line ending a
 * frame, `:` lines (pings) ignored. `id` carries over to later frames, as in EventSource.
 */
function sseParser(onFrame: (event: string, data: any, id: string | null) => void): (chunk: string) => void {
  let buf = "", event = "", id: string | null = null;
  let data: string[] = [];
  return (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line === "") {
        if (data.length) {
          let parsed: unknown, ok = true;
          try { parsed = JSON.parse(data.join("\n")); } catch { ok = false; }
          if (ok) onFrame(event || "message", parsed, id);
        }
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const c = line.indexOf(":");
      const field = c < 0 ? line : line.slice(0, c);
      const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  };
}

const readText = (f: string) => { try { return fs.readFileSync(f, "utf-8").trim(); } catch { return null; } };
const httpErr = (status: number, message: string) => Object.assign(new Error(message), { status });

export class HostedLink {
  private dir: string;
  private url: () => string | null;
  private env: NodeJS.ProcessEnv;
  private lastCheck: HostedLinkStatus["lastCheck"] = null;
  private remoteState: RemoteControlState | null = null;
  /** Wait between 503 retries (a stopped hosted dashboard starting); shortened in tests. */
  retryMs = 5000;
  /** How long stream() waits with no bytes before it gives the stream up; shortened in tests. */
  streamIdleMs = STREAM_IDLE_MS;

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
      remoteControl: this.remoteControlStatus(),
    };
  }

  private remoteControlStatus(): RemoteControlStatus {
    const on = this.remoteControl();
    const live = this.remoteState;
    if (!on) return { on, state: "off", message: null, lastSyncAt: live?.lastSyncAt ?? null };
    return { on, state: live?.state ?? "connecting", message: live?.message ?? null, lastSyncAt: live?.lastSyncAt ?? null };
  }

  /** Whether Remote control is on for this computer (<ledger>/hosted-link/remote-control.json; off by default). */
  remoteControl(): boolean {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, "remote-control.json"), "utf-8")).on === true; } catch { return false; }
  }

  /** Turn Remote control on or off; the client's live state starts again. */
  setRemoteControl(on: boolean) {
    this.write("remote-control.json", JSON.stringify({ on: !!on }));
    this.remoteState = null;
  }

  /** The Remote control client's live state, which status() reports while the switch is on. */
  setRemoteState(state: RemoteControlState) {
    this.remoteState = { ...state };
  }

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

  /** Forget both credentials (those from the environment stay), and turn Remote control off. */
  forget() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.lastCheck = null;
    this.remoteState = null;
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
   * credentials. A 503 (the hosted dashboard is starting) is retried for about a minute
   * (`retries503`). Rejects when no answer comes (a network error, the timeout) and, the same
   * way, with an AbortError when `signal` is aborted: the request in flight is destroyed and no
   * 503 retry is made after it.
   */
  async request(method: string, p: string, body?: unknown, timeoutMs = 30_000, opts: RemoteRequestOptions = {}): Promise<RemoteResponse> {
    const { target, token } = this.target(p);
    const { signal, retries503 = RETRIES_503 } = opts;
    for (let attempt = 0; ; attempt++) {
      const r = await this.once(method, target, token, body, timeoutMs, signal);
      if (r.status !== 503 || attempt >= retries503) return r;
      const ms = r.retryAfter ? Math.min(r.retryAfter * 1000, this.retryMs) : this.retryMs;
      await new Promise<void>((ok, fail) => {
        if (signal?.aborted) return fail(abortError());
        const stop = () => { clearTimeout(timer); fail(abortError()); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); ok(); }, ms);
        signal?.addEventListener("abort", stop, { once: true });
      });
    }
  }

  /**
   * An SSE GET of the hosted dashboard's `p` (an /api/remote/ path) with the link's credentials
   * and no request timeout: `onEvent(event, data, id)` for each frame (its `data` parsed as JSON;
   * a frame whose data isn't JSON is skipped; comment lines are pings; an `onEvent` that throws
   * is logged and the stream goes on). Resolves with the HTTP status once the stream ends, fails,
   * is aborted through `signal`, or goes `streamIdleMs` without a byte, pings included. Status 0
   * when nothing answered: then `error` says why when the request failed (a refused connection,
   * a TLS failure), or when it couldn't even be made (a client certificate that doesn't open);
   * none when aborted. A non-200 answer's body is read and dropped. Rejects (400) only when
   * there's no hosted address or link token.
   */
  async stream(p: string, onEvent: (event: string, data: any, id: string | null) => void, signal?: AbortSignal): Promise<{ status: number; error?: string }> {
    const { target, token } = this.target(p);
    if (signal?.aborted) return { status: 0 };
    return new Promise((resolve) => {
      let status = 0, done = false, error: string | undefined;
      let idle: NodeJS.Timeout | undefined;
      let req: http.ClientRequest | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(idle);
        signal?.removeEventListener("abort", finish);
        req?.destroy();
        resolve(status === 0 && error ? { status, error } : { status });
      };
      const touch = () => { clearTimeout(idle); idle = setTimeout(finish, this.streamIdleMs); };
      try {
        req = this.send("GET", target, token, { accept: "text/event-stream", "cache-control": "no-cache" }, null, (res) => {
          status = res.statusCode || 0;
          touch();
          res.on("end", finish);
          res.on("close", finish);
          res.on("error", finish);
          if (status !== 200) { res.on("data", touch); res.resume(); return; }
          res.setEncoding("utf-8");
          const parse = sseParser((event, data, id) => {
            try { onEvent(event, data, id); }
            catch (e) { console.error(`[remote] the link's ${event} event failed: ${(e as Error)?.message || e}`); }
          });
          res.on("data", (chunk: string) => { touch(); parse(chunk); });
        });
      } catch (e) {
        // Thrown before any request went out (https.request reading a .p12 that doesn't open).
        error = String((e as Error)?.message || e);
        finish();
        return;
      }
      req.on("error", (e) => { if (!signal?.aborted) error = e.message; finish(); });
      signal?.addEventListener("abort", finish, { once: true });
      touch();
      req.end();
    });
  }

  /** The hosted address for `p` and the link token, or a 400 saying which is missing. */
  private target(p: string): { target: URL; token: string } {
    const base = this.url();
    if (!base) throw httpErr(400, "No hosted dashboard is set: add its address as \"url\" in .claude/dashboard/hosting.json.");
    const token = this.token();
    if (!token) throw httpErr(400, "This computer isn't linked yet: paste a link token from your hosted dashboard's Settings.");
    return { target: new URL(p, base), token };
  }

  /** A request with the link token, and over https the client certificate and DASHBOARD_HOSTED_CA; `timeoutMs` null for none. */
  private send(method: string, target: URL, token: string, headers: http.OutgoingHttpHeaders, timeoutMs: number | null, onResponse: (res: http.IncomingMessage) => void): http.ClientRequest {
    const secure = target.protocol === "https:";
    const lib = secure ? https : http;
    return lib.request(target, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(timeoutMs === null ? {} : { timeout: timeoutMs }),
      ...(secure ? { ...(this.tlsOptions() || {}), ...(this.serverCa() || {}) } : {}),
    }, onResponse);
  }

  /** One request; aborted through `signal`, it's destroyed and rejects with an AbortError. */
  private once(method: string, target: URL, token: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<RemoteResponse> {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers: http.OutgoingHttpHeaders = { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) };
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => { fail(abortError()); req.destroy(); };
      const settle = () => { settled = true; signal?.removeEventListener("abort", onAbort); };
      const ok = (r: RemoteResponse) => { if (!settled) { settle(); resolve(r); } };
      const fail = (e: unknown) => { if (!settled) { settle(); reject(e); } };
      const req = this.send(method, target, token, headers, timeoutMs, (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
          ok({ status: res.statusCode || 0, json, retryAfter: parseInt(String(res.headers["retry-after"] || ""), 10) || null });
        });
        res.on("error", fail);
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("The hosted dashboard took too long to answer."), { code: "ETIMEDOUT" })));
      req.on("error", fail);
      signal?.addEventListener("abort", onAbort, { once: true });
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

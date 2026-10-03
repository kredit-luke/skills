/**
 * HTTP for snapshot sources: JSON calls, and file downloads / uploads that stream
 * (snapshots are tens of MB). Redirects are followed, but credentials only go to the
 * host they were given for: a redirect to another host (Confluence hands downloads to
 * its media service with a signed URL) drops the Authorization header.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;

export class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string | number>;
  /** Sent as-is (Buffer / string), or streamed (a function that writes to the request and ends it). */
  body?: Buffer | string | ((req: http.ClientRequest) => void);
}

/** The response of a request, after redirects; the caller consumes (or discards) its body. */
export function request(url: string, opts: RequestOptions = {}, hops = 0): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(u, { method: opts.method || "GET", headers: opts.headers || {}, timeout: TIMEOUT_MS }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && (opts.method || "GET") === "GET") {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error(`Too many redirects from ${url}`));
        const next = new URL(res.headers.location, u);
        const headers = { ...(opts.headers || {}) };
        if (next.host !== u.host) delete headers.Authorization;
        return resolve(request(next.toString(), { ...opts, headers }, hops + 1));
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error(`Request to ${u.host} timed out`)));
    req.on("error", reject);
    if (typeof opts.body === "function") opts.body(req);
    else req.end(opts.body);
  });
}

async function readText(res: http.IncomingMessage): Promise<string> {
  let out = "";
  for await (const c of res) out += c;
  return out;
}

/** An error for a non-2xx response, with the service's own message when it sends one. */
export async function statusError(res: http.IncomingMessage, what: string): Promise<HttpStatusError> {
  const status = res.statusCode || 0;
  const text = await readText(res).catch(() => "");
  let msg = "";
  try { const j = JSON.parse(text); msg = j.message || (j.data && j.data.errors && j.data.errors[0] && j.data.errors[0].message) || ""; } catch {}
  if (status === 401 || status === 403) return new HttpStatusError(status, `${what} was refused (HTTP ${status}): check the key, and that it can see this.`);
  if (status === 404) return new HttpStatusError(status, `${what}: not found (HTTP 404).`);
  return new HttpStatusError(status, `${what} failed (HTTP ${status})${msg ? `: ${msg}` : ""}`);
}

/** A JSON request; throws HttpStatusError on non-2xx. An empty body is {}. */
export async function requestJson(url: string, opts: RequestOptions, what: string): Promise<any> {
  const res = await request(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } });
  if ((res.statusCode || 0) >= 300) throw await statusError(res, what);
  const text = await readText(res);
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error(`${what}: the response wasn't JSON.`); }
}

/** Download to a file (written to <dest>.part, then renamed); returns its size. */
export async function downloadFile(url: string, headers: Record<string, string>, dest: string, what: string): Promise<number> {
  const res = await request(url, { headers });
  if ((res.statusCode || 0) >= 300) throw await statusError(res, what);
  const part = `${dest}.part`;
  try {
    await pipeline(res, fs.createWriteStream(part));
    fs.renameSync(part, dest);
  } catch (e) {
    try { fs.unlinkSync(part); } catch {}
    throw e;
  }
  return fs.statSync(dest).size;
}

/** multipart/form-data with one file field (plus plain fields), streamed from disk. */
export function multipartFile(file: string, filename: string, fields: Record<string, string> = {}, fileField = "file") {
  const boundary = `----agentic-os-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const esc = (s: string) => s.replace(/"/g, "%22").replace(/[\r\n]/g, " ");
  let head = "";
  for (const [k, v] of Object.entries(fields)) head += `--${boundary}\r\nContent-Disposition: form-data; name="${esc(k)}"\r\n\r\n${v}\r\n`;
  head += `--${boundary}\r\nContent-Disposition: form-data; name="${esc(fileField)}"; filename="${esc(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const length = Buffer.byteLength(head) + fs.statSync(file).size + Buffer.byteLength(tail);
  return {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": length },
    body: (req: http.ClientRequest) => {
      req.write(head);
      const rs = fs.createReadStream(file);
      rs.on("error", (e) => req.destroy(e));
      rs.on("end", () => req.end(tail));
      rs.pipe(req, { end: false });
    },
  };
}

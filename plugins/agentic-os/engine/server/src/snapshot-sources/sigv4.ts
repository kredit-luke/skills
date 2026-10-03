/**
 * AWS Signature Version 4 for the Authorization header (S3 and S3-compatible stores:
 * Cloudflare R2, MinIO, Google Cloud Storage's interop API, Backblaze B2...), with
 * node:crypto only. https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */

import crypto from "node:crypto";

export interface SigV4Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string | null }

/** S3 accepts this in place of the body's SHA-256 (over TLS), so uploads can stream. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (key: crypto.BinaryLike, s: string) => crypto.createHmac("sha256", key).update(s).digest();

/** RFC 3986 percent-encoding, which SigV4 requires (encodeURIComponent leaves !'()* alone). */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** 20130524T000000Z */
export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * The headers to send: the given ones plus x-amz-date, x-amz-content-sha256, the
 * session token if any, and Authorization. Every header passed in is signed, and host
 * comes from the URL (as Node sends it). The URL's path must already be encoded.
 */
export function signV4(req: {
  method: string; url: URL; headers?: Record<string, string | number>; region: string; service: string;
  credentials: SigV4Credentials; payloadHash: string; now?: Date;
}): Record<string, string> {
  const when = amzDate(req.now || new Date());
  const day = when.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  headers["x-amz-date"] = when;
  headers["x-amz-content-sha256"] = req.payloadHash;
  if (req.credentials.sessionToken) headers["x-amz-security-token"] = req.credentials.sessionToken;
  const signedHeaders = { ...headers, host: req.url.host };
  const names = Object.keys(signedHeaders).sort();
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [
    req.method.toUpperCase(),
    req.url.pathname || "/",
    query,
    names.map((n) => `${n}:${signedHeaders[n]}\n`).join(""),
    names.join(";"),
    req.payloadHash,
  ].join("\n");
  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", when, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${req.credentials.secretAccessKey}`, day), req.region), req.service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}

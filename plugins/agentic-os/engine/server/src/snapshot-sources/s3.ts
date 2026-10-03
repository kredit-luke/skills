/**
 * Snapshots as objects in an S3 bucket, or any S3-compatible store (Cloudflare R2,
 * MinIO, Google Cloud Storage's interop API, Backblaze B2...). repos.json:
 *
 *   "snapshot": { "source": "s3", "bucket": "acme-code", "region": "eu-west-1", "prefix": "snapshots/" }
 *   "snapshot": { "source": "s3", "bucket": "acme-code", "region": "auto", "endpoint": "https://<account>.r2.cloudflarestorage.com" }
 *
 * The key is an access key pair, `ACCESS_KEY_ID:SECRET_ACCESS_KEY`:
 * SNAPSHOT_S3_ACCESS_KEY_ID + SNAPSHOT_S3_SECRET_ACCESS_KEY (+ SNAPSHOT_S3_SESSION_TOKEN),
 * else AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN), else the ledger
 * file snapshot-s3-key (pasted on the Repos page). s3:ListBucket + s3:GetObject to
 * download; add s3:PutObject + s3:DeleteObject to publish (and s3:ListBucketVersions +
 * s3:DeleteObjectVersion, with versioning on, to prune). AWS uses virtual-hosted
 * addresses (path-style for bucket names with dots); an `endpoint` uses path-style.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProviderContext, ProviderHelp, ProviderStatus } from "../docs-providers/index.ts";
import type { SnapshotConfig } from "../repos.ts";
import type { SnapshotFile, SnapshotSource } from "./index.ts";
import { downloadFile, request, requestJson, statusError } from "./http-util.ts";
import { rfc3986, signV4, UNSIGNED_PAYLOAD, type SigV4Credentials } from "./sigv4.ts";
import { elements, folderPrefix, text } from "./xml.ts";

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,32}$/;
/** PutObject's single-request limit. */
const MAX_PUT_BYTES = 5 * 1024 * 1024 * 1024;

export class S3Source implements SnapshotSource {
  kind = "s3";
  label = "S3";
  maxFileBytes = MAX_PUT_BYTES;
  private readonly base: string | null;
  private readonly region: string;
  private readonly prefix: string;
  private readonly keyFile: string;
  private readonly problem: string | null;

  constructor(cfg: SnapshotConfig, ctx: ProviderContext) {
    const bucket = String(cfg.bucket || "").trim();
    const region = String(cfg.region || "us-east-1").trim();
    const endpoint = String(cfg.endpoint || "").trim().replace(/\/+$/, "");
    let problem: string | null = !BUCKET.test(bucket) ? 'repos.json snapshot needs "bucket": the bucket\'s name.'
      : !REGION.test(region) ? 'repos.json snapshot "region" isn\'t a region name, e.g. "us-east-1" ("auto" for Cloudflare R2).'
      : null;
    if (!problem && endpoint) { try { if (!/^https?:$/.test(new URL(endpoint).protocol)) throw 0; } catch { problem = 'repos.json snapshot "endpoint" must be an http(s) address.'; } }
    this.problem = problem;
    this.region = region;
    this.base = problem ? null
      : endpoint ? `${endpoint}/${bucket}`
      : bucket.includes(".") ? `https://s3.${region}.amazonaws.com/${bucket}`
      : `https://${bucket}.s3.${region}.amazonaws.com`;
    if (endpoint) this.label = `S3 (${new URL(endpoint).hostname})`;
    this.prefix = folderPrefix(cfg.prefix);
    this.keyFile = path.join(ctx.ledgerDir, "snapshot-s3-key");
  }

  private credentials(): (SigV4Credentials & { source: ProviderStatus["source"] }) | null {
    const env = (p: string) => process.env[`${p}ACCESS_KEY_ID`] && process.env[`${p}SECRET_ACCESS_KEY`]
      ? { accessKeyId: process.env[`${p}ACCESS_KEY_ID`]!.trim(), secretAccessKey: process.env[`${p}SECRET_ACCESS_KEY`]!.trim(), sessionToken: process.env[`${p}SESSION_TOKEN`]?.trim() || null, source: "env" as const }
      : null;
    const fromEnv = env("SNAPSHOT_S3_") || env("AWS_");
    if (fromEnv) return fromEnv;
    try { const p = parseKey(fs.readFileSync(this.keyFile, "utf-8")); if (p) return { ...p, source: "file" }; } catch {}
    return null;
  }

  private url(name: string | null, query = ""): URL {
    if (!this.base) throw new Error(this.problem || "repos.json snapshot is incomplete.");
    const key = name === null ? "" : (this.prefix + name).split("/").map(rfc3986).join("/");
    return new URL(`${this.base}/${key}${query ? `?${query}` : ""}`);
  }

  private signed(method: string, url: URL, creds?: SigV4Credentials | null, headers: Record<string, string | number> = {}) {
    const c = creds || this.credentials();
    if (!c) throw new Error("Connect first: paste the access key on the Repos page.");
    return signV4({ method, url, headers, region: this.region, service: "s3", credentials: c, payloadHash: UNSIGNED_PAYLOAD });
  }

  status(): ProviderStatus {
    const c = this.credentials();
    return { connected: !!this.base && !!c, source: c ? c.source : null, viewer: null };
  }

  connectHelp(): ProviderHelp | null {
    if (!this.base) return { title: "Finish the snapshot settings", steps: [this.problem || "", "Then reload."], placeholder: "", needsKey: false, method: "key" };
    return {
      title: "Connect the code download",
      steps: [
        "Ask whoever publishes the code for an access key that can read the snapshot bucket.",
        "Paste it below as `ACCESS_KEY_ID:SECRET_ACCESS_KEY`.",
        "It stays on this machine (in `.claude/ledger/`, never committed).",
      ],
      placeholder: "AKIA…:secret",
      needsKey: true,
      method: "key",
    };
  }

  async connect(key: string): Promise<ProviderStatus> {
    const creds = parseKey(key);
    if (!creds) throw new Error("Paste it as ACCESS_KEY_ID:SECRET_ACCESS_KEY.");
    // Check it can list the bucket before keeping it.
    await this.listPage(`list-type=2&max-keys=1${this.prefix ? `&prefix=${rfc3986(this.prefix)}` : ""}`, creds);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, `${creds.accessKeyId}:${creds.secretAccessKey}${creds.sessionToken ? `:${creds.sessionToken}` : ""}`, { mode: 0o600 });
    return this.status();
  }

  disconnect(): ProviderStatus {
    try { fs.unlinkSync(this.keyFile); } catch {}
    return this.status();
  }

  private async listPage(query: string, creds?: SigV4Credentials | null): Promise<string> {
    const url = this.url(null, query);
    const res = await request(url.toString(), { headers: this.signed("GET", url, creds) });
    const status = res.statusCode || 0;
    if (status === 301) { res.resume(); throw new Error(`The bucket isn't in region "${this.region}": set "region" on snapshot in repos.json.`); }
    if (status >= 300) throw await statusError(res, "Listing the snapshot bucket");
    let xml = "";
    for await (const c of res) xml += c;
    return xml;
  }

  /** A name directly under the prefix (no deeper "folders"), else null. */
  private own(key: string): string | null {
    if (!key.startsWith(this.prefix)) return null;
    const name = key.slice(this.prefix.length);
    return name && !name.includes("/") ? name : null;
  }

  async list(): Promise<SnapshotFile[]> {
    const out: SnapshotFile[] = [];
    let token: string | null = null;
    do {
      const q = ["list-type=2", ...(this.prefix ? [`prefix=${rfc3986(this.prefix)}`] : []), ...(token ? [`continuation-token=${rfc3986(token)}`] : [])].join("&");
      const xml = await this.listPage(q);
      for (const c of elements(xml, "Contents")) {
        const name = this.own(text(c, "Key") || "");
        if (!name) continue;
        const size = Number(text(c, "Size"));
        out.push({ id: name, name, size: Number.isFinite(size) ? size : null, updatedAt: text(c, "LastModified") });
      }
      token = text(xml, "IsTruncated") === "true" ? text(xml, "NextContinuationToken") : null;
    } while (token);
    return out;
  }

  async download(file: SnapshotFile, destPath: string): Promise<void> {
    const url = this.url(file.name);
    await downloadFile(url.toString(), this.signed("GET", url), destPath, `Downloading ${file.name}`);
  }

  /** PutObject: one request, streamed from disk (unsigned payload); replaces an object of the same name. */
  async upload(name: string, srcPath: string): Promise<void> {
    const url = this.url(name);
    const size = fs.statSync(srcPath).size;
    await requestJson(url.toString(), {
      method: "PUT",
      headers: this.signed("PUT", url, null, { "content-length": size, "content-type": "application/octet-stream" }),
      body: (req) => {
        const rs = fs.createReadStream(srcPath);
        rs.on("error", (e) => req.destroy(e));
        rs.pipe(req);
      },
    }, `Uploading ${name}`);
  }

  async remove(file: SnapshotFile): Promise<void> {
    const url = this.url(file.name);
    await requestJson(url.toString(), { method: "DELETE", headers: this.signed("DELETE", url) }, `Deleting ${file.name}`);
  }

  /** With versioning on, replaced objects stay as noncurrent versions: delete those of the named files. */
  async prune(names: string[]): Promise<number> {
    const own = new Set(names);
    const old: { name: string; versionId: string }[] = [];
    let marker: { key: string; version: string } | null = null;
    do {
      const q = ["versions=", ...(this.prefix ? [`prefix=${rfc3986(this.prefix)}`] : []),
        ...(marker ? [`key-marker=${rfc3986(marker.key)}`, `version-id-marker=${rfc3986(marker.version)}`] : [])].join("&");
      const xml = await this.listPage(q);
      for (const v of elements(xml, "Version")) {
        const name = this.own(text(v, "Key") || "");
        const versionId = text(v, "VersionId");
        if (name && own.has(name) && versionId && versionId !== "null" && text(v, "IsLatest") !== "true") old.push({ name, versionId });
      }
      const k = text(xml, "NextKeyMarker"), vid = text(xml, "NextVersionIdMarker");
      marker = text(xml, "IsTruncated") === "true" && k && vid ? { key: k, version: vid } : null;
    } while (marker);
    for (const o of old) {
      const url = this.url(o.name, `versionId=${rfc3986(o.versionId)}`);
      await requestJson(url.toString(), { method: "DELETE", headers: this.signed("DELETE", url) }, `Deleting an old version of ${o.name}`);
    }
    return old.length;
  }
}

/** "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]" (secret keys never contain ":"). */
function parseKey(raw: string): SigV4Credentials | null {
  const [accessKeyId, secretAccessKey, ...rest] = String(raw || "").trim().split(":");
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), sessionToken: rest.join(":").trim() || null };
}

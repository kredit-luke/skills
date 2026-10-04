/**
 * Knowledge stores: a bucket (or a folder in one) that holds a team's business notes,
 * for people who have no git access. docs.json:
 *
 *   { "key": "company", "name": "Company", "kind": "store", "area": "company",
 *     "store": { "type": "s3", "bucket": "acme-knowledge", "region": "eu-west-1", "prefix": "company/" } }
 *   "store": { "type": "gcs", "bucket": "acme-knowledge" }                                  Google Cloud Storage (HMAC keys)
 *   "store": { "type": "s3", "bucket": "kb", "region": "auto", "endpoint": "https://<acct>.r2.cloudflarestorage.com" }
 *   "store": { "type": "azure-blob", "account": "acmekb", "container": "knowledge", "prefix": "company/" }
 *
 * Unlike snapshot sources (one flat folder of big files), a store is a tree of small
 * files edited by several people, so it lists every level and every write is guarded by
 * the object's ETag: a save that would overwrite someone else's change is refused (409).
 *
 * The key is each person's own, kept in the ledger (`knowledge-<source>.key`, never
 * committed), or KNOWLEDGE_<SOURCE>_KEY in the environment (a hosted dashboard):
 * S3/GCS `ACCESS_KEY_ID:SECRET` (GCS: an HMAC key), Azure a SAS token for the container.
 * Different sources can use different buckets and keys, so an area such as Finance can
 * be readable only by the people who have its key.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProviderHelp } from "../docs-providers/index.ts";
import { request, statusError } from "../snapshot-sources/http-util.ts";
import { rfc3986, signV4, UNSIGNED_PAYLOAD, type SigV4Credentials } from "../snapshot-sources/sigv4.ts";
import { elements, folderPrefix, text } from "../snapshot-sources/xml.ts";

export interface StoreObject { name: string; size: number; etag: string; updatedAt: string | null }
export interface StoreStatus { connected: boolean; source: "env" | "file" | null; problem: string | null }

export interface KnowledgeStore {
  label: string;
  status(): StoreStatus;
  connectHelp(): ProviderHelp | null;
  connect(key: string): Promise<StoreStatus>;
  disconnect(): StoreStatus;
  /** Every object under the prefix, at any depth (names relative to the prefix, "/"-separated). */
  list(): Promise<StoreObject[]>;
  get(name: string): Promise<{ body: Buffer; etag: string }>;
  /** Write; `ifMatch` = only if it's still that version, `ifNoneMatch` = only if it doesn't exist yet. Returns the new ETag. */
  put(name: string, body: Buffer, cond?: { ifMatch?: string; ifNoneMatch?: boolean }): Promise<string>;
  remove(name: string, ifMatch?: string): Promise<void>;
}

export interface StoreConfig { type: string; [k: string]: unknown }

/** Someone else changed (or created) it first. */
export class StoreConflict extends Error {
  status = 409;
  constructor(name: string) { super(`${name} was changed by someone else since you opened it.`); }
}

const MAX_GET_BYTES = 20 * 1024 * 1024;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,32}$/;
const ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The adapter for a source's `store` block. */
export function createStore(cfg: StoreConfig, source: { key: string; name: string }, ledgerDir: string): KnowledgeStore {
  const keyFile = path.join(ledgerDir, `knowledge-${source.key}.key`);
  const envName = `KNOWLEDGE_${source.key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
  const where = `docs.json "${source.key}" store`;
  const type = String(cfg?.type || "");
  if (type === "s3" || type === "gcs") return new S3Store(cfg, { keyFile, envName, where, gcs: type === "gcs" });
  if (type === "azure-blob") return new AzureStore(cfg, { keyFile, envName, where });
  return new BrokenStore(`${where}: "type" must be s3, gcs or azure-blob.`);
}

interface KeyPlace { keyFile: string; envName: string; where: string }

/** The pasted key (or the environment's), shared by every adapter. */
abstract class KeyedStore {
  protected readonly place: KeyPlace;
  constructor(place: KeyPlace) { this.place = place; }
  protected rawKey(): { key: string; source: "env" | "file" } | null {
    const env = process.env[this.place.envName];
    if (env && env.trim()) return { key: env.trim(), source: "env" };
    try { const k = fs.readFileSync(this.place.keyFile, "utf-8").trim(); if (k) return { key: k, source: "file" }; } catch {}
    return null;
  }
  protected saveKey(k: string) {
    fs.mkdirSync(path.dirname(this.place.keyFile), { recursive: true });
    fs.writeFileSync(this.place.keyFile, k, { mode: 0o600 });
  }
  disconnect(): StoreStatus {
    try { fs.unlinkSync(this.place.keyFile); } catch {}
    return (this as any).status();
  }
}

class BrokenStore implements KnowledgeStore {
  label = "Storage";
  private readonly problem: string;
  constructor(problem: string) { this.problem = problem; }
  status(): StoreStatus { return { connected: false, source: null, problem: this.problem }; }
  connectHelp(): ProviderHelp { return { title: "Finish the store settings", steps: [this.problem, "Then reload."], placeholder: "", needsKey: false, method: "key" }; }
  async connect(): Promise<StoreStatus> { throw new Error(this.problem); }
  disconnect(): StoreStatus { return this.status(); }
  async list(): Promise<StoreObject[]> { throw new Error(this.problem); }
  async get(): Promise<{ body: Buffer; etag: string }> { throw new Error(this.problem); }
  async put(): Promise<string> { throw new Error(this.problem); }
  async remove(): Promise<void> { throw new Error(this.problem); }
}

/** A name inside the prefix: relative, "/"-separated, no empty, "." or ".." parts. */
export function safeName(name: string): string {
  const n = String(name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!n || n.length > 400 || n.split("/").some((p) => !p || p === "." || p === ".." || /[\x00-\x1f]/.test(p))) throw Object.assign(new Error(`Invalid file name: ${name}`), { status: 400 });
  return n;
}

const unquote = (e: string | null | undefined) => String(e || "").replace(/^W\//, "").replace(/^"|"$/g, "");
const quote = (e: string) => `"${e.replace(/^"|"$/g, "")}"`;

async function readBody(res: import("node:http").IncomingMessage, what: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res) {
    n += c.length;
    if (n > MAX_GET_BYTES) { res.destroy(); throw new Error(`${what} is bigger than ${MAX_GET_BYTES / 1024 / 1024} MB.`); }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function contentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ({ ".md": "text/markdown; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf" } as Record<string, string>)[ext] || "application/octet-stream";
}

// ------------------------------------------------------------------ S3 (and S3-compatible: GCS, R2, MinIO)

export class S3Store extends KeyedStore implements KnowledgeStore {
  label: string;
  private readonly base: string | null;
  private readonly region: string;
  private readonly prefix: string;
  private readonly problem: string | null;

  constructor(cfg: StoreConfig, opts: KeyPlace & { gcs?: boolean }) {
    super(opts);
    const bucket = String(cfg.bucket || "").trim();
    const region = String(cfg.region || (opts.gcs ? "auto" : "us-east-1")).trim();
    let endpoint = String(cfg.endpoint || (opts.gcs ? "https://storage.googleapis.com" : "")).trim().replace(/\/+$/, "");
    let problem: string | null = !BUCKET.test(bucket) ? `${opts.where} needs "bucket": the bucket's name.`
      : !REGION.test(region) ? `${opts.where} "region" isn't a region name, e.g. "us-east-1".`
      : null;
    if (!problem && endpoint) { try { if (!/^https?:$/.test(new URL(endpoint).protocol)) throw 0; } catch { problem = `${opts.where} "endpoint" must be an http(s) address.`; endpoint = ""; } }
    this.problem = problem;
    this.region = region;
    this.prefix = folderPrefix(cfg.prefix);
    this.label = opts.gcs ? "Google Cloud Storage" : endpoint ? `S3 (${new URL(endpoint).hostname})` : "Amazon S3";
    this.base = problem ? null
      : endpoint ? `${endpoint}/${bucket}`
      : bucket.includes(".") ? `https://s3.${region}.amazonaws.com/${bucket}`
      : `https://${bucket}.s3.${region}.amazonaws.com`;
  }

  private creds(given?: SigV4Credentials | null): SigV4Credentials {
    if (given) return given;
    const k = this.rawKey();
    const c = k ? parseS3Key(k.key) : null;
    if (!c) throw Object.assign(new Error("Connect first: paste your access key on the Knowledge page."), { status: 409 });
    return c;
  }

  private url(name: string | null, query = ""): URL {
    if (!this.base) throw new Error(this.problem || "The store settings are incomplete.");
    const key = name === null ? "" : (this.prefix + name).split("/").map(rfc3986).join("/");
    return new URL(`${this.base}/${key}${query ? `?${query}` : ""}`);
  }

  private async send(method: string, url: URL, opts: { headers?: Record<string, string | number>; body?: Buffer; creds?: SigV4Credentials | null } = {}) {
    const headers = signV4({ method, url, headers: opts.headers || {}, region: this.region, service: "s3", credentials: this.creds(opts.creds), payloadHash: UNSIGNED_PAYLOAD });
    return request(url.toString(), { method, headers, body: opts.body });
  }

  status(): StoreStatus {
    const k = this.rawKey();
    return { connected: !!this.base && !!k && !!parseS3Key(k.key), source: k ? k.source : null, problem: this.problem };
  }

  connectHelp(): ProviderHelp | null {
    if (!this.base) return { title: "Finish the store settings", steps: [this.problem || "", "Then reload."], placeholder: "", needsKey: false, method: "key" };
    return {
      title: `Connect ${this.label}`,
      steps: [
        this.label === "Google Cloud Storage"
          ? "Ask your admin for an HMAC key for this bucket (Cloud Storage → Settings → Interoperability), with read and write access."
          : "Ask your admin for an access key that can read and write this bucket (s3:ListBucket, GetObject, PutObject, DeleteObject).",
        "Paste it below as `ACCESS_KEY_ID:SECRET`.",
        "It stays on this machine (in `.claude/ledger/`, never committed).",
      ],
      placeholder: "ACCESS_KEY_ID:secret",
      needsKey: true,
      method: "key",
    };
  }

  async connect(key: string): Promise<StoreStatus> {
    const c = parseS3Key(key);
    if (!c) throw Object.assign(new Error("Paste it as ACCESS_KEY_ID:SECRET."), { status: 400 });
    await this.listPage(null, c);
    this.saveKey(`${c.accessKeyId}:${c.secretAccessKey}${c.sessionToken ? `:${c.sessionToken}` : ""}`);
    return this.status();
  }

  private async listPage(token: string | null, creds?: SigV4Credentials | null): Promise<string> {
    const q = ["list-type=2", ...(this.prefix ? [`prefix=${rfc3986(this.prefix)}`] : []), ...(token ? [`continuation-token=${rfc3986(token)}`] : [])].join("&");
    const res = await this.send("GET", this.url(null, q), { creds });
    if (res.statusCode === 301) { res.resume(); throw new Error(`The bucket isn't in region "${this.region}": set "region" in ${this.place.where}.`); }
    if ((res.statusCode || 0) >= 300) throw await statusError(res, "Listing the knowledge bucket");
    return (await readBody(res, "The listing")).toString("utf-8");
  }

  async list(): Promise<StoreObject[]> {
    const out: StoreObject[] = [];
    let token: string | null = null;
    do {
      const xml = await this.listPage(token);
      for (const c of elements(xml, "Contents")) {
        const key = text(c, "Key") || "";
        if (!key.startsWith(this.prefix) || key.endsWith("/")) continue;
        out.push({ name: key.slice(this.prefix.length), size: Number(text(c, "Size")) || 0, etag: unquote(text(c, "ETag")), updatedAt: text(c, "LastModified") });
      }
      token = text(xml, "IsTruncated") === "true" ? text(xml, "NextContinuationToken") : null;
    } while (token);
    return out;
  }

  async get(name: string): Promise<{ body: Buffer; etag: string }> {
    const n = safeName(name);
    const res = await this.send("GET", this.url(n));
    if ((res.statusCode || 0) >= 300) throw await statusError(res, `Reading ${n}`);
    const etag = unquote(res.headers.etag as string);
    return { body: await readBody(res, n), etag };
  }

  async put(name: string, body: Buffer, cond: { ifMatch?: string; ifNoneMatch?: boolean } = {}): Promise<string> {
    const n = safeName(name);
    // Not every S3-compatible store honours If-Match on PUT; check first as well.
    if (cond.ifMatch || cond.ifNoneMatch) {
      const cur = await this.head(n);
      if (cond.ifNoneMatch && cur) throw new StoreConflict(n);
      if (cond.ifMatch && (!cur || cur !== unquote(cond.ifMatch))) throw new StoreConflict(n);
    }
    const headers: Record<string, string | number> = { "content-length": body.length, "content-type": contentType(n) };
    if (cond.ifMatch) headers["if-match"] = quote(cond.ifMatch);
    if (cond.ifNoneMatch) headers["if-none-match"] = "*";
    const res = await this.send("PUT", this.url(n), { headers, body });
    if (res.statusCode === 412) { res.resume(); throw new StoreConflict(n); }
    if ((res.statusCode || 0) >= 300) throw await statusError(res, `Saving ${n}`);
    res.resume();
    return unquote(res.headers.etag as string) || (await this.head(n)) || "";
  }

  private async head(name: string): Promise<string | null> {
    const res = await this.send("HEAD", this.url(name));
    res.resume();
    if (res.statusCode === 404) return null;
    if ((res.statusCode || 0) >= 300) throw await statusError(res, `Checking ${name}`);
    return unquote(res.headers.etag as string);
  }

  async remove(name: string, ifMatch?: string): Promise<void> {
    const n = safeName(name);
    if (ifMatch) { const cur = await this.head(n); if (cur && cur !== unquote(ifMatch)) throw new StoreConflict(n); }
    const res = await this.send("DELETE", this.url(n));
    if ((res.statusCode || 0) >= 300 && res.statusCode !== 404) throw await statusError(res, `Deleting ${n}`);
    res.resume();
  }
}

/** "ACCESS_KEY_ID:SECRET[:SESSION_TOKEN]". */
export function parseS3Key(raw: string): SigV4Credentials | null {
  const [accessKeyId, secretAccessKey, ...rest] = String(raw || "").trim().split(":");
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), sessionToken: rest.join(":").trim() || null };
}

// ------------------------------------------------------------------ Azure Blob Storage

const AZURE_API = "2023-11-03";

export class AzureStore extends KeyedStore implements KnowledgeStore {
  label = "Azure Blob Storage";
  private readonly base: string | null;
  private readonly prefix: string;
  private readonly problem: string | null;

  constructor(cfg: StoreConfig, opts: KeyPlace) {
    super(opts);
    const account = String(cfg.account || "").trim();
    const container = String(cfg.container || "").trim();
    let endpoint = String(cfg.endpoint || "").trim().replace(/\/+$/, "");
    this.problem = !ACCOUNT.test(account) && !endpoint ? `${opts.where} needs "account": the storage account name.`
      : !CONTAINER.test(container) ? `${opts.where} needs "container": the blob container's name.`
      : null;
    if (!endpoint && ACCOUNT.test(account)) endpoint = `https://${account}.blob.core.windows.net`;
    this.base = this.problem ? null : `${endpoint}/${container}`;
    this.prefix = folderPrefix(cfg.prefix);
  }

  private sas(given?: string): string {
    const k = given ?? this.rawKey()?.key.replace(/^.*\?/, "");
    if (!k) throw Object.assign(new Error("Connect first: paste your SAS token on the Knowledge page."), { status: 409 });
    return k;
  }

  private url(name: string | null, query = "", sas?: string): string {
    if (!this.base) throw new Error(this.problem || "The store settings are incomplete.");
    const blob = name === null ? "" : `/${(this.prefix + name).split("/").map(encodeURIComponent).join("/")}`;
    return `${this.base}${blob}?${query ? `${query}&` : ""}${this.sas(sas)}`;
  }

  private h(extra: Record<string, string | number> = {}) { return { "x-ms-version": AZURE_API, ...extra }; }

  status(): StoreStatus {
    const k = this.rawKey();
    return { connected: !!this.base && !!k, source: k ? k.source : null, problem: this.problem };
  }

  connectHelp(): ProviderHelp | null {
    if (!this.base) return { title: "Finish the store settings", steps: [this.problem || "", "Then reload."], placeholder: "", needsKey: false, method: "key" };
    return {
      title: "Connect Azure Blob Storage",
      steps: [
        "Ask your admin for a SAS token for this container with read, write, delete and list.",
        "Paste it below: the part after the ?, or the whole thing.",
        "It stays on this machine (in `.claude/ledger/`, never committed).",
      ],
      placeholder: "sv=…&sig=…",
      needsKey: true,
      method: "key",
    };
  }

  async connect(key: string): Promise<StoreStatus> {
    const k = String(key || "").trim().replace(/^.*\?/, "");
    if (!/(^|&)sig=/.test(k)) throw Object.assign(new Error("That isn't a SAS token: it should contain sig=…"), { status: 400 });
    await this.listPage(null, k);
    this.saveKey(k);
    return this.status();
  }

  private async listPage(marker: string | null, sas?: string): Promise<string> {
    const q = ["restype=container", "comp=list", ...(this.prefix ? [`prefix=${encodeURIComponent(this.prefix)}`] : []), ...(marker ? [`marker=${encodeURIComponent(marker)}`] : [])].join("&");
    const res = await request(this.url(null, q, sas), { headers: this.h() });
    if ((res.statusCode || 0) >= 300) throw await statusError(res, "Listing the knowledge container");
    return (await readBody(res, "The listing")).toString("utf-8");
  }

  async list(): Promise<StoreObject[]> {
    const out: StoreObject[] = [];
    let marker: string | null = null;
    do {
      const xml = await this.listPage(marker);
      for (const b of elements(xml, "Blob")) {
        const full = text(b, "Name") || "";
        if (!full.startsWith(this.prefix) || full.endsWith("/")) continue;
        const modified = text(b, "Last-Modified");
        out.push({ name: full.slice(this.prefix.length), size: Number(text(b, "Content-Length")) || 0, etag: unquote(text(b, "Etag")), updatedAt: modified ? new Date(modified).toISOString() : null });
      }
      marker = text(xml, "NextMarker") || null;
    } while (marker);
    return out;
  }

  async get(name: string): Promise<{ body: Buffer; etag: string }> {
    const n = safeName(name);
    const res = await request(this.url(n), { headers: this.h() });
    if ((res.statusCode || 0) >= 300) throw await statusError(res, `Reading ${n}`);
    const etag = unquote(res.headers.etag as string);
    return { body: await readBody(res, n), etag };
  }

  async put(name: string, body: Buffer, cond: { ifMatch?: string; ifNoneMatch?: boolean } = {}): Promise<string> {
    const n = safeName(name);
    const headers: Record<string, string | number> = this.h({ "x-ms-blob-type": "BlockBlob", "Content-Length": body.length, "Content-Type": contentType(n) });
    if (cond.ifMatch) headers["If-Match"] = quote(cond.ifMatch);
    if (cond.ifNoneMatch) headers["If-None-Match"] = "*";
    const res = await request(this.url(n), { method: "PUT", headers, body });
    if (res.statusCode === 412 || res.statusCode === 409) { res.resume(); throw new StoreConflict(n); }
    if ((res.statusCode || 0) >= 300) throw await statusError(res, `Saving ${n}`);
    res.resume();
    return unquote(res.headers.etag as string);
  }

  async remove(name: string, ifMatch?: string): Promise<void> {
    const n = safeName(name);
    const res = await request(this.url(n), { method: "DELETE", headers: this.h(ifMatch ? { "If-Match": quote(ifMatch) } : {}) });
    if (res.statusCode === 412) { res.resume(); throw new StoreConflict(n); }
    if ((res.statusCode || 0) >= 300 && res.statusCode !== 404) throw await statusError(res, `Deleting ${n}`);
    res.resume();
  }
}

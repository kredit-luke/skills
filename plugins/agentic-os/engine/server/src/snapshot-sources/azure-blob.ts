/**
 * Snapshots as blobs in one Azure Blob Storage container (REST, SAS auth). repos.json:
 *
 *   "snapshot": { "source": "azure-blob", "account": "acmecode", "container": "snapshots", "prefix": "code/" }
 *
 * The key is a SAS token for the container (the query string, with or without the
 * leading "?"): SNAPSHOT_AZURE_SAS, else the ledger file snapshot-azure-sas (pasted on
 * the Repos page). Read + list to download; add write + delete to publish (and delete
 * version, with blob versioning on, to prune). Issue it from a stored access policy so
 * it can be revoked without rotating the account key. `endpoint` replaces
 * https://<account>.blob.core.windows.net (Azurite, sovereign clouds).
 */

import fs from "node:fs";
import path from "node:path";
import type { ProviderContext, ProviderHelp, ProviderStatus } from "../docs-providers/index.ts";
import type { SnapshotConfig } from "../repos.ts";
import type { SnapshotFile, SnapshotSource } from "./index.ts";
import { downloadFile, request, requestJson, statusError } from "./http-util.ts";
import { elements, folderPrefix, text } from "./xml.ts";

const API_VERSION = "2023-11-03";
const ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** Put Blob's single-request limit. */
const MAX_PUT_BYTES = 5000 * 1024 * 1024;

export class AzureBlobSource implements SnapshotSource {
  kind = "azure-blob";
  label = "Azure Blob Storage";
  maxFileBytes = MAX_PUT_BYTES;
  private readonly base: string | null;
  private readonly prefix: string;
  private readonly keyFile: string;
  private readonly problem: string | null;

  constructor(cfg: SnapshotConfig, ctx: ProviderContext) {
    const account = String(cfg.account || "").trim();
    const container = String(cfg.container || "").trim();
    let endpoint = String(cfg.endpoint || "").trim().replace(/\/+$/, "");
    this.problem = !ACCOUNT.test(account) && !endpoint ? 'repos.json snapshot needs "account": the storage account name (3-24 lowercase letters and digits).'
      : !CONTAINER.test(container) ? 'repos.json snapshot needs "container": the blob container\'s name.'
      : null;
    if (!endpoint && ACCOUNT.test(account)) endpoint = `https://${account}.blob.core.windows.net`;
    this.base = this.problem ? null : `${endpoint}/${container}`;
    this.prefix = folderPrefix(cfg.prefix);
    this.keyFile = path.join(ctx.ledgerDir, "snapshot-azure-sas");
  }

  private key(): { key: string; source: ProviderStatus["source"] } | null {
    const env = process.env.SNAPSHOT_AZURE_SAS;
    if (env && env.trim()) return { key: env.trim().replace(/^\?/, ""), source: "env" };
    try { const k = fs.readFileSync(this.keyFile, "utf-8").trim().replace(/^\?/, ""); if (k) return { key: k, source: "file" }; } catch {}
    return null;
  }

  private sas(given?: string): string {
    const k = given ?? this.key()?.key;
    if (!k) throw new Error("Connect first: paste the SAS token on the Repos page.");
    return k;
  }

  /** The container (no name) or one blob, with the SAS and any extra query appended. */
  private url(name: string | null, query = "", sas?: string): string {
    if (!this.base) throw new Error(this.problem || "repos.json snapshot is incomplete.");
    const blob = name === null ? "" : `/${(this.prefix + name).split("/").map(encodeURIComponent).join("/")}`;
    return `${this.base}${blob}?${query ? `${query}&` : ""}${this.sas(sas)}`;
  }

  private headers(extra: Record<string, string | number> = {}) { return { "x-ms-version": API_VERSION, ...extra }; }

  status(): ProviderStatus {
    const k = this.key();
    return { connected: !!this.base && !!k, source: k ? k.source : null, viewer: null };
  }

  connectHelp(): ProviderHelp | null {
    if (!this.base) return { title: "Finish the snapshot settings", steps: [this.problem || "", "Then reload."], placeholder: "", needsKey: false, method: "key" };
    return {
      title: "Connect the code download",
      steps: [
        "Ask whoever publishes the code for a SAS token for the snapshot container (read and list).",
        "Paste it below: the part after the ?, or the whole thing with it.",
        "It stays on this machine (in `.claude/ledger/`, never committed).",
      ],
      placeholder: "sv=…&sig=…",
      needsKey: true,
      method: "key",
    };
  }

  async connect(key: string): Promise<ProviderStatus> {
    const k = String(key || "").trim().replace(/^.*\?/, "");
    if (!/(^|&)sig=/.test(k)) throw new Error("That isn't a SAS token: it should contain sig=…");
    // Check it can list the container before keeping it.
    await this.listPage(null, k);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, k, { mode: 0o600 });
    return this.status();
  }

  disconnect(): ProviderStatus {
    try { fs.unlinkSync(this.keyFile); } catch {}
    return this.status();
  }

  private async listPage(marker: string | null, sas?: string, versions = false): Promise<{ xml: string; next: string | null }> {
    const q = ["restype=container", "comp=list", ...(this.prefix ? [`prefix=${encodeURIComponent(this.prefix)}`] : []), ...(versions ? ["include=versions"] : []), ...(marker ? [`marker=${encodeURIComponent(marker)}`] : [])].join("&");
    const res = await request(this.url(null, q, sas), { headers: this.headers() });
    if ((res.statusCode || 0) >= 300) throw await statusError(res, "Listing the snapshot container");
    let xml = "";
    for await (const c of res) xml += c;
    return { xml, next: text(xml, "NextMarker") || null };
  }

  /** Every blob under the prefix: { name without the prefix, versionId, current }. */
  private async blobs(versions: boolean): Promise<{ file: SnapshotFile; versionId: string | null; current: boolean }[]> {
    const out: { file: SnapshotFile; versionId: string | null; current: boolean }[] = [];
    let marker: string | null = null;
    do {
      const page = await this.listPage(marker, undefined, versions);
      for (const b of elements(page.xml, "Blob")) {
        const full = text(b, "Name") || "";
        if (!full.startsWith(this.prefix)) continue;
        const name = full.slice(this.prefix.length);
        if (!name || name.includes("/")) continue;
        const size = Number(text(b, "Content-Length"));
        const modified = text(b, "Last-Modified");
        out.push({
          file: { id: name, name, size: Number.isFinite(size) ? size : null, updatedAt: modified ? new Date(modified).toISOString() : null },
          versionId: text(b, "VersionId"),
          current: !versions || text(b, "IsCurrentVersion") === "true",
        });
      }
      marker = page.next;
    } while (marker);
    return out;
  }

  async list(): Promise<SnapshotFile[]> {
    return (await this.blobs(false)).map((b) => b.file);
  }

  async download(file: SnapshotFile, destPath: string): Promise<void> {
    await downloadFile(this.url(file.name), this.headers(), destPath, `Downloading ${file.name}`);
  }

  /** Put Blob: one request, streamed from disk; replaces a blob of the same name. */
  async upload(name: string, srcPath: string): Promise<void> {
    const size = fs.statSync(srcPath).size;
    await requestJson(this.url(name), {
      method: "PUT",
      headers: this.headers({ "x-ms-blob-type": "BlockBlob", "Content-Length": size, "Content-Type": "application/octet-stream" }),
      body: (req) => {
        const rs = fs.createReadStream(srcPath);
        rs.on("error", (e) => req.destroy(e));
        rs.pipe(req);
      },
    }, `Uploading ${name}`);
  }

  async remove(file: SnapshotFile): Promise<void> {
    await requestJson(this.url(file.name), { method: "DELETE", headers: this.headers() }, `Deleting ${file.name}`);
  }

  /**
   * With blob versioning on, each upload keeps the replaced blob as a version: delete
   * those for the named files. Without versioning there are none.
   */
  async prune(names: string[]): Promise<number> {
    const own = new Set(names);
    let removed = 0;
    for (const b of await this.blobs(true)) {
      if (b.current || !b.versionId || !own.has(b.file.name)) continue;
      await requestJson(this.url(b.file.name, `versionid=${encodeURIComponent(b.versionId)}`), { method: "DELETE", headers: this.headers() }, `Deleting an old version of ${b.file.name}`);
      removed++;
    }
    return removed;
  }
}

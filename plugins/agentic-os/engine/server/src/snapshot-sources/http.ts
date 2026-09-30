/**
 * Snapshots on any web server with direct links: S3 / CloudFront, an internal file
 * server, a CDN. Read-only: publish uploads somewhere else (CI copies the files there)
 * and this downloads <baseUrl>/<name>. repos.json:
 *
 *   "snapshot": { "source": "http", "baseUrl": "https://files.acme.com/code", "auth": "none" | "bearer" | "basic" }
 *
 * With auth, the viewer's key is SNAPSHOT_HTTP_TOKEN, else the ledger file
 * snapshot-http-token (pasted on the Repos page): a bearer token, or "user:password" for basic.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProviderContext, ProviderHelp, ProviderStatus } from "../docs-providers/index.ts";
import type { SnapshotConfig } from "../repos.ts";
import type { SnapshotFile, SnapshotSource } from "./index.ts";
import { downloadFile, requestJson } from "./http-util.ts";
import { MANIFEST } from "./manifest.ts";


const NAME = /^[\w.-]+$/;

export class HttpSource implements SnapshotSource {
  kind = "http";
  label = "Web server";
  maxFileBytes = null;
  private readonly baseUrl: string | null;
  private readonly auth: "none" | "bearer" | "basic";
  private readonly keyFile: string;

  constructor(cfg: SnapshotConfig, ctx: ProviderContext) {
    let base: string | null = null;
    try {
      const u = new URL(String(cfg.baseUrl || ""));
      if (u.protocol === "https:" || u.protocol === "http:") base = u.toString().replace(/\/+$/, "");
    } catch {}
    this.baseUrl = base;
    this.auth = cfg.auth === "bearer" || cfg.auth === "basic" ? cfg.auth : "none";
    this.keyFile = path.join(ctx.ledgerDir, "snapshot-http-token");
  }

  private key(): { key: string; source: ProviderStatus["source"] } | null {
    if (process.env.SNAPSHOT_HTTP_TOKEN) return { key: process.env.SNAPSHOT_HTTP_TOKEN.trim(), source: "env" };
    try { const k = fs.readFileSync(this.keyFile, "utf-8").trim(); if (k) return { key: k, source: "file" }; } catch {}
    return null;
  }

  private headers(): Record<string, string> {
    if (this.auth === "none") return {};
    const k = this.key();
    if (!k) throw new Error("Connect first: paste the download key on the Repos page.");
    return { Authorization: this.auth === "bearer" ? `Bearer ${k.key}` : `Basic ${Buffer.from(k.key).toString("base64")}` };
  }

  private url(name: string): string {
    if (!this.baseUrl) throw new Error('repos.json snapshot needs "baseUrl", e.g. "https://files.acme.com/code".');
    if (!NAME.test(name)) throw new Error(`Bad snapshot file name ${JSON.stringify(name)}`);
    return `${this.baseUrl}/${name}`;
  }

  status(): ProviderStatus {
    const k = this.key();
    return { connected: !!this.baseUrl && (this.auth === "none" || !!k), source: this.auth === "none" ? null : k ? k.source : null, viewer: null };
  }

  connectHelp(): ProviderHelp | null {
    if (!this.baseUrl) return { title: "Set the download address", steps: ['Set `"baseUrl"` on `snapshot` in `repos.json`, then reload.'], placeholder: "", needsKey: false, method: "key" };
    if (this.auth === "none") return null;
    return {
      title: "Connect the code download",
      steps: [
        this.auth === "bearer" ? "Ask whoever publishes the code for a download token." : "Ask whoever publishes the code for a download user name and password.",
        this.auth === "bearer" ? "Paste the token below." : "Paste it below as `user:password`.",
        "It stays on this machine (in `.claude/ledger/`, never committed).",
      ],
      placeholder: this.auth === "bearer" ? "token" : "user:password",
      needsKey: true,
      method: "key",
    };
  }

  async connect(key: string): Promise<ProviderStatus> {
    const k = String(key || "").trim();
    if (!k) throw new Error("Paste the key first.");
    if (this.auth === "basic" && !k.includes(":")) throw new Error("Paste it as user:password.");
    // Check it against the manifest before keeping it.
    const header = this.auth === "bearer" ? `Bearer ${k}` : `Basic ${Buffer.from(k).toString("base64")}`;
    await requestJson(this.url(MANIFEST), { headers: { Authorization: header } }, "Reading the snapshot manifest");
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, k, { mode: 0o600 });
    return this.status();
  }

  disconnect(): ProviderStatus {
    try { fs.unlinkSync(this.keyFile); } catch {}
    return this.status();
  }

  /** A web server has no listing: the manifest names the files. */
  async list(): Promise<SnapshotFile[]> {
    const m = await requestJson(this.url(MANIFEST), { headers: this.headers() }, "Reading the snapshot manifest");
    const files: SnapshotFile[] = [{ id: MANIFEST, name: MANIFEST, size: null, updatedAt: m.builtAt || null }];
    const entries = [...Object.values(m.repos || {}), ...(m.workspace ? [m.workspace] : [])] as any[];
    for (const e of entries) if (e && typeof e.file === "string" && NAME.test(e.file)) files.push({ id: e.file, name: e.file, size: Number(e.size) || null, updatedAt: e.builtAt || m.builtAt || null });
    return files;
  }

  async download(file: SnapshotFile, destPath: string): Promise<void> {
    await downloadFile(this.url(file.name), this.headers(), destPath, `Downloading ${file.name}`);
  }
}

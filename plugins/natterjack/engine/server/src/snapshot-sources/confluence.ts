/**
 * Snapshots as attachments on one Confluence Cloud page (REST v1). repos.json:
 *
 *   "snapshot": { "source": "confluence", "site": "acme.atlassian.net", "pageId": "123456", "maxFileMb": 100 }
 *
 * The page's view permissions decide who can download the code. The key is the one the
 * Docs page uses for Confluence (ledger confluence-api-token, CONFLUENCE_EMAIL +
 * CONFLUENCE_API_TOKEN, or the tracker's key when it's Jira on the same site), so
 * someone already connected there is connected here. Publishing needs a key that can
 * edit the page. `maxFileMb` is the site's attachment size limit (100 MB is Confluence
 * Cloud's default; an admin can change it).
 */

import type { ProviderContext, ProviderHelp, ProviderStatus } from "../docs-providers/index.ts";
import { ConfluenceProvider } from "../docs-providers/confluence.ts";
import type { SnapshotConfig } from "../repos.ts";
import type { SnapshotFile, SnapshotSource } from "./index.ts";
import { downloadFile, multipartFile, requestJson } from "./http-util.ts";

const PAGE_ID = /^\d{1,20}$/;
const DEFAULT_MAX_MB = 100;

export class ConfluenceSource implements SnapshotSource {
  kind = "confluence";
  label = "Confluence";
  maxFileBytes: number;
  private readonly auth: ConfluenceProvider;
  private readonly pageId: string | null;

  constructor(cfg: SnapshotConfig, ctx: ProviderContext) {
    const site = String(cfg.site || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    // The docs provider owns the key (lookup, validation, the ledger file); only its credentials are used.
    this.auth = new ConfluenceProvider({ key: "snapshot", kind: "external", provider: "confluence", url: `https://${site}/wiki` } as any, ctx);
    const id = String(cfg.pageId ?? "").trim();
    this.pageId = PAGE_ID.test(id) ? id : null;
    const mb = Number(cfg.maxFileMb);
    this.maxFileBytes = (mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
  }

  /** https://<site>; a test points it at a local server. */
  protected origin(): string { return this.auth.origin; }
  private get wiki() { return `${this.origin()}/wiki`; }

  private headers(): Record<string, string> {
    const cred = this.auth._cred();
    if (!cred) throw new Error("Connect Confluence first.");
    return { Authorization: `Basic ${Buffer.from(cred.cred).toString("base64")}` };
  }

  private page(): string {
    if (!this.auth.site) throw new Error('repos.json snapshot needs "site", e.g. "acme.atlassian.net".');
    if (!this.pageId) throw new Error('repos.json snapshot needs "pageId": the number in the page\'s URL (…/pages/<pageId>/…).');
    return this.pageId;
  }

  status(): ProviderStatus { return this.auth.status(); }

  connectHelp(): ProviderHelp | null {
    const base = this.auth.connectHelp();
    if (!base || !base.needsKey) return base;
    return {
      ...base,
      steps: [
        base.steps[0],
        base.steps[1],
        "It stays on this machine (in `.claude/ledger/`, never committed). The download works if your account can view the page the code is published on.",
      ],
      method: "key",
    };
  }

  connect(key: string): Promise<ProviderStatus> { return this.auth.connect(key); }
  disconnect(): ProviderStatus { return this.auth.disconnect(); }

  async list(): Promise<SnapshotFile[]> {
    const page = this.page();
    const out: SnapshotFile[] = [];
    let next: string | null = `/wiki/rest/api/content/${page}/child/attachment?limit=100&expand=version`;
    const headers = this.headers();
    while (next) {
      const res = await requestJson(`${this.origin()}${next}`, { headers }, "Listing the page's attachments");
      for (const a of res.results || []) {
        out.push({
          id: String(a.id),
          name: String(a.title || ""),
          size: a.extensions && Number.isFinite(Number(a.extensions.fileSize)) ? Number(a.extensions.fileSize) : null,
          updatedAt: (a.version && a.version.when) || null,
        });
      }
      const n = res._links && res._links.next;
      // v1 hands back a path relative to the site root, sometimes without /wiki.
      next = typeof n === "string" && n ? (n.startsWith("/wiki/") ? n : `/wiki${n}`) : null;
    }
    return out;
  }

  async download(file: SnapshotFile, destPath: string): Promise<void> {
    const page = this.page();
    // Redirects to Atlassian's media service with a signed URL; http-util drops our credentials on the way.
    const url = `${this.wiki}/rest/api/content/${page}/child/attachment/${encodeURIComponent(file.id)}/download`;
    await downloadFile(url, this.headers(), destPath, `Downloading ${file.name}`);
  }

  async upload(name: string, srcPath: string): Promise<void> {
    const page = this.page();
    // PUT creates the attachment, or adds a version to the one with this file name.
    const form = multipartFile(srcPath, name, { minorEdit: "true", comment: "Published by natterjack snapshot" });
    await requestJson(`${this.wiki}/rest/api/content/${page}/child/attachment`, {
      method: "PUT",
      headers: { ...this.headers(), "X-Atlassian-Token": "nocheck", ...form.headers },
      body: form.body,
    }, `Uploading ${name}`);
  }

  /** Moves the attachment to the space's trash. */
  async remove(file: SnapshotFile): Promise<void> {
    await requestJson(`${this.wiki}/rest/api/content/${encodeURIComponent(file.id)}`, { method: "DELETE", headers: this.headers() }, `Deleting ${file.name}`);
  }

  /**
   * Each upload is a new version of the attachment; delete all but the current one, so
   * nightly publishes don't pile up. Only the named files: the page may have others.
   */
  async prune(names: string[]): Promise<number> {
    const headers = this.headers();
    const own = new Set(names);
    let removed = 0;
    for (const f of (await this.list()).filter((x) => own.has(x.name))) {
      const res = await requestJson(`${this.wiki}/rest/api/content/${encodeURIComponent(f.id)}/version?limit=200`, { headers }, `Listing versions of ${f.name}`);
      const numbers: number[] = (res.results || []).map((v: any) => Number(v.number)).filter((n: number) => Number.isInteger(n));
      const latest = Math.max(0, ...numbers);
      for (const n of numbers.filter((x) => x !== latest)) {
        await requestJson(`${this.wiki}/rest/api/content/${encodeURIComponent(f.id)}/version/${n}`, { method: "DELETE", headers }, `Deleting version ${n} of ${f.name}`);
        removed++;
      }
    }
    return removed;
  }
}

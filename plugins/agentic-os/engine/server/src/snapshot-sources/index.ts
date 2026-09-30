/**
 * Snapshot sources: where read-only copies of the workspace's repos are published
 * (by `dashboard/bin/snapshot.mjs publish`, usually from CI) and downloaded from (the
 * Repos page), for people who can't clone. repos.json picks one:
 *
 *   "snapshot": { "source": "confluence", "site": "acme.atlassian.net", "pageId": "123456" }
 *   "snapshot": { "source": "http", "baseUrl": "https://files.acme.com/code", "auth": "bearer" }
 *
 * An adapter only moves files by name. What's in them is snapshot.ts's business: one
 * <repo>.tar.gz per repo plus snapshot-manifest.json (names → commit, size, date),
 * uploaded last. Credentials are the viewer's own, in the ledger (never committed).
 *
 * To add a source: implement SnapshotSource in snapshot-sources/<kind>.ts and register
 * it in SOURCES (the agentic-os add-adapter skill walks through it).
 */

import type { ProviderContext, ProviderHelp, ProviderStatus } from "../docs-providers/index.ts";
import type { SnapshotConfig } from "../repos.ts";
import { ConfluenceSource } from "./confluence.ts";
import { HttpSource } from "./http.ts";

export interface SnapshotFile { id: string; name: string; size: number | null; updatedAt: string | null }

export interface SnapshotSource {
  kind: string;
  /** Shown in the UI: "Confluence", "Web server", ... */
  label: string;
  /** Largest file the source takes (publish refuses bigger ones); null = no limit known. */
  maxFileBytes: number | null;
  status(): ProviderStatus;
  connectHelp(): ProviderHelp | null;
  connect(key: string): Promise<ProviderStatus>;
  disconnect(): ProviderStatus;
  list(): Promise<SnapshotFile[]>;
  /** Stream a file to destPath. */
  download(file: SnapshotFile, destPath: string): Promise<void>;
  /** Publishing only: create or replace the file called `name`. */
  upload?(name: string, srcPath: string): Promise<void>;
  /** Publishing only: delete a file (one the new manifest no longer names). */
  remove?(file: SnapshotFile): Promise<void>;
  /** Publishing only: drop old versions of the named files (only those: the source may hold other files); returns how many. */
  prune?(names: string[]): Promise<number>;
}

type Factory = (cfg: SnapshotConfig, ctx: ProviderContext) => SnapshotSource;
const SOURCES: Record<string, Factory> = {
  confluence: (cfg, ctx) => new ConfluenceSource(cfg, ctx),
  http: (cfg, ctx) => new HttpSource(cfg, ctx),
};

export function snapshotSourceKinds(): string[] {
  return Object.keys(SOURCES);
}

/** The adapter for repos.json's `snapshot` block; throws for an unknown kind (the message says which exist). */
export function createSource(cfg: SnapshotConfig, ctx: ProviderContext): SnapshotSource {
  const make = SOURCES[cfg.source];
  if (!make) throw new Error(`repos.json snapshot.source "${cfg.source}" isn't supported (known: ${snapshotSourceKinds().join(", ")}).`);
  return make(cfg, ctx);
}

/** One instance per config (adapters cache the signed-in viewer). */
export class SnapshotSources {
  private cache: { sig: string; source: SnapshotSource } | null = null;
  private readonly ctx: () => ProviderContext;
  constructor(ctx: () => ProviderContext) { this.ctx = ctx; }
  get(cfg: SnapshotConfig): SnapshotSource {
    const ctx = this.ctx();
    const sig = JSON.stringify([cfg, ctx.issues]);
    if (this.cache && this.cache.sig === sig) return this.cache.source;
    const source = createSource(cfg, ctx);
    this.cache = { sig, source };
    return source;
  }
}

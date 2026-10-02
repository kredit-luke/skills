/**
 * Docs providers: search and read docs that live outside the workspace
 * (Confluence first; Notion, Google Drive, a wiki… the same way), for a
 * docs.json source with `"kind": "external", "provider": "<kind>"`.
 *
 * The dashboard reads the service directly with each person's own credentials,
 * like the issue trackers: searching costs no Claude usage, and everyone sees
 * only what their account can see. Claude runs that should use the docs get a
 * note (the "Use <source>" toggle) pointing them at that service's MCP connector.
 *
 * A provider is added like a tracker adapter: implement DocsProvider in
 * docs-providers/<kind>.ts and register it in PROVIDERS.
 */

import type { DocSiteDef } from "../docs.ts";
import { ConfluenceProvider } from "./confluence.ts";

export interface ExcerptPart { text: string; hl: boolean }
export interface DocHit {
  id: string; title: string; url: string;
  space: string; spaceName: string;
  excerpt: ExcerptPart[];
  updatedAt?: string | null;
}
export interface DocPage {
  id: string; title: string; url: string;
  space: string; spaceName: string;
  /** The page body as HTML (links absolute). The UI renders it through Angular's sanitizer. */
  html: string;
  updatedAt?: string | null; updatedBy?: string | null;
  labels: string[];
  ancestors: { id: string; title: string }[];
}
export interface DocSpace { key: string; name: string; url: string }
export interface ProviderStatus {
  connected: boolean;
  /** Where the key came from: an env var, the pasted key, or the issue tracker's key for the same site. */
  source: "env" | "file" | "tracker" | null;
  viewer: string | null;
}
/**
 * How to connect. `method` "key" (the default) = paste a key into the card; "oauth" is
 * reserved for a sign-in-with flow (an adapter that has one returns its authorize URL
 * from connect) and nothing uses it yet.
 */
export interface ProviderHelp {
  title: string; steps: string[]; placeholder: string; needsKey: boolean; method?: "key" | "oauth";
  /** 'email-token': the key is an email and an API token, asked for in two fields and sent as "email:token". */
  keyFields?: "email-token";
}

export interface DocsProvider {
  kind: string;
  label: string;
  status(): ProviderStatus;
  connectHelp(): ProviderHelp | null;
  connect(key: string): Promise<ProviderStatus>;
  disconnect(): ProviderStatus;
  spaces(): Promise<DocSpace[]>;
  /** Best matches first; an empty query lists recently updated pages. */
  search(query: string, spaces: string[], limit?: number): Promise<DocHit[]>;
  page(id: string): Promise<DocPage>;
  /** Appended to a run's system prompt when the run should use these docs. */
  runNote(pageId?: string | null): string;
}

export interface ProviderContext {
  ledgerDir: string;
  /** workspace.json issues (kind, site), so a provider on the same site can reuse the tracker's key. */
  issues: { kind: string; site?: string | null };
}

type Factory = (source: DocSiteDef, ctx: ProviderContext) => DocsProvider;
const PROVIDERS: Record<string, Factory> = {
  confluence: (source, ctx) => new ConfluenceProvider(source, ctx),
};

export function providerKinds(): string[] {
  return Object.keys(PROVIDERS);
}

/** One provider instance per docs source (they cache spaces and the signed-in viewer). */
export class DocsProviders {
  private cache = new Map<string, { sig: string; provider: DocsProvider }>();
  private ctx: () => ProviderContext;
  constructor(ctx: () => ProviderContext) { this.ctx = ctx; }

  /** The provider for a source, or null when the source isn't external or its provider has no adapter. */
  get(source: DocSiteDef | undefined | null): DocsProvider | null {
    if (!source || source.kind !== "external" || !source.provider || !PROVIDERS[source.provider]) return null;
    const ctx = this.ctx();
    const sig = JSON.stringify([source, ctx.issues]);
    const hit = this.cache.get(source.key);
    if (hit && hit.sig === sig) return hit.provider;
    const provider = PROVIDERS[source.provider](source, ctx);
    this.cache.set(source.key, { sig, provider });
    return provider;
  }
}

/**
 * Confluence Cloud (REST v1 search + content), with the viewer's own Atlassian
 * API token. docs.json:
 *
 *   { "key": "wiki", "name": "Confluence", "kind": "external", "provider": "confluence",
 *     "url": "https://acme.atlassian.net/wiki", "spaces": ["ENG", "OPS"] }
 *
 * `spaces` narrows search (empty = every non-personal space the token can see).
 * Key lookup: CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN, else <ledger>/confluence-api-token
 * ("email:token", written by the Connect card), else, when the issue tracker is
 * Jira on the same site, Jira's key (it's the same Atlassian token). Never sent
 * to the browser.
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { atlassianRequest, removeKeyFile } from "../atlassian.ts";
import type { DocSiteDef } from "../docs.ts";
import type {
  DocHit, DocPage, DocSpace, DocsProvider, ExcerptPart, ProviderContext, ProviderHelp, ProviderStatus,
} from "./index.ts";
import { decodeEntities, quoted } from "./util.ts";

const SPACE_KEY = /^[A-Za-z0-9_~-]{1,255}$/;
const PAGE_ID = /^\d{1,20}$/;
const SPACES_TTL_MS = 10 * 60_000;

export class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** The CQL for a search: pages, the query on `field`, the chosen spaces. */
export function buildCql(query: string, spaces: string[], field: "siteSearch" | "text" = "siteSearch"): string {
  const parts = ["type = page"];
  const q = query.trim();
  if (q) parts.push(`${field} ~ ${quoted(q)}`);
  const keys = spaces.filter((s) => SPACE_KEY.test(s));
  if (keys.length) parts.push(`space IN (${keys.map(quoted).join(", ")})`);
  // No query: what changed most recently. With one, Confluence ranks by relevance.
  return parts.join(" AND ") + (q ? "" : " ORDER BY lastmodified DESC");
}

/** Confluence's "@@@hl@@@term@@@endhl@@@" markers → plain / highlighted runs. */
export function parseExcerpt(raw: string | undefined | null): ExcerptPart[] {
  if (!raw) return [];
  const text = decodeEntities(raw.replace(/\s+/g, " "));
  const parts: ExcerptPart[] = [];
  const re = /@@@hl@@@([\s\S]*?)@@@endhl@@@/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hl: false });
    parts.push({ text: m[1], hl: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hl: false });
  return parts.filter((p) => p.text);
}

/** Site-relative href/src → absolute, so links and images in a page point at Confluence. */
export function absolutizeLinks(html: string, origin: string): string {
  return html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${origin}/`);
}

/** A search API result → a hit (null for non-page results). */
export function toHit(r: any, wiki: string): DocHit | null {
  const c = r && r.content;
  if (!c || !c.id) return null;
  const displayUrl = r.resultGlobalContainer && r.resultGlobalContainer.displayUrl;
  return {
    id: String(c.id),
    title: String(c.title || r.title || "").replace(/@@@(end)?hl@@@/g, ""),
    space: (c.space && c.space.key) || (/\/spaces\/([^/]+)/.exec(displayUrl || "") || [])[1] || "",
    spaceName: (r.resultGlobalContainer && r.resultGlobalContainer.title) || (c.space && c.space.name) || "",
    url: `${wiki}${(c._links && c._links.webui) || r.url || ""}`,
    excerpt: parseExcerpt(r.excerpt),
    updatedAt: r.lastModified || null,
  };
}

export class ConfluenceProvider implements DocsProvider {
  kind = "confluence";
  label = "Confluence";
  source: DocSiteDef & Record<string, any>;
  ctx: ProviderContext;
  keyFile: string;
  viewer: string | null = null;
  private spacesCache: { at: number; spaces: DocSpace[] } | null = null;

  constructor(source: DocSiteDef, ctx: ProviderContext) {
    this.source = source as any;
    this.ctx = ctx;
    this.keyFile = path.join(ctx.ledgerDir, "confluence-api-token");
  }

  /** acme.atlassian.net, from the source url. */
  get site(): string | null {
    try {
      const host = new URL(String(this.source.url)).hostname;
      return /^[\w.-]+$/.test(host) ? host : null;
    } catch { return null; }
  }
  get origin() { return `https://${this.site}`; }
  get wiki() { return `${this.origin}/wiki`; }
  get spaceFilter(): string[] {
    const s = this.source.spaces;
    return Array.isArray(s) ? s.filter((k) => typeof k === "string" && SPACE_KEY.test(k)) : [];
  }

  /** The tracker is Jira on this same site: its key is an Atlassian token that works here too. */
  private get sameSiteJira(): boolean {
    const i = this.ctx.issues;
    const host = String(i.site || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return i.kind === "jira" && !!host && host === this.site;
  }

  /** The key, where it came from, and whether it's a saved file Disconnect can delete (env keys aren't). */
  _cred(): { cred: string; source: ProviderStatus["source"]; removable: boolean } | null {
    if (process.env.CONFLUENCE_API_TOKEN && process.env.CONFLUENCE_EMAIL) {
      return { cred: `${process.env.CONFLUENCE_EMAIL.trim()}:${process.env.CONFLUENCE_API_TOKEN.trim()}`, source: "env", removable: false };
    }
    try { const k = fs.readFileSync(this.keyFile, "utf-8").trim(); if (k) return { cred: k, source: "file", removable: true }; } catch {}
    if (this.sameSiteJira) {
      if (process.env.JIRA_API_TOKEN && process.env.JIRA_EMAIL) return { cred: `${process.env.JIRA_EMAIL.trim()}:${process.env.JIRA_API_TOKEN.trim()}`, source: "tracker", removable: false };
      try { const k = fs.readFileSync(path.join(this.ctx.ledgerDir, "jira-api-token"), "utf-8").trim(); if (k) return { cred: k, source: "tracker", removable: true }; } catch {}
    }
    return null;
  }

  _get(pathAndQuery: string, cred = this._cred()?.cred): Promise<any> {
    const site = this.site;
    if (!site) return Promise.reject(new Error("The Confluence source needs a url like https://acme.atlassian.net/wiki in docs.json."));
    if (!cred) return Promise.reject(new HttpStatusError(401, "Connect Confluence first."));
    const send = (url: string) => new Promise<any>((resolve, reject) => {
      const req = https.request(url, {
        headers: { Authorization: `Basic ${Buffer.from(cred).toString("base64")}`, Accept: "application/json" },
        timeout: 20000,
      }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (status === 401 || status === 403) return reject(new HttpStatusError(status, "Confluence rejected the email/API token. A scoped token needs Confluence read scopes (e.g. read:confluence-content.all, search:confluence, read:confluence-space.summary)."));
          let json;
          try { json = out ? JSON.parse(out) : {}; } catch { return reject(new HttpStatusError(status, `Confluence returned HTTP ${status}`)); }
          if (status >= 400) return reject(new HttpStatusError(status, json.message || (json.data && json.data.errors && json.data.errors[0] && json.data.errors[0].message) || `Confluence returned HTTP ${status}`));
          resolve(json);
        });
      });
      req.on("timeout", () => req.destroy(new Error("Confluence request timed out")));
      req.on("error", reject);
      req.end();
    });
    return atlassianRequest("confluence", site, cred, pathAndQuery, send);
  }

  status(): ProviderStatus {
    const c = this._cred();
    return { connected: !!c && !!this.site, source: c ? c.source : null, removable: !!c && c.removable, viewer: this.viewer };
  }

  connectHelp(): ProviderHelp | null {
    if (!this.site) {
      return { title: "Set the Confluence url", steps: ["Set `\"url\": \"https://<you>.atlassian.net/wiki\"` on this source in `.claude/dashboard/docs.json`, then reload."], placeholder: "", needsKey: false };
    }
    return {
      title: "Connect Confluence",
      steps: [
        "Create an API token at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) (a Jira token for this site works too).",
        "Enter it below with the email you sign in to Atlassian with. A classic token (no scopes) covers both Confluence and Issues; a scoped one needs Confluence read scopes.",
        "It stays on this machine (in `.claude/ledger/`, never committed), and search only shows what your account can see.",
      ],
      placeholder: "you@company.com:ATATT…",
      needsKey: true,
      keyFields: "email-token",
    };
  }

  async connect(key: string): Promise<ProviderStatus> {
    const cred = String(key || "").trim();
    if (!/^[^:\s]+@[^:\s]+:\S{10,}$/.test(cred)) throw new Error("Enter the email you sign in with and an API token.");
    const me = await this._get("/wiki/rest/api/user/current", cred);
    fs.writeFileSync(this.keyFile, cred, { mode: 0o600 });
    this.viewer = me.displayName || me.publicName || null;
    this.spacesCache = null;
    return this.status();
  }

  disconnect(): ProviderStatus {
    removeKeyFile(this.keyFile);
    this.viewer = null;
    this.spacesCache = null;
    return this.status();
  }

  async spaces(): Promise<DocSpace[]> {
    if (this.spacesCache && Date.now() - this.spacesCache.at < SPACES_TTL_MS) return this.spacesCache.spaces;
    const res = await this._get("/wiki/rest/api/space?status=current&limit=250");
    const only = new Set(this.spaceFilter);
    const spaces = (res.results || [])
      .filter((s) => s.type !== "personal" && (!only.size || only.has(s.key)))
      .map((s) => ({ key: String(s.key), name: String(s.name), url: `${this.wiki}${(s._links && s._links.webui) || `/spaces/${s.key}`}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.spacesCache = { at: Date.now(), spaces };
    return spaces;
  }

  async search(query: string, spaces: string[], limit = 25): Promise<DocHit[]> {
    // Chosen spaces must be within the source's own filter.
    const allowed = this.spaceFilter;
    const chosen = spaces.filter((s) => SPACE_KEY.test(s) && (!allowed.length || allowed.includes(s)));
    const scope = chosen.length ? chosen : allowed;
    const n = Math.min(50, Math.max(1, limit | 0 || 25));
    const run = async (field: "siteSearch" | "text") => {
      const cql = buildCql(query, scope, field);
      const res = await this._get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${n}&excerpt=highlight`);
      return (res.results || []).map((r) => toHit(r, this.wiki)).filter((h): h is DocHit => !!h);
    };
    try {
      return await run("siteSearch");
    } catch (e) {
      // Some sites reject siteSearch; plain text search works everywhere.
      if (query.trim() && e instanceof HttpStatusError && e.status === 400) return run("text");
      throw e;
    }
  }

  async page(id: string): Promise<DocPage> {
    if (!PAGE_ID.test(id)) throw new HttpStatusError(400, `Bad page id "${id}"`);
    const c = await this._get(`/wiki/rest/api/content/${id}?expand=body.view,space,version,metadata.labels,ancestors`);
    return {
      id: String(c.id),
      title: String(c.title || ""),
      space: (c.space && c.space.key) || "",
      spaceName: (c.space && c.space.name) || "",
      url: `${this.wiki}${(c._links && c._links.webui) || ""}`,
      html: absolutizeLinks(String((c.body && c.body.view && c.body.view.value) || ""), this.origin),
      updatedAt: (c.version && c.version.when) || null,
      updatedBy: (c.version && c.version.by && c.version.by.displayName) || null,
      labels: ((c.metadata && c.metadata.labels && c.metadata.labels.results) || []).map((l) => String(l.name)),
      ancestors: (c.ancestors || []).map((a) => ({ id: String(a.id), title: String(a.title || "") })),
    };
  }

  runNote(pageId?: string | null): string {
    const scope = this.spaceFilter.length ? ` (spaces ${this.spaceFilter.join(", ")})` : "";
    const page = pageId && PAGE_ID.test(pageId) ? ` The question is about Confluence page ${pageId}: read it first (getConfluencePage).` : "";
    return `Use the team's Confluence at ${this.wiki}${scope} as a source: search it with the Atlassian MCP tools `
      + `(searchConfluenceUsingCql, or search) before answering, using cloudId ${this.site}.${page} For policies, processes, `
      + `runbooks and specs, Confluence is the authority over the code. Cite every page you rely on as a link. If Confluence `
      + `has nothing on it, say so plainly instead of guessing, and mention a page's age when it matters. If the Atlassian `
      + `tools aren't available in this session, say that the Atlassian connector needs to be added in Claude.`;
  }
}

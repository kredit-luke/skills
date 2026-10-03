/**
 * Docs sources, from .claude/dashboard/docs.json. The Docs page reads them and
 * search indexes the ones that live in the workspace.
 *
 * Kinds:
 *   site      a static site repo (HTML, e.g. published to Cloudflare Pages / Netlify).
 *             "Preview" serves the working copy on its own fixed localhost `port`
 *             (own origin, so root-relative asset paths work and none of it shares
 *             the dashboard's origin), started on first use and kept for the life of
 *             the dashboard. `live` is the published URL.
 *   notes     a folder of Markdown; the Docs page renders it.
 *   external  docs that live elsewhere (Confluence, Notion, Google Drive, a wiki):
 *             a card that opens `url`, and "Ask Claude" goes through the matching
 *             MCP connector. With a `provider` that has an adapter (docs-providers/),
 *             the Docs page also searches and reads it with each person's own key.
 *             Nothing is indexed locally.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { readConfigFile } from "./config.ts";

export type DocKind = "site" | "notes" | "external";
export type DocSiteDef = { key: string; name: string; kind: DocKind; dir?: string; live?: string; port?: number; url?: string; provider?: string; description?: string; spaces?: string[] };

const SAFE_DIR = /^[\w.-]+(\/[\w.-]+)*$/;

/** docs.json sources, validated (entries that don't make sense are dropped). */
export function docSources(): { sources: DocSiteDef[]; error: string | null; configured: boolean } {
  const { data, error } = readConfigFile("docs.json");
  const list = data && Array.isArray(data.sources) ? data.sources : [];
  const httpUrl = (u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u) ? u : undefined;
  const sources: DocSiteDef[] = [];
  for (const s of list) {
    if (!s || typeof s.key !== "string" || !/^[\w-]+$/.test(s.key) || typeof s.name !== "string") continue;
    const kind: DocKind = s.kind === "notes" || s.kind === "external" ? s.kind : "site";
    if (kind === "external") {
      if (!httpUrl(s.url)) continue;
    } else if (typeof s.dir !== "string" || !SAFE_DIR.test(s.dir) || s.dir.split("/").some((p) => /^\.+$/.test(p))) {
      continue;
    }
    sources.push({
      key: s.key, name: s.name, kind,
      dir: kind === "external" ? undefined : s.dir,
      live: httpUrl(s.live),
      port: kind === "site" && Number(s.port) > 1024 ? Number(s.port) : undefined,
      url: httpUrl(s.url),
      provider: typeof s.provider === "string" ? s.provider : undefined,
      description: typeof s.description === "string" ? s.description : undefined,
      spaces: Array.isArray(s.spaces) ? s.spaces.filter((k) => typeof k === "string") : undefined,
    });
  }
  return { sources, error, configured: !!data };
}

/** Local sources only (the ones with a folder in the workspace), keyed. */
export function localDocSources(): Record<string, DocSiteDef> {
  return Object.fromEntries(docSources().sources.filter((s) => s.dir).map((s) => [s.key, s]));
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".md": "text/plain; charset=utf-8",
};

class DocSites {
  root: any;
  servers: any;

  constructor(workspaceRoot) {
    this.root = workspaceRoot;
    this.servers = new Map(); // key -> http.Server
  }

  list() {
    return docSources().sources.map((s) => {
      if (s.kind === "external") {
        return {
          key: s.key, name: s.name, repo: null, kind: s.kind,
          type: s.provider ? s.provider[0].toUpperCase() + s.provider.slice(1) : "External",
          live: s.url || null, url: s.url || null, provider: s.provider || null, description: s.description || null,
          available: true, previewUrl: null, docs: 0,
        };
      }
      const dir = path.join(this.root, s.dir!);
      return {
        key: s.key,
        name: s.name,
        repo: s.dir!,
        kind: s.kind,
        type: s.kind === "site" ? "Static site" : "Markdown notes",
        live: s.live || null,
        url: null, provider: null, description: s.description || null,
        available: fs.existsSync(dir),
        previewUrl: this.servers.has(s.key) && s.port ? `http://localhost:${s.port}/` : null,
        docs: countDocs(dir),
      };
    });
  }

  /** Start (or reuse) the local preview server for a site. Resolves to its URL. */
  preview(key) {
    const site = localDocSources()[key];
    if (!site || site.kind !== "site") return Promise.reject(new Error(`No previewable site ${key}`));
    if (!site.port) return Promise.reject(new Error(`${site.name} has no preview port in docs.json.`));
    const dir = path.join(this.root, site.dir!);
    if (!fs.existsSync(dir)) return Promise.reject(new Error(`${site.dir} isn't cloned.`));
    const port = site.port;
    const url = `http://localhost:${port}/`;
    if (this.servers.has(key)) return Promise.resolve(url);

    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => serveStatic(dir, port, req, res));
      server.once("error", (e) => reject(new Error((e as any).code === "EADDRINUSE" ? `Port ${port} is already in use.` : e.message)));
      server.listen(port, "127.0.0.1", () => {
        this.servers.set(key, server);
        resolve(url);
      });
    });
  }
}

function serveStatic(dir, port, req, res) {
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) { res.writeHead(421); return res.end(); }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400); return res.end(); }
  const base = path.resolve(dir);
  let full = path.resolve(base, "." + rel);
  if (full !== base && !full.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  if (/[\\/]\.(git|github)([\\/]|$)/.test(full) || /[\\/]node_modules([\\/]|$)/.test(full)) { res.writeHead(404); return res.end(); }
  try {
    if (fs.statSync(full).isDirectory()) full = path.join(full, "index.html");
  } catch {
    // Cloudflare Pages serves /guides as guides.html.
    if (!path.extname(full) && fs.existsSync(full + ".html")) full += ".html";
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(full).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

function countDocs(dir) {
  let n = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(d, e.name)); }
      else if (/\.(md|html?)$/i.test(e.name)) n++;
    }
  };
  walk(dir);
  return n;
}

export { DocSites };

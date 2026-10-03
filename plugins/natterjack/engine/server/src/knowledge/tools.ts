/**
 * Knowledge setup: which tools a team keeps its knowledge in, and how Claude reaches
 * each one (its MCP connector). The Knowledge page asks once for the team; the answer
 * is written to the committed config, so everyone sees their own connection status:
 *
 *   docs.json         one external source per tool (`tool`, `url`, `connection`: the
 *                     connector names that work for it, any one of them)
 *   connections.json  one required server per tool (`knowledge: <tool id>`, with the
 *                     same names as `alternatives`), so the sidebar and doctor flag it
 *
 * Teams that keep their knowledge in none of them get a store (their own bucket) instead.
 * Only entries this setup wrote (marked `tool` / `knowledge`) are ever replaced or removed.
 */

import { readConfigFile, writeConfigFile } from "../config.ts";

export interface KnowledgeTool {
  id: string;
  label: string;
  description: string;
  /** What the link points at, and an example. */
  urlLabel: string;
  urlPlaceholder: string;
  urlRequired: boolean;
  urlPattern: string | null;
  /** Connector names that reach it (claude.ai's first), as `claude mcp list` shows them. */
  connections: string[];
  /** A docs provider the page can also search it with (docs-providers/). */
  provider: string | null;
  /** How someone connects Claude to it (markdown). */
  connectHelp: string;
}

const CLAUDE_AI = "Connect it once at claude.ai → Settings → Connectors; it then reaches Claude Code in every folder and dashboard runs.";

export const KNOWLEDGE_TOOLS: KnowledgeTool[] = [
  {
    id: "notion", label: "Notion", description: "Wiki, docs and databases",
    urlLabel: "Workspace link", urlPlaceholder: "https://www.notion.so/acme", urlRequired: false, urlPattern: "^https://([\\w-]+\\.)?notion\\.(so|site)(/|$)",
    connections: ["claude.ai Notion", "notion"], provider: null,
    connectHelp: `${CLAUDE_AI} Or add Notion's own server (https://mcp.notion.com/mcp) on the Connections page.`,
  },
  {
    id: "confluence", label: "Confluence", description: "Atlassian wiki",
    urlLabel: "Site", urlPlaceholder: "https://acme.atlassian.net/wiki", urlRequired: true, urlPattern: "^https://[\\w.-]+/wiki/?$",
    connections: ["claude.ai Atlassian", "atlassian"], provider: "confluence",
    connectHelp: `${CLAUDE_AI} The Atlassian connector covers Confluence and Jira. Or add Atlassian's server (https://mcp.atlassian.com/v1/mcp) on the Connections page.`,
  },
  {
    id: "google-drive", label: "Google Drive", description: "Docs, Sheets and Slides",
    urlLabel: "Shared drive or folder", urlPlaceholder: "https://drive.google.com/drive/folders/…", urlRequired: false, urlPattern: "^https://(drive|docs)\\.google\\.com/",
    connections: ["claude.ai Google Drive"], provider: null,
    connectHelp: CLAUDE_AI,
  },
  {
    id: "sharepoint", label: "SharePoint / OneDrive", description: "Microsoft 365 files and sites",
    urlLabel: "Site", urlPlaceholder: "https://acme.sharepoint.com/sites/…", urlRequired: false, urlPattern: "^https://[\\w-]+(-my)?\\.sharepoint\\.com/",
    connections: ["claude.ai Microsoft 365"], provider: null,
    connectHelp: `${CLAUDE_AI} An organization admin enables the Microsoft 365 connector for the organization first.`,
  },
];

export interface ChosenTool { tool: string; key: string; name: string; url: string | null; area: string | null; connection: string[] }
export interface SetupRequest {
  tools: { tool: string; url?: string | null; name?: string | null; area?: string | null; connection?: string | null }[];
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : typeof v === "string" && v.trim() ? [v] : []);

/** The tools this setup wrote into docs.json (sources with a `tool`). */
export function chosenTools(): ChosenTool[] {
  const { data } = readConfigFile("docs.json");
  return (Array.isArray(data?.sources) ? data.sources : [])
    .filter((s: any) => s && typeof s.tool === "string")
    .map((s: any) => ({ tool: s.tool, key: s.key, name: s.name, url: typeof s.url === "string" ? s.url : null, area: typeof s.area === "string" ? s.area : null, connection: strList(s.connection) }));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "tool";

/**
 * Replace the team's tool list. "other" tools need a name, a link and (to check Claude's
 * access) the connector's name. Everything else in docs.json / connections.json is kept.
 */
export function saveTools(req: SetupRequest): ChosenTool[] {
  const list = Array.isArray(req?.tools) ? req.tools.slice(0, 20) : [];
  const docs = readConfigFile("docs.json");
  if (docs.error) throw httpError(409, `${docs.error}: fix docs.json by hand first.`);
  const conns = readConfigFile("connections.json");
  if (conns.error) throw httpError(409, `${conns.error}: fix connections.json by hand first.`);
  const docsData = docs.data && typeof docs.data === "object" ? docs.data : {};
  const sources: any[] = Array.isArray(docsData.sources) ? docsData.sources : [];
  const areas = new Set((Array.isArray(docsData.areas) ? docsData.areas : []).map((a: any) => a?.key));

  const kept = sources.filter((s) => !s || typeof s.tool !== "string");
  const taken = new Set(kept.map((s) => s?.key));
  const before = new Map(sources.filter((s) => s && typeof s.tool === "string").map((s) => [s.key, s]));
  const next: any[] = [];
  for (const t of list) {
    const def = KNOWLEDGE_TOOLS.find((d) => d.id === t.tool);
    const other = t.tool === "other";
    if (!def && !other) throw httpError(400, `Unknown tool ${t.tool}`);
    const name = String((other ? t.name : t.name || def!.label) || "").trim();
    if (!name) throw httpError(400, "Give the tool a name.");
    const url = String(t.url || "").trim();
    if (url && !/^https:\/\//.test(url)) throw httpError(400, `${name}: the link must start with https://`);
    if (def?.urlRequired && !url) throw httpError(400, `${name}: add the ${def.urlLabel.toLowerCase()} (${def.urlPlaceholder}).`);
    if (def?.urlPattern && url && !new RegExp(def.urlPattern).test(url)) throw httpError(400, `${name}: that doesn't look like a ${def.label} ${def.urlLabel.toLowerCase()} (e.g. ${def.urlPlaceholder}).`);
    if (other && !url) throw httpError(400, `${name}: add its link.`);
    const area = t.area && areas.has(t.area) ? t.area : undefined;
    const connection = other ? strList(t.connection) : def!.connections;
    // Keep the key a tool already had, so links to /knowledge/<key> keep working.
    const prev = [...before.values()].find((s) => s.tool === t.tool && (!other || s.name === name));
    let key = prev?.key || (other ? slug(name) : def!.id);
    for (let i = 2; taken.has(key); i++) key = `${prev?.key || (other ? slug(name) : def!.id)}-${i}`;
    taken.add(key);
    const fallbackUrl = def?.id === "notion" ? "https://www.notion.so" : def?.id === "google-drive" ? "https://drive.google.com" : def?.id === "sharepoint" ? "https://www.office.com" : "";
    next.push({
      ...(prev || {}),
      key, name, kind: "external", tool: t.tool, url: url || fallbackUrl,
      ...(def?.provider ? { provider: def.provider } : {}),
      ...(connection.length ? { connection: connection.length === 1 ? connection[0] : connection } : {}),
      ...(area ? { area } : {}),
      ...(def ? { description: def.description } : {}),
    });
    if (!area) delete next[next.length - 1].area;
  }
  writeConfigFile("docs.json", { ...docsData, sources: [...kept, ...next] });

  // connections.json: one requirement per tool that names a connector.
  const connData = conns.data && typeof conns.data === "object" ? conns.data : { $comment: "MCP servers this workspace relies on (Connections page). Names as `claude mcp list` shows them. Schema: references/config.md." };
  const required: any[] = (Array.isArray(connData.required) ? connData.required : []).filter((r: any) => !r || typeof r.knowledge !== "string");
  const names = new Set(required.map((r) => String(r?.name || "").toLowerCase()));
  for (const s of next) {
    const c = strList(s.connection);
    if (!c.length || names.has(c[0].toLowerCase())) continue;
    names.add(c[0].toLowerCase());
    required.push({ name: c[0], why: `Knowledge: ${s.name}`, knowledge: s.tool, ...(c.length > 1 ? { alternatives: c.slice(1) } : {}) });
  }
  if (required.length || conns.data) writeConfigFile("connections.json", { ...connData, required });
  return chosenTools();
}

/** Add a store source (the team's own bucket) from the setup panel. Keys never go in config. */
export function addStoreSource(req: { key?: string; name?: string; area?: string | null; store?: Record<string, unknown> }): string {
  const docs = readConfigFile("docs.json");
  if (docs.error) throw httpError(409, `${docs.error}: fix docs.json by hand first.`);
  const data = docs.data && typeof docs.data === "object" ? docs.data : {};
  const sources: any[] = Array.isArray(data.sources) ? data.sources : [];
  const name = String(req?.name || "").trim();
  if (!name) throw httpError(400, "Give it a name, e.g. Company handbook.");
  const key = String(req?.key || slug(name)).trim();
  if (!/^[\w-]+$/.test(key)) throw httpError(400, "The key is letters, digits, _ or -.");
  if (sources.some((s) => s?.key === key)) throw httpError(400, `There's already a source called ${key}.`);
  const st = req?.store && typeof req.store === "object" ? req.store : {};
  const type = String(st.type || "");
  const pick = (k: string) => (typeof st[k] === "string" && (st[k] as string).trim() ? { [k]: (st[k] as string).trim() } : {});
  let store: Record<string, unknown>;
  if (type === "s3") { if (!st.bucket) throw httpError(400, "Add the bucket's name."); store = { type, ...pick("bucket"), ...pick("region"), ...pick("prefix"), ...pick("endpoint") }; }
  else if (type === "gcs") { if (!st.bucket) throw httpError(400, "Add the bucket's name."); store = { type, ...pick("bucket"), ...pick("prefix") }; }
  else if (type === "azure-blob") { if (!st.account || !st.container) throw httpError(400, "Add the storage account and container."); store = { type, ...pick("account"), ...pick("container"), ...pick("prefix") }; }
  else throw httpError(400, "Pick S3, Google Cloud Storage or Azure Blob Storage.");
  const areas = new Set((Array.isArray(data.areas) ? data.areas : []).map((a: any) => a?.key));
  writeConfigFile("docs.json", { ...data, sources: [...sources, { key, name, kind: "store", ...(req.area && areas.has(req.area) ? { area: req.area } : {}), store }] });
  return key;
}

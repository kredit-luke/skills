import type { ConnectionsResponse, DocSite, KnowledgeArea, KnowledgeNote } from '../../../../../shared/api';

export interface TreeFolder { name: string; path: string; folders: TreeFolder[]; notes: KnowledgeNote[] }

/** Notes as a folder tree: folders first, then notes, each by name. */
export function buildTree(notes: KnowledgeNote[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], notes: [] };
  for (const n of notes) {
    const parts = n.rel.split('/');
    let at = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      let f = at.folders.find((x) => x.path === p);
      if (!f) { f = { name: parts[i], path: p, folders: [], notes: [] }; at.folders.push(f); }
      at = f;
    }
    at.notes.push(n);
  }
  const sort = (f: TreeFolder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.notes.sort((a, b) => a.title.localeCompare(b.title));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

/** Where a [[wikilink]] points (the server's rules: a path, else a bare name, same folder first, then the shortest path). */
export function resolveWiki(target: string, fromRel: string, rels: string[]): string | null {
  if (!target) return fromRel;
  const withMd = (t: string) => (/\.md$/i.test(t) ? t : t + '.md');
  const lower = new Map(rels.map((r) => [r.toLowerCase(), r]));
  if (target.startsWith('.')) return lower.get(normalize(dirname(fromRel) + '/' + withMd(target)).toLowerCase()) || null;
  if (target.includes('/')) return lower.get(normalize(withMd(target)).toLowerCase()) || null;
  const name = withMd(target).toLowerCase();
  const hits = rels.filter((r) => basename(r).toLowerCase() === name);
  if (!hits.length) return null;
  return hits.find((h) => dirname(h) === dirname(fromRel)) || [...hits].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];
}

/** A relative path from a note (Markdown links and images), or null when it leaves the vault. */
export function joinNote(fromRel: string, href: string): string | null {
  const [p] = href.split('#');
  let decoded = p;
  try { decoded = decodeURIComponent(p); } catch {}
  const parts = (dirname(fromRel) ? dirname(fromRel) + '/' : '') + decoded;
  const up = parts.split('/').filter((x) => x === '..').length;
  const out = normalize(parts);
  return out && up <= dirname(fromRel).split('/').filter(Boolean).length ? out : null;
}

/** Notes matching a search (title, path, owner, tags, summary) and a tag. */
export function filterNotes(notes: KnowledgeNote[], q: string, tag: string | null, staleOnly = false): KnowledgeNote[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    if (tag && !n.tags.includes(tag)) return false;
    if (staleOnly && !n.stale) return false;
    if (!words.length) return true;
    const hay = [n.title, n.rel, n.owner || '', n.tags.join(' '), n.summary].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The note a search result or old link names: ?page=doc:<base>/<rel>, or ?note=<rel>. */
export function relFromDocId(id: string, site: DocSite): string | null {
  const base = site.kind === 'store' ? `knowledge/${site.key}` : site.repo || '';
  const prefix = `doc:${base}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/** Whether Claude can reach an external source's MCP server, from the Connections page's check. */
export function reach(site: DocSite, c: ConnectionsResponse | null): 'ok' | 'bad' | 'checking' | 'none' {
  if (!site.connection) return 'none';
  if (!c || !c.checkedAt) return 'checking';
  const row = c.connections.find((x) => x.name.toLowerCase() === site.connection!.toLowerCase());
  return row && !row.missing && row.state === 'connected' && row.approval !== 'pending' && row.approval !== 'rejected' ? 'ok' : 'bad';
}

/** Sources grouped by area, in docs.json order; sources without a (known) area last. */
export function byArea(sites: DocSite[], areas: KnowledgeArea[]): { area: KnowledgeArea | null; sites: DocSite[] }[] {
  const known = new Set(areas.map((a) => a.key));
  const groups = areas.map((area) => ({ area: area as KnowledgeArea | null, sites: sites.filter((s) => s.area === area.key) }));
  const rest = sites.filter((s) => !s.area || !known.has(s.area));
  if (rest.length) groups.push({ area: null, sites: rest });
  return groups.filter((g) => g.sites.length || g.area);
}

/** "3 days ago" style, from an ISO date. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const d = Math.round((now - Date.parse(iso)) / 1000);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  const days = Math.round(d / 86400);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

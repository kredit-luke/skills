/** Workspace-relative path helpers for the Explore page. Pure functions. */

/** "API/src/a.cs" → "API/src"; "a.md" → "". */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** The folders above `rel`, outermost first: "a/b/c.md" → ["a", "a/b"]. */
export function ancestors(rel: string): string[] {
  const parts = rel.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * A URL from a document in `dir`, resolved to a workspace-relative path.
 * Drops ?query and #hash; a leading "/" means the workspace root. Null for
 * absolute URLs (http:, mailto:, data:), bare anchors, and paths above the root.
 */
export function joinRel(dir: string, href: string): string | null {
  const h = String(href || '').replace(/[?#].*$/, '');
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(h); } catch { decoded = h; }
  const out: string[] = decoded.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of decoded.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); }
    else out.push(seg);
  }
  return out.join('/');
}

/** The URL that serves a workspace file's bytes. */
export function rawUrl(rel: string): string {
  return '/api/explore/raw/' + rel.split('/').map(encodeURIComponent).join('/');
}

export type ExploreLang =
  | 'javascript' | 'typescript' | 'jsx' | 'tsx' | 'json' | 'html' | 'css' | 'scss' | 'markdown' | 'go'
  | 'csharp' | 'yaml' | 'xml' | 'shell' | 'powershell' | 'python' | 'sql' | 'dockerfile' | 'toml' | 'ini' | null;

const BY_EXT: Record<string, ExploreLang> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', map: 'json',
  html: 'html', htm: 'html', cshtml: 'html', razor: 'html',
  css: 'css', scss: 'scss', less: 'css',
  md: 'markdown', markdown: 'markdown',
  go: 'go', cs: 'csharp', csx: 'csharp',
  yml: 'yaml', yaml: 'yaml',
  xml: 'xml', csproj: 'xml', props: 'xml', targets: 'xml', config: 'xml', svg: 'xml', resx: 'xml', sln: null,
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell',
  py: 'python', sql: 'sql', toml: 'toml', ini: 'ini', env: 'ini', editorconfig: 'ini',
};

function extOf(rel: string): string {
  const name = baseName(rel).toLowerCase();
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
}

export function languageOf(rel: string): ExploreLang {
  const name = baseName(rel).toLowerCase();
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'dockerfile';
  return BY_EXT[extOf(rel)] ?? null;
}

export type PreviewKind = 'markdown' | 'html' | 'image' | null;

export function previewOf(rel: string): PreviewKind {
  const ext = extOf(rel);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext)) return 'image';
  return null;
}

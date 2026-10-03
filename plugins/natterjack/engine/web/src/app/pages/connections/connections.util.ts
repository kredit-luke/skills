import type { Connection, McpServerConfig } from '../../../../../shared/api';

/** The Machine page's status classes: ok ✓, warn !, missing ✕, info – (not checked yet). */
export function statusOf(c: Connection): 'ok' | 'warn' | 'missing' | 'info' {
  if (c.missing) return c.required ? 'missing' : 'warn';
  if (c.approval === 'pending' || c.approval === 'rejected') return 'warn';
  if (c.state === null || c.state === 'unknown') return 'info';
  if (c.state === 'connected') return 'ok';
  if (c.state === 'failed') return 'missing';
  return 'warn';
}

/** A few words for the state. */
export function stateLabel(c: Connection): string {
  if (c.missing) return 'Not set up';
  if (c.approval === 'pending') return 'Waiting for your approval';
  if (c.approval === 'rejected') return 'Turned down';
  switch (c.state) {
    case null: return 'Checking…';
    case 'connected': return 'Connected';
    case 'needs-auth': return 'Needs sign-in';
    case 'failed': return 'Failed to connect';
    case 'disabled': return 'Turned off';
    case 'pending': return 'Waiting for your approval';
    case 'not-configured': return 'Not configured';
    default: return c.status || 'Unknown';
  }
}

export const SCOPE_LABEL: Record<string, string> = {
  'claude.ai': 'claude.ai', plugin: 'plugin', user: 'you, every folder', local: 'you, this workspace', project: 'workspace .mcp.json', unknown: '',
};

/** Panels, in order: what the team needs, then by where it's configured. */
export function groupOf(c: Connection): string {
  if (c.required) return 'Your team relies on';
  switch (c.scope) {
    case 'claude.ai': return 'claude.ai connectors';
    case 'project': case 'local': return 'This workspace';
    case 'user': return 'Yours, in every folder';
    case 'plugin': return 'From plugins';
    default: return 'Other';
  }
}
export const GROUP_ORDER = ['Your team relies on', 'claude.ai connectors', 'This workspace', 'Yours, in every folder', 'From plugins', 'Other'];

/** "Key: value" (headers) or "KEY=value" (env) lines → a map; blank lines skipped. Throws on a line without the separator. */
export function parsePairs(text: string, sep: ':' | '='): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(sep);
    if (i <= 0) throw new Error(`"${line}" isn't ${sep === ':' ? 'Name: value' : 'NAME=value'}.`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** The reverse of parsePairs, for prefilling the dialog. */
export function pairsText(map: Record<string, string> | undefined, sep: ':' | '='): string {
  return Object.entries(map || {}).map(([k, v]) => (sep === ':' ? `${k}: ${v}` : `${k}=${v}`)).join('\n');
}

/** Replace ${VAR} placeholders with the values typed in (unfilled ones stay, and the server refuses them). */
export function fillVars(c: McpServerConfig, values: Record<string, string>): McpServerConfig {
  const f = (s: string) => s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, k) => (values[k] ? values[k] : m));
  const map = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, f(v)])) : undefined);
  return {
    type: c.type,
    ...(c.url !== undefined ? { url: f(c.url) } : {}),
    ...(c.headers ? { headers: map(c.headers) } : {}),
    ...(c.command !== undefined ? { command: f(c.command) } : {}),
    ...(c.args ? { args: c.args.map(f) } : {}),
    ...(c.env ? { env: map(c.env) } : {}),
  };
}

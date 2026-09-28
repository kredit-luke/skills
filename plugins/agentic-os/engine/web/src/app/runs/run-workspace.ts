import type { RunEvent, WorkspaceStatus } from '../../../../shared/api';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The workspace a run actually worked in. Usually the one it started in, but a
 * run started in main that created (or moved into) a worktree, e.g. /implement,
 * belongs to that worktree: the one holding most of its edits (the same signal
 * the server's Changes tab uses), or before any edits, the one named after its
 * ticket. Workspaces nested in another (worktrees under main) win by longest path.
 */
export function runWorkspace(
  run: { workspace?: string | null } | null,
  workspaces: readonly WorkspaceStatus[],
  events: readonly RunEvent[],
  ticketId?: string | null,
): WorkspaceStatus | null {
  if (!run) return null;
  const own = workspaces.find((w) => w.slug === run.workspace) || null;
  // Started in a worktree (nothing nested inside it): that's where it worked.
  if (own && !workspaces.some((w) => w !== own && within(w.path, own.path))) return own;

  const hits = new Map<WorkspaceStatus, { n: number; last: number }>();
  editedPaths(events).forEach((p, i) => {
    let best: WorkspaceStatus | null = null;
    for (const w of workspaces) if (within(p, w.path) && (!best || norm(w.path).length > norm(best.path).length)) best = w;
    if (!best || best === own) return;
    const h = hits.get(best) || { n: 0, last: 0 };
    hits.set(best, { n: h.n + 1, last: i });
  });
  let pick: WorkspaceStatus | null = null;
  for (const [w, h] of hits) {
    const p = pick && hits.get(pick)!;
    if (!p || h.n > p.n || (h.n === p.n && h.last > p.last)) pick = w;
  }
  if (pick) return pick;

  const t = (ticketId || '').toUpperCase();
  if (t) {
    const named = workspaces.find((w) => w !== own && ((w._ticketId || '').toUpperCase() === t || w.slug.toUpperCase() === t));
    if (named) return named;
  }
  return own;
}

/** Absolute paths the run's edit tools wrote to, in order (main session and subagents). */
function editedPaths(events: readonly RunEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
    for (const b of ev.message.content) {
      if (b?.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
      const p = b.input?.file_path || b.input?.notebook_path;
      if (typeof p === 'string' && /^([a-zA-Z]:[\\/]|[\\/])/.test(p)) out.push(p);
    }
  }
  return out;
}

/** Windows-tolerant: forward slashes, lower case, no trailing slash. */
function norm(p: string): string { return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function within(p: string, dir: string): boolean {
  const a = norm(p), d = norm(dir);
  return !!d && (a === d || a.startsWith(d + '/'));
}

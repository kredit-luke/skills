import type { HostedLinkStatus, RemoteCommandKind, RemoteLinkLive, RemoteRunInfo, RunMeta } from '../../../../shared/api';
import { lastActivity, ONLINE_MS, REMOTE_COMMAND_KINDS } from '../../../../shared/remote';
import { relTime } from '../core/util';

export { lastActivity };

/**
 * Remote control on the hosted dashboard: runs mirrored from a linked computer (RunMeta.remote),
 * which runs them. Pure helpers for the run list, run page and Settings.
 *
 * Online is per link, not per run: the pod sends each linked computer's state (RemoteLinkLive) in
 * RunsResponse.remoteLinks and on the live `remote-links` topic, and a run is online when its link
 * (`remote.linkId`) is. DataService keeps each entry with the time this browser received it
 * (StampedLink) and hands out a LinkLive through remoteLive(run), worked out by linkLive(): the
 * pod's `online` flag, trusted for ONLINE_MS after it arrived. Both sides of that sum are the
 * browser's clock, so a browser whose clock is off from the pod's still gets it right.
 * `lastSeenAt` (the pod's clock) is only shown as text ("last seen 3m ago").
 *
 * A run's own `remote.online` / `remote.lastSeenAt` (only on single-run payloads) are never read,
 * so a list row and the run page always agree.
 */

/** A linked computer as DataService keeps it: the pod's RemoteLinkLive and when this browser received it (Date.now()). */
export type StampedLink = RemoteLinkLive & { receivedAt: number };

/**
 * A mirrored run's computer right now (DataService.remoteLive). `online` already folds in Remote
 * control being on and the ONLINE_MS window; `lastSeenAt` is for "last seen" text only.
 */
export interface LinkLive { online: boolean; lastSeenAt: string | null; enabled: boolean; label: string }

/** Stamp every link of one payload with its arrival time: the payload is the pod's state of all of them at that moment. */
export function stampLinks(links: readonly RemoteLinkLive[], at: number): StampedLink[] {
  return links.map((l) => ({ ...l, receivedAt: at }));
}

/**
 * A link's live state at `now`: online while the pod said online, Remote control is on there, and
 * that arrived within ONLINE_MS. Without an entry (the link hasn't connected, or the list isn't in
 * yet), it's offline with `fallback`'s (the run's `remote`) label and switch.
 */
export function linkLive(
  entry: Pick<StampedLink, 'online' | 'enabled' | 'lastSeenAt' | 'label' | 'receivedAt'> | null | undefined,
  fallback: Pick<RemoteRunInfo, 'enabled' | 'label'>,
  now = Date.now(),
): LinkLive {
  if (!entry) return { online: false, lastSeenAt: null, enabled: fallback.enabled, label: fallback.label };
  return {
    online: entry.online && entry.enabled && now - entry.receivedAt < ONLINE_MS,
    lastSeenAt: entry.lastSeenAt ?? null,
    enabled: entry.enabled,
    label: entry.label,
  };
}

/** A mirrored run's link: `link` (from remoteLive), or offline from the run's own `remote` when there's none; null for a run that isn't mirrored. */
function liveOf(run: Pick<RunMeta, 'remote'>, link: LinkLive | null | undefined): LinkLive | null {
  const r = run.remote;
  if (!r) return null;
  return link ?? { online: false, lastSeenAt: null, enabled: r.enabled, label: r.label };
}

/** The computer is online and Remote control is on there (linkLive did the ONLINE_MS window). */
export function isOnline(link: Pick<LinkLive, 'online' | 'enabled'> | null | undefined): boolean {
  return !!link && link.online && link.enabled;
}

export type RemoteBannerTone = 'info' | 'warn' | 'off';

/**
 * The line the run page shows above a mirrored run; null for a run that isn't mirrored. `text` is
 * the state, which the page announces (a live region); `seen` ("Last seen 3m ago.") changes every
 * minute, so it sits outside the live region.
 */
export function remoteBanner(
  run: Pick<RunMeta, 'status' | 'remote'>,
  link: LinkLive | null | undefined,
  now = Date.now(),
): { tone: RemoteBannerTone; text: string; seen: string } | null {
  const l = liveOf(run, link);
  if (!l) return null;
  if (!l.enabled) return { tone: 'off', text: `Remote control is off on ${l.label}.`, seen: '' };
  if (!isOnline(l)) {
    const seen = l.lastSeenAt ? `Last seen ${relTime(l.lastSeenAt, now)}.` : '';
    const then = run.status === 'waiting' ? "You can answer when it's back." : "Messages you queue wait until it's back.";
    return { tone: 'warn', text: `Your computer is offline. ${then}`, seen };
  }
  if (run.status === 'running') return { tone: 'info', text: `Running on ${l.label}`, seen: '' };
  if (run.status === 'waiting') return { tone: 'info', text: `Waiting for your answer · on ${l.label}`, seen: '' };
  return { tone: 'info', text: `On ${l.label}`, seen: '' };
}

/**
 * The run page's copy of a mirrored run with `enabled`, `pending` and `lastError` taken from
 * DataService's copy (`list`, its remoteRuns), which every `runs` push replaces, so the page and
 * its list row show the same pending commands. Liveness is in neither: it's the link's
 * (remoteLive), so the run's own `online` / `lastSeenAt` are dropped and nothing can read them.
 * Falls back to the run's own `remote`; a run that isn't mirrored comes back as it is.
 */
export function withListRemote<T extends Pick<RunMeta, 'id' | 'remote'>>(run: T | null, list: readonly Pick<RunMeta, 'id' | 'remote'>[]): T | null {
  if (!run?.remote) return run;
  const fresh = list.find((x) => x.id === run.id)?.remote;
  if (!fresh || fresh === run.remote) return run;
  const { linkId, label } = run.remote;
  return { ...run, remote: { linkId, label, enabled: fresh.enabled, pending: fresh.pending, lastError: fresh.lastError ?? null } };
}

/**
 * Whether the run page may offer `action` on a run, matching the pod's rules for mirrored runs
 * (shared/api.ts, the mirrored-run POST doc; server/src/remote-mirror.ts command()). A run that
 * isn't mirrored allows everything here (its own rules apply). For queue-edit / queue-remove, `id`
 * is the queued message's id: one that names a pending `queue` command already delivered to the
 * computer is refused online or offline ("Already sent to your computer"); offline, only a pending
 * undelivered `queue` is allowed. Any other id (another kind's pending command, or a message
 * queued on the computer) is forwarded, so it needs the computer online. `link` is the run's
 * computer (DataService.remoteLive).
 *  - Remote control off there: nothing.
 *  - Online: every command kind (shared/remote.ts REMOTE_COMMAND_KINDS).
 *  - Offline: queue, and queue-edit / queue-remove on a pending queue not yet delivered. The run
 *    page only offers Remove on those (run-detail); the composer's Edit is for the computer's queue.
 *  - Anything else (rename, verdict, flag, terminal, send-to-hosted, changes, …): never.
 */
export function remoteAllows(
  run: Pick<RunMeta, 'remote'>,
  action: string,
  link: LinkLive | null | undefined,
  id?: string,
): boolean {
  const r = run.remote;
  const l = liveOf(run, link);
  if (!r || !l) return true;
  if (!l.enabled || !REMOTE_COMMAND_KINDS.has(action as RemoteCommandKind)) return false;
  const editsQueue = action === 'queue-edit' || action === 'queue-remove';
  const pending = editsQueue && id ? r.pending.find((p) => p.id === id && p.kind === 'queue') : undefined;
  if (pending && pending.delivered) return false;
  if (isOnline(l)) return true;
  if (action === 'queue') return true;
  return editsQueue && !!pending && pending.delivered === false;
}

/** A pending command's state on the run page. */
export function pendingLabel(p: Pick<RemoteRunInfo['pending'][number], 'delivered'>): string {
  return p.delivered ? 'Sent to your computer' : 'Waiting for your computer';
}

const PENDING_KIND: Record<RemoteCommandKind, string> = {
  reply: 'Reply',
  queue: 'Queued message',
  'queue-edit': 'Edit a queued message',
  'queue-remove': 'Remove a queued message',
  'queue-send': 'Send the queued messages',
  'queue-auto': 'Auto-send setting',
  cancel: 'Cancel',
  'plan-mode': 'Plan mode setting',
};

/** What a pending command says on the run page: the text of a reply or queue, else what it does. */
export function pendingText(p: Pick<RemoteRunInfo['pending'][number], 'kind' | 'text'>): string {
  if ((p.kind === 'reply' || p.kind === 'queue') && p.text) return p.text;
  return PENDING_KIND[p.kind] ?? p.kind;
}

/**
 * Why the run page can't send commands to a mirrored run right now, shown next to what it disables
 * ("Your computer is offline"); null when it can (online, Remote control on) or the run isn't mirrored.
 */
export function remoteBlockedReason(run: Pick<RunMeta, 'remote'>, link: LinkLive | null | undefined): string | null {
  const l = liveOf(run, link);
  if (!l) return null;
  if (!l.enabled) return `Remote control is off on ${l.label}`;
  return isOnline(l) ? null : 'Your computer is offline';
}

/** Statuses a run takes a reply in: between turns (the server's reply rule). */
const REPLYABLE: ReadonlySet<string> = new Set(['waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']);

/** A mirrored run has a `kind` command on its way to the computer (pending: not yet delivered, or not yet acked). */
export function commandPending(run: Pick<RunMeta, 'remote'>, kind: RemoteCommandKind): boolean {
  return !!run.remote?.pending.some((p) => p.kind === kind);
}

/** A mirrored run has a reply on its way to the computer (pending: not yet delivered, or not yet acked). */
export function replyPending(run: Pick<RunMeta, 'remote'>): boolean {
  return commandPending(run, 'reply');
}

/**
 * Why a one-shot command (cancel, plan-mode) is disabled on a mirrored run; null when it can be
 * sent, and for a run that isn't mirrored. Remote control off and offline come first; otherwise
 * one already on its way to the computer disables it (`sent`), so it isn't sent twice.
 */
function commandBlocked(
  run: Pick<RunMeta, 'remote'>,
  kind: 'cancel' | 'plan-mode',
  sent: string,
  link: LinkLive | null | undefined,
): string | null {
  if (!run.remote) return null;
  if (!remoteAllows(run, kind, link)) return remoteBlockedReason(run, link) || "Your computer can't take this now";
  return commandPending(run, kind) ? sent : null;
}

/** Why the run page's Cancel is disabled on a mirrored run (Remote control off, offline, a cancel on its way); null when it isn't. */
export function cancelBlockedReason(run: Pick<RunMeta, 'remote'>, link: LinkLive | null | undefined): string | null {
  return commandBlocked(run, 'cancel', 'Cancel sent to your computer', link);
}

/** Why the composer's plan-mode switch is disabled on a mirrored run (Remote control off, offline, a change on its way); null when it isn't. */
export function planModeBlockedReason(run: Pick<RunMeta, 'remote'>, link: LinkLive | null | undefined): string | null {
  return commandBlocked(run, 'plan-mode', 'Plan mode change sent to your computer', link);
}

/**
 * The composer's main action: `queue` while a turn runs, `reply` between turns, null when neither.
 * On a mirrored run:
 *  - Remote control off there: null.
 *  - A reply still on its way to the computer: null between turns (no second reply).
 *  - Offline and `waiting`: null. A queued message there would be held on the computer and sent
 *    as "this isn't my answer" (server/src/runs.ts QUEUED_OVER_QUESTION), so it can't answer.
 *  - Offline and otherwise between turns: `queue`. It waits on the pod until the computer is
 *    back; there, after `succeeded`/`failed` it goes out by itself, after `cancelled`/`interrupted`
 *    it's held until you press Send now (server/src/runs.ts drainable; offlineQueueHint).
 */
export function composerAction(
  run: Pick<RunMeta, 'status' | 'remote'>,
  link: LinkLive | null | undefined,
): 'reply' | 'queue' | null {
  const queue = remoteAllows(run, 'queue', link) ? 'queue' : null;
  if (run.status === 'running') return queue;
  if (!REPLYABLE.has(run.status) || replyPending(run)) return null;
  if (remoteAllows(run, 'reply', link)) return 'reply';
  return run.status === 'waiting' ? null : queue;
}

/**
 * The hint under the composer's box when a mirrored run between turns takes a queue because its
 * computer is offline: what happens to the message on the computer (server/src/runs.ts drainable).
 */
export function offlineQueueHint(status: RunMeta['status']): string {
  if (status === 'cancelled' || status === 'interrupted') {
    return `Enter to queue · it goes to your computer when it's back and is held there until you press Send now, because the turn was ${status}.`;
  }
  return "Enter to queue · it goes to your computer when it's back and is sent there as your next reply.";
}

/**
 * The composer's one visible line saying why its controls are disabled on a mirrored run (the
 * buttons keep their `title`s too); null when nothing is, and for a run that isn't mirrored.
 */
export function composerHint(
  run: Pick<RunMeta, 'status' | 'remote' | 'queued'>,
  link: LinkLive | null | undefined,
): string | null {
  const r = run.remote;
  const l = liveOf(run, link);
  if (!r || !l) return null;
  if (!l.enabled) return `Remote control is off on ${l.label}, so nothing can be sent to this run.`;
  const online = isOnline(l);
  if (run.status !== 'running' && replyPending(run)) {
    return online ? 'Sending to your computer…' : "Your reply goes to your computer when it's back.";
  }
  if (!online) {
    // The banner above already says the computer is offline and when you can answer.
    return run.status === 'waiting'
      ? 'Answering needs your computer online.'
      : 'Plan mode, auto-send, Send now and messages already on your computer need it online.';
  }
  const sent = (run.queued || []).some((q) => r.pending.some((p) => p.id === q.id && p.kind === 'queue' && p.delivered));
  return sent ? "Messages already sent to your computer can't be changed here." : null;
}

/**
 * The run list: the pod's own runs and the mirrored ones (RunsResponse.remote), latest activity
 * (shared/remote.ts lastActivity) first as the server sorts each. A pod-local run wins over a mirrored one with the same id.
 */
export function mergeRuns(local: readonly RunMeta[], remote: readonly RunMeta[] = []): RunMeta[] {
  if (!remote.length) return [...local];
  const ids = new Set(local.map((r) => r.id));
  const all = [...local, ...remote.filter((r) => !ids.has(r.id))];
  return all.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
}

/**
 * Put a fresher copy of one run into the list: in place, or first when it's new. A mirrored copy
 * never replaces a pod-local run with the same id (the pod's own run wins).
 */
export function upsertRunInList(list: readonly RunMeta[], run: RunMeta): RunMeta[] {
  const i = list.findIndex((x) => x.id === run.id);
  if (i < 0) return [run, ...list];
  if (run.remote && !list[i].remote) return [...list];
  return list.map((x, j) => (j === i ? run : x));
}

/**
 * DataService keeps the pod's own runs (`local`) apart from mirrored ones (`remote`), as the
 * server does; only the Activity page shows them together (mergeRuns). Put a fresher copy of one
 * run in the right list:
 *  - mirrored: into `remote`, unless the pod has its own run with that id (the pod's run wins);
 *  - the pod's own: into `local`, and out of `remote` if a mirrored copy had its id.
 * A list that doesn't change comes back as the same array.
 */
export function upsertRunSplit(local: RunMeta[], remote: RunMeta[], run: RunMeta): { local: RunMeta[]; remote: RunMeta[] } {
  if (run.remote) {
    if (local.some((x) => x.id === run.id)) return { local, remote };
    return { local, remote: upsertRunInList(remote, run) };
  }
  const next = upsertRunInList(local, run);
  return { local: next, remote: remote.some((x) => x.id === run.id) ? remote.filter((x) => x.id !== run.id) : remote };
}

/** The run row's tag for a mirrored run's computer: Remote control off there, offline, or none (online). */
export function remoteTag(link: LinkLive | null | undefined, now = Date.now()): { text: string; title: string } | null {
  if (!link) return null;
  if (!link.enabled) return { text: 'remote control off', title: 'Remote control is off on ' + link.label };
  if (isOnline(link)) return null;
  return {
    text: 'offline',
    title: link.lastSeenAt ? 'Your computer was last seen ' + relTime(link.lastSeenAt, now) : "Your computer hasn't synced yet",
  };
}

/** "12 s ago" under a minute (Settings refreshes every few seconds), else relTime's "3m ago". */
export function agoSeconds(at: string, now = Date.now()): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  return s < 60 ? `${Math.max(0, s)} s ago` : relTime(t, now);
}

/** Settings' state line under the Remote control switch on the computer. */
export function remoteControlLine(rc: HostedLinkStatus['remoteControl'], now = Date.now()): string {
  if (!rc.on || rc.state === 'off') return 'Off';
  switch (rc.state) {
    case 'connected': return 'Connected' + (rc.lastSyncAt ? ' · last sync ' + agoSeconds(rc.lastSyncAt, now) : '');
    case 'connecting': return 'Connecting…';
    case 'refused': return 'Refused' + (rc.message ? ': ' + rc.message : '');
    case 'error': return rc.message || 'Something went wrong';
  }
}

/**
 * Settings on the hosted dashboard: a linked computer's state ("Online", "Last seen 3m ago",
 * "Remote control off · last seen 2m ago") from its LinkLive (linkLive, the run list's rule);
 * never "Online" while Remote control is off.
 */
export function linkState(l: Pick<LinkLive, 'online' | 'lastSeenAt' | 'enabled'>, now = Date.now()): string {
  const seen = l.lastSeenAt ? relTime(l.lastSeenAt, now) : '';
  if (!l.enabled) return 'Remote control off' + (seen ? ' · last seen ' + seen : '');
  if (isOnline(l)) return 'Online';
  return seen ? 'Last seen ' + seen : '';
}

// Remote control's wire protocol: a person's computer mirrors its runs to their hosted
// dashboard over the link (server/src/link-tokens.ts), and commands typed on the hosted
// dashboard come back down to run there. Types, constants and a few small rules both sides
// share: the server (Node type stripping, .ts extensions) and the web build both compile this
// file, so it has no runtime imports (the one import is type-only, erased by both).
import type { RemoteCommandKind, RunEvent, RunMeta } from './api.ts';

export type { RemoteCommandKind };

/** Bumped on a breaking change; the computer refuses a `hello` with another number. */
export const REMOTE_PROTOCOL = 1;

/** Every command kind: a mirrored run's POST routes of these names become commands; anything else is refused. */
export const REMOTE_COMMAND_KINDS: ReadonlySet<RemoteCommandKind> = new Set<RemoteCommandKind>(['reply', 'queue', 'queue-edit', 'queue-remove', 'queue-send', 'queue-auto', 'cancel', 'plan-mode']);

/**
 * When a run last did something: the newest of its start, current turn's start and last finish.
 * A resumed turn keeps the previous turn's endedAt, so take the max rather than a fallback chain.
 * ISO strings sort lexically. Runs lists sort on it, newest first.
 */
export function lastActivity(r: Pick<RunMeta, 'startedAt' | 'turnStartedAt' | 'endedAt'>): string {
  return [r.startedAt, r.turnStartedAt, r.endedAt].reduce<string>((max, t) => (t && t > max ? t : max), '');
}

/** A mirrorable event: a plain object with a string `type`. The pod 400s a sync with any other; the computer sends a placeholder instead. */
export function isEvent(e: unknown): e is RunEvent {
  return !!e && typeof e === 'object' && !Array.isArray(e) && typeof (e as { type?: unknown }).type === 'string';
}

/**
 * A query parameter on GET /api/remote/link (`?machine=`): a random id the computer keeps for
 * good (Forget leaves it), so the pod can tell a re-link of the same computer from another one.
 * Only decides who takes the link over, never what a caller may do: the token does that.
 */
export const MACHINE_ID_RE = /^[a-z0-9-]{1,64}$/;

/** Largest POST /api/remote/sync body. */
export const SYNC_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Largest run of events the computer puts in one sync (the rest go in the next). An event bigger
 * than this goes alone in its own sync if it fits under SYNC_MAX_BYTES with the rest of the body;
 * otherwise the computer sends { type: 'omitted', reason: 'too-large', bytes } (an OmittedEvent) at
 * the same index instead, so the two sides' indexes stay in step.
 */
export const SYNC_EVENTS_MAX_BYTES = 1024 * 1024;

/**
 * The placeholder for an event the computer can't mirror, at its index (so the two sides' indexes
 * stay in step); build it with `satisfies OmittedEvent`. `reason`:
 *  - 'too-large': over SYNC_EVENTS_MAX_BYTES and no room for it alone in a body, or one of at
 *    least 256 KB whose sync, with only it in, was refused (413) or cut off (reset) every time.
 *  - 'invalid': not a plain object with a string `type` (the pod 400s a sync with one), or in a
 *    run's batch the pod still refused (400) when that run was sent on its own.
 * `bytes` is the event's size as JSON.
 */
export interface OmittedEvent { type: 'omitted'; reason: 'too-large' | 'invalid'; bytes: number; uuid?: string; timestamp?: string }
/** A link is online while its last sync or open is newer than this (an ack doesn't count). */
export const ONLINE_MS = 60_000;
/** The computer syncs at least this often, even with nothing new. */
export const HEARTBEAT_MS = 20_000;
/** Commands a link can have waiting on the pod (not yet acked) before new ones are refused. */
export const PENDING_MAX = 50;

/** A command for one mirrored run. Kept on the pod until the computer acks it, and re-sent on every connect. */
export interface RemoteCommand {
  /** Unique per command: the computer runs an id once and re-acks a repeat. */
  id: string;
  runId: string;
  kind: RemoteCommandKind;
  /**
   * The run POST's body (POST /api/runs/:id/<kind> on the computer), field for field, except
   * attachments (refused) and effort (the computer's default applies, as from the run page).
   * cancel and queue-send have none.
   */
  payload: {
    /** reply, queue, queue-edit: the message. */
    text?: string;
    /**
     * queue-edit, queue-remove: the queued message (queue-send has no id: it sends the whole queue).
     * Either a still-pending RemoteCommand.id (a queue the computer hasn't had yet), which the
     * pod applies in place on that command and never forwards, or a QueuedMessage.id on the computer.
     * In place only while that command has `delivered === false`; once it went down the link but
     * isn't acked yet, the pod refuses with 409 "Already sent to your computer", online or offline.
     */
    id?: string;
    /** plan-mode: plan mode on or off. queue-auto: RunMeta.queueAutoSend on or off. */
    on?: boolean;
    /** queue: also send it as the answer when Claude ends a turn with a question (RunMeta.queueAutoSend). */
    autoSend?: boolean;
    /** reply only: the rest of the run on another model (ReplyRequest.model). A queued message has no model. */
    model?: string;
  };
  /** When it was typed (ISO). */
  at: string;
}

/**
 * A run the hosted dashboard has open: the computer sends its events from `after` (the pod's count) on.
 * On the link, the whole watch set goes only in `hello.watch`, on connect; after that, watch / unwatch
 * events change it.
 */
export interface RemoteWatch { runId: string; after: number }

/**
 * GET /api/remote/link[?machine=<id>] (Server-Sent Events, pod → computer; held open by the computer).
 * Before the stream starts: 401 for a bad or revoked token; 409 while another computer's link
 * is online (synced or opened within ONLINE_MS; an ack doesn't count), or while this same link
 * is online from another computer and holds its stream ("This link is in use on another
 * computer."). `machine` (MACHINE_ID_RE, else ignored) tells computers apart: a link from the
 * same machine as the online one takes over at once (a re-link with a new token, or after
 * Forget). Without one (an older computer) any other online link is another computer. A link
 * that is held open but not syncing doesn't count: a new link takes over and the stale stream
 * is ended.
 *   event: hello    data: RemoteHello    — first, on every connect; carries the whole watch set
 *   event: command  data: RemoteCommand  — every unacked command after hello, then new ones
 *   event: watch    data: RemoteWatch    — a run was opened on the hosted dashboard
 *   event: unwatch  data: { runId }      — nobody has it open any more
 *   : ping                               — keepalive comment every 25s
 */
export interface RemoteHello { protocol: number; linkId: string; label: string; watch: RemoteWatch[] }
export interface RemoteUnwatch { runId: string }

/**
 * POST /api/remote/sync (computer → pod) body: SyncRequest (at most SYNC_MAX_BYTES) → SyncResponse
 * `events[].from` is the index of the first event in the run's events file. The pod appends
 * only at its own count: an overlap is skipped, a gap is ignored, and `have` says where to
 * resume. Every event must be a plain object with a string `type`, or the whole sync is a 400.
 * `full`: `runs` is the computer's whole recent set, and the pod drops this link's runs that
 * aren't in it, together with their pending (unacked) commands and last errors: a command for
 * a run the computer no longer lists is discarded, never failed. `off`: Remote control was
 * turned off; the pod fails pending commands and refuses new ones until a sync without it.
 * Failures are HTTP statuses, never `ok: false`: 401 for a bad or revoked token, 409 while
 * another computer's link is online (the same rule as GET /api/remote/link, with the machine of
 * the stream this link last opened: sync only while holding the link stream), 413 "A sync can be
 * up to 2 MB." (over SYNC_MAX_BYTES), 400 for a wrong protocol or a bad body.
 */
export interface SyncRequest {
  protocol: number;
  full?: boolean;
  off?: boolean;
  runs: RunMeta[];
  events: { runId: string; from: number; events: RunEvent[] }[];
}
/** `have`: the pod's event count for every run the sync touched. */
export interface SyncResponse { ok: true; have: Record<string, number> }

/**
 * POST /api/remote/ack (computer → pod) body: AckRequest → { ok: true }. Only `ok: true` is a
 * success (it clears the run's lastError); anything else is a failure, and `error` shows on the
 * run (RemoteRunInfo.lastError).
 */
export interface AckRequest { id: string; ok: boolean; error?: string }

// Remote control, on the computer: holds the link to the person's hosted dashboard
// (GET /api/remote/link through hosted-link.ts), mirrors recent runs up to it
// (POST /api/remote/sync), and runs the commands typed there (POST /api/remote/ack).
// shared/remote.ts has the protocol; remote-mirror.ts is the other end.
//
// What goes up (plan Assumption 2): the metas of runs with activity in the last 7 days (at most
// 200, and as many as fit in one sync body; never a run handed off to the hosted dashboard), and
// events only for runs that are running or waiting, or open on the hosted dashboard (its watch
// set), each from the pod's own count (`have`). Syncs happen only while the link stream is held:
// the pod refuses (409) a sync from a link that isn't the one online. Nothing is held in memory
// while there's no link: each hello starts again from a full sync and the runs' files. One sync
// is in flight at a time, and the link dropping aborts it (its 503 retries and any body not yet
// sent; a body the pod already received stands), and the next sync waits until it has ended.
//
// No runtime imports of main.ts or runs.ts: main.ts passes the runs (RunSource) and the command
// executor in (remoteExecutor over main.ts's run actions).
//
// Commands run exactly once: each finished id and its result go in
// <ledger>/remote-link/done-commands.json before the ack is posted, so a command the pod re-sends
// (its ack was lost, the computer restarted, or the link was forgotten and made again) is
// re-acked from there without running again. Forget (hosted-link.ts) leaves that folder alone.
//
// The same folder keeps this computer's machine id (<ledger>/remote-link/machine-id, made once):
// sent as `?machine=` when the link opens, so the hosted dashboard lets a re-link of this computer
// (a new token, or after Forget) take over at once, and refuses another computer using this token.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { RunEvent, RunMeta } from "../../shared/api.ts";
import type { AckRequest, OmittedEvent, RemoteCommand, RemoteHello, RemoteUnwatch, RemoteWatch, SyncRequest, SyncResponse } from "../../shared/remote.ts";
import { HEARTBEAT_MS, MACHINE_ID_RE, REMOTE_PROTOCOL, SYNC_EVENTS_MAX_BYTES, SYNC_MAX_BYTES, isEvent, lastActivity } from "../../shared/remote.ts";
import type { HostedLink, RemoteControlState } from "./hosted-link.ts";

/** The runs this computer has (RunManager, narrowed to what the link reads). */
export interface RunSource {
  /** Latest activity first. */
  list(): RunMeta[];
  get(id: string): RunMeta | null;
  /** The run's events file, as RunManager.subscribe indexes it. */
  events(id: string): RunEvent[];
}

/** Runs one command on this computer; never throws for a refusal (`ok: false` with why). */
export type RemoteExecutor = (cmd: RemoteCommand) => Promise<{ ok: boolean; error?: string }>;

export type QueueAction = "queue" | "queue-auto" | "queue-edit" | "queue-remove" | "queue-send";

/**
 * What a run's POST routes do on this computer (main.ts replyToRun, queueAction, setRunPlanMode,
 * cancelRun), with their limits. Each throws an error with a user-facing message (httpError).
 */
export interface RunActions {
  /** Whether the run is on this computer. */
  has(runId: string): boolean;
  /** POST /api/runs/:id/reply. */
  reply(runId: string, body: { text?: string; model?: string }): unknown;
  /** POST /api/runs/:id/<action>. */
  queue(runId: string, action: QueueAction, body: { text?: string; id?: string; on?: boolean; autoSend?: boolean }): unknown;
  /** POST /api/runs/:id/plan-mode. */
  planMode(runId: string, on: boolean): unknown;
  /** POST /api/runs/:id/cancel. */
  cancel(runId: string): unknown;
}

export const REMOTE_OFF = "Remote control is off on this computer.";
export const RUN_GONE = "That run isn't on this computer any more.";
export const NO_ATTACHMENTS = "Attach files on your computer.";

/**
 * The executor main.ts gives RemoteLinkClient: each command kind goes to the run action its HTTP
 * route uses, so the same limits and refusals apply. Never starts a run, opens a terminal or sends
 * to the hosted dashboard. `isOn` is the Remote control switch, read as each command arrives.
 */
export function remoteExecutor(actions: RunActions, isOn: () => boolean): RemoteExecutor {
  return async (cmd) => {
    if (!isOn()) return { ok: false, error: REMOTE_OFF };
    if (!actions.has(cmd.runId)) return { ok: false, error: RUN_GONE };
    const p = (cmd.payload || {}) as RemoteCommand["payload"] & { attachments?: unknown };
    try {
      switch (cmd.kind) {
        case "reply":
        case "queue":
          // Not carried over the link (the pod refuses them too): files come from this computer.
          if (Array.isArray(p.attachments) ? p.attachments.length : p.attachments != null) return { ok: false, error: NO_ATTACHMENTS };
          // No effort: on a model switch the computer's default applies, as from the run page.
          if (cmd.kind === "reply") actions.reply(cmd.runId, { text: p.text, ...(p.model !== undefined ? { model: p.model } : {}) });
          else actions.queue(cmd.runId, "queue", { text: p.text, ...(p.autoSend !== undefined ? { autoSend: p.autoSend } : {}) });
          break;
        case "queue-edit": actions.queue(cmd.runId, "queue-edit", { id: p.id, text: p.text }); break;
        case "queue-remove": actions.queue(cmd.runId, "queue-remove", { id: p.id }); break;
        case "queue-send": actions.queue(cmd.runId, "queue-send", {}); break;
        case "queue-auto": actions.queue(cmd.runId, "queue-auto", { on: p.on }); break;
        case "plan-mode": actions.planMode(cmd.runId, !!p.on); break;
        case "cancel": actions.cancel(cmd.runId); break;
        default: return { ok: false, error: `Unknown command ${String((cmd as RemoteCommand).kind)}.` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || String(e) };
    }
  };
}

export interface RemoteLinkTimings {
  /** How often the sync loop looks for something to send. */
  tickMs: number;
  /** A sync at least this often, even with nothing new. */
  heartbeatMs: number;
  /** Reconnect backoff: from this, doubling, with jitter… */
  backoffMinMs: number;
  /** …to at most this. */
  backoffMaxMs: number;
  /** The wait before trying again after a 404, a 409 or an older hosted dashboard. */
  slowRetryMs: number;
  /** The recent set: runs with activity this recently… */
  recentMs: number;
  /** …at most this many. */
  recentMax: number;
  /** One sync POST's timeout. */
  syncTimeoutMs: number;
  /** One ack POST's timeout (no 503 retry: a failed ack is retried on the next tick). */
  ackTimeoutMs: number;
  /** How long turnOff() takes at most, waiting for a sync in flight and its last sync together. */
  offTimeoutMs: number;
}

export const DEFAULT_TIMINGS: RemoteLinkTimings = {
  tickMs: 1000,
  heartbeatMs: HEARTBEAT_MS,
  backoffMinMs: 1000,
  backoffMaxMs: 60_000,
  slowRetryMs: 60_000,
  recentMs: 7 * 24 * 3600 * 1000,
  recentMax: 200,
  syncTimeoutMs: 30_000,
  ackTimeoutMs: 10_000,
  offTimeoutMs: 10_000,
};

export interface RemoteLinkLimits {
  /** Event bytes in one sync (SYNC_EVENTS_MAX_BYTES). */
  eventsMaxBytes: number;
  /** A whole sync body (SYNC_MAX_BYTES). */
  maxBytes: number;
}

export interface RemoteLinkOptions {
  link: HostedLink;
  runs: RunSource;
  execute: RemoteExecutor;
  /** The ledger: finished command ids are kept in <ledger>/remote-link/done-commands.json. */
  ledgerDir: string;
  now?: () => number;
  timers?: Partial<RemoteLinkTimings>;
  limits?: Partial<RemoteLinkLimits>;
}

/** Room left in a sync body for the envelope and each run's batch header. */
const ENVELOPE_BYTES = 1024;
const BATCH_HEADER_BYTES = 128;
/** Events held from noteEvent per run before falling back to reading its file. */
const BUFFER_MAX = 2000;
/** Resets of a sync with only one event in it before that event goes as a placeholder… */
const RESETS_BEFORE_OMIT = 3;
/** …and only when it's at least this big: a smaller one's resets are the network, retried. */
const OMIT_ON_RESET_MIN_BYTES = 256 * 1024;
/** The batch divides by at most this (so recovering to full size takes a few syncs, not dozens). */
const SHRINK_MAX = 64;
/** Finished commands remembered (the newest), to re-ack a repeat without running it again. */
const DONE_MAX = 500;

const OLDER_VERSION = "Your hosted dashboard is on an older version. It picks up Remote control when it's updated.";
const ANOTHER_COMPUTER = "Another computer is using Remote control on your hosted dashboard.";
const REFUSED = "Link token refused: make a new one in your hosted dashboard's Settings › Linked computers.";

const bytes = (s: string) => Buffer.byteLength(s, "utf-8");
const active = (m: Pick<RunMeta, "status"> | null | undefined) => m?.status === "running" || m?.status === "waiting";
const jitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));

function placeholder(ev: unknown, reason: OmittedEvent["reason"], size: number): OmittedEvent {
  const o = (ev && typeof ev === "object" ? ev : {}) as Record<string, unknown>;
  return {
    type: "omitted", reason, bytes: size,
    ...(typeof o.uuid === "string" ? { uuid: o.uuid } : {}),
    ...(typeof o.timestamp === "string" ? { timestamp: o.timestamp } : {}),
  };
}

/** The ack for a command's result: only `ok: true` is a success, and a failure always says why. */
function ackOf(id: string, result: { ok: boolean; error?: string }): AckRequest {
  return result.ok === true ? { id, ok: true } : { id, ok: false, error: result.error || "It failed on your computer." };
}

/**
 * This computer's machine id: read from `file`, or made and kept there. One that can't be kept
 * (a read-only ledger) still works for this process; a re-link then waits like another computer.
 */
function machineId(file: string): string {
  try {
    const id = fs.readFileSync(file, "utf-8").trim();
    if (MACHINE_ID_RE.test(id)) return id;
  } catch { /* none yet */ }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id);
  } catch (e) {
    log(`keeping the machine id: ${(e as Error).message}`);
  }
  return id;
}

function log(message: string) {
  console.error(`[remote] ${message}`);
}

/** Events from noteEvent, contiguous from `start` (an index in the run's events file). */
interface Buffered { start: number; events: RunEvent[] }

/** What one sync POST carried, to apply its answer. */
interface Sent {
  body: SyncRequest;
  /** The metas sent, as they were (one changed since stays to send). */
  metas: Map<string, RunMeta>;
  /** Per run: the first index and how many events (placeholders included). */
  batches: { runId: string; from: number; count: number }[];
  /** Built as usual, the same body again after a 400, or one run's events on their own after a second 400. */
  kind: "normal" | "retry" | "solo";
  /** The connection it went on: the answer to one from an earlier connection is ignored. */
  conn: number;
  /** When its only event is a real one (not a placeholder): that event's size. */
  loneBytes: number | null;
}

export class RemoteLinkClient {
  private readonly link: HostedLink;
  private readonly runs: RunSource;
  private readonly execute: RemoteExecutor;
  private readonly now: () => number;
  private readonly t: RemoteLinkTimings;
  private readonly limits: RemoteLinkLimits;

  /** Bumped by stop(): anything started under an older one leaves state alone. */
  private gen = 0;
  private running = false;
  private abort: AbortController | null = null;
  /** turnOff()'s last sync, aborted by stop(): switched back on, it ends at once, 503 retries and all. */
  private offAbort: AbortController | null = null;
  private wakeWait: (() => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs: number;
  private lastSyncAt: string | null = null;

  // Per connection (reset on hello).
  private connected = false;
  private helloSeen = false;
  private mismatch = false;
  /** Bumped on each hello and disconnect: a sync's answer from an earlier connection is ignored. */
  private conn = 0;
  private needFull = false;
  private lastSentAt = 0;
  /** The sync in flight (at most one)… */
  private inflight: Promise<void> | null = null;
  /** …and its abort, which the link dropping (_disconnected) pulls: it ends at once, 503 retries and all. */
  private syncAbort: AbortController | null = null;
  /** The runs the pod holds for this link (sent in a sync since the last full one), with their meta's size. */
  private pod = new Map<string, number>();
  /** The pod's event count per run (SyncResponse.have, hello.watch, watch events). */
  private have = new Map<string, number>();
  /** Runs open on the hosted dashboard: replaced by each hello.watch, then watch / unwatch. */
  private watch = new Set<string>();
  /** A full sync's metas fit in this many bytes (halved on a 413 on one): what fits is the recent set. */
  private fullMaxBytes = 0;
  /** The oldest activity in the last full sync when its set was cut (by count or bytes), else "". */
  private boundaryAt = "";
  /** Divides the batch: doubled on each 413 or reset, halved on each sync that goes through (1 = full size). */
  private shrink = 1;
  /** Failed syncs back off: this wait, doubling to heartbeatMs; 0 after one goes through. */
  private failMs = 0;
  private nextSyncAt = 0;
  /** After a 400: the sync to send once more, unchanged… */
  private retry: Sent | null = null;
  /** …and after a second one, the runs in it, each to send on its own. */
  private solo: string[] | null = null;

  // Kept while connected (cleared on disconnect and stop: the next hello reads it all again).
  /** Metas changed since they were last acknowledged by a sync. */
  private dirty = new Map<string, RunMeta>();
  private buffers = new Map<string, Buffered>();
  /** Runs whose next events come from their file (a gap in the buffer, a fresh watch). */
  private reread = new Set<string>();

  // Kept across connections (until stop).
  /** Runs that are running or waiting (from the full sync, then noteChange). */
  private activeIds = new Set<string>();
  /** Events sent as placeholders instead, by run and index, with why. */
  private omit = new Map<string, Map<number, OmittedEvent["reason"]>>();
  /** Resets of a sync carrying one event alone, by its run and index (cleared by any sync that goes through). */
  private resets = new Map<string, number>();
  /** Commands run one at a time, in the order they came: the end of that line. */
  private commandChain: Promise<void> = Promise.resolve();
  /** Command ids queued or running, with the generation they came in (a re-delivery meanwhile, in the same one, is dropped). */
  private queuedCommands = new Map<string, number>();
  /** Acks that didn't go through, retried each tick (the pod also re-sends the command on the next connect). */
  private pendingAcks = new Map<string, AckRequest>();
  private acking = false;

  // Kept for good (in <ledger>/remote-link/done-commands.json, which Forget doesn't delete).
  /** Finished commands, oldest first, with their result: a repeat is re-acked from here, not run again. */
  private done = new Map<string, AckRequest>();
  private readonly doneFile: string;
  /** This computer's machine id (<ledger>/remote-link/machine-id, which Forget doesn't delete), sent as `?machine=`. */
  readonly machine: string;
  /** Runs left out of the full sync because their meta alone is over fullMaxBytes: each is logged once. */
  private tooBig = new Set<string>();

  constructor(opts: RemoteLinkOptions) {
    this.link = opts.link;
    this.runs = opts.runs;
    this.execute = opts.execute;
    this.now = opts.now ?? Date.now;
    this.t = { ...DEFAULT_TIMINGS, ...opts.timers };
    this.limits = { eventsMaxBytes: SYNC_EVENTS_MAX_BYTES, maxBytes: SYNC_MAX_BYTES, ...opts.limits };
    this.backoffMs = this.t.backoffMinMs;
    this.doneFile = path.join(opts.ledgerDir, "remote-link", "done-commands.json");
    this.machine = machineId(path.join(opts.ledgerDir, "remote-link", "machine-id"));
    try {
      const list = JSON.parse(fs.readFileSync(this.doneFile, "utf-8"));
      for (const d of Array.isArray(list) ? list : []) {
        if (d && typeof d.id === "string") this.done.set(d.id, ackOf(d.id, { ok: d.ok === true, error: typeof d.error === "string" ? d.error : undefined }));
      }
    } catch { /* none yet */ }
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Connect, when Remote control is on and the link has a token and a hosted address; a no-op
   * while already running. Switched on without either, the state says what's missing.
   */
  start(): void {
    if (this.running || !this.link.remoteControl()) return;
    const st = this.link.status();
    if (!st.url || !st.token.present) {
      this.link.setRemoteState({
        state: "error",
        message: !st.url ? "No hosted dashboard address is set (\"url\" in .claude/dashboard/hosting.json)." : "This computer isn't linked yet: paste a link token from your hosted dashboard's Settings.",
        lastSyncAt: this.lastSyncAt,
      });
      return;
    }
    this.running = true;
    this.backoffMs = this.t.backoffMinMs;
    const g = ++this.gen;
    this._state(g, "connecting", null);
    void this._loop(g);
  }

  /** Let go of the link: the stream closes and no callback from before touches the state. */
  stop(): void {
    this.gen++;
    this.running = false;
    this._disconnected();
    this.activeIds.clear();
    this.omit.clear();
    this.resets.clear();
    this.pendingAcks.clear(); // the pod re-sends those commands on the next connect, re-acked from the store
    this.abort?.abort();
    this.abort = null;
    this.offAbort?.abort();
    this.offAbort = null;
    this.wakeWait?.();
    this.wakeWait = null;
  }

  /** Stop and start again (a new token or certificate): a refused link tries again. */
  restart(): void {
    this.stop();
    this.start();
  }

  /**
   * Remote control was switched off (or the link forgotten): stop, then a last sync saying so
   * (best effort), so the hosted dashboard marks the link off and refuses new commands. A sync
   * in flight is aborted (stop) and waited for until it has ended, so that one can't turn it back
   * on after. The whole of it, wait included, takes at most offTimeoutMs; switched back on
   * meanwhile (start runs stop, which aborts it), the last sync isn't sent, or ends at once.
   */
  async turnOff(): Promise<void> {
    const inflight = this.inflight;
    this.stop(); // aborts the sync in flight (and an earlier turnOff's): it ends at once
    const g = this.gen;
    const deadline = Date.now() + this.t.offTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((ok) => { timer = setTimeout(() => ok("expired"), this.t.offTimeoutMs); });
    // Given up on, or switched back on (stop), the off sync is aborted (503 retries and all): it
    // can't land after the new connection's syncs. Made after the stop above, so it isn't that one's.
    const offAbort = new AbortController();
    this.offAbort = offAbort;
    try {
      if (inflight && (await Promise.race([inflight.then(() => "done", () => "done"), expired])) === "expired") {
        log("turning Remote control off: a sync was still going, so the hosted dashboard wasn't told");
        return;
      }
      if (g !== this.gen) return; // switched back on meanwhile: the new connection says so
      const st = this.link.status();
      if (!st.url || !st.token.present) return;
      const body: SyncRequest = { protocol: REMOTE_PROTOCOL, off: true, runs: [], events: [] };
      const r = await Promise.race([this.link.request("POST", "/api/remote/sync", body, Math.max(1, deadline - Date.now()), { signal: offAbort.signal }), expired]);
      if (r === "expired") log("turning Remote control off: the hosted dashboard took too long to answer");
      else if (r.status !== 200) log(`turning Remote control off: the hosted dashboard answered ${r.status}`);
    } catch (e) {
      log(`turning Remote control off: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      offAbort.abort();
      if (this.offAbort === offAbort) this.offAbort = null;
    }
  }

  // ------------------------------------------------------------ from RunManager

  /** A run's meta was written (RunManager onChange). Ignored while not connected: the next hello's full sync reads the runs. */
  noteChange(meta: RunMeta): void {
    if (!this.running || !this.connected) return;
    if (active(meta)) this.activeIds.add(meta.id);
    else this.activeIds.delete(meta.id);
    if (meta.handedOffTo === "hosted") {
      this.dirty.delete(meta.id);
      // The pod's own (imported) copy wins there anyway; a full sync takes ours out.
      if (this.pod.has(meta.id)) this.needFull = true;
      return;
    }
    this.dirty.set(meta.id, meta);
  }

  /**
   * An event was appended to a run's file at `index` (RunManager onEvent). Held only while
   * connected, and only for a run whose events go up (running or waiting, or watched); any
   * other's come from its file if it's opened.
   */
  noteEvent(meta: RunMeta, ev: RunEvent, index: number): void {
    if (!this.running || !this.connected || meta.handedOffTo === "hosted") return;
    if (!active(meta) && !this.activeIds.has(meta.id) && !this.watch.has(meta.id)) return;
    const b = this.buffers.get(meta.id);
    if (b && b.start + b.events.length === index) {
      b.events.push(ev);
      if (b.events.length > BUFFER_MAX) { this.buffers.delete(meta.id); this.reread.add(meta.id); }
      return;
    }
    if (b && b.events.length) {
      // Not the next one: something was missed, so the file is the truth from `have` on.
      this.buffers.delete(meta.id);
      this.reread.add(meta.id);
      return;
    }
    this.buffers.set(meta.id, { start: index, events: [ev] });
  }

  // ------------------------------------------------------------ the link stream

  private async _loop(g: number): Promise<void> {
    while (g === this.gen) {
      this.helloSeen = false;
      this.mismatch = false;
      const abort = new AbortController();
      this.abort = abort;
      let r: { status: number; error?: string };
      try { r = await this.link.stream(`/api/remote/link?machine=${encodeURIComponent(this.machine)}`, (event, data) => this._onStream(g, event, data), abort.signal); }
      catch (e) { r = { status: 0, error: (e as Error).message }; }
      if (g !== this.gen) return;
      const hadHello = this.helloSeen;
      this._disconnected();

      let wait: number;
      if (this.mismatch) {
        this._state(g, "error", OLDER_VERSION);
        wait = jitter(this.t.slowRetryMs);
      } else if (hadHello) {
        // The stream ended (the pod restarted, the network dropped, an idle limit): reconnect.
        this._state(g, "connecting", null);
        wait = this._backoff();
      } else if (r.status === 401 || r.status === 403) {
        this._state(g, "refused", REFUSED);
        this.running = false;
        return;
      } else if (r.status === 404 || r.status === 200) {
        this._state(g, "error", OLDER_VERSION);
        wait = jitter(this.t.slowRetryMs);
      } else if (r.status === 409) {
        this._state(g, "error", ANOTHER_COMPUTER);
        wait = jitter(this.t.slowRetryMs);
      } else if (r.status === 0) {
        this._state(g, "error", `Can't reach your hosted dashboard${r.error ? ` (${r.error})` : ""}.`);
        wait = this._backoff();
      } else {
        this._state(g, "error", `Your hosted dashboard answered ${r.status}.`);
        wait = this._backoff();
      }
      await this._sleep(wait);
    }
  }

  private _backoff(): number {
    const base = this.backoffMs;
    this.backoffMs = Math.min(this.t.backoffMaxMs, this.backoffMs * 2);
    return Math.min(this.t.backoffMaxMs, jitter(base));
  }

  /** A wait that stop() cuts short. */
  private _sleep(ms: number): Promise<void> {
    return new Promise((ok) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const self = this;
      function done() { clearTimeout(timer); if (self.wakeWait === done) self.wakeWait = null; ok(); }
      this.wakeWait = done;
    });
  }

  private _onStream(g: number, event: string, data: any): void {
    if (g !== this.gen) return;
    if (event === "hello") return this._hello(g, data as RemoteHello);
    if (!this.helloSeen) return;
    if (event === "command") { this._enqueue(data as RemoteCommand); return; }
    if (event === "watch") {
      const w = data as RemoteWatch;
      if (typeof w?.runId !== "string" || !Number.isInteger(w.after)) return;
      this.watch.add(w.runId);
      this.have.set(w.runId, w.after);
      // A newly opened run: its events from the pod's count, out of the file.
      this.reread.add(w.runId);
      return;
    }
    if (event === "unwatch") {
      const u = data as RemoteUnwatch;
      if (typeof u?.runId === "string") this.watch.delete(u.runId);
    }
  }

  private _hello(g: number, hello: RemoteHello): void {
    if (!hello || hello.protocol !== REMOTE_PROTOCOL) {
      this.mismatch = true;
      this.abort?.abort();
      return;
    }
    this.helloSeen = true;
    this.connected = true;
    this.backoffMs = this.t.backoffMinMs;
    this.have = new Map();
    this.watch = new Set();
    for (const w of Array.isArray(hello.watch) ? hello.watch : []) {
      if (typeof w?.runId !== "string" || !Number.isInteger(w.after)) continue;
      this.watch.add(w.runId);
      this.have.set(w.runId, w.after);
      this.reread.add(w.runId);
    }
    this.conn++;
    this.needFull = true;
    this.fullMaxBytes = this.limits.maxBytes - ENVELOPE_BYTES;
    this.shrink = 1;
    this.resets.clear();
    this.failMs = 0;
    this.nextSyncAt = 0;
    this.retry = null;
    this.solo = null;
    this._state(g, "connected", null);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this._tick(g), this.t.tickMs);
    this.tickTimer.unref?.();
    this._tick(g);
  }

  /**
   * The stream is gone: no syncing until the next hello, and nothing held meanwhile. That's
   * safe because the next hello starts from scratch: `have` and the watch set come from it,
   * its full sync sends every recent meta (so no changed one is lost), and with no buffer a
   * run's events come from its file, from the pod's count. The sync in flight is aborted: that
   * covers its 503 retries and any body not yet sent (one the pod already received stands), and
   * the next connection's first sync waits until it has ended.
   */
  private _disconnected() {
    this.connected = false;
    this.conn++;
    this.syncAbort?.abort();
    this.syncAbort = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.buffers.clear();
    this.dirty.clear();
    this.reread.clear();
    this.retry = null;
    this.solo = null;
  }

  private _state(g: number, state: RemoteControlState["state"], message: string | null) {
    if (g !== this.gen) return;
    this.link.setRemoteState({ state, message, lastSyncAt: this.lastSyncAt });
  }

  // ------------------------------------------------------------ commands

  /**
   * Commands run one at a time, in the order they came. One already finished is re-acked from the
   * store; a re-delivery of one queued or running (in this generation) is dropped.
   */
  private _enqueue(cmd: RemoteCommand): void {
    if (!cmd || typeof cmd.id !== "string") return;
    const g = this.gen;
    const finished = this.done.get(cmd.id);
    if (finished) { void this._ack(g, finished); return; }
    if (this.queuedCommands.get(cmd.id) === g) return;
    this.queuedCommands.set(cmd.id, g);
    this.commandChain = this.commandChain
      .then(() => this._command(g, cmd))
      .catch((e) => log(`command ${cmd.id}: ${(e as Error)?.message || e}`));
  }

  /**
   * Run a command, keep its result, then ack it. Not run at all when the client stopped since it
   * came (the switch went off, or it restarted): the pod re-sends it on the next connect. One
   * finished meanwhile (an earlier delivery of the same id) is only re-acked.
   */
  private async _command(g: number, cmd: RemoteCommand): Promise<void> {
    try {
      if (g !== this.gen) return;
      let ack = this.done.get(cmd.id);
      if (!ack) {
        let result: { ok: boolean; error?: string };
        try { result = await this.execute(cmd); }
        catch (e) { result = { ok: false, error: (e as Error)?.message || String(e) }; }
        ack = ackOf(cmd.id, result);
        this._remember(ack); // before the ack: a re-delivery after this never runs it again
      }
      // Not awaited: the result is kept, so the next command needn't wait for the round trip.
      void this._ack(g, ack);
    } finally {
      if (this.queuedCommands.get(cmd.id) === g) this.queuedCommands.delete(cmd.id);
    }
  }

  /** Keep a finished command's result (the newest DONE_MAX), on disk before it's acked. */
  private _remember(ack: AckRequest) {
    this.done.delete(ack.id);
    this.done.set(ack.id, ack);
    while (this.done.size > DONE_MAX) this.done.delete(this.done.keys().next().value!);
    try {
      fs.mkdirSync(path.dirname(this.doneFile), { recursive: true });
      const tmpFile = `${this.doneFile}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify([...this.done.values()]));
      fs.renameSync(tmpFile, this.doneFile);
    } catch (e) {
      log(`keeping finished commands: ${(e as Error).message}`);
    }
  }

  /**
   * Post an ack (ackTimeoutMs, no 503 retry). One that doesn't go through (no answer, or a 5xx)
   * is retried on the next tick; stopped meanwhile, it isn't, and the pod re-sends the command
   * on the next connect.
   */
  private async _ack(g: number, ack: AckRequest): Promise<void> {
    if (g !== this.gen) return;
    let retry = true;
    try {
      const r = await this.link.request("POST", "/api/remote/ack", ack, this.t.ackTimeoutMs, { retries503: 0 });
      if (r.status === 200) retry = false;
      else {
        log(`ack for ${ack.id}: the hosted dashboard answered ${r.status}`);
        if (r.status < 500) retry = false; // a refusal: trying again won't change it
      }
    } catch (e) {
      log(`ack for ${ack.id}: ${(e as Error).message}`);
    }
    if (g !== this.gen) return;
    if (retry) this.pendingAcks.set(ack.id, ack);
    else this.pendingAcks.delete(ack.id);
  }

  /** The acks that didn't go through, once more, one at a time. */
  private async _retryAcks(g: number): Promise<void> {
    if (this.acking || !this.pendingAcks.size) return;
    this.acking = true;
    try {
      for (const ack of [...this.pendingAcks.values()]) {
        if (g !== this.gen) return;
        this.pendingAcks.delete(ack.id);
        await this._ack(g, ack);
      }
    } finally { this.acking = false; }
  }

  // ------------------------------------------------------------ syncing

  private _tick(g: number): void {
    if (g !== this.gen || !this.connected) return;
    void this._retryAcks(g);
    // One sync at a time. One from an earlier connection was aborted when it dropped, so it ends
    // at once (and ticks again then): it never lands after this connection's.
    if (this.inflight) return;
    if (this.now() < this.nextSyncAt) return; // backing off after failed syncs
    let sent: Sent;
    if (this.retry) { sent = { ...this.retry, kind: "retry", conn: this.conn }; this.retry = null; }
    else sent = this._build();
    const idle = sent.kind === "normal" && !sent.body.full && !sent.body.runs.length && !sent.body.events.length;
    if (idle && this.now() - this.lastSentAt < this.t.heartbeatMs) return;
    this.lastSentAt = this.now();
    const ac = new AbortController();
    this.syncAbort = ac;
    const p: Promise<void> = this._send(g, sent, ac.signal).finally(() => {
      if (this.inflight === p) this.inflight = null;
      if (this.syncAbort === ac) this.syncAbort = null;
      // Clearing `inflight` is what matters: the next hello's tick sends the full sync. This tick
      // only saves a second when that hello came before the aborted sync ended.
      if (ac.signal.aborted) this._tick(g);
    });
    this.inflight = p;
  }

  /** Runs that may be mirrored (Assumption 2): last 7 days, not handed off to hosted, newest first. */
  private _recent(): RunMeta[] {
    const since = new Date(this.now() - this.t.recentMs).toISOString();
    return this.runs.list()
      .filter((r) => r.handedOffTo !== "hosted" && lastActivity(r) >= since)
      .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  }

  private _build(): Sent {
    const full = this.needFull;
    const maxBytes = this.limits.maxBytes - ENVELOPE_BYTES;
    const metas = new Map<string, RunMeta>();
    const sent = (body: SyncRequest, batches: Sent["batches"], kind: Sent["kind"], loneBytes: number | null): Sent => ({ body, metas, batches, kind, conn: this.conn, loneBytes });
    let used = 0;
    if (full) {
      // The recent set is the newest runs, at most recentMax, that fit in one body (fullMaxBytes):
      // a full sync carries all of it, never a shrunk part, so the pod prunes only what's outside.
      // A run whose meta alone is over fullMaxBytes is left out (logged once), so it can't hold up
      // the rest: it goes up once it fits, and never if it doesn't.
      const all = this._recent();
      let cut = all.length > this.t.recentMax;
      for (const m of all.slice(0, this.t.recentMax)) {
        const b = bytes(JSON.stringify(m)) + 1;
        if (this._tooBig(m.id, b)) continue;
        if (used + b > this.fullMaxBytes) { cut = true; break; }
        metas.set(m.id, m);
        used += b;
      }
      const kept = [...metas.values()];
      this.activeIds = new Set(kept.filter(active).map((r) => r.id));
      this.boundaryAt = cut && kept.length ? lastActivity(kept[kept.length - 1]) : "";
      // Events only once the pod's count is known (not on the full sync, which learns it).
      return sent({ protocol: REMOTE_PROTOCOL, full: true, runs: kept, events: [] }, [], "normal", null);
    }

    if (this.solo) {
      // After a second 400: one run's events at a time, with no metas (they go once that's done).
      while (this.solo.length) {
        const body: SyncRequest = { protocol: REMOTE_PROTOCOL, runs: [], events: [] };
        const batches: Sent["batches"] = [];
        const lone = this._packEvents(body, metas, batches, 0, this.solo[0]);
        if (batches.length) return sent(body, batches, "solo", lone);
        this.solo.shift();
      }
      this.solo = null;
    }

    const since = new Date(this.now() - this.t.recentMs).toISOString();
    const changed = [...this.dirty.values()].filter((m) => {
      if (this.pod.has(m.id)) return true;
      const at = lastActivity(m);
      if (at >= since && at >= this.boundaryAt) return true;
      this.dirty.delete(m.id); // outside the recent set, and not on the pod
      return false;
    });
    const cap = Math.max(1, Math.ceil(changed.length / this.shrink));
    for (const m of changed.slice(0, cap)) {
      const b = bytes(JSON.stringify(m)) + 1;
      // Too big for any full sync (see above): it would only be refused, and ask for a full sync.
      if (this._tooBig(m.id, b)) { this.dirty.delete(m.id); continue; }
      if (metas.size && used + b > maxBytes) break;
      metas.set(m.id, m);
      used += b;
    }
    // A new run past the cap (count or bytes): a full sync next, so the pod keeps only the newest.
    const fresh = [...metas.keys()].filter((id) => !this.pod.has(id));
    if (fresh.length) {
      let podBytes = 0;
      for (const [id, n] of this.pod) podBytes += metas.has(id) ? bytes(JSON.stringify(metas.get(id))) + 1 : n;
      for (const id of fresh) podBytes += bytes(JSON.stringify(metas.get(id))) + 1;
      if (this.pod.size + fresh.length > this.t.recentMax || podBytes > this.fullMaxBytes) this.needFull = true;
    }

    const body: SyncRequest = { protocol: REMOTE_PROTOCOL, runs: [...metas.values()], events: [] };
    const batches: Sent["batches"] = [];
    const lone = this._packEvents(body, metas, batches, used);
    return sent(body, batches, "normal", lone);
  }

  /** A meta of `size` bytes is over fullMaxBytes, so it stays off the pod; logged the first time for each run. */
  private _tooBig(id: string, size: number): boolean {
    if (size <= this.fullMaxBytes) { this.tooBig.delete(id); return false; }
    if (!this.tooBig.has(id)) {
      this.tooBig.add(id);
      log(`run ${id}: its details (${size} bytes) are too big to mirror; it stays off the hosted dashboard`);
    }
    return true;
  }

  /**
   * The runs whose events go up (or just `only`), and each one's from `have` on, under the byte
   * caps. An event the pod would refuse goes as an 'invalid' placeholder, one too big for any
   * sync as a 'too-large' one. Returns the size of the only event when it's a real one, else null.
   */
  private _packEvents(body: SyncRequest, metas: Map<string, RunMeta>, batches: Sent["batches"], metaBytes: number, only?: string): number | null {
    const eventsMax = Math.max(1, Math.floor(this.limits.eventsMaxBytes / this.shrink));
    const maxBytes = this.limits.maxBytes - ENVELOPE_BYTES;
    let eventBytes = 0, total = metaBytes, count = 0, real = 0, realBytes = 0;
    const ids = only !== undefined ? new Set([only])
      : new Set<string>([...this.watch, ...this.activeIds, ...this.reread, ...[...this.buffers].filter(([, b]) => b.events.length).map(([id]) => id)]);
    for (const runId of ids) {
      const h = this.have.get(runId);
      if (h === undefined) continue; // not on the pod yet: its meta goes first
      const tail = this._tail(runId, h);
      if (!tail.length) continue;
      const omit = this.omit.get(runId);
      const out: RunEvent[] = [];
      let stop = false;
      total += BATCH_HEADER_BYTES;
      for (let i = 0; i < tail.length; i++) {
        const index = h + i;
        let ev = tail[i];
        let b = bytes(JSON.stringify(ev) ?? "null") + 1;
        let reason: OmittedEvent["reason"] | null = !isEvent(ev) ? "invalid" : omit?.get(index) ?? null;
        if (!reason && (b > this.limits.eventsMaxBytes || b + BATCH_HEADER_BYTES > maxBytes)) {
          if (b + BATCH_HEADER_BYTES <= maxBytes) {
            // Bigger than a batch of events but fits a body: it goes by itself, in a sync of its own
            // (without the changed metas when they'd push it over: they stay to go next).
            if (out.length || batches.length) { stop = true; break; }
            if (total + b > maxBytes) {
              body.runs = [];
              metas.clear();
              total = BATCH_HEADER_BYTES;
            }
            out.push(ev);
            eventBytes += b;
            total += b;
            real++;
            realBytes = b - 1;
            stop = true;
            break;
          }
          reason = "too-large"; // too big for any sync
        }
        if (reason) {
          ev = placeholder(ev, reason, b - 1) as RunEvent;
          b = bytes(JSON.stringify(ev)) + 1;
        }
        if (eventBytes + b > eventsMax || total + b > maxBytes) {
          // At least one event, so a shrunk batch still moves (unless the metas fill this body).
          if (!out.length && !batches.length && total + b <= maxBytes) {
            out.push(ev); eventBytes += b; total += b;
            if (!reason) { real++; realBytes = b - 1; }
          }
          stop = true;
          break;
        }
        out.push(ev);
        eventBytes += b;
        total += b;
        if (!reason) { real++; realBytes = b - 1; }
      }
      if (out.length) {
        body.events.push({ runId, from: h, events: out });
        batches.push({ runId, from: h, count: out.length });
        count += out.length;
      }
      if (stop) break;
    }
    return count === 1 && real === 1 ? realBytes : null;
  }

  /** A run's events from index `h` on: from the buffer when it reaches back that far, else from its file. */
  private _tail(runId: string, h: number): RunEvent[] {
    const b = this.buffers.get(runId);
    if (!this.reread.has(runId) && b && b.start <= h && h <= b.start + b.events.length) return b.events.slice(h - b.start);
    const events = this.runs.events(runId);
    this.reread.delete(runId);
    const tail = events.slice(h);
    this.buffers.set(runId, { start: h, events: tail.slice(0, BUFFER_MAX) });
    if (tail.length > BUFFER_MAX) this.reread.add(runId);
    return tail;
  }

  private async _send(g: number, sent: Sent, signal: AbortSignal): Promise<void> {
    const nEvents = sent.batches.reduce((n, b) => n + b.count, 0);
    let status: number, json: any = null;
    try {
      const r = await this.link.request("POST", "/api/remote/sync", sent.body, this.t.syncTimeoutMs, { signal });
      status = r.status;
      json = r.json;
    } catch (e) {
      if (g !== this.gen || sent.conn !== this.conn) return;
      const err = e as NodeJS.ErrnoException;
      if ((err.code === "ECONNRESET" || err.code === "EPIPE") && nEvents) {
        // Maybe the pod cut off a body it found too large (its 413 can come as a reset), or maybe
        // it was the network. A smaller batch next; one big event that is still cut off when it
        // goes alone, after a few tries, goes as a placeholder. A small one is only ever retried.
        // Only a reset of the event on its own counts: one with others in the sync says nothing about it.
        const first = sent.batches[0];
        const key = `${first.runId}\n${first.from}`;
        const n = sent.loneBytes !== null ? (this.resets.get(key) ?? 0) + 1 : 0;
        if (sent.loneBytes !== null) this.resets.set(key, n);
        if (sent.loneBytes !== null && sent.loneBytes >= OMIT_ON_RESET_MIN_BYTES && n >= RESETS_BEFORE_OMIT) {
          this._omitOnly(sent, "too-large");
          this.resets.delete(key);
        } else this.shrink = Math.min(SHRINK_MAX, this.shrink * 2);
      }
      this._failed();
      log(`sync: ${err.message}`);
      return; // no answer, a reset, a timeout: tried again after a wait
    }
    if (g !== this.gen || sent.conn !== this.conn) return;

    if (status === 200 && json && typeof json.have === "object") {
      this._synced(sent, json as SyncResponse);
      this.failMs = 0;
      this.nextSyncAt = 0;
      if (sent.kind === "solo") this._soloDone();
      this.lastSyncAt = new Date(this.now()).toISOString();
      this._state(g, "connected", null);
      return;
    }
    if (status === 401 || status === 403) {
      this._state(g, "refused", REFUSED);
      this.stop();
      return;
    }
    if (status === 409) {
      // Not the link the pod holds as online (any more): reconnect, which says why.
      this.abort?.abort();
      return;
    }
    if (status === 413) {
      if (sent.body.full) {
        // The recent set is what fits: a smaller boundary, and the set built again under it.
        this.fullMaxBytes = Math.max(1, Math.floor(this.fullMaxBytes / 2));
        if (sent.body.runs.length <= 1) this._failed(); // can't get smaller: only wait
        log(`sync: too large (a full sync of ${sent.body.runs.length} runs); fewer runs next`);
        return;
      }
      if (sent.loneBytes !== null) this._omitOnly(sent, "too-large");
      else this.shrink = Math.min(SHRINK_MAX, this.shrink * 2);
      log(`sync: too large (${nEvents} events); ${sent.loneBytes !== null ? "sending a placeholder for it" : "halving the batch"}`);
      return;
    }
    if (status === 400) {
      log(`sync refused: ${json?.error || "400"}`);
      // Events are checked here first, so this is a backstop: the same once more (it may have
      // been passing), then each run on its own, and only a run still refused alone has that
      // batch's events replaced.
      if (!sent.batches.length) { this._failed(); return; } // nothing of ours to change
      if (sent.kind === "normal") this.retry = sent;
      else if (sent.kind === "retry") this.solo = [...new Set(sent.batches.map((b) => b.runId))];
      else {
        const b = sent.batches[0];
        let marks = this.omit.get(b.runId);
        if (!marks) this.omit.set(b.runId, (marks = new Map()));
        for (let i = b.from; i < b.from + b.count; i++) if (!marks.has(i)) marks.set(i, "invalid");
        this._soloDone();
      }
      return;
    }
    // A 5xx or anything else: tried again after a wait.
    this._failed();
    log(`sync: the hosted dashboard answered ${status}`);
  }

  /** A sync that didn't go through, for nothing a smaller one would fix: wait longer each time, up to the heartbeat. */
  private _failed() {
    this.failMs = this.failMs ? Math.min(this.t.heartbeatMs, this.failMs * 2) : this.t.tickMs;
    this.nextSyncAt = this.now() + this.failMs;
  }

  /** The run sent on its own after a second 400 is done with: on to the next. */
  private _soloDone() {
    this.solo?.shift();
    if (!this.solo?.length) this.solo = null;
  }

  /** The one event in a sync that the pod can't take: a placeholder from now on. */
  private _omitOnly(sent: Sent, reason: OmittedEvent["reason"]) {
    const b = sent.batches.find((x) => x.count)!;
    let marks = this.omit.get(b.runId);
    if (!marks) this.omit.set(b.runId, (marks = new Map()));
    marks.set(b.from, reason);
  }

  /** A sync went through: its metas are up, and `have` says where each run's events resume. */
  private _synced(sent: Sent, res: SyncResponse) {
    // Back towards full size a step at a time (a pod with a lower limit would 413 a full one again).
    this.shrink = Math.max(1, this.shrink / 2);
    this.resets.clear();
    if (sent.body.full) {
      this.needFull = false;
      this.pod = new Map();
    }
    for (const [id, m] of sent.metas) this.pod.set(id, bytes(JSON.stringify(m)) + 1);
    for (const [id, m] of sent.metas) if (this.dirty.get(id) === m) this.dirty.delete(id);
    for (const [id, n] of Object.entries(res.have || {})) if (Number.isInteger(n)) this.have.set(id, n);
    for (const b of sent.batches) {
      // The pod doesn't have the run (pruned, or never listed): no events for it until it does.
      if (!(b.runId in (res.have || {}))) this.have.delete(b.runId);
    }
    // Drop what the pod has from each buffer, and placeholders it has taken.
    for (const [id, buf] of this.buffers) {
      const h = this.have.get(id);
      if (h === undefined) continue;
      if (h < buf.start || h > buf.start + buf.events.length) { this.buffers.delete(id); if (h < buf.start) this.reread.add(id); continue; }
      buf.events = buf.events.slice(h - buf.start);
      buf.start = h;
      if (!buf.events.length && !this.activeIds.has(id) && !this.watch.has(id)) this.buffers.delete(id);
    }
    for (const [id, marks] of this.omit) {
      const h = this.have.get(id) ?? 0;
      for (const i of marks.keys()) if (i < h) marks.delete(i);
      if (!marks.size) this.omit.delete(id);
    }
  }
}

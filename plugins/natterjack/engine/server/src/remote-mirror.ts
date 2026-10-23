// Remote control, on the hosted dashboard: the runs a linked computer mirrors here, and the
// commands typed here for it (shared/remote.ts has the protocol). The computer runs the work;
// this only stores what it syncs and holds commands until it acks them.
//
// <ledger>/remote/<linkId>/
//   state.json                 label, lastSeenAt, enabled, pending commands, last error per run
//   runs/<runId>.json          the run's meta as the computer sent it (no `remote`)
//   runs/<runId>.events.jsonl  its events, one per line, at the computer's indexes
//
// A run id lives under one link only: a sync from a new link moves it there. Revoked link ids are
// refused (401) for the life of the process; after a restart LinkTokens.verify refuses them.
//
// Which computer a link is on: the machine id the computer sends when it opens the link
// (`?machine=`, shared/remote.ts), kept in state.json. It only decides takeover: a link from the
// same machine as the online one takes over at once (a re-link with a new token, or after
// Forget), one from another machine waits (409), and the same link from another machine is
// refused while its stream is held, so two computers sharing a token don't keep taking it from
// each other. A link without one (an older computer) counts as another computer.
//
// No runtime imports of main.ts or runs.ts: main.ts wires this in.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ServerResponse } from "node:http";
import type { RemoteCommandKind, RemoteLinkLive, RemoteRunInfo, RunEvent, RunMeta } from "../../shared/api.ts";
import type { AckRequest, RemoteCommand, RemoteHello, RemoteWatch, SyncRequest, SyncResponse } from "../../shared/remote.ts";
import { isEvent, lastActivity, MACHINE_ID_RE, ONLINE_MS, PENDING_MAX, REMOTE_COMMAND_KINDS, REMOTE_PROTOCOL } from "../../shared/remote.ts";
import type { LinkInfo } from "./link-tokens.ts";

const ID_RE = /^[a-z0-9-]{1,64}$/;
const PING_MS = 25_000;
const UNWATCH_GRACE_MS = 30_000;

/** Same shape as runs.ts httpError (not imported: this module stays free of runs.ts). */
function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

type StoredCommand = RemoteCommand & { delivered: boolean };
type LastError = NonNullable<RemoteRunInfo["lastError"]>;

interface LinkState {
  label: string;
  lastSeenAt: string | null;
  enabled: boolean;
  /** The machine id the link was last opened from; null when that computer sent none (an older one). */
  machine: string | null;
  pending: StoredCommand[];
  errors: Record<string, LastError>;
}

interface Live {
  res: ServerResponse;
  timer: ReturnType<typeof setInterval>;
}

interface Watched {
  linkId: string;
  subs: Set<ServerResponse>;
  /** The unwatch grace after the last subscriber left. */
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RemoteMirrorOptions {
  /** A mirrored run's meta changed (main.ts publishes it on the live `run` topic). */
  onChange?: (meta: RunMeta) => void;
  /**
   * A sync added a mirrored run, pruned one (`full`), or moved one to another link: once per
   * sync (main.ts refreshes the runs list). Not called by drop(); its caller refreshes.
   */
  onListChange?: () => void;
  /**
   * A link's live state (remoteLinks()) may have changed: on every sync and open, and on drop
   * (main.ts refreshes the `remote-links` topic, which sends it only when it differs).
   */
  onLinksChange?: () => void;
  /** How long a run stays watched after its last subscriber leaves. */
  unwatchGraceMs?: number;
  pingMs?: number;
  /** How recently a link synced (or opened) to count as online: ONLINE_MS unless a test shortens it. */
  onlineMs?: number;
}

export class RemoteMirror {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly opts: RemoteMirrorOptions;
  private readonly states = new Map<string, LinkState>();
  private readonly streams = new Map<string, Live>();
  private readonly counts = new Map<string, number>();
  private readonly watched = new Map<string, Watched>();
  /** runId → the link that mirrors it and its meta (no `remote`), so a lookup reads no file. Disk is the truth on restart. */
  private readonly index = new Map<string, { linkId: string; meta: RunMeta }>();
  /** Revoked link ids, in memory only (see the header). */
  private readonly dropped = new Set<string>();
  /** The links with a folder here: listed once at start, then kept up to date (_save adds, drop removes). */
  private readonly links = new Set<string>();
  /**
   * Links another link from the same machine took over (a re-link): offline from then on, and
   * their syncs refused, until they open again. In memory only: after a restart they're simply
   * not online once ONLINE_MS has passed.
   */
  private readonly replaced = new Set<string>();

  constructor(ledgerDir: string, now: () => number = Date.now, opts: RemoteMirrorOptions = {}) {
    this.dir = path.join(ledgerDir, "remote");
    this.now = now;
    this.opts = opts;
    try {
      for (const d of fs.readdirSync(this.dir, { withFileTypes: true })) if (d.isDirectory() && ID_RE.test(d.name)) this.links.add(d.name);
    } catch { /* none yet */ }
    for (const linkId of this._linkIds()) {
      for (const id of this._runIds(linkId)) {
        const meta = this._readMeta(linkId, id);
        if (meta) this.index.set(id, { linkId, meta });
      }
    }
  }

  // ------------------------------------------------------------ the link (computer side of the pod)

  /**
   * GET /api/remote/link, step 1 of 2: throws 401 for a revoked link, and 409 while another
   * computer's link is online (synced or opened within ONLINE_MS; an ack, or a stream held without
   * syncing, doesn't count) or while this link is online from another machine with its stream
   * held. `machine` is the computer's `?machine=` (null when it sent none, or one that isn't
   * MACHINE_ID_RE): a link online from the same machine is taken over, not a refusal (see the
   * header). main.ts calls this, then writes the SSE headers, then calls openLink with the same
   * `machine`, with no await in between.
   */
  assertCanOpen(link: LinkInfo, machine: string | null = null): void {
    const linkId = this._linkId(link.id);
    this._assertNotDropped(linkId);
    this._assertAlone(linkId, this._machine(machine));
  }

  /**
   * GET /api/remote/link, step 2 of 2, after assertCanOpen and the SSE headers: hello, then every
   * unacked command, then new ones as they come; a ping every 25s. Doesn't re-check for another
   * online link (assertCanOpen did); any other stream still held is stale, or the same machine's
   * older link, and is ended here (takeover), as is this link's own older stream. A link online
   * from the same machine is replaced: offline from now on, and its syncs refused.
   */
  openLink(link: LinkInfo, res: ServerResponse, machine: string | null = null): void {
    const linkId = this._linkId(link.id);
    this._assertNotDropped(linkId);
    const m = this._machine(machine);
    for (const other of [...this.streams.keys()]) this._endStream(other);
    if (m) {
      for (const other of this._linkIds()) {
        if (other !== linkId && this._online(other) && this._state(other).machine === m) this.replaced.add(other);
      }
    }
    this.replaced.delete(linkId);

    const st = this._state(linkId);
    st.label = link.label;
    st.machine = m;
    st.lastSeenAt = this._iso();
    const hello: RemoteHello = { protocol: REMOTE_PROTOCOL, linkId, label: link.label, watch: this._watchSet(linkId) };
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    for (const cmd of st.pending) {
      res.write(this._commandFrame(cmd));
      cmd.delivered = true;
    }
    this._save(linkId);

    const timer = setInterval(() => res.write(": ping\n\n"), this.opts.pingMs ?? PING_MS);
    timer.unref?.();
    this.streams.set(linkId, { res, timer });
    res.on("close", () => {
      clearInterval(timer);
      if (this.streams.get(linkId)?.res === res) this.streams.delete(linkId);
    });
    for (const runId of new Set(st.pending.map((c) => c.runId))) this._changed(linkId, runId);
    this.opts.onLinksChange?.();
  }

  /**
   * POST /api/remote/sync. 401 for a revoked link (so a sync in flight when it was revoked can't
   * bring the mirror back), 409 while another computer's link is online (judged on the machine
   * this link was last opened from, as assertCanOpen) or when this link was replaced by a newer
   * one from the same machine, 400 for a bad body. A `full` sync also prunes the runs the same
   * machine's other links still hold that it doesn't list (they're this computer's older links).
   */
  sync(link: LinkInfo, body: SyncRequest): SyncResponse {
    const linkId = this._linkId(link.id);
    this._assertNotDropped(linkId);
    if (!body || typeof body !== "object") throw httpError(400, "Expected a sync body.");
    if (body.protocol !== REMOTE_PROTOCOL) {
      throw httpError(400, `Remote control protocol ${String(body.protocol)} isn't this dashboard's (${REMOTE_PROTOCOL}). Update the dashboard on both sides.`);
    }
    if (this.replaced.has(linkId)) throw httpError(409, "A newer link from this computer took over.");
    this._assertAlone(linkId, this._state(linkId).machine);
    const runs = Array.isArray(body.runs) ? body.runs : [];
    const batches = Array.isArray(body.events) ? body.events : [];
    // Checked before anything is written: a line _readEvents skips would shift every later index.
    for (const b of batches) {
      if (b && Array.isArray(b.events) && !b.events.every(isEvent)) throw httpError(400, "Every event must be an object with a type.");
    }
    const st = this._state(linkId);
    st.label = link.label;
    st.lastSeenAt = this._iso();
    const changed = new Set<string>();
    let listChanged = false;

    if (body.off) {
      if (st.enabled || st.pending.length) {
        const message = `Remote control was turned off on ${link.label}.`;
        for (const cmd of st.pending) { st.errors[cmd.runId] = { kind: cmd.kind, message, at: this._iso() }; changed.add(cmd.runId); }
        st.pending = [];
      }
      st.enabled = false;
    } else {
      st.enabled = true;
    }

    const runsDir = this._runsDir(linkId);
    fs.mkdirSync(runsDir, { recursive: true });
    const have: Record<string, number> = {};
    const listed = new Set<string>();
    for (const m of runs) {
      if (!m || typeof m.id !== "string" || !ID_RE.test(m.id)) continue;
      const { remote: _drop, ...meta } = m;
      const prev = this.index.get(m.id);
      if (prev && prev.linkId !== linkId) this._moveRun(prev.linkId, linkId, m.id);
      if (!prev || prev.linkId !== linkId) listChanged = true;
      fs.writeFileSync(this._metaPath(linkId, m.id), JSON.stringify(meta, null, 2));
      this.index.set(m.id, { linkId, meta: meta as RunMeta });
      listed.add(m.id);
      changed.add(m.id);
      have[m.id] = this._count(linkId, m.id);
    }

    if (body.full) {
      const same = st.machine ? this._linkIds().filter((o) => o !== linkId && this._state(o).machine === st.machine) : [];
      for (const owner of [linkId, ...same]) {
        const ost = this._state(owner);
        const before = ost.pending.length + Object.keys(ost.errors).length;
        for (const id of this._runIds(owner)) if (!listed.has(id)) { this._deleteRun(owner, id); listChanged = true; }
        ost.pending = ost.pending.filter((c) => listed.has(c.runId));
        for (const id of Object.keys(ost.errors)) if (!listed.has(id)) delete ost.errors[id];
        if (owner !== linkId && ost.pending.length + Object.keys(ost.errors).length !== before) this._save(owner);
      }
    }

    for (const b of batches) {
      if (!b || typeof b.runId !== "string" || !ID_RE.test(b.runId) || this.index.get(b.runId)?.linkId !== linkId) continue;
      const n = this._count(linkId, b.runId);
      const from = Number(b.from);
      const events = Array.isArray(b.events) ? b.events : [];
      // Only at our own count: an overlap is skipped, a gap is dropped (`have` says where to resume).
      if (Number.isInteger(from) && from >= 0 && from <= n) {
        const fresh = events.slice(n - from);
        if (fresh.length) {
          fs.appendFileSync(this._eventsPath(linkId, b.runId), fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
          this.counts.set(this._key(linkId, b.runId), n + fresh.length);
          fresh.forEach((e, i) => this._broadcast(b.runId, "event", e, n + i));
        }
      }
      have[b.runId] = this._count(linkId, b.runId);
    }

    this._save(linkId);
    for (const id of changed) this._changed(linkId, id);
    if (listChanged) this.opts.onListChange?.();
    this.opts.onLinksChange?.();
    return { ok: true, have };
  }

  /** POST /api/remote/ack: the computer ran (or refused) a command. A repeat is fine. */
  ack(link: LinkInfo, body: AckRequest): void {
    const linkId = this._linkId(link.id);
    this._assertNotDropped(linkId);
    if (!body || typeof body.id !== "string") throw httpError(400, "Expected an ack id.");
    // Not a sighting: only a sync or an open is (a stale computer's late ack can't take the link back).
    const st = this._state(linkId);
    const cmd = st.pending.find((c) => c.id === body.id);
    // A repeat, or a link that never synced: nothing to write.
    if (!cmd) return;
    st.pending = st.pending.filter((c) => c !== cmd);
    if (body.ok === true) delete st.errors[cmd.runId];
    else st.errors[cmd.runId] = { kind: cmd.kind, message: String(body.error || "It failed on your computer."), at: this._iso() };
    this._save(linkId);
    this._changed(linkId, cmd.runId);
  }

  // ------------------------------------------------------------ the hosted dashboard

  /**
   * A command typed on the hosted dashboard for a mirrored run: held until the computer acks it,
   * and sent at once when its link is open. Returns the run with `remote.pending`.
   */
  command(runId: string, kind: RemoteCommandKind, payload: Record<string, any> = {}): RunMeta {
    const found = this._find(runId);
    if (!found) throw httpError(404, `No run ${runId}`);
    const { linkId } = found;
    this._assertNotDropped(linkId);
    if (!REMOTE_COMMAND_KINDS.has(kind)) throw httpError(400, `Unknown command ${String(kind)}`);
    const body = payload && typeof payload === "object" ? payload : {};
    if (Array.isArray(body.attachments) && body.attachments.length) throw httpError(400, "Attach files on your computer.");
    if (body.model !== undefined && typeof body.model !== "string") throw httpError(400, "Expected the model as a string.");
    if (body.model && kind !== "reply") throw httpError(400, "Only a reply can switch the model.");
    const st = this._state(linkId);
    if (!st.enabled) throw httpError(409, `Remote control is off on ${st.label}.`);

    const text = typeof body.text === "string" ? body.text : undefined;
    if ((kind === "reply" || kind === "queue" || kind === "queue-edit") && !text?.trim()) throw httpError(400, "Message is empty.");
    if ((kind === "queue-edit" || kind === "queue-remove") && typeof body.id !== "string") throw httpError(400, "Which queued message?");
    if ((kind === "plan-mode" || kind === "queue-auto") && typeof body.on !== "boolean") throw httpError(400, "Expected on: true or false.");

    // A queue still held here: edited or removed in place, never forwarded.
    if (kind === "queue-edit" || kind === "queue-remove") {
      const held = st.pending.find((c) => c.id === body.id && c.runId === runId && c.kind === "queue");
      if (held) {
        if (held.delivered) throw httpError(409, "Already sent to your computer.");
        if (kind === "queue-edit") held.payload.text = text;
        else st.pending = st.pending.filter((c) => c !== held);
        this._save(linkId);
        return this._changed(linkId, runId)!;
      }
    }

    if (!this._online(linkId) && kind !== "queue") {
      throw httpError(409, `Your computer is offline (last seen ${st.lastSeenAt ?? "never"}). Queue it instead.`);
    }
    if (st.pending.length >= PENDING_MAX) throw httpError(429, "Too many messages waiting for your computer.");

    const p: RemoteCommand["payload"] = {};
    if (text !== undefined && kind !== "queue-remove") p.text = text;
    if (typeof body.id === "string") p.id = body.id;
    if (typeof body.on === "boolean") p.on = body.on;
    if (kind === "queue" && typeof body.autoSend === "boolean") p.autoSend = body.autoSend;
    if (kind === "reply" && typeof body.model === "string" && body.model) p.model = body.model;
    const cmd: StoredCommand = { id: crypto.randomUUID(), runId, kind, payload: p, at: this._iso(), delivered: false };
    st.pending.push(cmd);
    const live = this.streams.get(linkId);
    if (live) { live.res.write(this._commandFrame(cmd)); cmd.delivered = true; }
    this._save(linkId);
    return this._changed(linkId, runId)!;
  }

  /** Every mirrored run, latest activity first (as RunManager.list), with `remote` filled in. */
  list(): RunMeta[] {
    const out: RunMeta[] = [];
    for (const { linkId, meta } of this.index.values()) out.push(this._fill(linkId, meta));
    return out.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  }

  get(id: string): RunMeta | null {
    const found = this._find(id);
    return found ? this._fill(found.linkId, found.meta) : null;
  }

  events(id: string): RunEvent[] {
    const found = this._find(id);
    return found ? this._readEvents(found.linkId, id) : [];
  }

  /** GET /api/remote-links: a link's state, or null before it first connected. */
  linkStatus(linkId: string): { online: boolean; lastSeenAt: string | null; enabled: boolean } | null {
    if (!this.links.has(linkId) || this.dropped.has(linkId)) return null;
    const st = this._state(linkId);
    return { online: this._online(linkId), lastSeenAt: st.lastSeenAt, enabled: st.enabled };
  }

  /**
   * Every link that has connected, with its live state (RunsResponse.remoteLinks and the
   * `remote-links` topic), by link id. Mirrored runs in the runs list carry no online state:
   * a run's is its link's here.
   */
  remoteLinks(): RemoteLinkLive[] {
    return this._linkIds().sort().map((linkId) => {
      const st = this._state(linkId);
      return { linkId, label: st.label, enabled: st.enabled, online: this._online(linkId), lastSeenAt: st.lastSeenAt };
    });
  }

  /**
   * SSE for a mirrored run, framed as RunManager.subscribe: the events after `after` (ids are
   * indexes), the meta, then live ones. The first subscriber asks the computer for the run's
   * events (`watch`); the last one leaving lets it stop (`unwatch`) after a grace.
   */
  subscribe(id: string, res: ServerResponse, after = -1): boolean {
    const found = this._find(id);
    if (!found) return false;
    const { linkId } = found;
    const events = this._readEvents(linkId, id);
    for (let i = Math.max(0, after + 1); i < events.length; i++) res.write(`id: ${i}\nevent: event\ndata: ${JSON.stringify(events[i])}\n\n`);
    res.write(`event: meta\ndata: ${JSON.stringify(this._fill(linkId, found.meta))}\n\n`);

    let w = this.watched.get(id);
    if (!w) {
      w = { linkId, subs: new Set(), timer: null };
      this.watched.set(id, w);
      const watch: RemoteWatch = { runId: id, after: this._count(linkId, id) };
      this._send(linkId, "watch", watch);
    }
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    const entry = w;
    entry.subs.add(res);
    res.on("close", () => {
      entry.subs.delete(res);
      if (entry.subs.size || this.watched.get(id) !== entry) return;
      entry.timer = setTimeout(() => {
        if (entry.subs.size || this.watched.get(id) !== entry) return;
        this.watched.delete(id);
        this._send(entry.linkId, "unwatch", { runId: id });
      }, this.opts.unwatchGraceMs ?? UNWATCH_GRACE_MS);
      entry.timer.unref?.();
    });
    return true;
  }

  /**
   * The link was revoked: close its stream, forget everything it mirrored, and refuse it (401)
   * from now on, so a sync already in flight can't recreate the mirror. Kept in memory only:
   * after a restart LinkTokens.verify refuses the revoked token.
   */
  drop(linkId: string): void {
    if (typeof linkId !== "string" || !ID_RE.test(linkId)) return;
    this.dropped.add(linkId);
    this._endStream(linkId);
    for (const [runId, w] of this.watched) {
      if (w.linkId !== linkId) continue;
      if (w.timer) clearTimeout(w.timer);
      this.watched.delete(runId);
      for (const res of w.subs) res.end();
    }
    for (const key of this.counts.keys()) if (key.startsWith(`${linkId}/`)) this.counts.delete(key);
    for (const [runId, r] of this.index) if (r.linkId === linkId) this.index.delete(runId);
    this.states.delete(linkId);
    this.links.delete(linkId);
    this.replaced.delete(linkId);
    fs.rmSync(path.join(this.dir, linkId), { recursive: true, force: true });
    this.opts.onLinksChange?.();
  }

  // ------------------------------------------------------------ internals

  private _linkId(id: string): string {
    if (typeof id !== "string" || !ID_RE.test(id)) throw httpError(400, "Bad link id.");
    return id;
  }

  private _iso() { return new Date(this.now()).toISOString(); }

  private _assertNotDropped(linkId: string) {
    if (this.dropped.has(linkId)) throw httpError(401, "This link was revoked.");
  }

  /** A `?machine=` worth keeping, else null (ignored, as from an older computer). */
  private _machine(machine: string | null | undefined): string | null {
    return typeof machine === "string" && MACHINE_ID_RE.test(machine) ? machine : null;
  }

  /**
   * One computer at a time (see the header): 409 while another link is online from another
   * machine (or either has none), or while this link is online from another machine and holds
   * its stream. Another link online from the same machine is a takeover, allowed.
   */
  private _assertAlone(linkId: string, machine: string | null) {
    for (const other of this._linkIds()) {
      if (other === linkId || !this._online(other)) continue;
      const ost = this._state(other);
      if (machine && ost.machine === machine) continue;
      throw httpError(409, `Another computer (${ost.label}) is linked to this dashboard right now.`);
    }
    const st = this._state(linkId);
    if (machine && st.machine && st.machine !== machine && this.streams.has(linkId) && this._online(linkId)) {
      throw httpError(409, "This link is in use on another computer.");
    }
  }

  private _endStream(linkId: string) {
    const live = this.streams.get(linkId);
    if (!live) return;
    this.streams.delete(linkId);
    clearInterval(live.timer);
    live.res.end();
  }

  /** Synced or opened within ONLINE_MS, and not replaced by a newer link from the same machine. */
  private _online(linkId: string): boolean {
    if (this.replaced.has(linkId)) return false;
    const st = this._state(linkId);
    return !!st.lastSeenAt && this.now() - Date.parse(st.lastSeenAt) < (this.opts.onlineMs ?? ONLINE_MS);
  }

  private _statePath(linkId: string) { return path.join(this.dir, linkId, "state.json"); }
  private _runsDir(linkId: string) { return path.join(this.dir, linkId, "runs"); }
  private _metaPath(linkId: string, id: string) { return path.join(this._runsDir(linkId), `${id}.json`); }
  private _eventsPath(linkId: string, id: string) { return path.join(this._runsDir(linkId), `${id}.events.jsonl`); }
  private _key(linkId: string, id: string) { return `${linkId}/${id}`; }

  private _linkIds(): string[] {
    return [...this.links].filter((id) => !this.dropped.has(id));
  }

  private _runIds(linkId: string): string[] {
    try {
      return fs.readdirSync(this._runsDir(linkId)).filter((f) => f.endsWith(".json") && ID_RE.test(f.slice(0, -5))).map((f) => f.slice(0, -5));
    } catch { return []; }
  }

  private _state(linkId: string): LinkState {
    let st = this.states.get(linkId);
    if (st) return st;
    st = { label: linkId, lastSeenAt: null, enabled: true, machine: null, pending: [], errors: {} };
    try {
      const s = JSON.parse(fs.readFileSync(this._statePath(linkId), "utf-8"));
      st = {
        label: typeof s.label === "string" ? s.label : linkId,
        lastSeenAt: typeof s.lastSeenAt === "string" ? s.lastSeenAt : null,
        enabled: s.enabled !== false,
        machine: this._machine(s.machine),
        pending: Array.isArray(s.pending) ? s.pending : [],
        errors: s.errors && typeof s.errors === "object" ? s.errors : {},
      };
    } catch {}
    this.states.set(linkId, st);
    return st;
  }

  private _save(linkId: string) {
    const st = this._state(linkId);
    fs.mkdirSync(path.join(this.dir, linkId), { recursive: true });
    fs.writeFileSync(this._statePath(linkId), JSON.stringify(st, null, 2));
    this.links.add(linkId);
  }

  private _readMeta(linkId: string, id: string): RunMeta | null {
    try {
      const m = JSON.parse(fs.readFileSync(this._metaPath(linkId, id), "utf-8"));
      return m && m.id === id ? m : null;
    } catch { return null; }
  }

  private _readEvents(linkId: string, id: string): RunEvent[] {
    try {
      return fs.readFileSync(this._eventsPath(linkId, id), "utf-8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }

  private _count(linkId: string, id: string): number {
    const key = this._key(linkId, id);
    let n = this.counts.get(key);
    if (n === undefined) {
      n = this._readEvents(linkId, id).length;
      this.counts.set(key, n);
    }
    return n;
  }

  private _deleteRun(linkId: string, id: string) {
    fs.rmSync(this._metaPath(linkId, id), { force: true });
    fs.rmSync(this._eventsPath(linkId, id), { force: true });
    this.counts.delete(this._key(linkId, id));
    if (this.index.get(id)?.linkId === linkId) this.index.delete(id);
  }

  /**
   * A run id synced by `to` that `from` still holds (a re-link gives the same computer a new link
   * id; the old link isn't revoked): the run moves to `to`, so one link owns it on disk too. Its
   * events and their count move, so `have` resumes at the old count and viewers get nothing twice;
   * the meta goes (sync writes it under `to` next). Its pending commands move with their ids,
   * order and `delivered`; if `to` is open, every kept one is sent on it now, delivered or not,
   * and marked delivered (the computer dedupes by id and re-acks ids it has finished). Any past
   * PENDING_MAX, or all of them if `to` is off, fail on the run instead. Its error
   * moves too. Viewers stay, now watching it on `to`.
   */
  private _moveRun(from: string, to: string, id: string) {
    const n = this._count(from, id);
    fs.mkdirSync(this._runsDir(to), { recursive: true });
    if (fs.existsSync(this._eventsPath(from, id))) fs.renameSync(this._eventsPath(from, id), this._eventsPath(to, id));
    else fs.rmSync(this._eventsPath(to, id), { force: true });
    this.counts.delete(this._key(from, id));
    this.counts.set(this._key(to, id), n);
    fs.rmSync(this._metaPath(from, id), { force: true });
    const prev = this.index.get(id);
    if (prev) this.index.set(id, { linkId: to, meta: prev.meta });

    const src = this._state(from);
    const dst = this._state(to);
    const moving = src.pending.filter((c) => c.runId === id);
    src.pending = src.pending.filter((c) => c.runId !== id);
    if (src.errors[id]) { dst.errors[id] = src.errors[id]; delete src.errors[id]; }
    const room = dst.enabled ? Math.max(0, PENDING_MAX - dst.pending.length) : 0;
    const kept = moving.slice(0, room);
    const failed = moving.slice(room);
    const live = this.streams.get(to);
    for (const cmd of kept) {
      dst.pending.push(cmd);
      // Every kept one, delivered or not: the delivery was on the old link, and the computer dedupes by id.
      if (live) { live.res.write(this._commandFrame(cmd)); cmd.delivered = true; }
    }
    if (failed.length) {
      const message = dst.enabled
        ? `${failed.length} message(s) couldn't move to ${dst.label}: too many waiting for your computer.`
        : `Remote control was turned off on ${dst.label}.`;
      dst.errors[id] = { kind: failed[0].kind, message, at: this._iso() };
    }
    this._save(from);
    this._save(to);

    const w = this.watched.get(id);
    if (w && w.linkId === from) {
      w.linkId = to;
      const watch: RemoteWatch = { runId: id, after: this._count(to, id) };
      this._send(to, "watch", watch);
    }
  }

  private _find(id: string): { linkId: string; meta: RunMeta } | null {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    return this.index.get(id) ?? null;
  }

  private _fill(linkId: string, meta: RunMeta): RunMeta {
    const st = this._state(linkId);
    const remote: RemoteRunInfo = {
      linkId,
      label: st.label,
      online: this._online(linkId),
      lastSeenAt: st.lastSeenAt,
      enabled: st.enabled,
      pending: st.pending.filter((c) => c.runId === meta.id).map((c) => ({
        id: c.id, kind: c.kind, ...(c.payload.text !== undefined ? { text: c.payload.text } : {}), at: c.at, delivered: c.delivered,
      })),
      lastError: st.errors[meta.id] ?? null,
    };
    return { ...meta, remote };
  }

  private _watchSet(linkId: string): RemoteWatch[] {
    const out: RemoteWatch[] = [];
    for (const [runId, w] of this.watched) if (w.linkId === linkId) out.push({ runId, after: this._count(linkId, runId) });
    return out;
  }

  private _commandFrame(cmd: StoredCommand) {
    const { delivered: _d, ...wire } = cmd;
    return `event: command\ndata: ${JSON.stringify(wire)}\n\n`;
  }

  /** An event on the link's open stream, if there is one (otherwise it goes in the next hello). */
  private _send(linkId: string, event: string, data: unknown) {
    this.streams.get(linkId)?.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private _broadcast(id: string, event: string, data: unknown, eventId: number | null = null) {
    const w = this.watched.get(id);
    if (!w) return;
    const payload = `${eventId === null ? "" : `id: ${eventId}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of w.subs) res.write(payload);
  }

  /** The run's meta changed: tell its subscribers and onChange. */
  private _changed(linkId: string, id: string): RunMeta | null {
    const found = this.index.get(id);
    if (!found || found.linkId !== linkId) return null;
    const full = this._fill(linkId, found.meta);
    this._broadcast(id, "meta", full);
    this.opts.onChange?.(full);
    return full;
  }
}

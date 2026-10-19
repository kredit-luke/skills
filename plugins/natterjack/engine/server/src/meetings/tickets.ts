/**
 * Tickets made from a meeting, found two ways and merged by key:
 *
 * - Run: a meeting's Ask run writes meeting-tickets.json ([{key, url, title}]) to its outputs
 *   folder after creating tickets. When its turn ends, the dashboard records them by key in
 *   <ledger>/meeting-tickets.json ({ meetingId → [{key, title, runId, at}] }; the run's url
 *   isn't kept, the tracker builds the link): instant, but only for runs on this dashboard.
 * - Tracker: each ticket's description carries a marker ("roam-meeting-<id>"), so the tracker's
 *   linkedIssues finds them for everyone. Bounded by a timeout: a slow tracker leaves the
 *   page with the recorded ones.
 */

import fs from "node:fs";
import path from "node:path";
import type { Meeting, MeetingTicket } from "../../../shared/api.ts";
import type { IssueTracker, LinkedIssue, TrackerStatus } from "../issues/index.ts";
import { MEETING_ID_RE } from "./index.ts";

/** What a meeting's Ask run writes to its outputs folder. */
export const TICKETS_FILE = "meeting-tickets.json";

/** Caps: tickets a run's file may add (perFile), kept and read back per meeting (perMeeting, the newest), and field lengths. */
export const TICKET_CAPS = { perFile: 50, perMeeting: 100, key: 100, url: 2000, title: 300, fileBytes: 256 * 1024 };

/** How long the tracker gets before the page goes with the recorded tickets only. */
export const TRACKER_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60 * 1000;

/** The marker a ticket's description carries for a meeting: "<source>-meeting-<id>", e.g. "roam-meeting-3f2a…". */
export function meetingMarker(source: string, id: string): string {
  const kind = String(source || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "meeting";
  return `${kind}-meeting-${id}`;
}

/** A ticket an Ask run reported, by key: its link is always the tracker's (trackerUrl), so a run's url isn't kept. */
export interface RunTicket { key: string; title: string }
/** One recorded in the ledger. */
export interface RecordedTicket extends RunTicket { runId: string; at: string }

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s && s.length <= max ? s : null;
}

function httpsUrl(v: unknown): string | null {
  const s = clean(v, TICKET_CAPS.url);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : null;
  } catch { return null; }
}

/**
 * The valid entries of a run's meeting-tickets.json content: string key, a title (may be empty).
 * A url, if there is one, is ignored (the tracker builds the link from the key; older ledgers
 * have one). The first `max` entries (a run's file); `newest`: the last ones (the ledger).
 */
export function parseRunTickets(raw: unknown, max = TICKET_CAPS.perFile, newest = false): RunTicket[] {
  if (!Array.isArray(raw)) return [];
  const out: RunTicket[] = [];
  for (const x of newest ? raw.slice(-max) : raw.slice(0, max)) {
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    const key = clean((x as any).key, TICKET_CAPS.key);
    if (!key) continue;
    const t = typeof (x as any).title === "string" ? (x as any).title.replace(/\s+/g, " ").trim() : "";
    const title = t.length > TICKET_CAPS.title ? t.slice(0, TICKET_CAPS.title - 1) + "…" : t;
    if (!out.some((o) => o.key === key)) out.push({ key, title });
  }
  return out;
}

/** A run's meeting-tickets.json (its path, or null: there's none); [] when it's missing, too big or not JSON. */
export function readRunTickets(file: string | null): RunTicket[] {
  if (!file) return [];
  try {
    if (fs.statSync(file).size > TICKET_CAPS.fileBytes) { console.warn(`${TICKETS_FILE} is too big; ignored.`); return []; }
    return parseRunTickets(JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, "")));
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn(`${TICKETS_FILE} couldn't be read: ${e.message}`);
    return [];
  }
}

/** <ledger>/meeting-tickets.json: tickets meetings' Ask runs reported, by meeting id. */
export class MeetingTickets {
  file: string;
  constructor(ledgerDir: string) { this.file = path.join(ledgerDir, TICKETS_FILE); }

  /** Everything recorded, entries that don't hold up left out. */
  all(): Record<string, RecordedTicket[]> {
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(this.file, "utf-8")); } catch { return {}; }
    // No prototype: a meeting id like "__proto__" is an ordinary key.
    const out: Record<string, RecordedTicket[]> = Object.create(null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [id, list] of Object.entries(raw)) {
      if (!MEETING_ID_RE.test(id) || !Array.isArray(list)) continue;
      const ok = parseRunTickets(list, TICKET_CAPS.perMeeting, true).map((t) => {
        const src = (list as any[]).find((x) => x && x.key === t.key) || {};
        return { ...t, runId: typeof src.runId === "string" ? src.runId : "", at: typeof src.at === "string" ? src.at : "" };
      });
      if (ok.length) out[id] = ok;
    }
    return out;
  }

  forMeeting(id: string): RecordedTicket[] { return (MEETING_ID_RE.test(id) && this.all()[id]) || []; }

  /** Add a run's tickets to a meeting: one per key (a later report updates the title, keeping when it was first seen). */
  record(meetingId: string, runId: string, tickets: RunTicket[], at = new Date().toISOString()): RecordedTicket[] {
    if (!MEETING_ID_RE.test(meetingId) || !tickets.length) return this.forMeeting(meetingId);
    const all = this.all();
    const list = all[meetingId] || [];
    for (const t of tickets) {
      const i = list.findIndex((x) => x.key === t.key);
      if (i >= 0) list[i] = { ...list[i], title: t.title || list[i].title };
      else list.push({ key: t.key, title: t.title, runId, at });
    }
    all[meetingId] = list.slice(-TICKET_CAPS.perMeeting);
    // Temp file, then rename: a reader never sees half a file.
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, this.file);
    return all[meetingId];
  }
}

/**
 * When a meetings run's turn ends: record what its meeting-tickets.json lists (`file` is its path
 * in the run's outputs, or null). Never throws.
 */
export function recordRunTickets(store: MeetingTickets, run: { id: string; trigger: string; meetingId?: string }, file: string | null): void {
  if (run.trigger !== "meetings" || !run.meetingId || !MEETING_ID_RE.test(run.meetingId)) return;
  try {
    const tickets = readRunTickets(file);
    if (tickets.length) store.record(run.meetingId, run.id, tickets);
  } catch (e) {
    console.warn(`Recording a meeting run's tickets failed: ${e.message}`);
  }
}

const normUrl = (u: string) => u.toLowerCase().replace(/\/+$/, "");

/**
 * A recorded ticket's link as the tracker builds it from the key, so a run can't point a ticket
 * anywhere else. No link when the tracker can't build one: no tracker, or a key that isn't one of
 * its ids (each adapter's issueUrl checks its own).
 */
export function trackerUrl(tracker: IssueTracker | null, key: string): string {
  if (!tracker) return "";
  try { return httpsUrl(tracker.issueUrl(key)) || ""; } catch { return ""; }
}

/** Recorded and tracker tickets as one list, one per key (or link): the tracker's title and link win, and its source sticks. */
export function mergeTickets(recorded: { key: string; url: string; title: string }[], found: LinkedIssue[]): MeetingTicket[] {
  const out: MeetingTicket[] = [];
  const same = (a: MeetingTicket, key: string, url: string) => a.key.toLowerCase() === key.toLowerCase() || (!!url && normUrl(a.url) === normUrl(url));
  for (const t of recorded) {
    if (!out.some((o) => same(o, t.key, t.url))) out.push({ key: t.key, url: t.url, title: t.title, source: "run" });
  }
  for (const t of found) {
    const i = out.findIndex((o) => same(o, t.key, t.url));
    const ticket: MeetingTicket = { key: t.key, url: t.url || (i >= 0 ? out[i].url : ""), title: t.title || (i >= 0 ? out[i].title : ""), source: "tracker" };
    if (i >= 0) out[i] = ticket;
    else out.push(ticket);
  }
  return out;
}

/**
 * Adds `tickets` to meetings: the ledger's, and the tracker's (one linkedIssues call for all of
 * them, cached per tracker and marker set, bounded by a timeout; the call carries on and fills the cache).
 */
export class MeetingTicketLinks {
  store: MeetingTickets;
  timeoutMs: number;
  ttlMs: number;
  /** Searches by tracker scope (trackerScope) and marker set; `truncated` is null until the search settles. */
  private cache = new Map<string, { at: number; truncated: boolean | null; result: Promise<Map<string, LinkedIssue[]>> }>();
  /** A number per tracker instance: Trackers makes a new one whenever its settings (sites, projects, repos) change. */
  private instances = new WeakMap<IssueTracker, number>();
  private nextInstance = 0;

  constructor(store: MeetingTickets, opts: { timeoutMs?: number; ttlMs?: number } = {}) {
    this.store = store;
    this.timeoutMs = opts.timeoutMs ?? TRACKER_TIMEOUT_MS;
    this.ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  }

  /** Forget every search (the tracker was connected or disconnected). */
  clear() { this.cache.clear(); }

  /**
   * Which tracker settings and connection a search was made with: the instance (new settings make
   * a new one) and who it's connected as, so another site, project, repo or account never reuses it.
   * JSON, so it holds no newline (the cache key's separator).
   */
  private trackerScope(tracker: IssueTracker, status: TrackerStatus): string {
    let n = this.instances.get(tracker);
    if (n === undefined) { n = ++this.nextInstance; this.instances.set(tracker, n); }
    return JSON.stringify([tracker.kind, n, status.source, status.viewer]);
  }

  /**
   * The tracker's issues by marker; an empty map when it isn't connected, fails or is too slow.
   * Never throws. A failed search isn't cached: the next load tries again.
   */
  async linked(tracker: IssueTracker | null, markers: string[]): Promise<Map<string, LinkedIssue[]>> {
    if (!tracker || !tracker.linkedIssues || !markers.length) return new Map();
    let status: TrackerStatus;
    try { status = tracker.status(); } catch { return new Map(); }
    if (!status.connected) return new Map();
    const scope = this.trackerScope(tracker, status);
    const wanted = [...new Set(markers)].sort();
    const key = `${scope}\n${wanted.join("\n")}`;
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at >= this.ttlMs) this.cache.delete(k);
    let hit = this.cache.get(key);
    // A finished search by the same tracker and connection that covered these markers too (a
    // detail opened from the list): use the newest one, unless it hit its result cap (it may have missed some).
    if (!hit) {
      for (const [k, v] of this.cache) {
        const [by, ...had] = k.split("\n");
        if (by === scope && v.truncated === false && wanted.every((m) => had.includes(m)) && (!hit || v.at > hit.at)) hit = v;
      }
    }
    if (!hit) {
      const entry = { at: now, truncated: null as boolean | null, result: null as unknown as Promise<Map<string, LinkedIssue[]>> };
      // Through Promise.resolve().then: an adapter that throws synchronously fails like one that rejects.
      entry.result = Promise.resolve().then(() => tracker.linkedIssues!(markers)).then((found) => {
        entry.truncated = !!(found && found.truncated);
        return found;
      }, (e) => {
        console.warn(`${tracker.kind}: looking up meeting tickets failed: ${e && e.message}`);
        if (this.cache.get(key) === entry) this.cache.delete(key);
        return new Map<string, LinkedIssue[]>();
      });
      hit = entry;
      this.cache.set(key, entry);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Map<string, LinkedIssue[]>>((resolve) => { timer = setTimeout(() => resolve(new Map()), this.timeoutMs); timer.unref?.(); });
    try { return await Promise.race([hit.result, timeout]); } finally { clearTimeout(timer); }
  }

  /** The meetings with their tickets. `source` is the meeting tool's kind (it names the marker). */
  async attach<T extends Meeting>(source: string, meetings: T[], tracker: IssueTracker | null): Promise<T[]> {
    // Only real ids reach the tracker's query.
    const markers = meetings.map((m) => (MEETING_ID_RE.test(String(m.id)) ? meetingMarker(source, m.id) : null));
    const found = await this.linked(tracker, markers.filter((x): x is string => !!x));
    let recorded: Record<string, RecordedTicket[]> = Object.create(null);
    try { recorded = this.store.all(); } catch {}
    return meetings.map((m, i) => {
      const marker = markers[i];
      if (!marker) return { ...m, tickets: [] };
      const own = (recorded[m.id] || []).map((t) => ({ key: t.key, title: t.title, url: trackerUrl(tracker, t.key) }));
      return { ...m, tickets: mergeTickets(own, found.get(marker) || []) };
    });
  }
}

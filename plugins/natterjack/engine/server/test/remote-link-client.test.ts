// Remote control on the computer (remote-link.ts) against a real local HTTP server that mounts a
// RemoteMirror (remote-mirror.ts) the way main.ts does, without auth: runs go up, events follow,
// a restart of the hosted side loses and duplicates nothing, and refusals stop it trying.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { RunEvent, RunMeta } from "../../shared/api.ts";
import { LinkTokens } from "../src/link-tokens.ts";
import type { LinkInfo } from "../src/link-tokens.ts";
import { HostedLink } from "../src/hosted-link.ts";
import { RemoteMirror } from "../src/remote-mirror.ts";
import type { RemoteMirrorOptions } from "../src/remote-mirror.ts";
import { NO_ATTACHMENTS, REMOTE_OFF, RUN_GONE, RemoteLinkClient, remoteExecutor } from "../src/remote-link.ts";
import type { RemoteExecutor, RemoteLinkLimits, RemoteLinkTimings, RunActions, RunSource } from "../src/remote-link.ts";
import { RunManager, httpError } from "../src/runs.ts";
import type { RemoteCommand, SyncRequest } from "../../shared/remote.ts";
import { fakeClaude, settled } from "./fake-claude.ts";

// Commands run real turns through RunManager on a fake claude (fake-claude.ts).
const fake = fakeClaude("dash-rlc-claude-");
before(() => fake.install());
after(() => fake.cleanup());

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-rlc-"));
const ANA = "ana@example.com";
const LAPTOP: LinkInfo = { id: "link-a", label: "Work laptop", createdAt: "2026-10-22T09:00:00Z", lastUsedAt: null };
const TIMERS = { tickMs: 30, heartbeatMs: 300, backoffMinMs: 30, backoffMaxMs: 150, slowRetryMs: 150, syncTimeoutMs: 3000, offTimeoutMs: 2000 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, ok: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await wait(15);
  }
  return Date.now() - t0;
}

/** What a gate says about one request: answer it with `status`, hold it `delayMs` first, or cut the connection (`reset`). */
type Gate = (req: http.IncomingMessage, body: Buffer) => { status?: number; delayMs?: number; reset?: boolean } | null;

/**
 * The hosted side: a RemoteMirror's link, sync and ack routes, as main.ts mounts them (no auth;
 * the link is LAPTOP unless `linkOf` picks one by the request's Bearer token), with `?machine=`.
 */
async function pod(ledger: string, port = 0, gate?: Gate, mirrorOpts: RemoteMirrorOptions = {}, now: () => number = Date.now, linkOf: (token: string) => LinkInfo = () => LAPTOP) {
  const mirror = new RemoteMirror(ledger, now, mirrorOpts);
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url || "/", "http://x");
    const p = url.pathname;
    requests.push(`${req.method} ${p}`);
    const link = linkOf(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    const fail = (e: any) => { if (!res.headersSent) { res.writeHead(e.status || 400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); } else res.end(); };
    try {
      const g = gate?.(req, raw);
      if (g?.reset) { req.socket.destroy(); return; }
      if (g?.delayMs) await wait(g.delayMs);
      if (g?.status) return fail({ status: g.status, message: `gate ${g.status}` });
      if (req.method === "GET" && p === "/api/remote/link") {
        const machine = url.searchParams.get("machine");
        mirror.assertCanOpen(link, machine);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        mirror.openLink(link, res, machine);
        return;
      }
      const json = (s: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(s)); };
      if (req.method === "POST" && p === "/api/remote/sync") return json(mirror.sync(link, JSON.parse(raw.toString("utf-8"))));
      if (req.method === "POST" && p === "/api/remote/ack") { mirror.ack(link, JSON.parse(raw.toString("utf-8"))); return json({ ok: true }); }
      fail({ status: 404, message: "Not found" });
    } catch (e) { fail(e); }
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", () => ok()));
  const actual = (server.address() as any).port as number;
  return {
    mirror, requests, port: actual, url: `http://127.0.0.1:${actual}`,
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}

/** A hosted side that answers every request with one status. */
async function refusing(status: number) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `no (${status})` }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  return { requests, url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }) };
}

/** A computer's runs, in memory; changes and appends go to the client as RunManager's hooks would. */
class FakeRuns implements RunSource {
  metas = new Map<string, RunMeta>();
  evs = new Map<string, RunEvent[]>();
  client: RemoteLinkClient | null = null;
  list() { return [...this.metas.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  get(id: string) { return this.metas.get(id) ?? null; }
  events(id: string) { return [...(this.evs.get(id) || [])]; }
  add(id: string, patch: Partial<RunMeta> = {}, events: RunEvent[] = []) {
    const meta = { id, status: "succeeded", startedAt: new Date().toISOString(), endedAt: null, turnStartedAt: null, prompt: `run ${id}`, ...patch } as RunMeta;
    this.metas.set(id, meta);
    this.evs.set(id, [...events]);
    this.client?.noteChange(meta);
    return meta;
  }
  set(id: string, patch: Partial<RunMeta>) {
    const meta = { ...this.metas.get(id)!, ...patch };
    this.metas.set(id, meta);
    this.client?.noteChange(meta);
  }
  append(id: string, ev: RunEvent) {
    const list = this.evs.get(id)!;
    list.push(ev);
    this.client?.noteEvent(this.metas.get(id)!, ev, list.length - 1);
  }
}

/** A computer: its own ledger (so its own machine id) and link token, unless given. */
function computer(url: string, opts: { on?: boolean; limits?: Partial<RemoteLinkLimits>; runs?: FakeRuns; timers?: Partial<RemoteLinkTimings>; execute?: RemoteExecutor; ledger?: string; token?: string } = {}) {
  const ledger = opts.ledger ?? tmp();
  const link = new HostedLink(ledger, () => url, { DASHBOARD_LINK_TOKEN: opts.token ?? new LinkTokens(tmp()).create(ANA, "Work laptop").token });
  link.retryMs = 10;
  if (opts.on !== false) link.setRemoteControl(true);
  const runs = opts.runs ?? new FakeRuns();
  const commands: string[] = [];
  const client = new RemoteLinkClient({
    link, runs, ledgerDir: ledger, timers: { ...TIMERS, ...opts.timers }, limits: opts.limits,
    execute: opts.execute ?? (async (cmd) => { commands.push(cmd.id); return { ok: false, error: "not yet supported" }; }),
  });
  runs.client = client;
  return { link, runs, client, commands, ledger, state: () => link.status().remoteControl };
}

const ev = (n: number, extra: Record<string, unknown> = {}): RunEvent => ({ type: "assistant", uuid: `e${n}`, n, ...extra });

/** What the client holds in memory (buffers, changed metas). */
const held = (c: RemoteLinkClient) => {
  const x = c as any;
  return { buffered: [...x.buffers.values()].reduce((n: number, b: any) => n + b.events.length, 0), dirty: x.dirty.size as number, reread: x.reread.size as number };
};

/** Every sync body that reached the gate, parsed. */
const syncBodies = () => {
  const bodies: SyncRequest[] = [];
  const record = (req: http.IncomingMessage, body: Buffer) => { if (req.url?.startsWith("/api/remote/sync")) bodies.push(JSON.parse(body.toString("utf-8"))); };
  return { bodies, record };
};

/** A fake hosted-dashboard viewer for mirror.subscribe. */
const viewer = () => Object.assign(new EventEmitter(), { chunks: [] as string[], write(s: string) { this.chunks.push(s); return true; } });

test("a new run appears on the mirror within about 2 s; the state says connected and when it last synced", async () => {
  const hosted = await pod(tmp());
  const c = computer(hosted.url);
  try {
    c.client.start();
    await waitFor("connected", () => c.state().state === "connected");
    c.runs.add("r-new", { status: "succeeded" }, [ev(0)]);
    const took = await waitFor("the run on the mirror", () => !!hosted.mirror.get("r-new"));
    assert.ok(took < 2000, `${took} ms`);
    assert.equal(hosted.mirror.get("r-new")!.remote!.label, "Work laptop");
    assert.deepEqual(hosted.mirror.events("r-new"), [], "a run nobody opened goes up as its meta only");
    await waitFor("lastSyncAt", () => !!c.state().lastSyncAt);
  } finally { c.client.stop(); await hosted.close(); }
});

test("the full sync on connect: the recent set only (7 days, not handed off to hosted, at most the cap)", async () => {
  const hosted = await pod(tmp());
  const runs = new FakeRuns();
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  runs.add("r-recent");
  runs.add("r-old", { startedAt: old });
  runs.add("r-hosted", { handedOffTo: "hosted", status: "handedOff" });
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("the recent run", () => !!hosted.mirror.get("r-recent"));
    await wait(100);
    assert.equal(hosted.mirror.get("r-old"), null);
    assert.equal(hosted.mirror.get("r-hosted"), null);
  } finally { c.client.stop(); await hosted.close(); }
});

test("a running run's events follow live through noteEvent", async () => {
  const hosted = await pod(tmp());
  const c = computer(hosted.url);
  try {
    c.runs.add("r-live", { status: "running" }, [ev(0)]);
    c.client.start();
    await waitFor("the first event", () => hosted.mirror.events("r-live").length === 1);
    for (let i = 1; i <= 5; i++) { c.runs.append("r-live", ev(i)); await wait(10); }
    await waitFor("all six", () => hosted.mirror.events("r-live").length === 6);
    assert.deepEqual(hosted.mirror.events("r-live"), c.runs.events("r-live"));
    // Ended: the tail still goes up.
    c.runs.append("r-live", ev(6));
    c.runs.set("r-live", { status: "succeeded" });
    await waitFor("the tail", () => hosted.mirror.events("r-live").length === 7);
    await waitFor("the finished meta", () => hosted.mirror.get("r-live")!.status === "succeeded");
  } finally { c.client.stop(); await hosted.close(); }
});

test("the hosted side killed mid-run and restarted on the same port (same ledger, a fresh RemoteMirror) loses and duplicates nothing", async () => {
  const podLedger = tmp();
  let hosted = await pod(podLedger);
  const port = hosted.port;
  const c = computer(hosted.url);
  try {
    c.runs.add("r-kill", { status: "running" });
    c.client.start();
    await waitFor("connected", () => c.state().state === "connected");
    let n = 0;
    for (; n < 15; n++) { c.runs.append("r-kill", ev(n, { pad: "x".repeat(200) })); await wait(8); }
    await hosted.close(); // mid-run, a sync quite possibly in flight
    for (; n < 30; n++) { c.runs.append("r-kill", ev(n, { pad: "x".repeat(200) })); await wait(8); }
    await waitFor("not connected", () => c.state().state !== "connected");
    hosted = await pod(podLedger, port);
    for (; n < 40; n++) { c.runs.append("r-kill", ev(n)); await wait(8); }
    await waitFor("all 40 on the new mirror", () => hosted.mirror.events("r-kill").length >= 40, 6000);
    await wait(150);
    assert.deepEqual(hosted.mirror.events("r-kill"), c.runs.events("r-kill"));
  } finally { c.client.stop(); await hosted.close(); }
});

test("a run opened on the hosted dashboard that isn't running is backfilled from the pod's count", async () => {
  const hosted = await pod(tmp());
  const runs = new FakeRuns();
  runs.add("r-old", { status: "succeeded" }, [ev(0), ev(1), ev(2), ev(3)]);
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("its meta", () => !!hosted.mirror.get("r-old"));
    await wait(100);
    assert.deepEqual(hosted.mirror.events("r-old"), [], "nothing until it's opened");
    const res = viewer();
    assert.ok(hosted.mirror.subscribe("r-old", res as any));
    await waitFor("the backfill", () => hosted.mirror.events("r-old").length === 4);
    assert.deepEqual(hosted.mirror.events("r-old"), runs.events("r-old"));
    await waitFor("the viewer got them live", () => res.chunks.filter((x) => x.includes("event: event\n")).length === 4);
  } finally { c.client.stop(); await hosted.close(); }
});

test("a 401 stops reconnecting: state refused, one request", async () => {
  const hosted = await refusing(401);
  const c = computer(hosted.url);
  try {
    c.client.start();
    await waitFor("refused", () => c.state().state === "refused");
    assert.match(c.state().message || "", /Link token refused/);
    await wait(400);
    assert.equal(hosted.requests.length, 1);
    // A new token (main.ts restarts it) tries again.
    c.client.restart();
    await waitFor("a second try", () => hosted.requests.length === 2);
  } finally { c.client.stop(); await hosted.close(); }
});

test("a 404 or a 409 says why and retries slowly", async () => {
  for (const [status, why] of [[404, /older version/], [409, /Another computer/]] as const) {
    const hosted = await refusing(status);
    const c = computer(hosted.url);
    try {
      c.client.start();
      await waitFor(`error for ${status}`, () => c.state().state === "error");
      assert.match(c.state().message || "", why);
      await waitFor("a slow retry", () => hosted.requests.length >= 2, 2000);
    } finally { c.client.stop(); await hosted.close(); }
  }
});

test("switched on without a token: state error, no request", async () => {
  const hosted = await refusing(500);
  const link = new HostedLink(tmp(), () => hosted.url, {});
  link.setRemoteControl(true);
  const client = new RemoteLinkClient({ link, runs: new FakeRuns(), ledgerDir: tmp(), timers: TIMERS, execute: async () => ({ ok: true }) });
  try {
    client.start();
    assert.equal(link.status().remoteControl.state, "error");
    assert.match(link.status().remoteControl.message || "", /isn't linked yet/);
    await wait(150);
    assert.equal(hosted.requests.length, 0);
  } finally { client.stop(); await hosted.close(); }
});

test("with the switch off, the client makes no request", async () => {
  const hosted = await pod(tmp());
  const c = computer(hosted.url, { on: false });
  try {
    c.runs.add("r1", { status: "running" });
    c.client.start();
    c.runs.append("r1", ev(0));
    await wait(200);
    assert.deepEqual(hosted.requests, []);
    assert.equal(c.state().state, "off");
  } finally { c.client.stop(); await hosted.close(); }
});

test("off: a last sync marks the mirror disabled, then nothing more", async () => {
  const hosted = await pod(tmp());
  const c = computer(hosted.url);
  try {
    c.runs.add("r1");
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get("r1"));
    c.link.setRemoteControl(false);
    await c.client.turnOff();
    assert.equal(hosted.mirror.linkStatus(LAPTOP.id)!.enabled, false);
    assert.throws(() => hosted.mirror.command("r1", "queue", { text: "hi" }), /off on Work laptop/);
    const before = hosted.requests.length;
    await wait(200);
    assert.equal(hosted.requests.length, before);
  } finally { c.client.stop(); await hosted.close(); }
});

test("an event too big for any sync becomes an omitted placeholder at its index; one too big for a batch goes alone", async () => {
  const hosted = await pod(tmp());
  const c = computer(hosted.url, { limits: { eventsMaxBytes: 2000, maxBytes: 8000 } });
  try {
    c.runs.add("r-big", { status: "running" });
    c.client.start();
    await waitFor("connected", () => c.state().state === "connected");
    c.runs.append("r-big", ev(0));
    c.runs.append("r-big", ev(1, { text: "b".repeat(3000) })); // over a batch, under a body
    c.runs.append("r-big", ev(2, { text: "h".repeat(20_000) })); // over any body
    c.runs.append("r-big", ev(3));
    await waitFor("four on the mirror", () => hosted.mirror.events("r-big").length === 4);
    const got = hosted.mirror.events("r-big");
    assert.deepEqual(got[0], ev(0));
    assert.deepEqual(got[1], c.runs.events("r-big")[1]);
    assert.equal(got[2].type, "omitted");
    assert.equal(got[2].reason, "too-large");
    assert.equal(got[2].uuid, "e2");
    assert.ok(got[2].bytes > 20_000);
    assert.deepEqual(got[3], ev(3));
  } finally { c.client.stop(); await hosted.close(); }
});

test("a 413 is never retried unchanged: the batch halves, and a lone event still refused goes as a placeholder", async () => {
  const syncSizes: number[] = [];
  const hosted = await pod(tmp(), 0, (req, body) => {
    if (!req.url?.startsWith("/api/remote/sync")) return null;
    syncSizes.push(body.length);
    return body.length > 4000 ? { status: 413 } : null;
  });
  const runs = new FakeRuns();
  runs.add("r-413", { status: "running" }, [
    ...Array.from({ length: 8 }, (_, i) => ev(i, { pad: "p".repeat(800) })),
    ev(8, { pad: "q".repeat(6000) }),
    ev(9),
  ]);
  const c = computer(hosted.url, { runs, limits: { eventsMaxBytes: 50_000, maxBytes: 100_000 } });
  try {
    c.client.start();
    await waitFor("all ten", () => hosted.mirror.events("r-413").length === 10, 5000);
    const got = hosted.mirror.events("r-413");
    assert.deepEqual(got.slice(0, 8), runs.events("r-413").slice(0, 8));
    assert.equal(got[8].type, "omitted");
    assert.deepEqual(got[9], ev(9));
    assert.ok(syncSizes.length < 30, `${syncSizes.length} syncs`);
  } finally { c.client.stop(); await hosted.close(); }
});

test("a stopped client's late callbacks leave the state alone", async () => {
  let holdSync = false;
  const hosted = await pod(tmp(), 0, (req) => (holdSync && req.url?.startsWith("/api/remote/sync") ? { delayMs: 300 } : null));
  const c = computer(hosted.url);
  try {
    c.runs.add("r1");
    c.client.start();
    await waitFor("connected", () => c.state().state === "connected" && !!c.state().lastSyncAt);
    holdSync = true;
    c.runs.add("r2"); // a sync goes out and is held
    await wait(80);
    c.client.stop();
    const sentinel = { state: "connecting" as const, message: "sentinel", lastSyncAt: null };
    c.link.setRemoteState(sentinel);
    await wait(600); // the held sync answers; the stream's end comes back
    assert.deepEqual({ ...c.state(), on: undefined }, { ...sentinel, on: undefined });
  } finally { c.client.stop(); await hosted.close(); }
});

test("a meta changed in place while a sync with it waits for its answer still goes up after that answer", async () => {
  // RunManager hands noteChange its own meta and changes that object in place on the next write.
  let holdSync = false;
  const seen = syncBodies();
  const hosted = await pod(tmp(), 0, (req, body) => {
    seen.record(req, body);
    return holdSync && req.url?.startsWith("/api/remote/sync") ? { delayMs: 300 } : null;
  });
  const c = computer(hosted.url);
  try {
    c.runs.add("r-turn", { status: "succeeded" });
    c.client.start();
    await waitFor("synced", () => hosted.mirror.get("r-turn")?.status === "succeeded");
    holdSync = true;
    c.runs.set("r-turn", { status: "running" }); // a turn starts: this sync is held
    await waitFor("the running meta sent", () => seen.bodies.some((b) => b.runs.some((r) => r.id === "r-turn" && r.status === "running")));
    const live = c.runs.metas.get("r-turn")!;
    live.status = "succeeded"; // the turn ends: the same object, written again
    live.endedAt = new Date().toISOString();
    c.client.noteChange(live);
    holdSync = false;
    await waitFor("the finished meta on the mirror", () => hosted.mirror.get("r-turn")?.status === "succeeded" && !!hosted.mirror.get("r-turn")?.endedAt);
  } finally { c.client.stop(); await hosted.close(); }
});

test("a command from the hosted dashboard goes to the (stub) executor and is acked; its refusal shows as lastError", async () => {
  const hosted = await pod(tmp());
  const c = computer(hosted.url);
  try {
    c.runs.add("r-cmd", { status: "succeeded" });
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get("r-cmd"));
    const run = hosted.mirror.command("r-cmd", "reply", { text: "hello" });
    assert.equal(run.remote!.pending.length, 1);
    await waitFor("acked", () => hosted.mirror.get("r-cmd")!.remote!.pending.length === 0);
    assert.equal(c.commands.length, 1);
    assert.equal(hosted.mirror.get("r-cmd")!.remote!.lastError?.message, "not yet supported");
    assert.equal(hosted.mirror.get("r-cmd")!.remote!.lastError?.kind, "reply");
  } finally { c.client.stop(); await hosted.close(); }
});

test("commands run one at a time, in the order they came", async () => {
  const hosted = await pod(tmp());
  const order: string[] = [];
  const c = computer(hosted.url, {
    execute: async (cmd) => {
      order.push(`start ${cmd.payload.text}`);
      await wait(cmd.payload.text === "one" ? 150 : 0);
      order.push(`end ${cmd.payload.text}`);
      return { ok: true };
    },
  });
  try {
    c.runs.add("r-cmd");
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get("r-cmd"));
    hosted.mirror.command("r-cmd", "queue", { text: "one" });
    hosted.mirror.command("r-cmd", "queue", { text: "two" });
    await waitFor("both ran", () => order.length === 4);
    assert.deepEqual(order, ["start one", "end one", "start two", "end two"]);
  } finally { c.client.stop(); await hosted.close(); }
});

test("nothing is held while the switch is off or the link is down; the next hello recovers from the files", async () => {
  // Off: noteEvent and noteChange hold nothing.
  const hosted = await pod(tmp());
  const c = computer(hosted.url, { on: false });
  try {
    c.runs.add("r1", { status: "running" });
    c.client.start();
    for (let i = 0; i < 3000; i++) c.runs.append("r1", ev(i));
    c.runs.set("r1", { prompt: "changed" });
    assert.deepEqual(held(c.client), { buffered: 0, dirty: 0, reread: 0 });
    // Switched on: the run and all its events come from the full sync and its file.
    c.link.setRemoteControl(true);
    c.client.start();
    await waitFor("all of them", () => hosted.mirror.events("r1").length === 3000, 5000);
    assert.deepEqual(hosted.mirror.events("r1"), c.runs.events("r1"));
    assert.equal(hosted.mirror.get("r1")!.prompt, "changed");
  } finally { c.client.stop(); await hosted.close(); }

  // On, but the hosted side won't hold the link (500): running, never connected, nothing grows.
  const down = await refusing(500);
  const d = computer(down.url);
  try {
    d.runs.add("r1", { status: "running" });
    d.client.start();
    await waitFor("an error", () => d.state().state === "error");
    for (let i = 0; i < 3000; i++) d.runs.append("r1", ev(i));
    d.runs.set("r1", { prompt: "changed" });
    assert.deepEqual(held(d.client), { buffered: 0, dirty: 0, reread: 0 });
  } finally { d.client.stop(); await down.close(); }
});

test("a reset is a network retry for a small event: it arrives intact once the resets stop", async () => {
  let resets = 0;
  const hosted = await pod(tmp(), 0, (req, body) => {
    if (!req.url?.startsWith("/api/remote/sync") || !body.includes('"events":[{')) return null;
    return resets++ < 5 ? { reset: true } : null;
  });
  const c = computer(hosted.url);
  try {
    c.runs.add("r-small", { status: "running" }, [ev(0, { t: "a small one" })]);
    c.client.start();
    await waitFor("the event", () => hosted.mirror.events("r-small").length === 1, 6000);
    assert.ok(resets >= 5);
    assert.deepEqual(hosted.mirror.events("r-small"), c.runs.events("r-small"));
  } finally { c.client.stop(); await hosted.close(); }
});

test("a big event (256 KB or more) that is still cut off when it goes alone, 3 times, becomes a too-large placeholder", async () => {
  const hosted = await pod(tmp(), 0, (req, body) => (req.url?.startsWith("/api/remote/sync") && body.length > 200_000 ? { reset: true } : null));
  const c = computer(hosted.url);
  try {
    c.runs.add("r-huge", { status: "running" }, [ev(0), ev(1, { text: "h".repeat(300_000) }), ev(2)]);
    c.client.start();
    await waitFor("all three", () => hosted.mirror.events("r-huge").length === 3, 8000);
    const got = hosted.mirror.events("r-huge");
    assert.deepEqual(got[0], ev(0));
    assert.equal(got[1].type, "omitted");
    assert.equal(got[1].reason, "too-large");
    assert.equal(got[1].uuid, "e1");
    assert.ok(got[1].bytes > 300_000);
    assert.deepEqual(got[2], ev(2));
  } finally { c.client.stop(); await hosted.close(); }
});

test("an event the pod would refuse goes as an invalid placeholder; the rest of its run and other runs arrive intact", async () => {
  const rec = syncBodies();
  const hosted = await pod(tmp(), 0, (req, body) => { rec.record(req, body); return null; });
  const runs = new FakeRuns();
  runs.add("r-bad", { status: "running" }, [ev(0), "not an event" as any, [1, 2] as any, { n: 3 } as any, null as any, ev(5)]);
  runs.add("r-ok", { status: "running" }, [ev(0), ev(1)]);
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("both runs", () => hosted.mirror.events("r-bad").length === 6 && hosted.mirror.events("r-ok").length === 2);
    const got = hosted.mirror.events("r-bad");
    assert.deepEqual(got[0], ev(0));
    for (const i of [1, 2, 3, 4]) {
      assert.equal(got[i].type, "omitted");
      assert.equal(got[i].reason, "invalid");
      assert.equal(got[i].bytes, Buffer.byteLength(JSON.stringify(runs.events("r-bad")[i])));
    }
    assert.deepEqual(got[5], ev(5));
    assert.deepEqual(hosted.mirror.events("r-ok"), runs.events("r-ok"));
  } finally { c.client.stop(); await hosted.close(); }
});

test("a pod that refuses (400) a sync once and then takes it: no placeholders at all", async () => {
  let refused = 0;
  const hosted = await pod(tmp(), 0, (req, body) => (req.url?.startsWith("/api/remote/sync") && body.includes('"events":[{') && refused++ === 0 ? { status: 400 } : null));
  const runs = new FakeRuns();
  runs.add("r-a", { status: "running" }, [ev(0), ev(1)]);
  runs.add("r-b", { status: "running" }, [ev(0), ev(1), ev(2)]);
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("both runs", () => hosted.mirror.events("r-a").length === 2 && hosted.mirror.events("r-b").length === 3);
    assert.equal(refused >= 1, true);
    assert.deepEqual(hosted.mirror.events("r-a"), runs.events("r-a"));
    assert.deepEqual(hosted.mirror.events("r-b"), runs.events("r-b"));
  } finally { c.client.stop(); await hosted.close(); }
});

test("a 400 that keeps coming: each run goes alone, and only the run still refused alone gets invalid placeholders", async () => {
  const hosted = await pod(tmp(), 0, (req, body) => (req.url?.startsWith("/api/remote/sync") && body.includes("poison") ? { status: 400 } : null));
  const runs = new FakeRuns();
  runs.add("r-a", { status: "running" }, [ev(0), ev(1, { poison: true }), ev(2)]);
  runs.add("r-b", { status: "running" }, [ev(0), ev(1)]);
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("both runs", () => hosted.mirror.events("r-a").length === 3 && hosted.mirror.events("r-b").length === 2, 5000);
    assert.deepEqual(hosted.mirror.events("r-b"), runs.events("r-b"));
    for (const e of hosted.mirror.events("r-a")) { assert.equal(e.type, "omitted"); assert.equal(e.reason, "invalid"); }
    assert.deepEqual(hosted.mirror.events("r-a").map((e) => e.uuid), ["e0", "e1", "e2"]);
  } finally { c.client.stop(); await hosted.close(); }
});

test("the full sync carries the newest runs that fit in one body; a later change outside that boundary prunes nothing", async () => {
  const rec = syncBodies();
  const hosted = await pod(tmp(), 0, (req, body) => { rec.record(req, body); return null; });
  const runs = new FakeRuns();
  for (let i = 0; i < 10; i++) runs.add(`r${i}`, { startedAt: new Date(Date.now() - i * 60_000).toISOString(), prompt: "p".repeat(1500) });
  const c = computer(hosted.url, { runs, limits: { maxBytes: 8000, eventsMaxBytes: 2000 } });
  try {
    c.client.start();
    await waitFor("the full sync", () => rec.bodies.some((b) => b.full) && !!hosted.mirror.get("r0"));
    const full = rec.bodies.find((b) => b.full)!;
    const n = full.runs.length;
    assert.ok(n >= 1 && n < 10, `${n} runs`);
    assert.deepEqual(full.runs.map((r) => r.id), Array.from({ length: n }, (_, i) => `r${i}`), "the newest, in order");
    const inside = () => Array.from({ length: n }, (_, i) => `r${i}`).every((id) => !!hosted.mirror.get(id));
    assert.ok(inside());
    // A change inside the boundary goes up; one outside it (no new activity) doesn't, and no full sync follows.
    runs.set("r0", { prompt: "changed" });
    runs.set(`r${n + 1}`, { prompt: "changed too" });
    await waitFor("the change", () => hosted.mirror.get("r0")!.prompt === "changed");
    await wait(150);
    assert.equal(hosted.mirror.get(`r${n + 1}`), null);
    assert.ok(inside());
    assert.equal(rec.bodies.filter((b) => b.full).length, 1);
  } finally { c.client.stop(); await hosted.close(); }
});

test("a 413 on a full sync halves its byte boundary and builds the set again: the pod gets the newest that fit", async () => {
  const rec = syncBodies();
  const hosted = await pod(tmp(), 0, (req, body) => { rec.record(req, body); return req.url?.startsWith("/api/remote/sync") && body.length > 6000 ? { status: 413 } : null; });
  const runs = new FakeRuns();
  for (let i = 0; i < 10; i++) runs.add(`r${i}`, { startedAt: new Date(Date.now() - i * 60_000).toISOString(), prompt: "p".repeat(1500) });
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("connected and synced", () => !!c.state().lastSyncAt, 5000);
    const fulls = rec.bodies.filter((b) => b.full);
    assert.ok(fulls.length > 1);
    const n = fulls[fulls.length - 1].runs.length;
    assert.ok(n >= 1 && n < 10);
    for (let i = 0; i < 10; i++) assert.equal(!!hosted.mirror.get(`r${i}`), i < n, `r${i}`);
  } finally { c.client.stop(); await hosted.close(); }
});

test("between full syncs, a new run past the cap brings a full sync, so the pod keeps only the newest", async () => {
  const rec = syncBodies();
  const hosted = await pod(tmp(), 0, (req, body) => { rec.record(req, body); return null; });
  const runs = new FakeRuns();
  for (let i = 1; i <= 3; i++) runs.add(`r${i}`, { startedAt: new Date(Date.now() - (10 - i) * 60_000).toISOString() });
  const c = computer(hosted.url, { runs, timers: { recentMax: 3 } });
  try {
    c.client.start();
    await waitFor("three", () => ["r1", "r2", "r3"].every((id) => !!hosted.mirror.get(id)));
    runs.add("r4");
    await waitFor("r4, and r1 pruned", () => !!hosted.mirror.get("r4") && !hosted.mirror.get("r1"));
    assert.ok(!!hosted.mirror.get("r2") && !!hosted.mirror.get("r3"));
    assert.equal(rec.bodies.filter((b) => b.full).length, 2);
    assert.deepEqual(rec.bodies.filter((b) => b.full)[1].runs.map((r) => r.id), ["r4", "r3", "r2"]);
  } finally { c.client.stop(); await hosted.close(); }
});

test("after the full sync, a sync carries only the metas that changed, and a heartbeat with nothing new carries none", async () => {
  const rec = syncBodies();
  const hosted = await pod(tmp(), 0, (req, body) => { rec.record(req, body); return null; });
  const runs = new FakeRuns();
  for (const id of ["r1", "r2", "r3"]) runs.add(id);
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("the full sync", () => !!c.state().lastSyncAt);
    const start = rec.bodies.length;
    runs.set("r2", { prompt: "changed" });
    await waitFor("the change", () => hosted.mirror.get("r2")!.prompt === "changed");
    await waitFor("a heartbeat after it", () => {
      const later = rec.bodies.slice(start);
      const i = later.findIndex((b) => b.runs.length);
      return i >= 0 && later.slice(i + 1).length > 0;
    }, 2000);
    const later = rec.bodies.slice(start);
    assert.ok(later.every((b) => !b.full));
    const withMetas = later.filter((b) => b.runs.length);
    assert.deepEqual(withMetas.map((b) => b.runs.map((r) => r.id)), [["r2"]]);
    assert.deepEqual(later[later.length - 1].runs, []);
  } finally { c.client.stop(); await hosted.close(); }
});

test("watch and unwatch during a connection: a run's events go up while it's open, and not after", async () => {
  const hosted = await pod(tmp(), 0, undefined, { unwatchGraceMs: 20 });
  const runs = new FakeRuns();
  runs.add("r-w", { status: "succeeded" }, [ev(0), ev(1)]);
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("its meta", () => !!hosted.mirror.get("r-w"));
    const res = viewer();
    assert.ok(hosted.mirror.subscribe("r-w", res as any));
    await waitFor("the backfill", () => hosted.mirror.events("r-w").length === 2);
    runs.append("r-w", ev(2));
    await waitFor("live while watched", () => hosted.mirror.events("r-w").length === 3);
    res.emit("close");
    await waitFor("unwatched", () => !(c.client as any).watch.has("r-w"));
    runs.append("r-w", ev(3));
    await wait(200);
    assert.equal(hosted.mirror.events("r-w").length, 3, "not open, not running: nothing goes up");
    // Opened again: from the pod's count, out of the file.
    const again = viewer();
    assert.ok(hosted.mirror.subscribe("r-w", again as any));
    await waitFor("the rest", () => hosted.mirror.events("r-w").length === 4);
    assert.deepEqual(hosted.mirror.events("r-w"), runs.events("r-w"));
  } finally { c.client.stop(); await hosted.close(); }
});

test("hello.watch replaces the watch set: a run open before the reconnect but not after isn't streamed", async () => {
  const hosted = await pod(tmp(), 0, undefined, { unwatchGraceMs: 20 });
  const runs = new FakeRuns();
  runs.add("r1", { status: "succeeded" }, [ev(0)]);
  runs.add("r2", { status: "succeeded" }, [ev(0)]);
  const c = computer(hosted.url, { runs });
  try {
    c.client.start();
    await waitFor("both metas", () => !!hosted.mirror.get("r1") && !!hosted.mirror.get("r2"));
    const a = viewer();
    assert.ok(hosted.mirror.subscribe("r1", a as any));
    await waitFor("r1 backfilled", () => hosted.mirror.events("r1").length === 1);
    // While the computer is away, r1 is closed and r2 opened.
    c.client.stop();
    a.emit("close");
    await wait(60);
    const b = viewer();
    assert.ok(hosted.mirror.subscribe("r2", b as any));
    c.client.start();
    await waitFor("r2 backfilled", () => hosted.mirror.events("r2").length === 1);
    runs.append("r1", ev(1));
    runs.append("r2", ev(1));
    await waitFor("r2 live", () => hosted.mirror.events("r2").length === 2);
    await wait(150);
    assert.equal(hosted.mirror.events("r1").length, 1, "r1 isn't watched any more");
  } finally { c.client.stop(); await hosted.close(); }
});

test("failed syncs (a 5xx) back off, doubling up to the heartbeat, and a success resets it", async () => {
  let failing = true, syncs = 0;
  const hosted = await pod(tmp(), 0, (req) => {
    if (!req.url?.startsWith("/api/remote/sync")) return null;
    syncs++;
    return failing ? { status: 500 } : null;
  });
  const c = computer(hosted.url);
  try {
    c.runs.add("r1");
    c.client.start();
    await waitFor("connected", () => c.state().state === "connected");
    await wait(900);
    assert.ok(syncs <= 10, `${syncs} syncs in 900 ms (a tick is 30 ms)`);
    failing = false;
    await waitFor("synced", () => !!hosted.mirror.get("r1"), 1000);
    c.runs.add("r2");
    const took = await waitFor("the next one", () => !!hosted.mirror.get("r2"), 1000);
    assert.ok(took < 200, `${took} ms`);
  } finally { c.client.stop(); await hosted.close(); }
});

test("turnOff with a sync in flight returns within offTimeoutMs", async () => {
  let hold = false;
  const hosted = await pod(tmp(), 0, (req) => (hold && req.url?.startsWith("/api/remote/sync") ? { delayMs: 3000 } : null));
  const c = computer(hosted.url, { timers: { offTimeoutMs: 300 } });
  try {
    c.runs.add("r1");
    c.client.start();
    await waitFor("synced", () => !!c.state().lastSyncAt);
    hold = true;
    c.runs.add("r2");
    await wait(80); // its sync is held
    c.link.setRemoteControl(false);
    const t0 = Date.now();
    await c.client.turnOff();
    const took = Date.now() - t0;
    assert.ok(took < 600, `${took} ms`);
  } finally { c.client.stop(); await hosted.close(); }
});

test("switched back on while turnOff waits: the late off sync isn't sent; one already retrying 503s is aborted", async () => {
  const rec = syncBodies();
  let hold = false, refuseOff = false;
  const hosted = await pod(tmp(), 0, (req, body) => {
    rec.record(req, body);
    if (!req.url?.startsWith("/api/remote/sync")) return null;
    if (refuseOff && JSON.parse(body.toString("utf-8")).off) return { status: 503 };
    return hold ? { delayMs: 200 } : null;
  });
  const c = computer(hosted.url);
  try {
    c.runs.add("r1");
    c.client.start();
    await waitFor("synced", () => !!c.state().lastSyncAt);
    hold = true;
    c.runs.add("r2");
    await wait(60); // its sync is held
    c.link.setRemoteControl(false);
    const off = c.client.turnOff();
    c.link.setRemoteControl(true);
    hold = false;
    c.client.start();
    await off;
    await waitFor("connected again", () => c.state().state === "connected" && !!hosted.mirror.get("r2"));
    await wait(100);
    assert.equal(rec.bodies.some((b) => b.off), false);
    assert.equal(hosted.mirror.linkStatus(LAPTOP.id)!.enabled, true);

    // Now the off sync is sent, and the hosted dashboard 503s it (starting up) until after the
    // new connection's full sync. Switching back on (main.ts restarts) aborts its retries.
    c.link.retryMs = 100; // 12 retries: over a second of them, past the new full sync
    refuseOff = true;
    c.link.setRemoteControl(false);
    const off2 = c.client.turnOff();
    await waitFor("the off sync refused", () => rec.bodies.some((b) => b.off));
    c.link.setRemoteControl(true);
    const before = rec.bodies.length;
    c.client.restart();
    await waitFor("the new connection's full sync", () => rec.bodies.slice(before).some((b) => b.full && !b.off) && c.state().state === "connected");
    await wait(60); // that full sync has landed
    refuseOff = false;
    const offs = rec.bodies.filter((b) => b.off).length;
    await off2; // ended at once: aborted
    await wait(400); // several retryMs: a retry still going would land now
    assert.equal(rec.bodies.filter((b) => b.off).length, offs, "no off sync after the switch went back on");
    assert.equal(hosted.mirror.linkStatus(LAPTOP.id)!.enabled, true);
  } finally { c.client.stop(); await hosted.close(); }
});

// ------------------------------------------------------------ carry-forwards from the Step 3b review

test("a command queued behind a slow one isn't run once the client stops; after a restart it runs, and the slow one isn't run again", async () => {
  const hosted = await pod(tmp());
  const order: string[] = [];
  const c = computer(hosted.url, {
    execute: async (cmd) => {
      order.push(`start ${cmd.payload.text}`);
      await wait(cmd.payload.text === "one" ? 200 : 0);
      order.push(`end ${cmd.payload.text}`);
      return { ok: true };
    },
  });
  try {
    c.runs.add("r-cmd");
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get("r-cmd"));
    hosted.mirror.command("r-cmd", "queue", { text: "one" });
    hosted.mirror.command("r-cmd", "queue", { text: "two" });
    await waitFor("one started", () => order.includes("start one"));
    c.client.stop();
    await wait(400);
    assert.deepEqual(order, ["start one", "end one"], "two never ran");
    assert.equal(hosted.mirror.get("r-cmd")!.remote!.pending.length, 2, "neither was acked after the stop");
    // On again: the hosted side re-sends both; one is re-acked from the store, two runs.
    c.client.start();
    await waitFor("both acked", () => hosted.mirror.get("r-cmd")!.remote!.pending.length === 0);
    assert.deepEqual(order, ["start one", "end one", "start two", "end two"]);
  } finally { c.client.stop(); await hosted.close(); }
});

test("only resets of a big event sent alone count towards its placeholder: with smaller ones behind it, it takes 3 lone resets", async () => {
  const resets: number[] = []; // events in each sync that was cut off
  const hosted = await pod(tmp(), 0, (req, body) => {
    if (!req.url?.startsWith("/api/remote/sync") || body.length <= 200_000) return null;
    resets.push((JSON.parse(body.toString("utf-8")) as SyncRequest).events.reduce((n, b) => n + b.events.length, 0));
    return { reset: true };
  });
  const c = computer(hosted.url);
  try {
    const small = Array.from({ length: 20 }, (_, i) => ev(i + 1));
    c.runs.add("r-big", { status: "running" }, [ev(0, { text: "h".repeat(300_000) }), ...small]);
    c.client.start();
    await waitFor("all of them", () => hosted.mirror.events("r-big").length === 21, 8000);
    const got = hosted.mirror.events("r-big");
    assert.equal(got[0].type, "omitted");
    assert.equal(got[0].reason, "too-large");
    assert.deepEqual(got.slice(1), small);
    assert.ok(resets.some((n) => n > 1), `resets with others in the sync first: ${resets}`);
    assert.equal(resets.filter((n) => n === 1).length, 3, `resets: ${resets}`);
  } finally { c.client.stop(); await hosted.close(); }
});

test("a sync in flight when the link drops is aborted: its connection closes at once, and the next connection's full sync isn't held up", async () => {
  let hang = false, closedAt = 0;
  const fullAt: number[] = [];
  const hosted = await pod(tmp(), 0, (req, body) => {
    if (!req.url?.startsWith("/api/remote/sync")) return null;
    if ((JSON.parse(body.toString("utf-8")) as SyncRequest).full) fullAt.push(Date.now());
    if (hang) {
      hang = false;
      req.socket.once("close", () => { closedAt = Date.now(); });
      return { delayMs: 2500, status: 503 }; // held under syncTimeoutMs (3000), and never applied
    }
    return null;
  });
  const c = computer(hosted.url);
  try {
    c.runs.add("r1");
    c.client.start();
    await waitFor("synced", () => !!c.state().lastSyncAt);
    hang = true;
    c.runs.add("r2");
    await waitFor("its sync held", () => !hang);
    const t0 = Date.now();
    (c.client as any).abort.abort(); // the link drops: the client reconnects
    await waitFor("the held sync's connection closed", () => closedAt > 0, 1000);
    assert.ok(closedAt - t0 < 500, `${closedAt - t0} ms`);
    await waitFor("the next connection's full sync", () => fullAt.some((t) => t > t0), 3000);
    const took = fullAt.find((t) => t > t0)! - t0;
    assert.ok(took < 1000, `${took} ms`);
    await waitFor("r2", () => !!hosted.mirror.get("r2"), 1000);
  } finally { c.client.stop(); await hosted.close(); }
});

/** A pod that answers 503 to every sync that isn't full or off while `stall` is on; `applied` has the bodies it took, in order. */
async function stallingPod() {
  const s = { stall: false, refused: 0, applied: [] as SyncRequest[] };
  const hosted = await pod(tmp(), 0, (req, body) => {
    if (!req.url?.startsWith("/api/remote/sync")) return null;
    const b = JSON.parse(body.toString("utf-8")) as SyncRequest;
    if (s.stall && !b.full && !b.off) { s.refused++; return { status: 503 }; }
    s.applied.push(b);
    return null;
  });
  return Object.assign(s, { hosted });
}

test("a sync from a dropped connection, held by 503s at the pod, never lands after the next connection's full sync", async () => {
  const p = await stallingPod();
  const c = computer(p.hosted.url);
  c.link.retryMs = 100; // 12 retries: about 1.2 s of them
  try {
    c.runs.add("r1");
    c.client.start();
    await waitFor("synced", () => !!c.state().lastSyncAt);
    p.stall = true;
    c.runs.add("r2", { status: "running" });
    await waitFor("its sync refused twice", () => p.refused >= 2);
    c.runs.set("r2", { status: "succeeded" }); // it finished while that sync was held
    const before = p.applied.length;
    (c.client as any).abort.abort(); // the link drops
    await waitFor("the next connection's full sync, with r2 finished", () => p.hosted.mirror.get("r2")?.status === "succeeded");
    p.stall = false; // a retry of the old sync would go through now
    await wait(1500); // past the old sync's 503 retries
    assert.equal(p.hosted.mirror.get("r2")!.status, "succeeded", "not reverted to running");
    assert.deepEqual(p.applied.slice(before).filter((b) => b.runs.some((r) => r.id === "r2" && r.status === "running")), []);
  } finally { c.client.stop(); await p.hosted.close(); }
});

test("after turnOff, a sync that was in flight never turns the link back on", async () => {
  // Held by 503s on this connection: turnOff aborts it and sends the off sync without waiting it out.
  const p = await stallingPod();
  const c = computer(p.hosted.url, { timers: { offTimeoutMs: 500 } });
  c.link.retryMs = 100;
  try {
    c.runs.add("r1");
    c.client.start();
    await waitFor("synced", () => !!c.state().lastSyncAt);
    p.stall = true;
    c.runs.add("r2");
    await waitFor("its sync refused", () => p.refused >= 1);
    c.link.setRemoteControl(false);
    const t0 = Date.now();
    await c.client.turnOff();
    assert.ok(Date.now() - t0 < 400, `${Date.now() - t0} ms`);
    assert.equal(p.hosted.mirror.linkStatus(LAPTOP.id)!.enabled, false, "the off sync went");
    p.stall = false;
    await wait(1500); // past the held sync's 503 retries
    assert.equal(p.hosted.mirror.linkStatus(LAPTOP.id)!.enabled, false);
    assert.equal(p.applied.at(-1)!.off, true, "nothing landed after the off sync");
  } finally { c.client.stop(); await p.hosted.close(); }

  // Held on a connection that has since dropped, with the next one's full sync done: still nothing after the off sync.
  const q = await stallingPod();
  const d = computer(q.hosted.url);
  d.link.retryMs = 100;
  try {
    d.runs.add("r1");
    d.client.start();
    await waitFor("synced", () => !!d.state().lastSyncAt);
    q.stall = true;
    d.runs.add("r2");
    await waitFor("its sync refused", () => q.refused >= 1);
    const fulls = q.applied.filter((b) => b.full).length;
    (d.client as any).abort.abort(); // the link drops
    await waitFor("the next connection's full sync", () => q.applied.filter((b) => b.full).length > fulls);
    d.link.setRemoteControl(false);
    await d.client.turnOff();
    assert.equal(q.hosted.mirror.linkStatus(LAPTOP.id)!.enabled, false);
    q.stall = false;
    await wait(1500);
    assert.equal(q.hosted.mirror.linkStatus(LAPTOP.id)!.enabled, false);
    assert.equal(q.applied.at(-1)!.off, true, "nothing landed after the off sync");
  } finally { d.client.stop(); await q.hosted.close(); }
});

test("an ack that hangs doesn't hold up the next command", async () => {
  let hangFirst = true;
  const hosted = await pod(tmp(), 0, (req) => {
    if (!req.url?.startsWith("/api/remote/ack") || !hangFirst) return null;
    hangFirst = false;
    return { delayMs: 1500 };
  });
  const startedAt: Record<string, number> = {};
  const c = computer(hosted.url, { execute: async (cmd) => { startedAt[cmd.payload.text as string] = Date.now(); return { ok: true }; } });
  try {
    c.runs.add("r-cmd");
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get("r-cmd"));
    hosted.mirror.command("r-cmd", "queue", { text: "one" });
    hosted.mirror.command("r-cmd", "queue", { text: "two" });
    await waitFor("two ran", () => !!startedAt.two);
    assert.ok(startedAt.two - startedAt.one < 500, `${startedAt.two - startedAt.one} ms`);
    await waitFor("both acked", () => hosted.mirror.get("r-cmd")!.remote!.pending.length === 0, 4000);
  } finally { c.client.stop(); await hosted.close(); }
});

test("Forget keeps the finished commands: after a re-link, a re-delivered one is re-acked, not run again", async () => {
  let dropAcks = true;
  const hosted = await pod(tmp(), 0, (req) => (dropAcks && req.url?.startsWith("/api/remote/ack") ? { reset: true } : null));
  const ran: string[] = [];
  const execute: RemoteExecutor = async (cmd) => { ran.push(cmd.id); return { ok: true }; };
  const c = computer(hosted.url, { execute });
  let again: RemoteLinkClient | null = null;
  try {
    c.runs.add("r-cmd");
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get("r-cmd"));
    const cmd = hosted.mirror.command("r-cmd", "queue", { text: "once" }).remote!.pending[0];
    await waitFor("it ran", () => ran.length === 1);
    await wait(100);
    assert.equal(hosted.mirror.get("r-cmd")!.remote!.pending.length, 1, "its ack was lost");
    c.client.stop();
    c.link.forget();
    assert.equal(fs.existsSync(path.join(c.ledger, "hosted-link")), false);
    // Linked again (the token here comes from the environment) and switched on: a new client on the same ledger.
    c.link.setRemoteControl(true);
    dropAcks = false;
    again = new RemoteLinkClient({ link: c.link, runs: c.runs, ledgerDir: c.ledger, timers: TIMERS, execute });
    c.runs.client = again;
    again.start();
    await waitFor("acked", () => hosted.mirror.get("r-cmd")!.remote!.pending.length === 0);
    assert.deepEqual(ran, [cmd.id]);
  } finally { c.client.stop(); again?.stop(); await hosted.close(); }
});

test("machine id: Forget and a re-link with a new token on the same computer take over at once; its runs move, ones it no longer lists are pruned", async () => {
  const NEW: LinkInfo = { ...LAPTOP, id: "link-b", label: "Work laptop again" };
  const tokens = new LinkTokens(tmp());
  const t1 = tokens.create(ANA, "Work laptop").token, t2 = tokens.create(ANA, "Work laptop again").token;
  const hosted = await pod(tmp(), 0, undefined, {}, Date.now, (t) => (t === t2 ? NEW : LAPTOP));
  const ledger = tmp();
  const runs = new FakeRuns();
  runs.add("r-keep");
  runs.add("r-gone");
  const a = computer(hosted.url, { runs, ledger, token: t1 });
  let b: ReturnType<typeof computer> | null = null;
  try {
    a.client.start();
    await waitFor("both on the first link", () => hosted.mirror.get("r-keep")?.remote?.linkId === "link-a" && !!hosted.mirror.get("r-gone"));
    assert.equal(a.client.machine, fs.readFileSync(path.join(ledger, "remote-link", "machine-id"), "utf-8"));
    // The first link is still online (it synced just now) when the computer re-links.
    a.client.stop();
    a.link.forget();
    runs.metas.delete("r-gone");
    const opens = () => hosted.requests.filter((r) => r === "GET /api/remote/link").length;
    const before = opens();
    b = computer(hosted.url, { runs, ledger, token: t2 });
    assert.equal(b.client.machine, a.client.machine, "the machine id survives Forget");
    b.client.start();
    await waitFor("moved to the new link", () => hosted.mirror.get("r-keep")?.remote?.linkId === "link-b");
    assert.equal(opens() - before, 1, "no 409 and no retry: it took over at once");
    assert.equal(b.state().state, "connected");
    await waitFor("the run it no longer lists pruned from the old link", () => !hosted.mirror.get("r-gone"));
    assert.deepEqual(hosted.mirror.remoteLinks().map((l) => [l.linkId, l.online]), [["link-a", false], ["link-b", true]]);
  } finally { a.client.stop(); b?.client.stop(); await hosted.close(); }
});

test("machine id: two computers on one token: the second gets 409 and the first keeps working; nothing is deleted", async () => {
  const hosted = await pod(tmp());
  const token = new LinkTokens(tmp()).create(ANA, "Work laptop").token;
  const runsA = new FakeRuns();
  runsA.add("a1");
  runsA.add("a2");
  const runsB = new FakeRuns();
  runsB.add("b1");
  const a = computer(hosted.url, { runs: runsA, token });
  const b = computer(hosted.url, { runs: runsB, token });
  try {
    a.client.start();
    await waitFor("the first computer's runs", () => !!hosted.mirror.get("a1") && !!hosted.mirror.get("a2"));
    b.client.start();
    await waitFor("the second refused", () => b.state().state === "error");
    assert.match(b.state().message!, /Another computer/);
    runsA.add("a3");
    await waitFor("the first still syncing", () => !!hosted.mirror.get("a3"));
    await wait(400); // the second tries again meanwhile (slowRetryMs)
    assert.equal(a.state().state, "connected");
    assert.equal(b.state().state, "error");
    assert.deepEqual(hosted.mirror.list().map((m) => m.id).sort(), ["a1", "a2", "a3"]);
  } finally { a.client.stop(); b.client.stop(); await hosted.close(); }
});

test("a run whose meta alone is over the full sync's limit is left out: the rest are mirrored, and the link isn't stuck", async () => {
  const rec = syncBodies();
  const hosted = await pod(tmp(), 0, (req, body) => { rec.record(req, body); return null; });
  const runs = new FakeRuns();
  for (let i = 1; i <= 3; i++) runs.add(`r${i}`, { startedAt: new Date(Date.now() - i * 60_000).toISOString() });
  runs.add("huge", { prompt: "p".repeat(12_000) }); // the newest
  const c = computer(hosted.url, { runs, limits: { maxBytes: 8000, eventsMaxBytes: 2000 } });
  try {
    c.client.start();
    await waitFor("the others", () => ["r1", "r2", "r3"].every((id) => !!hosted.mirror.get(id)));
    assert.equal(hosted.mirror.get("huge"), null);
    // Not stuck: a change goes up; the big one changing again neither goes up nor brings a full sync.
    runs.set("huge", { prompt: "q".repeat(12_000) });
    runs.set("r1", { prompt: "changed" });
    await waitFor("the change", () => hosted.mirror.get("r1")!.prompt === "changed");
    await wait(150);
    assert.equal(rec.bodies.filter((b) => b.full).length, 1);
    assert.ok(rec.bodies.every((b) => b.runs.every((r) => r.id !== "huge")));
    // Once it fits, it goes up.
    runs.set("huge", { prompt: "small now" });
    await waitFor("the big one once it fits", () => hosted.mirror.get("huge")?.prompt === "small now");
  } finally { c.client.stop(); await hosted.close(); }
});

// ------------------------------------------------------------ commands on a real RunManager

test("remoteExecutor: each kind goes to its run action; a missing run, attachments, a refusal and the switch off come back ok: false", async () => {
  const calls: string[] = [];
  const actions: RunActions = {
    has: (id) => id === "r1",
    reply: (_id, b) => calls.push(`reply ${JSON.stringify(b)}`),
    queue: (_id, action, b) => calls.push(`${action} ${JSON.stringify(b)}`),
    planMode: (_id, on) => calls.push(`plan-mode ${on}`),
    cancel: () => { throw httpError(409, "Nothing to cancel: the run isn't working or waiting."); },
  };
  let on = true;
  const exec = remoteExecutor(actions, () => on);
  const cmd = (kind: RemoteCommand["kind"], payload: Record<string, unknown> = {}, runId = "r1") => ({ id: "c1", runId, kind, payload, at: "" }) as RemoteCommand;
  assert.deepEqual(await exec(cmd("reply", { text: "hi" })), { ok: true });
  assert.deepEqual(await exec(cmd("reply", { text: "hi", model: "opus" })), { ok: true });
  assert.deepEqual(await exec(cmd("queue", { text: "later", autoSend: true })), { ok: true });
  assert.deepEqual(await exec(cmd("queue-edit", { id: "q1", text: "edited" })), { ok: true });
  assert.deepEqual(await exec(cmd("queue-remove", { id: "q1" })), { ok: true });
  assert.deepEqual(await exec(cmd("queue-send")), { ok: true });
  assert.deepEqual(await exec(cmd("queue-auto", { on: true })), { ok: true });
  assert.deepEqual(await exec(cmd("plan-mode", { on: true })), { ok: true });
  assert.deepEqual(calls, [
    'reply {"text":"hi"}', 'reply {"text":"hi","model":"opus"}', 'queue {"text":"later","autoSend":true}',
    'queue-edit {"id":"q1","text":"edited"}', 'queue-remove {"id":"q1"}', "queue-send {}", 'queue-auto {"on":true}', "plan-mode true",
  ]);
  assert.deepEqual(await exec(cmd("cancel")), { ok: false, error: "Nothing to cancel: the run isn't working or waiting." });
  assert.deepEqual(await exec(cmd("reply", { text: "hi" }, "gone")), { ok: false, error: RUN_GONE });
  assert.deepEqual(await exec(cmd("reply", { text: "hi", attachments: ["a1"] })), { ok: false, error: NO_ATTACHMENTS });
  on = false;
  assert.deepEqual(await exec(cmd("reply", { text: "hi" })), { ok: false, error: REMOTE_OFF });
  assert.equal(calls.length, 8, "nothing else ran");
});

/**
 * The run actions as main.ts has them (replyToRun, queueAction, setRunPlanMode, cancelRun),
 * calling RunManager the same way. main.ts can't be imported here (importing it starts the
 * server), so this is a copy, and these differences from it are deliberate:
 *   - effort: a model switch passes `effort: null`; main.ts passes the deck's default effort
 *     (`defaults.effort`, none for a local or team model), and the deck config isn't loaded here;
 *   - reply's model checks ("Only Claude runs can change model.", "Unknown model …"),
 *     launchBlocker and the run budget (reply's and queue-send's `budgetUsd`), which read this
 *     machine's models, Claude sign-in, usage and limits, are left out;
 *   - attachments: not passed on (main.ts checks reply's with attachments.check); remoteExecutor
 *     refuses any before an action is called.
 * hosted.test.ts checks the real functions' statuses and messages through the HTTP routes.
 */
function actionsFor(runs: RunManager): RunActions {
  return {
    has: (id) => !!runs.get(id),
    reply: (id, b) => {
      const switchTo = b.model !== undefined && b.model !== runs.get(id)?.model ? String(b.model || "") : undefined;
      return runs.reply(id, b.text as string, switchTo !== undefined ? { model: switchTo, effort: null } : {});
    },
    queue: (id, action, b) => {
      switch (action) {
        case "queue": return runs.enqueue(id, b.text as string, typeof b.autoSend === "boolean" ? b.autoSend : undefined);
        case "queue-auto": return runs.setQueueAutoSend(id, !!b.on);
        case "queue-edit": return runs.editQueued(id, String(b.id || ""), b.text as string);
        case "queue-remove": return runs.removeQueued(id, String(b.id || ""));
        case "queue-send": return runs.sendQueued(id, {});
      }
    },
    planMode: (id, on) => runs.setPlanMode(id, on),
    cancel: (id) => { if (!runs.cancel(id)) throw httpError(409, "Nothing to cancel: the run isn't working or waiting."); },
  };
}

interface Executed { cmd: RemoteCommand; live: boolean; result?: { ok: boolean; error?: string } }

/** A computer with a real RunManager (its hooks feed the client) and remoteExecutor over it, as main.ts wires them. */
function realComputer(url: string) {
  const ledger = tmp();
  const cwd = tmp();
  const link = new HostedLink(ledger, () => url, { DASHBOARD_LINK_TOKEN: new LinkTokens(tmp()).create(ANA, "Work laptop").token });
  link.retryMs = 10;
  link.setRemoteControl(true);
  let client: RemoteLinkClient | null = null;
  const runs = new RunManager(ledger, { onChange: (m) => client?.noteChange(m), onEvent: (m, e, i) => client?.noteEvent(m, e, i) });
  const executed: Executed[] = [];
  const exec = remoteExecutor(actionsFor(runs), () => link.remoteControl());
  const make = () => new RemoteLinkClient({
    link, runs, ledgerDir: ledger, timers: TIMERS,
    execute: async (cmd) => {
      const x: Executed = { cmd, live: runs.live.has(cmd.runId) };
      executed.push(x);
      x.result = await exec(cmd);
      return x.result;
    },
  });
  client = make();
  return {
    link, runs, executed, ledger,
    get client() { return client!; },
    /** The dashboard restarted: a new client on the same ledger. */
    restart() { client!.stop(); client = make(); return client; },
    start: (prompt: string, extra: { model?: string } = {}) => runs.start({ prompt, cwd, ...extra }),
    humans: (id: string) => runs.events(id).filter((e: any) => e.type === "human").map((e: any) => e.text as string),
    stopAll: () => { client!.stop(); for (const id of runs.live.keys()) runs.cancel(id); },
  };
}

const pendingOf = (hosted: { mirror: RemoteMirror }, id: string) => hosted.mirror.get(id)!.remote!.pending;

test("from the hosted dashboard: a reply, plan mode and a reply that switches the model take effect on the computer's run", async () => {
  const hosted = await pod(tmp());
  const c = realComputer(hosted.url);
  try {
    const run = c.start("first", { model: "sonnet" });
    await settled(c.runs, run.id);
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get(run.id));

    hosted.mirror.command(run.id, "reply", { text: "from the hosted dashboard" });
    await waitFor("acked", () => pendingOf(hosted, run.id).length === 0);
    let done = await settled(c.runs, run.id);
    assert.equal(done.turns, 2);
    assert.equal(c.humans(run.id).at(-1), "from the hosted dashboard");
    assert.equal(fake.prompts().at(-1), "from the hosted dashboard");
    assert.equal(hosted.mirror.get(run.id)!.remote!.lastError ?? null, null);

    hosted.mirror.command(run.id, "plan-mode", { on: true });
    await waitFor("acked", () => pendingOf(hosted, run.id).length === 0);
    assert.equal(c.runs.get(run.id)!.planMode, true);

    hosted.mirror.command(run.id, "reply", { text: "on opus now", model: "opus" });
    await waitFor("acked", () => pendingOf(hosted, run.id).length === 0);
    done = await settled(c.runs, run.id);
    assert.equal(done.turns, 3);
    assert.equal(done.model, "opus");
    assert.equal(c.humans(run.id).at(-1), "on opus now");
    assert.ok(c.executed.every((x) => x.result?.ok), JSON.stringify(c.executed.map((x) => x.result)));
  } finally { c.stopAll(); await hosted.close(); }
});

test("from the hosted dashboard: an answer to a question (answerText's format) is a reply that goes on the run", async () => {
  const hosted = await pod(tmp());
  const c = realComputer(hosted.url);
  try {
    const run = c.start("slow ask");
    await settled(c.runs, run.id, ["waiting"]);
    c.client.start();
    await waitFor("synced", () => hosted.mirror.get(run.id)?.status === "waiting");
    // web/src/app/runs/answer.ts answerText: "Q: <header or question>\nA: <labels>".
    const answer = "Q: Pick\nA: A";
    hosted.mirror.command(run.id, "reply", { text: answer });
    await waitFor("acked", () => pendingOf(hosted, run.id).length === 0);
    const done = await settled(c.runs, run.id, ["succeeded"]);
    assert.equal(done.turns, 2);
    assert.equal(done.question ?? null, null);
    assert.equal(c.humans(run.id).at(-1), answer);
  } finally { c.stopAll(); await hosted.close(); }
});

test("from the hosted dashboard: a queued message goes straight out on an idle run, and is held while Claude works", async () => {
  const hosted = await pod(tmp());
  const c = realComputer(hosted.url);
  try {
    const idle = c.start("first");
    await settled(c.runs, idle.id);
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get(idle.id));
    hosted.mirror.command(idle.id, "queue", { text: "queued while idle" });
    await waitFor("acked", () => pendingOf(hosted, idle.id).length === 0);
    const sent = await settled(c.runs, idle.id);
    assert.equal(sent.turns, 2);
    assert.equal(c.humans(idle.id).at(-1), "queued while idle");

    const busy = c.start("slow start");
    await waitFor("mirrored", () => !!hosted.mirror.get(busy.id));
    hosted.mirror.command(busy.id, "queue", { text: "held" });
    await waitFor("acked", () => pendingOf(hosted, busy.id).length === 0);
    const x = c.executed.at(-1)!;
    assert.equal(x.live, true, "queued mid-turn");
    assert.deepEqual(x.result, { ok: true });
    const done = await settled(c.runs, busy.id);
    assert.equal(done.turns, 2);
    assert.deepEqual(done.queued, []);
    assert.equal(c.humans(busy.id).at(-1), "held");
  } finally { c.stopAll(); await hosted.close(); }
});

test("from the hosted dashboard: cancel stops the turn", async () => {
  const hosted = await pod(tmp());
  const c = realComputer(hosted.url);
  try {
    c.client.start();
    await waitFor("connected", () => c.link.status().remoteControl.state === "connected");
    const busy = c.start("slow start");
    await waitFor("mirrored", () => !!hosted.mirror.get(busy.id));
    hosted.mirror.command(busy.id, "cancel", {});
    await waitFor("acked", () => pendingOf(hosted, busy.id).length === 0);
    assert.deepEqual(c.executed.at(-1)!.result, { ok: true });
    const done = await settled(c.runs, busy.id);
    assert.equal(done.status, "cancelled");
  } finally { c.stopAll(); await hosted.close(); }
});

test("a reply while Claude is still working comes back ok: false with the run's own message, shown as lastError", async () => {
  const hosted = await pod(tmp());
  const c = realComputer(hosted.url);
  try {
    c.client.start();
    await waitFor("connected", () => c.link.status().remoteControl.state === "connected");
    const busy = c.start("slow start");
    await waitFor("mirrored", () => !!hosted.mirror.get(busy.id));
    hosted.mirror.command(busy.id, "reply", { text: "too soon" });
    await waitFor("acked", () => pendingOf(hosted, busy.id).length === 0);
    assert.deepEqual(c.executed.at(-1)!.result, { ok: false, error: "Claude is still working on this run." });
    const err = hosted.mirror.get(busy.id)!.remote!.lastError!;
    assert.equal(err.kind, "reply");
    assert.equal(err.message, "Claude is still working on this run.");
    assert.equal((await settled(c.runs, busy.id)).turns, 1);
  } finally { c.stopAll(); await hosted.close(); }
});

test("a command re-delivered after its ack was lost runs once: the restarted computer re-acks it from done-commands.json", async () => {
  let dropAcks = true;
  let acks = 0;
  const hosted = await pod(tmp(), 0, (req) => {
    if (!req.url?.startsWith("/api/remote/ack")) return null;
    acks++;
    return dropAcks ? { reset: true } : null;
  });
  const c = realComputer(hosted.url);
  try {
    const run = c.start("first");
    await settled(c.runs, run.id);
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get(run.id));
    const cmd = hosted.mirror.command(run.id, "reply", { text: "exactly once" }).remote!.pending[0];
    await waitFor("the ack and a retry, both lost", () => acks >= 2);
    assert.equal((await settled(c.runs, run.id)).turns, 2);
    assert.equal(pendingOf(hosted, run.id).length, 1, "still waiting for its ack");
    const stored = JSON.parse(fs.readFileSync(path.join(c.ledger, "remote-link", "done-commands.json"), "utf-8"));
    assert.deepEqual(stored, [{ id: cmd.id, ok: true }]);

    // The dashboard restarts (a new client on the same ledger); the hosted side re-sends the command.
    dropAcks = false;
    c.restart().start();
    await waitFor("acked", () => pendingOf(hosted, run.id).length === 0);
    await wait(200);
    assert.equal(c.executed.filter((x) => x.cmd.id === cmd.id).length, 1);
    assert.equal((await settled(c.runs, run.id)).turns, 2);
    assert.equal(fake.prompts().filter((p) => p === "exactly once").length, 1);
    assert.equal(hosted.mirror.get(run.id)!.remote!.lastError ?? null, null);
  } finally { c.stopAll(); await hosted.close(); }
});

test("a message queued while the computer is offline waits on the hosted side, then is delivered and sent on reconnect", async () => {
  let offset = 0;
  const hosted = await pod(tmp(), 0, undefined, {}, () => Date.now() + offset);
  const c = realComputer(hosted.url);
  try {
    const run = c.start("first");
    await settled(c.runs, run.id);
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get(run.id));
    c.client.stop(); // the lid closes: no stream, no syncs…
    await wait(150); // (the hosted side sees the stream close)
    offset = 61_000; // …and a minute passes on the hosted side
    assert.equal(hosted.mirror.get(run.id)!.remote!.online, false);
    assert.throws(() => hosted.mirror.command(run.id, "reply", { text: "now" }), (e: any) => e.status === 409);
    const held = hosted.mirror.command(run.id, "queue", { text: "when you're back" });
    assert.equal(held.remote!.pending[0].delivered, false);
    await wait(150);
    assert.equal(c.executed.length, 0);

    c.client.start();
    await waitFor("acked", () => pendingOf(hosted, run.id).length === 0);
    const done = await settled(c.runs, run.id);
    assert.equal(done.turns, 2);
    assert.equal(c.humans(run.id).at(-1), "when you're back");
  } finally { c.stopAll(); await hosted.close(); }
});

test("Remote control switched off when a command arrives: refused with why, and the run is untouched", async () => {
  const hosted = await pod(tmp());
  const c = realComputer(hosted.url);
  try {
    const run = c.start("first");
    await settled(c.runs, run.id);
    c.client.start();
    await waitFor("synced", () => !!hosted.mirror.get(run.id));
    c.link.setRemoteControl(false); // switched off; the client hasn't stopped yet
    hosted.mirror.command(run.id, "reply", { text: "too late" });
    await waitFor("acked", () => pendingOf(hosted, run.id).length === 0);
    assert.deepEqual(c.executed.at(-1)!.result, { ok: false, error: REMOTE_OFF });
    assert.equal(hosted.mirror.get(run.id)!.remote!.lastError!.message, REMOTE_OFF);
    await wait(100);
    assert.equal(c.runs.get(run.id)!.turns, 1);
  } finally { c.stopAll(); await hosted.close(); }
});

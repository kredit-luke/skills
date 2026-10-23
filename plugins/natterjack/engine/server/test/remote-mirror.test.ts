// Remote control on the hosted dashboard (remote-mirror.ts): mirrored runs, their events at the
// computer's indexes, and the commands held for the computer until it acks them. In process,
// with a temp ledger, fake responses and a clock the tests move.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { RemoteMirror } from "../src/remote-mirror.ts";
import { ONLINE_MS, PENDING_MAX, REMOTE_PROTOCOL } from "../../shared/remote.ts";
import type { SyncRequest } from "../../shared/remote.ts";
import type { RunMeta } from "../../shared/api.ts";
import type { LinkInfo } from "../src/link-tokens.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-mirror-"));
const LAPTOP: LinkInfo = { id: "link-a", label: "Work laptop", createdAt: "2026-10-22T09:00:00Z", lastUsedAt: null };
const DESKTOP: LinkInfo = { id: "link-b", label: "Home desktop", createdAt: "2026-10-22T09:00:00Z", lastUsedAt: null };

type FakeRes = ServerResponse & { chunks: string[]; ended: boolean };
function fakeRes(): FakeRes {
  const res = Object.assign(new EventEmitter(), {
    chunks: [] as string[],
    ended: false,
    write(s: string) { this.chunks.push(s); return true; },
    end(this: EventEmitter & { ended: boolean }) { if (!this.ended) { this.ended = true; this.emit("close"); } },
  });
  return res as unknown as FakeRes;
}
/** The SSE frames written so far, parsed. */
function frames(res: FakeRes): { id?: string; event: string; data: any }[] {
  return res.chunks.join("").split("\n\n").filter((f) => f && !f.startsWith(":")).map((f) => {
    const out: any = {};
    for (const line of f.split("\n")) {
      const i = line.indexOf(": ");
      const k = line.slice(0, i), v = line.slice(i + 2);
      out[k] = k === "data" ? JSON.parse(v) : v;
    }
    return out;
  });
}
const of = (res: FakeRes, event: string) => frames(res).filter((f) => f.event === event).map((f) => f.data);

const meta = (id: string, extra: Partial<RunMeta> = {}) => ({ id, status: "waiting", startedAt: "2026-10-22T09:30:00Z", ...extra }) as RunMeta;
const ev = (n: number) => ({ type: "assistant", uuid: `u${n}`, text: `e${n}` });
const sync = (body: Partial<SyncRequest>): SyncRequest => ({ protocol: REMOTE_PROTOCOL, runs: [], events: [], ...body });

function setup() {
  let now = Date.parse("2026-10-22T10:00:00Z");
  const changes: RunMeta[] = [];
  const mirror = new RemoteMirror(tmp(), () => now, { onChange: (m) => changes.push(m), unwatchGraceMs: 20 });
  return { mirror, changes, tick: (ms: number) => { now += ms; } };
}
const status = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.status; } return 200; };
/** As main.ts does it: assertCanOpen, (the SSE headers), openLink. */
const open = (mirror: RemoteMirror, link: LinkInfo, res: FakeRes) => { mirror.assertCanOpen(link); mirror.openLink(link, res); };

test("sync: metas upserted with remote filled in, events appended at the pod's count, wrong protocol refused", () => {
  const { mirror, changes } = setup();
  const r = mirror.sync(LAPTOP, sync({ runs: [meta("r1", { remote: { bogus: true } as any })], events: [{ runId: "r1", from: 0, events: [ev(0), ev(1)] }] }));
  assert.deepEqual(r, { ok: true, have: { r1: 2 } });
  const got = mirror.get("r1")!;
  assert.equal(got.remote!.linkId, "link-a");
  assert.equal(got.remote!.label, "Work laptop");
  assert.equal(got.remote!.online, true);
  assert.equal(got.remote!.enabled, true);
  assert.deepEqual(got.remote!.pending, []);
  assert.equal((got.remote as any).bogus, undefined, "the computer's own `remote` is not kept");
  assert.deepEqual(mirror.events("r1").map((e) => e.uuid), ["u0", "u1"]);
  assert.deepEqual(mirror.list().map((m) => m.id), ["r1"]);
  assert.ok(changes.some((m) => m.id === "r1" && m.remote));
  assert.equal(status(() => mirror.sync(LAPTOP, { ...sync({}), protocol: 99 })), 400);
  assert.equal(mirror.get("nope"), null);
});

test("sync: a `from` below `have` skips the overlap, above it is ignored; nothing lost, nothing doubled", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")], events: [{ runId: "r1", from: 0, events: [ev(0), ev(1)] }] }));
  assert.deepEqual(mirror.sync(LAPTOP, sync({ events: [{ runId: "r1", from: 1, events: [ev(1), ev(2), ev(3)] }] })).have, { r1: 4 });
  assert.deepEqual(mirror.sync(LAPTOP, sync({ events: [{ runId: "r1", from: 6, events: [ev(6)] }] })).have, { r1: 4 }, "a gap: resend from 4");
  assert.deepEqual(mirror.sync(LAPTOP, sync({ events: [{ runId: "r1", from: 0, events: [ev(0), ev(1)] }] })).have, { r1: 4 }, "all overlap");
  assert.deepEqual(mirror.sync(LAPTOP, sync({ events: [{ runId: "r1", from: 4, events: [ev(4)] }] })).have, { r1: 5 });
  assert.deepEqual(mirror.events("r1").map((e) => e.uuid), ["u0", "u1", "u2", "u3", "u4"]);
  assert.deepEqual(mirror.sync(LAPTOP, sync({ events: [{ runId: "ghost", from: 0, events: [ev(0)] }] })).have, {}, "events for a run with no meta");
});

test("sync full: runs not in the list are dropped", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1"), meta("r2")], events: [{ runId: "r2", from: 0, events: [ev(0)] }] }));
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  assert.equal(mirror.list().length, 2, "a partial sync keeps the rest");
  mirror.sync(LAPTOP, sync({ full: true, runs: [meta("r1")] }));
  assert.deepEqual(mirror.list().map((m) => m.id), ["r1"]);
  assert.deepEqual(mirror.events("r2"), []);
});

test("online and offline follow the clock", () => {
  const { mirror, tick } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  tick(ONLINE_MS - 1);
  assert.equal(mirror.get("r1")!.remote!.online, true);
  assert.deepEqual(mirror.linkStatus("link-a"), { online: true, lastSeenAt: "2026-10-22T10:00:00.000Z", enabled: true });
  tick(1);
  assert.equal(mirror.get("r1")!.remote!.online, false);
  assert.equal(mirror.list()[0].remote!.online, false);
  mirror.sync(LAPTOP, sync({}));
  assert.equal(mirror.get("r1")!.remote!.online, true, "a heartbeat brings it back");
  assert.equal(mirror.linkStatus("link-z"), null);
});

test("commands are kept until acked and re-sent on every reopen; an ack error shows on the run", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  const queued = mirror.command("r1", "queue", { text: "later", autoSend: true }).remote!.pending[0];
  assert.equal(queued.delivered, false);
  assert.equal(queued.text, "later");

  const s1 = fakeRes();
  open(mirror, LAPTOP, s1);
  const hello = of(s1, "hello")[0];
  assert.deepEqual(hello, { protocol: REMOTE_PROTOCOL, linkId: "link-a", label: "Work laptop", watch: [] });
  assert.equal(frames(s1)[0].event, "hello", "hello comes first");
  assert.deepEqual(of(s1, "command").map((c) => [c.id, c.kind, c.payload]), [[queued.id, "queue", { text: "later", autoSend: true }]]);
  assert.equal(of(s1, "command")[0].delivered, undefined, "`delivered` stays on the pod");
  assert.equal(mirror.get("r1")!.remote!.pending[0].delivered, true);

  const reply = mirror.command("r1", "reply", { text: "go on", model: "opus" }).remote!.pending[1];
  assert.equal(reply.delivered, true, "sent at once on the open link");
  assert.deepEqual(of(s1, "command")[1].payload, { text: "go on", model: "opus" });

  const s2 = fakeRes();
  open(mirror, LAPTOP, s2);
  assert.equal(s1.ended, true, "the older stream for the same link is closed");
  assert.deepEqual(of(s2, "command").map((c) => c.id), [queued.id, reply.id], "unacked commands again, in order");

  mirror.ack(LAPTOP, { id: queued.id, ok: true });
  assert.deepEqual(mirror.get("r1")!.remote!.pending.map((p) => p.id), [reply.id]);
  mirror.ack(LAPTOP, { id: reply.id, ok: false, error: "Claude is still working" });
  const r = mirror.get("r1")!.remote!;
  assert.deepEqual(r.pending, []);
  assert.equal(r.lastError!.kind, "reply");
  assert.equal(r.lastError!.message, "Claude is still working");
  mirror.ack(LAPTOP, { id: reply.id, ok: true });
  assert.equal(mirror.get("r1")!.remote!.lastError!.message, "Claude is still working", "a repeat ack of a gone command changes nothing");

  const s3 = fakeRes();
  open(mirror, LAPTOP, s3);
  assert.deepEqual(of(s3, "command"), [], "acked commands aren't re-sent");
  s3.end();
});

test("command: unknown run 404, attachments 400, model only on a reply", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  assert.equal(status(() => mirror.command("nope", "reply", { text: "x" })), 404);
  assert.equal(status(() => mirror.command("r1", "reply", { text: "x", attachments: [{ name: "a.png" }] })), 400);
  assert.equal(status(() => mirror.command("r1", "queue", { text: "x", model: "opus" })), 400);
  for (const model of [1, true, null, {}, ["opus"]]) {
    assert.equal(status(() => mirror.command("r1", "reply", { text: "x", model })), 400, `model ${JSON.stringify(model)}`);
  }
  assert.equal(status(() => mirror.command("r1", "reply", { text: "  " })), 400);
  assert.equal(status(() => mirror.command("r1", "bogus" as any, {})), 400);
  assert.equal(status(() => mirror.command("r1", "plan-mode", { on: true })), 200);
});

test("offline: only queue, and edit/remove of a queue the computer hasn't had; a delivered one is 409", () => {
  const { mirror, tick } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  tick(ONLINE_MS);
  for (const [kind, payload] of [["reply", { text: "x" }], ["cancel", {}], ["plan-mode", { on: true }], ["queue-send", {}], ["queue-auto", { on: true }]] as const) {
    assert.equal(status(() => mirror.command("r1", kind, payload)), 409, kind);
  }
  assert.equal(status(() => mirror.command("r1", "queue-edit", { id: "on-the-computer", text: "y" })), 409, "a computer-side queue needs the computer");

  const a = mirror.command("r1", "queue", { text: "one" }).remote!.pending[0].id;
  const b = mirror.command("r1", "queue", { text: "two" }).remote!.pending[1].id;
  let run = mirror.command("r1", "queue-edit", { id: a, text: "one, edited" });
  assert.deepEqual(run.remote!.pending.map((p) => p.text), ["one, edited", "two"], "edited in place, no new command");
  run = mirror.command("r1", "queue-remove", { id: b });
  assert.deepEqual(run.remote!.pending.map((p) => p.id), [a]);

  // The computer connects (gets `a`), then drops off before acking it.
  const s = fakeRes();
  open(mirror, LAPTOP, s);
  assert.deepEqual(of(s, "command").map((c) => c.payload.text), ["one, edited"], "the in-place edit is what goes down");
  assert.equal(of(s, "command").length, 1, "the edit and the remove were never forwarded");
  s.end();
  tick(ONLINE_MS);
  assert.equal(status(() => mirror.command("r1", "queue-edit", { id: a, text: "too late" })), 409);
  assert.match(String((() => { try { mirror.command("r1", "queue-remove", { id: a }); } catch (e: any) { return e.message; } })()), /Already sent to your computer/);

  // Online too: a delivered-but-unacked queue is the computer's now.
  mirror.sync(LAPTOP, sync({}));
  assert.equal(status(() => mirror.command("r1", "queue-remove", { id: a })), 409);
  assert.equal(status(() => mirror.command("r1", "reply", { text: "now" })), 200, "online: a reply is fine");
});

test("PENDING_MAX commands waiting: the next is 429", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  for (let i = 0; i < PENDING_MAX; i++) mirror.command("r1", "queue", { text: `m${i}` });
  assert.equal(status(() => mirror.command("r1", "queue", { text: "one more" })), 429);
});

test("one computer at a time: a second link is 409 while the first is online; a stale stream is taken over", () => {
  const { mirror, tick } = setup();
  const a = fakeRes();
  open(mirror, LAPTOP, a);
  assert.equal(status(() => open(mirror, DESKTOP, fakeRes())), 409, "holding a live stream");
  assert.equal(status(() => mirror.sync(DESKTOP, sync({ runs: [meta("d1")] }))), 409, "nor can it sync");
  assert.equal(mirror.get("d1"), null);
  tick(ONLINE_MS - 1);
  mirror.sync(LAPTOP, sync({}));
  tick(ONLINE_MS - 1);
  assert.equal(status(() => open(mirror, DESKTOP, fakeRes())), 409, "seen just now");

  // The laptop's lid closed: its stream is still held (no FIN), but it stopped syncing.
  tick(1);
  const b = fakeRes();
  assert.equal(status(() => open(mirror, DESKTOP, b)), 200, "a stale stream doesn't block");
  assert.equal(a.ended, true, "the stale stream is ended");
  assert.equal(of(b, "hello")[0].label, "Home desktop");
  assert.equal(status(() => mirror.sync(LAPTOP, sync({}))), 409, "now the laptop is the second computer");
  assert.equal(status(() => mirror.assertCanOpen(LAPTOP)), 409);
  b.end();
});

test("off: pending commands fail with a reason and new ones are refused until a sync without it", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  mirror.command("r1", "queue", { text: "later" });
  mirror.sync(LAPTOP, sync({ off: true }));
  const r = mirror.get("r1")!.remote!;
  assert.equal(r.enabled, false);
  assert.deepEqual(r.pending, []);
  assert.equal(r.lastError!.message, "Remote control was turned off on Work laptop.");
  assert.equal(mirror.linkStatus("link-a")!.enabled, false);
  assert.equal(status(() => mirror.command("r1", "queue", { text: "x" })), 409);
  mirror.sync(LAPTOP, sync({}));
  assert.equal(mirror.get("r1")!.remote!.enabled, true);
  assert.equal(status(() => mirror.command("r1", "queue", { text: "x" })), 200);
});

test("drop: closes the link and its run streams, and forgets the mirror", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")], events: [{ runId: "r1", from: 0, events: [ev(0)] }] }));
  const link = fakeRes();
  open(mirror, LAPTOP, link);
  const viewer = fakeRes();
  mirror.subscribe("r1", viewer);
  mirror.drop("link-a");
  assert.equal(link.ended, true);
  assert.equal(viewer.ended, true);
  assert.equal(mirror.get("r1"), null);
  assert.deepEqual(mirror.list(), []);
  assert.equal(mirror.linkStatus("link-a"), null);
});

test("subscribe: replays after `after`, then live; watch for the first viewer, unwatch after the grace", async () => {
  const { mirror, changes } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")], events: [{ runId: "r1", from: 0, events: [ev(0), ev(1), ev(2)] }] }));
  const link = fakeRes();
  open(mirror, LAPTOP, link);
  assert.equal(mirror.subscribe("nope", fakeRes()), false);

  const v1 = fakeRes();
  assert.equal(mirror.subscribe("r1", v1, 0), true);
  const f = frames(v1);
  assert.deepEqual(f.filter((x) => x.event === "event").map((x) => [x.id, x.data.uuid]), [["1", "u1"], ["2", "u2"]]);
  assert.equal(f.at(-1)!.event, "meta");
  assert.equal(f.at(-1)!.data.remote.linkId, "link-a");
  assert.deepEqual(of(link, "watch"), [{ runId: "r1", after: 3 }]);

  const v2 = fakeRes();
  mirror.subscribe("r1", v2);
  assert.equal(of(link, "watch").length, 1, "only the first viewer asks");
  assert.equal(of(v2, "event").length, 3);

  mirror.sync(LAPTOP, sync({ runs: [meta("r1", { status: "running" })], events: [{ runId: "r1", from: 3, events: [ev(3)] }] }));
  const live = frames(v1).filter((x) => x.event === "event").at(-1)!;
  assert.deepEqual([live.id, live.data.uuid], ["3", "u3"], "live events carry their index as the id");
  assert.equal(of(v1, "meta").at(-1).status, "running");
  assert.equal(changes.at(-1)!.status, "running");

  mirror.command("r1", "reply", { text: "hi" });
  assert.equal(of(v1, "meta").at(-1).remote.pending.length, 1, "a command shows to viewers at once");

  // A reconnect sees the watch set in hello.
  const link2 = fakeRes();
  open(mirror, LAPTOP, link2);
  assert.deepEqual(of(link2, "hello")[0].watch, [{ runId: "r1", after: 4 }]);

  v1.end();
  v2.end();
  const v3 = fakeRes();
  mirror.subscribe("r1", v3);
  v3.end();
  assert.equal(of(link2, "watch").length, 0, "back within the grace: no second watch");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(of(link2, "unwatch"), [{ runId: "r1" }]);
  link2.end();

  const v4 = fakeRes();
  const link3 = fakeRes();
  open(mirror, LAPTOP, link3);
  mirror.subscribe("r1", v4);
  assert.deepEqual(of(link3, "watch"), [{ runId: "r1", after: 4 }], "after an unwatch, a new viewer watches again");
  v4.end();
  link3.end();
});

test("state survives a restart: pending commands and the link's state are read back", () => {
  const dir = tmp();
  const now = () => Date.parse("2026-10-22T10:00:00Z");
  const a = new RemoteMirror(dir, now);
  a.sync(LAPTOP, sync({ runs: [meta("r1")], events: [{ runId: "r1", from: 0, events: [ev(0)] }] }));
  const id = a.command("r1", "queue", { text: "later" }).remote!.pending[0].id;
  const b = new RemoteMirror(dir, now);
  assert.deepEqual(b.get("r1")!.remote!.pending.map((p) => p.id), [id]);
  assert.deepEqual(b.sync(LAPTOP, sync({ events: [{ runId: "r1", from: 1, events: [ev(1)] }] })).have, { r1: 2 });
});

test("a last event line cut short by a crash: after a restart the resent event is read back at its acknowledged index", () => {
  const dir = tmp();
  const now = () => Date.parse("2026-10-22T10:00:00Z");
  const a = new RemoteMirror(dir, now);
  a.sync(LAPTOP, sync({ runs: [meta("r1")], events: [{ runId: "r1", from: 0, events: [ev(0), ev(1)] }] }));
  // A crash mid-write of the third event: a fragment, with no newline after it.
  const file = path.join(dir, "remote", LAPTOP.id, "runs", "r1.events.jsonl");
  fs.appendFileSync(file, JSON.stringify(ev(2)).slice(0, 12));
  const b = new RemoteMirror(dir, now);
  // The computer resends from the pod's count, which the fragment isn't part of.
  assert.deepEqual(b.sync(LAPTOP, sync({ runs: [meta("r1")] })).have, { r1: 2 });
  assert.deepEqual(b.sync(LAPTOP, sync({ events: [{ runId: "r1", from: 2, events: [ev(2), ev(3)] }] })).have, { r1: 4 });
  assert.deepEqual(b.events("r1").map((e) => e.uuid), ["u0", "u1", "u2", "u3"]);
  // And read back the same way after another restart.
  const c = new RemoteMirror(dir, now);
  assert.deepEqual(c.events("r1").map((e) => e.uuid), ["u0", "u1", "u2", "u3"]);
  assert.deepEqual(c.sync(LAPTOP, sync({ events: [{ runId: "r1", from: 4, events: [ev(4)] }] })).have, { r1: 5 });
  assert.deepEqual(c.events("r1").map((e) => e.uuid), ["u0", "u1", "u2", "u3", "u4"]);
});

test("drop wins over a sync already in flight: 401 from then on and the mirror stays empty; in memory only", () => {
  const dir = tmp();
  const now = () => Date.parse("2026-10-22T10:00:00Z");
  const a = new RemoteMirror(dir, now);
  a.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  const cmd = a.command("r1", "queue", { text: "later" }).remote!.pending[0].id;
  a.drop("link-a");
  // main.ts verified the token before the revoke, then awaited the body: the sync lands now.
  assert.equal(status(() => a.sync(LAPTOP, sync({ runs: [meta("r1"), meta("r2")], events: [{ runId: "r1", from: 0, events: [ev(0)] }] }))), 401);
  assert.deepEqual(a.list(), []);
  assert.equal(a.get("r1"), null);
  assert.equal(a.linkStatus("link-a"), null);
  assert.equal(fs.existsSync(path.join(dir, "remote", "link-a")), false, "the folder isn't recreated");
  assert.equal(status(() => a.ack(LAPTOP, { id: cmd, ok: true })), 401);
  assert.equal(status(() => a.assertCanOpen(LAPTOP)), 401);
  assert.equal(status(() => a.openLink(LAPTOP, fakeRes())), 401);
  assert.equal(status(() => a.command("r1", "queue", { text: "x" })), 404, "its runs are gone");

  assert.equal(status(() => a.sync(DESKTOP, sync({ runs: [meta("d1")] }))), 200, "other links are unaffected");

  // After a restart LinkTokens.verify refuses the revoked token; nothing of it is on disk.
  assert.deepEqual(fs.readdirSync(path.join(dir, "remote")), ["link-b"], "no dropped.json");
  const b = new RemoteMirror(dir, now);
  assert.deepEqual(b.list().map((m) => m.id), ["d1"]);
  assert.equal(b.get("r1"), null);
});

test("a late ack from a stale computer isn't a sighting: the computer that took over stays linked", () => {
  const { mirror, tick } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  const cmd = mirror.command("r1", "queue", { text: "later" }).remote!.pending[0].id;
  tick(ONLINE_MS);
  const b = fakeRes();
  open(mirror, DESKTOP, b);
  mirror.ack(LAPTOP, { id: cmd, ok: true });
  assert.equal(mirror.linkStatus("link-a")!.online, false, "the ack didn't bring the laptop back");
  assert.equal(status(() => mirror.sync(DESKTOP, sync({ runs: [meta("d1")] }))), 200);
  assert.equal(mirror.get("d1")!.remote!.online, true);
  assert.equal(status(() => mirror.assertCanOpen(LAPTOP)), 409, "the desktop is still the online link");
  assert.equal(b.ended, false);
  b.end();
});

test("one run id, one link: a sync from a new link moves the run there, on disk too", () => {
  const dir = tmp();
  let now = Date.parse("2026-10-22T10:00:00Z");
  const a = new RemoteMirror(dir, () => now);
  a.sync(LAPTOP, sync({ runs: [meta("r1"), meta("r2")], events: [{ runId: "r1", from: 0, events: [ev(0)] }] }));
  const moved = a.command("r1", "queue", { text: "for r1" }).remote!.pending[0].id;
  const keep = a.command("r2", "queue", { text: "for r2" }).remote!.pending[0].id;
  const failed = a.command("r1", "reply", { text: "fails" }).remote!.pending[1].id;
  a.ack(LAPTOP, { id: failed, ok: false, error: "nope" });

  // The same computer re-linked: a new link id, the old link never revoked.
  now += ONLINE_MS;
  assert.deepEqual(a.sync(DESKTOP, sync({ runs: [meta("r1", { status: "running" })] })).have, { r1: 1 }, "its events moved with it");
  assert.equal(a.get("r1")!.remote!.linkId, "link-b");
  assert.equal(a.get("r1")!.status, "running");
  assert.deepEqual(a.get("r1")!.remote!.pending.map((p) => p.id), [moved], "the old link's commands for it moved");
  assert.equal(a.get("r1")!.remote!.lastError!.message, "nope", "and its error");
  assert.deepEqual(a.events("r1").map((e) => e.uuid), ["u0"]);
  assert.deepEqual(a.list().map((m) => [m.id, m.remote!.linkId]).sort(), [["r1", "link-b"], ["r2", "link-a"]]);

  const runsA = path.join(dir, "remote", "link-a", "runs");
  assert.deepEqual(fs.readdirSync(runsA), ["r2.json"], "r1 isn't left under link-a");
  const stateA = JSON.parse(fs.readFileSync(path.join(dir, "remote", "link-a", "state.json"), "utf-8"));
  assert.deepEqual(stateA.pending.map((c: any) => c.id), [keep]);
  assert.equal(stateA.errors.r1, undefined);

  const b = new RemoteMirror(dir, () => now);
  assert.equal(b.get("r1")!.remote!.linkId, "link-b", "a restart can't pick the dead link");
  assert.deepEqual(b.get("r1")!.remote!.pending.map((p) => p.id), [moved]);
  assert.deepEqual(b.get("r2")!.remote!.pending.map((p) => p.id), [keep]);
});

test("a re-link moves the run: a viewer gets no event twice, `have` and commands carry over, a restart agrees", () => {
  const dir = tmp();
  let now = Date.parse("2026-10-22T10:00:00Z");
  const a = new RemoteMirror(dir, () => now, { unwatchGraceMs: 20 });
  a.sync(LAPTOP, sync({ runs: [meta("r1")], events: [{ runId: "r1", from: 0, events: [ev(0), ev(1), ev(2)] }] }));
  const viewer = fakeRes();
  a.subscribe("r1", viewer);
  const sent = a.command("r1", "queue", { text: "sent" }).remote!.pending[0].id;
  const linkA = fakeRes();
  open(a, LAPTOP, linkA);
  assert.deepEqual(of(linkA, "command").map((c) => c.id), [sent], "delivered, not acked");
  linkA.end();
  const held = a.command("r1", "queue", { text: "held" }).remote!.pending[1].id;
  assert.deepEqual(a.get("r1")!.remote!.pending.map((p) => [p.id, p.delivered]), [[sent, true], [held, false]]);

  // The same computer re-linked as link-b: its stream opens, then it syncs r1 from the old count.
  now += ONLINE_MS;
  const linkB = fakeRes();
  open(a, DESKTOP, linkB);
  assert.deepEqual(of(linkB, "hello")[0].watch, [], "r1 is still link-a's until link-b syncs it");
  const r = a.sync(DESKTOP, sync({ runs: [meta("r1")], events: [{ runId: "r1", from: 3, events: [ev(3), ev(4)] }] }));
  assert.deepEqual(r.have, { r1: 5 }, "resumes at the old count");
  const ids = of(viewer, "event").map((e) => e.uuid);
  assert.deepEqual(ids, ["u0", "u1", "u2", "u3", "u4"], "no event twice, the new ones arrive");
  assert.deepEqual(frames(viewer).filter((f) => f.event === "event").map((f) => f.id), ["0", "1", "2", "3", "4"]);
  assert.deepEqual(of(linkB, "watch"), [{ runId: "r1", after: 3 }]);
  assert.deepEqual(of(linkB, "command").map((c) => c.id), [sent, held], "every kept one is sent on link-b now");

  const check = (m: RemoteMirror) => {
    const remote = m.get("r1")!.remote!;
    assert.equal(remote.linkId, "link-b");
    assert.deepEqual(remote.pending.map((p) => [p.id, p.delivered]), [[sent, true], [held, true]], "same ids and order");
    assert.deepEqual(m.events("r1").map((e) => e.uuid), ["u0", "u1", "u2", "u3", "u4"]);
    assert.deepEqual(fs.readdirSync(path.join(dir, "remote", "link-a", "runs")), [], "no r1 files under link-a");
    const stateA = JSON.parse(fs.readFileSync(path.join(dir, "remote", "link-a", "state.json"), "utf-8"));
    assert.deepEqual(stateA.pending, []);
  };
  check(a);

  // A reopen of link-b lists r1 in hello.watch and resends both unacked commands.
  const linkB2 = fakeRes();
  open(a, DESKTOP, linkB2);
  assert.deepEqual(of(linkB2, "hello")[0].watch, [{ runId: "r1", after: 5 }]);
  assert.deepEqual(of(linkB2, "command").map((c) => c.id), [sent, held]);
  linkB2.end();
  viewer.end();

  const b = new RemoteMirror(dir, () => now);
  check(b);
  assert.deepEqual(b.sync(DESKTOP, sync({ events: [{ runId: "r1", from: 5, events: [ev(5)] }] })).have, { r1: 6 });
  b.ack(DESKTOP, { id: sent, ok: true });
  assert.deepEqual(b.get("r1")!.remote!.pending.map((p) => p.id), [held], "link-b acks the moved command");
});

test("a re-link past PENDING_MAX keeps the oldest commands and fails the rest on the run", () => {
  const { mirror, tick } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  const first = mirror.command("r1", "queue", { text: "first" }).remote!.pending[0].id;
  mirror.command("r1", "queue", { text: "second" });
  tick(ONLINE_MS);
  mirror.sync(DESKTOP, sync({ runs: [meta("d1")] }));
  for (let i = 0; i < PENDING_MAX - 1; i++) mirror.command("d1", "queue", { text: `d${i}` });
  mirror.sync(DESKTOP, sync({ runs: [meta("r1")] }));
  const remote = mirror.get("r1")!.remote!;
  assert.deepEqual(remote.pending.map((p) => p.id), [first]);
  assert.match(remote.lastError!.message, /1 message\(s\) couldn't move to Home desktop/);
});

test("ack with no matching command writes nothing", () => {
  const { mirror } = setup();
  const dir = (mirror as any).dir as string;
  mirror.ack(DESKTOP, { id: "nope", ok: true });
  assert.equal(fs.existsSync(path.join(dir, "link-b")), false, "a link that never synced");
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  const id = mirror.command("r1", "queue", { text: "x" }).remote!.pending[0].id;
  mirror.ack(LAPTOP, { id, ok: true });
  const file = path.join(dir, "link-a", "state.json");
  // Marked by hand: a rewrite would drop the trailing space.
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8") + " ");
  const marked = fs.readFileSync(file, "utf-8");
  mirror.ack(LAPTOP, { id, ok: true });
  assert.equal(fs.readFileSync(file, "utf-8"), marked, "a repeat doesn't rewrite state.json");
});

test("metas are cached: list and get don't read the disk, and a restart reads it back", () => {
  const dir = tmp();
  const now = () => Date.parse("2026-10-22T10:00:00Z");
  const a = new RemoteMirror(dir, now);
  a.sync(LAPTOP, sync({ runs: [meta("r1"), meta("r2")] }));
  const file = path.join(dir, "remote", "link-a", "runs", "r1.json");
  fs.writeFileSync(file, JSON.stringify(meta("r1", { status: "done" } as any)));
  assert.equal(a.get("r1")!.status, "waiting", "served from memory");
  assert.equal(a.list().find((m) => m.id === "r1")!.status, "waiting");
  a.sync(LAPTOP, sync({ full: true, runs: [meta("r1", { status: "running" })] }));
  assert.equal(a.get("r1")!.status, "running");
  assert.equal(a.get("r2"), null, "pruned from the cache");
  const b = new RemoteMirror(dir, now);
  assert.deepEqual(b.list().map((m) => [m.id, m.status]), [["r1", "running"]]);
});

test("path safety: link and run ids outside [a-z0-9-]{1,64} are refused or ignored", () => {
  const { mirror, tick } = setup();
  const dir = (mirror as any).dir as string;
  for (const id of ["../x", "a/b", "", "A", "x".repeat(65)]) {
    assert.equal(status(() => mirror.sync({ ...LAPTOP, id }, sync({ runs: [meta("r1")] }))), 400, `link ${JSON.stringify(id)}`);
    assert.equal(mirror.linkStatus(id), null);
    mirror.drop(id);
  }
  assert.equal(fs.existsSync(dir), false, "nothing written for a bad link id");

  const r = mirror.sync(LAPTOP, sync({
    runs: [meta("../x"), meta("a/b"), meta(""), meta("y".repeat(65)), meta("ok")],
    events: [{ runId: "../x", from: 0, events: [ev(0)] }, { runId: "", from: 0, events: [ev(0)] }],
  }));
  assert.deepEqual(r.have, { ok: 0 });
  assert.deepEqual(mirror.list().map((m) => m.id), ["ok"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "link-a", "runs")), ["ok.json"]);
  assert.deepEqual(fs.readdirSync(dir), ["link-a"]);
  mirror.drop("../link-a");
  assert.deepEqual(mirror.list().map((m) => m.id), ["ok"], "a traversal id drops nothing");

  tick(ONLINE_MS);
  mirror.sync({ ...LAPTOP, id: "x".repeat(64) }, sync({}));
  assert.notEqual(mirror.linkStatus("x".repeat(64)), null, "64 characters is fine");
});

test("sync: a batch with an event that isn't an object with a string type is a 400 and writes nothing", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")], events: [{ runId: "r1", from: 0, events: [ev(0)] }] }));
  for (const bad of [null, 0, false, "", [], {}, { type: 1 }]) {
    const s = status(() => mirror.sync(LAPTOP, sync({ runs: [meta("r2")], events: [{ runId: "r1", from: 1, events: [ev(1), bad as any] }] })));
    assert.equal(s, 400, JSON.stringify(bad));
  }
  assert.deepEqual(mirror.events("r1").map((e) => e.uuid), ["u0"]);
  assert.equal(mirror.get("r2"), null, "refused before anything is written");
});

test("sync full: pending commands and errors for pruned runs are discarded", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1"), meta("r2")] }));
  const keep = mirror.command("r1", "queue", { text: "keep" }).remote!.pending[0].id;
  mirror.command("r2", "queue", { text: "gone" });
  const failed = mirror.command("r2", "reply", { text: "fails" }).remote!.pending[1].id;
  mirror.ack(LAPTOP, { id: failed, ok: false, error: "nope" });
  assert.equal(mirror.get("r2")!.remote!.lastError!.message, "nope");

  mirror.sync(LAPTOP, sync({ full: true, runs: [meta("r1")] }));
  const s = fakeRes();
  open(mirror, LAPTOP, s);
  assert.deepEqual(of(s, "command").map((c) => c.id), [keep], "r2's command is never sent");
  mirror.sync(LAPTOP, sync({ runs: [meta("r2")] }));
  assert.deepEqual(mirror.get("r2")!.remote!.pending, [], "nor failed: just gone");
  assert.equal(mirror.get("r2")!.remote!.lastError, null);
  s.end();
});

test("ack: only ok === true is a success, and it clears the run's lastError", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  const a = mirror.command("r1", "reply", { text: "one" }).remote!.pending[0].id;
  mirror.ack(LAPTOP, { id: a, ok: "yes" as any });
  assert.equal(mirror.get("r1")!.remote!.lastError!.message, "It failed on your computer.");
  const b = mirror.command("r1", "reply", { text: "two" }).remote!.pending[0].id;
  mirror.ack(LAPTOP, { id: b, ok: true });
  assert.equal(mirror.get("r1")!.remote!.lastError, null);
  assert.equal(status(() => mirror.ack(LAPTOP, {} as any)), 400);
});

test("openLink publishes each run with pending commands once", () => {
  const { mirror, changes } = setup();
  mirror.sync(LAPTOP, sync({ runs: [meta("r1"), meta("r2")] }));
  mirror.command("r1", "queue", { text: "a" });
  mirror.command("r1", "queue", { text: "b" });
  mirror.command("r2", "queue", { text: "c" });
  changes.length = 0;
  const s = fakeRes();
  open(mirror, LAPTOP, s);
  assert.deepEqual(changes.map((m) => m.id).sort(), ["r1", "r2"]);
  assert.equal(of(s, "command").length, 3);
  s.end();
});

test("list: latest activity first (start, turn start or end), as RunManager", () => {
  const { mirror } = setup();
  mirror.sync(LAPTOP, sync({ runs: [
    meta("old-but-busy", { startedAt: "2026-10-22T08:00:00Z", turnStartedAt: "2026-10-22T09:50:00Z" } as any),
    meta("newer", { startedAt: "2026-10-22T09:00:00Z" }),
    meta("ended", { startedAt: "2026-10-22T07:00:00Z", endedAt: "2026-10-22T09:40:00Z" } as any),
  ] }));
  assert.deepEqual(mirror.list().map((m) => m.id), ["old-but-busy", "ended", "newer"]);
});

test("onListChange: only when the set of mirrored ids changes, at most once per sync", () => {
  let now = Date.parse("2026-10-22T10:00:00Z");
  let n = 0;
  const mirror = new RemoteMirror(tmp(), () => now, { onListChange: () => { n++; } });
  mirror.sync(LAPTOP, sync({ runs: [meta("r1"), meta("r2")] }));
  assert.equal(n, 1, "two new runs, one call");
  mirror.sync(LAPTOP, sync({ runs: [meta("r1"), meta("r2")], events: [{ runId: "r1", from: 0, events: [ev(0)] }] }));
  assert.equal(n, 1, "same ids, new events");
  mirror.sync(LAPTOP, sync({ off: true }));
  assert.equal(n, 1, "off");
  mirror.sync(LAPTOP, sync({ full: true, runs: [meta("r1")] }));
  assert.equal(n, 2, "full omitting r2 prunes it");
  now += ONLINE_MS; // the laptop is stale, so the desktop's sync isn't a 409
  mirror.sync(DESKTOP, sync({ runs: [meta("r1")] }));
  assert.equal(mirror.get("r1")!.remote!.linkId, "link-b");
  assert.equal(n, 3, "a move to another link");
  mirror.drop("link-b");
  assert.equal(n, 3, "drop: main.ts refreshes on revoke itself");
});

// ------------------------------------------------------------ which computer (machine id)

/** As main.ts does it, with the computer's `?machine=`. */
const openOn = (mirror: RemoteMirror, link: LinkInfo, res: FakeRes, machine: string | null) => { mirror.assertCanOpen(link, machine); mirror.openLink(link, res, machine); };

test("machine id: a re-link with a new token on the same computer takes over at once; the old link's runs move or are pruned", () => {
  const { mirror } = setup();
  const a = fakeRes();
  openOn(mirror, LAPTOP, a, "m-laptop");
  mirror.sync(LAPTOP, sync({ full: true, runs: [meta("r1"), meta("r2")], events: [{ runId: "r1", from: 0, events: [ev(0)] }] }));
  const held = mirror.command("r1", "queue", { text: "later" }).remote!.pending[0].id;

  // Right away (the laptop's link is online): a new link token from the same computer.
  const b = fakeRes();
  assert.equal(status(() => openOn(mirror, DESKTOP, b, "m-laptop")), 200);
  assert.equal(a.ended, true, "the old link's stream is ended");
  assert.equal(of(b, "hello")[0].linkId, "link-b");
  assert.equal(mirror.linkStatus("link-a")!.online, false, "the replaced link is offline at once");
  assert.equal(status(() => mirror.sync(LAPTOP, sync({}))), 409, "and can't sync any more");

  mirror.sync(DESKTOP, sync({ full: true, runs: [meta("r1")] }));
  assert.equal(mirror.get("r1")!.remote!.linkId, "link-b");
  assert.deepEqual(mirror.get("r1")!.remote!.pending.map((p) => p.id), [held]);
  assert.deepEqual(mirror.events("r1").map((e) => e.uuid), ["u0"]);
  assert.equal(mirror.get("r2"), null, "the old link's run the computer no longer lists is pruned");
  assert.deepEqual(mirror.remoteLinks().map((l) => [l.linkId, l.online]), [["link-a", false], ["link-b", true]]);

  // The old link opening again from the same computer takes it back the same way.
  const a2 = fakeRes();
  assert.equal(status(() => openOn(mirror, LAPTOP, a2, "m-laptop")), 200);
  assert.equal(b.ended, true);
  assert.equal(status(() => mirror.sync(LAPTOP, sync({}))), 200);
  a2.end();
});

test("machine id: two computers sharing one token: the second gets 409 while the first holds it; nothing is deleted", () => {
  const { mirror, tick } = setup();
  const a = fakeRes();
  openOn(mirror, LAPTOP, a, "m-one");
  mirror.sync(LAPTOP, sync({ full: true, runs: [meta("r1"), meta("r2")] }));
  const b = fakeRes();
  let message = "";
  try { openOn(mirror, LAPTOP, b, "m-two"); } catch (e: any) { assert.equal(e.status, 409); message = e.message; }
  assert.equal(message, "This link is in use on another computer.");
  assert.equal(a.ended, false, "the first keeps its stream");
  assert.equal(b.chunks.length, 0);
  assert.equal(status(() => mirror.sync(LAPTOP, sync({ full: true, runs: [meta("r1"), meta("r2")] }))), 200, "and keeps syncing");
  assert.deepEqual(mirror.list().map((m) => m.id).sort(), ["r1", "r2"]);

  // An older computer (no machine id) on the same link behaves as before: it takes its own link over.
  const old = fakeRes();
  assert.equal(status(() => openOn(mirror, LAPTOP, old, null)), 200);
  assert.equal(a.ended, true);
  old.end();

  // Once the first has gone quiet, the second can take over (a stale stream doesn't hold it).
  const a2 = fakeRes();
  openOn(mirror, LAPTOP, a2, "m-one");
  tick(ONLINE_MS);
  assert.equal(status(() => openOn(mirror, LAPTOP, b, "m-two")), 200);
  assert.equal(a2.ended, true);
  b.end();
});

test("machine id: another computer while one is online gets 409, with or without a machine id; a junk id is ignored", () => {
  const { mirror, tick } = setup();
  const a = fakeRes();
  openOn(mirror, LAPTOP, a, "m-laptop");
  assert.equal(status(() => openOn(mirror, DESKTOP, fakeRes(), "m-desktop")), 409);
  assert.equal(status(() => openOn(mirror, DESKTOP, fakeRes(), null)), 409, "an older computer");
  assert.equal(status(() => openOn(mirror, DESKTOP, fakeRes(), "M-LAPTOP/../x")), 409, "not MACHINE_ID_RE: ignored, so another computer");
  assert.equal(status(() => mirror.sync(DESKTOP, sync({ runs: [meta("d1")] }))), 409);
  assert.equal(a.ended, false);
  tick(ONLINE_MS);
  assert.equal(status(() => openOn(mirror, DESKTOP, fakeRes(), "m-desktop")), 200, "an offline link can still be taken over");
});

test("remoteLinks: each link's live state, kept in memory and read back after a restart; onLinksChange on sync, open and drop", () => {
  const dir = tmp();
  let now = Date.parse("2026-10-22T10:00:00Z");
  let n = 0;
  const mirror = new RemoteMirror(dir, () => now, { onLinksChange: () => { n++; } });
  assert.deepEqual(mirror.remoteLinks(), []);
  mirror.sync(LAPTOP, sync({ runs: [meta("r1")] }));
  assert.equal(n, 1);
  assert.deepEqual(mirror.remoteLinks(), [{ linkId: "link-a", label: "Work laptop", enabled: true, online: true, lastSeenAt: "2026-10-22T10:00:00.000Z" }]);
  now += ONLINE_MS;
  assert.equal(mirror.remoteLinks()[0].online, false);
  const res = fakeRes();
  openOn(mirror, DESKTOP, res, "m-desktop");
  assert.equal(n, 2);
  mirror.sync(DESKTOP, sync({ off: true }));
  assert.equal(n, 3);
  assert.deepEqual(mirror.remoteLinks().map((l) => [l.linkId, l.online, l.enabled]), [["link-a", false, true], ["link-b", true, false]]);

  const again = new RemoteMirror(dir, () => now);
  assert.deepEqual(again.remoteLinks().map((l) => l.linkId), ["link-a", "link-b"], "listed from the folder at start");

  mirror.drop("link-a");
  assert.equal(n, 4);
  assert.deepEqual(mirror.remoteLinks().map((l) => l.linkId), ["link-b"]);
  res.end();
});

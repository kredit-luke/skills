import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { LiveHub } from "../src/live.ts";

/** Enough of a ServerResponse for the hub: what it wrote, and a way to hang up. */
function client() {
  const res = Object.assign(new EventEmitter(), {
    chunks: [] as string[],
    writeHead() { return res; },
    write(s: string) { res.chunks.push(s); return true; },
  });
  const events = (name: string) => res.chunks.filter((c) => c.startsWith(`event: ${name}\n`)).map((c) => JSON.parse(c.split("\ndata: ")[1]));
  return { res: res as unknown as ServerResponse, events, close: () => res.emit("close") };
}

/** A loader the test finishes itself, so nothing depends on timing. */
function held<T>() {
  const calls: ((v: T) => void)[] = [];
  return { load: () => new Promise<T>((r) => calls.push(r)), calls };
}

test("live: a topic is sent only when its JSON changes", async () => {
  const hub = new LiveHub();
  let value = { n: 1 };
  hub.register("t", () => value, 0);
  const c = client();
  hub.subscribe(c.res);
  await hub.refresh("t");
  await hub.refresh("t");
  assert.deepEqual(c.events("t"), [{ n: 1 }]);
  value = { n: 2 };
  await hub.refresh("t");
  assert.deepEqual(c.events("t"), [{ n: 1 }, { n: 2 }]);
  c.close();
});

test("live: nothing loads while nobody is connected", async () => {
  const hub = new LiveHub();
  let loads = 0;
  hub.register("t", () => ++loads, 0);
  await hub.refresh("t");
  assert.equal(loads, 0);
  const c = client();
  hub.subscribe(c.res); // the first client loads every topic
  await hub.refresh("t");
  assert.ok(loads >= 1);
  c.close();
  const before = loads;
  await hub.refresh("t");
  assert.equal(loads, before);
});

test("live: a refresh during a load waits for it, then loads once more", async () => {
  const hub = new LiveHub();
  const h = held<number>();
  hub.register("t", h.load, 0);
  const c = client();
  hub.subscribe(c.res); // load 1 starts
  hub.refresh("t");
  hub.refresh("t");
  assert.equal(h.calls.length, 1, "no second load while the first is running");
  h.calls[0](1);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 2, "one follow-up load for the refreshes that arrived mid-load");
  h.calls[1](2);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 2);
  assert.deepEqual(c.events("t"), [1, 2]);
  c.close();
});

test("live: a new client gets the last payloads straight away", async () => {
  const hub = new LiveHub();
  const h = held<string>();
  hub.register("t", h.load, 0);
  const a = client();
  hub.subscribe(a.res);
  h.calls[0]("first");
  await new Promise((r) => setImmediate(r));
  const b = client();
  hub.subscribe(b.res); // sent from the cache, before any load finishes
  assert.deepEqual(b.events("t"), ["first"]);
  a.close();
  b.close();
});

test("live: publish goes to connected clients only and isn't replayed", () => {
  const hub = new LiveHub();
  hub.publish("run", { id: "x" }); // nobody connected: dropped
  const a = client();
  hub.subscribe(a.res);
  hub.publish("run", { id: "y" });
  assert.deepEqual(a.events("run"), [{ id: "y" }]);
  const b = client();
  hub.subscribe(b.res);
  assert.deepEqual(b.events("run"), []);
  a.close();
  b.close();
});

test("live: a new timestamp alone isn't a change", async () => {
  const hub = new LiveHub();
  let n = 0;
  hub.register("t", () => ({ up: true, timestamp: String(++n) }), 0);
  const c = client();
  hub.subscribe(c.res);
  await hub.refresh("t");
  await hub.refresh("t");
  assert.equal(c.events("t").length, 1);
  c.close();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Routine } from "../../shared/api.ts";
import { Routines, Scheduler, checkRoutine, describeSchedule, dueSlot, nextFire, routineId } from "../src/routines.ts";

// Local times, so the tests hold in any time zone. 2026-11-09 is a Monday.
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m, 0, 0);
const r = (o: Partial<Routine>): Routine => checkRoutine({ id: "r", prompt: "Do it.", ...o });

// ------------------------------------------------------------ checking

test("checkRoutine: tidies a good routine and says what's wrong with a bad one", () => {
  assert.deepEqual(checkRoutine({ id: "brief", preset: "brief", at: "8:30", days: "weekdays", mode: "fresh", extra: 1 }), { id: "brief", enabled: true, preset: "brief", at: "08:30", days: "weekdays" });
  assert.deepEqual(checkRoutine({ id: "q", prompt: " Check. ", every: "2h", between: "08:00-18:00", days: ["Monday", "fri"], mode: "continue", enabled: false }),
    { id: "q", enabled: false, prompt: "Check.", every: "2h", between: "08:00-18:00", days: ["mon", "fri"], mode: "continue" });
  const bad: [any, RegExp][] = [
    [{ id: "Bad Id", prompt: "x", at: "09:00" }, /id/],
    [{ id: "a", at: "09:00" }, /prompt or a preset/],
    [{ id: "a", prompt: "x", preset: "p", at: "09:00" }, /not both/],
    [{ id: "a", prompt: "x" }, /when the routine runs/],
    [{ id: "a", prompt: "x", at: "25:00" }, /isn't a time/],
    [{ id: "a", prompt: "x", every: "5m" }, /15 minutes to 24 hours/],
    [{ id: "a", prompt: "x", every: "1h", between: "9-5" }, /time window/],
    [{ id: "a", prompt: "x", at: "09:00", days: ["nope"] }, /at least one day/],
    [{ id: "a", prompt: "x", at: "09:00", effort: "huge" }, /effort/],
    [{ id: "a", preset: "missing", at: "09:00" }, /Unknown preset/],
  ];
  for (const [input, re] of bad) assert.throws(() => checkRoutine(input, { presets: ["brief"] }), re, JSON.stringify(input));
});

test("describeSchedule and routineId", () => {
  assert.equal(describeSchedule({ at: "08:30", days: "weekdays" }), "Weekdays at 08:30");
  assert.equal(describeSchedule({ every: "2h", between: "08:00-18:00", days: "weekdays" }), "Every 2 h, 08:00-18:00, weekdays");
  assert.equal(describeSchedule({ every: "90m" }), "Every 1 h 30 min");
  assert.equal(routineId("Morning brief!"), "morning-brief");
});

// ------------------------------------------------------------ slots

test("dueSlot: an `at` slot is due for its catch-up time on its days only", () => {
  const brief = r({ at: "08:30", days: "weekdays" });
  assert.equal(dueSlot(brief, at(9, 8, 29)), null);
  assert.equal(dueSlot(brief, at(9, 8, 30))!.getTime(), at(9, 8, 30).getTime());
  assert.equal(dueSlot(brief, at(9, 8, 40))!.getTime(), at(9, 8, 30).getTime());
  assert.equal(dueSlot(brief, at(9, 8, 41)), null); // past the default 10 minutes
  assert.equal(dueSlot({ ...brief, catchUpMinutes: 120 }, at(9, 10, 0))!.getTime(), at(9, 8, 30).getTime());
  assert.equal(dueSlot(brief, at(8, 8, 30)), null); // Sunday
  // A slot just before midnight is still reachable just after it.
  assert.equal(dueSlot(r({ at: "23:55" }), at(10, 0, 3))!.getTime(), at(9, 23, 55).getTime());
});

test("dueSlot and nextFire: interval slots line up with midnight and stay inside `between`", () => {
  const q = r({ every: "2h", between: "08:00-18:00", days: "weekdays" });
  assert.equal(dueSlot(q, at(9, 9, 59))!.getTime(), at(9, 8).getTime());
  assert.equal(dueSlot(q, at(9, 10, 0))!.getTime(), at(9, 10).getTime());
  assert.equal(dueSlot(q, at(9, 19, 0)), null); // 18:00 isn't in the window, 16:00 is over an interval ago
  assert.equal(nextFire(q, at(9, 10, 0))!.getTime(), at(9, 12).getTime());
  assert.equal(nextFire(q, at(13, 17, 0))!.getTime(), at(16, 8).getTime()); // Friday evening → Monday 08:00
  assert.equal(nextFire(r({ at: "07:00", days: ["wed"] }), at(9, 12))!.getTime(), at(11, 7).getTime());
});

// ------------------------------------------------------------ your routines and the team's

function files(team: any[] = [], presets = [{ id: "brief" }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-routines-"));
  const store = new Routines(path.join(dir, "ledger", "routines.json"), () => ({ routines: team, presets }));
  return { dir, store, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("Routines: yours are created, changed and removed; a team one can only be switched off for you", () => {
  const f = files([{ id: "brief", preset: "brief", at: "08:30", days: "weekdays", enabled: true }, { id: "broken", at: "08:00", enabled: true }]);
  try {
    const mine = f.store.save({ label: "Queue check", prompt: "Check the queue.", every: "1h" });
    assert.equal(mine.id, "queue-check");
    assert.equal(f.store.save({ label: "Queue check", prompt: "Again.", every: "1h" }).id, "queue-check-2");
    f.store.save({ id: "queue-check", label: "Queue check", prompt: "Check it twice.", every: "30m" });
    assert.equal(f.store.get("queue-check")!.routine.prompt, "Check it twice.");
    assert.throws(() => f.store.save({ id: "brief", prompt: "x", at: "09:00" }), /team's routines/);
    assert.throws(() => f.store.save({ id: "ghost", prompt: "x", at: "09:00" }), /No routine ghost/);

    const list = f.store.list();
    assert.deepEqual(list.map((x) => [x.routine.id, x.source]), [["brief", "team"], ["broken", "team"], ["queue-check", "personal"], ["queue-check-2", "personal"]]);
    assert.match(list[1].problem!, /prompt or a preset/);
    assert.equal(list[1].routine.enabled, false);

    f.store.setEnabled("brief", false);
    assert.equal(f.store.get("brief")!.routine.enabled, false);
    assert.equal(f.store.get("brief")!.overridden, true);
    f.store.setEnabled("brief", true); // back to the team's setting: no override left
    assert.deepEqual(f.store.personal().team, {});
    assert.throws(() => f.store.remove("brief"), /deck\.json/);
    f.store.remove("queue-check-2");
    assert.equal(f.store.get("queue-check-2"), null);
  } finally { f.done(); }
});

test("Routines: a team routine without \"enabled\" stays off (deck.json routines are opt-in); one you create is on", () => {
  const f = files([{ id: "legacy", preset: "brief", at: "08:30" }]);
  try {
    assert.equal(f.store.get("legacy")!.routine.enabled, false);
    assert.equal(f.store.save({ label: "Mine", prompt: "x", at: "09:00" }).enabled, true);
    f.store.setEnabled("legacy", true);
    assert.equal(f.store.get("legacy")!.routine.enabled, true);
    assert.deepEqual(f.store.personal().team, { legacy: { enabled: true } });
    f.store.setEnabled("legacy", false); // back to the team's (off): no override left
    assert.deepEqual(f.store.personal().team, {});
  } finally { f.done(); }
});

test("checkRoutine: a local or team model is fine (launch checks it's available)", () => {
  assert.equal(checkRoutine({ id: "a", prompt: "x", at: "09:00", model: "local/qwen3.8:27b" }).model, "local/qwen3.8:27b");
  assert.equal(checkRoutine({ id: "a", prompt: "x", at: "09:00", model: "team/gpu-box/llama-4:70b" }).model, "team/gpu-box/llama-4:70b");
  assert.throws(() => checkRoutine({ id: "a", prompt: "x", at: "09:00", model: "--bare" }), /Invalid model/);
});

test("dueSlot: no catch-up still gives the 30 s scheduler a minute to catch the slot", () => {
  const exact = r({ at: "09:00", catchUpMinutes: 0 });
  assert.equal(dueSlot(exact, at(9, 9, 0))!.getTime(), at(9, 9).getTime());
  assert.equal(dueSlot(exact, new Date(at(9, 9).getTime() + 29000))!.getTime(), at(9, 9).getTime());
  assert.equal(dueSlot(exact, at(9, 9, 2)), null);
});

// ------------------------------------------------------------ the scheduler

function scheduler(team: any[]) {
  const f = files(team);
  const fired: { id: string; last: string | null }[] = [];
  const busy = new Map<string, string>();
  let n = 0;
  let fail: string | null = null;
  const s = new Scheduler(f.store, path.join(f.dir, "state.json"), {
    fire: (routine, last) => {
      fired.push({ id: routine.id, last });
      if (fail) return { ok: false, error: fail };
      return { ok: true, runId: routine.mode === "continue" && last ? last : `run-${++n}` };
    },
    busy: (id) => busy.get(id) || null,
  });
  return { ...f, s, fired, busy, failWith: (e: string | null) => { fail = e; } };
}

test("Scheduler: an `at` routine fires once per slot, also after a restart", () => {
  const t = scheduler([{ id: "brief", preset: "brief", at: "08:30", days: "weekdays", enabled: true }]);
  try {
    t.s.tick(at(9, 8, 29));
    assert.equal(t.fired.length, 0);
    t.s.tick(at(9, 8, 31));
    t.s.tick(at(9, 8, 35));
    assert.equal(t.fired.length, 1);
    const again = new Scheduler(t.store, path.join(t.dir, "state.json"), { fire: () => { throw new Error("fired twice"); }, busy: () => null });
    again.tick(at(9, 8, 36));
    t.s.tick(at(10, 8, 30));
    assert.equal(t.fired.length, 2);
    const v = t.s.view(at(10, 9))[0];
    assert.equal(v.last!.runId, "run-2");
    assert.equal(v.schedule, "Weekdays at 08:30");
    assert.equal(v.nextAt, at(11, 8, 30).toISOString());
  } finally { t.done(); }
});

test("Scheduler: a new interval routine starts with the next slot, and a missed slot catches up once", () => {
  const t = scheduler([{ id: "q", prompt: "Check.", every: "1h", enabled: true }]);
  try {
    t.s.tick(at(9, 10, 20)); // first sighting: records the 10:00 slot without firing
    assert.equal(t.fired.length, 0);
    t.s.tick(at(9, 11, 0));
    assert.equal(t.fired.length, 1);
    // Asleep 11:30 to 14:40: the 14:00 slot fires once, the ones before are gone.
    t.s.tick(at(9, 14, 40));
    t.s.tick(at(9, 14, 50));
    assert.equal(t.fired.length, 2);
  } finally { t.done(); }
});

test("Scheduler: an interval routine first seen outside its window fires on the window's first slot", () => {
  const t = scheduler([{ id: "w", prompt: "Check.", every: "2h", between: "08:00-18:00", enabled: true }]);
  try {
    t.s.tick(at(9, 7, 30)); // before the window: nothing due, but the schedule is recorded
    assert.equal(t.fired.length, 0);
    assert.equal(t.s.view(at(9, 7, 30))[0].nextAt, at(9, 8).toISOString());
    t.s.tick(at(9, 8, 0));
    assert.equal(t.fired.length, 1, "08:00 runs, as nextAt said");
  } finally { t.done(); }
});

test("Scheduler: a slot is skipped while the last run is busy; continue gets the last run", () => {
  const t = scheduler([{ id: "c", prompt: "Carry on.", at: "09:00", mode: "continue", enabled: true }]);
  try {
    t.s.tick(at(9, 9, 0));
    assert.deepEqual(t.fired[0], { id: "c", last: null });
    t.busy.set("run-1", "waiting on your answer");
    t.s.tick(at(10, 9, 0));
    assert.equal(t.fired.length, 1);
    const v = t.s.view(at(10, 9, 1))[0];
    assert.match(v.last!.skipped!, /waiting on your answer/);
    t.busy.clear();
    t.s.tick(at(10, 9, 5)); // the same slot isn't tried again
    assert.equal(t.fired.length, 1);
    t.s.tick(at(11, 9, 0));
    assert.deepEqual(t.fired[1], { id: "c", last: "run-1" });
    assert.equal(t.s.view(at(11, 9, 1))[0].last!.skipped, null);
  } finally { t.done(); }
});

test("Scheduler: a failed start is kept with its error; Run now fires off schedule; disabled and broken ones never fire", () => {
  const t = scheduler([
    { id: "a", prompt: "A.", at: "09:00", enabled: true },
    { id: "off", prompt: "Off.", at: "09:00", enabled: false },
    { id: "broken", at: "09:00", enabled: true },
  ]);
  try {
    t.failWith("Already 3 runs in flight");
    t.s.tick(at(9, 9, 0));
    assert.deepEqual(t.fired.map((x) => x.id), ["a"]);
    const v = t.s.view(at(9, 9, 1)).find((x) => x.id === "a")!;
    assert.equal(v.last!.ok, false);
    assert.match(v.last!.error!, /3 runs/);
    t.failWith(null);
    const last = t.s.runNow("off", at(9, 10));
    assert.equal(last.manual, true);
    assert.equal(last.runId, "run-1");
    assert.throws(() => t.s.runNow("broken"), /prompt or a preset/);
    t.busy.set("run-1", "still working");
    assert.throws(() => t.s.runNow("off"), /still working/);
  } finally { t.done(); }
});

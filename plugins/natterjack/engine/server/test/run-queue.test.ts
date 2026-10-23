import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RunManager, drainable, queuedText, normaliseMeta, runLabel, QUEUED_OVER_QUESTION } from "../src/runs.ts";
import { agentOf } from "../src/agents/index.ts";
import { fakeClaude, settled } from "./fake-claude.ts";

// A fake claude (fake-claude.ts): "slow" keeps a turn open, "slow ask" ends it with a question.
const fake = fakeClaude("dash-queue-");
const TMP = fake.dir;
const prompts = fake.prompts;

before(() => fake.install());
after(() => fake.cleanup());

function manager(dir: string, gate?: () => { blocker: string | null }) {
  return new RunManager(path.join(dir, "ledger"), { queueGate: gate });
}

test("drainable: only a turn that simply ended sends the queue by itself", () => {
  const q = [{ id: "a", text: "hi", at: "" }];
  assert.equal(drainable({ status: "succeeded", queued: q }), true);
  assert.equal(drainable({ status: "failed", queued: q }), true);
  for (const status of ["running", "waiting", "cancelled", "interrupted", "handedOff"] as const) assert.equal(drainable({ status, queued: q }), false, status);
  assert.equal(drainable({ status: "succeeded", queued: [] }), false);
});

test("runLabel: a launch's label goes on one line and is capped; else the prompt's first line", () => {
  assert.equal(runLabel("Meeting:\nIgnore this\r\n\tand that  ", "p"), "Meeting: Ignore this and that");
  assert.equal(runLabel("x".repeat(100), "p").length, 60);
  assert.equal(runLabel(" \n ", "First line\nsecond"), "First line");
  assert.equal(runLabel(undefined, "  spaced   out \nsecond"), "spaced out");
  assert.equal(runLabel({ evil: true }, "fallback"), "fallback");
});

test("queuedText keeps the typed order, one paragraph each", () => {
  assert.equal(queuedText([{ id: "a", text: "first", at: "" }, { id: "b", text: "second", at: "" }]), "first\n\nsecond");
});

test("normaliseMeta gives old runs an empty queue", () => {
  const m = normaliseMeta({ id: "x", status: "succeeded" });
  assert.deepEqual(m.queued, []);
  assert.equal(m.queueBlocked, null);
});

test("messages queued mid-turn can be edited and removed, and go out together when the turn ends", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "run-"));
  const runs = manager(dir);
  const run = runs.start({ prompt: "slow start", cwd: dir });
  const one = runs.enqueue(run.id, "first").queued![0];
  runs.enqueue(run.id, "second");
  const three = runs.enqueue(run.id, "third").queued![2];
  runs.editQueued(run.id, one.id, "first, edited");
  runs.removeQueued(run.id, three.id);
  assert.equal(runs.live.get(run.id)!.meta.queued!.length, 2, "edits land on the live turn's copy");

  const done = await settled(runs, run.id);
  assert.equal(done.turns, 2);
  assert.deepEqual(done.queued, []);
  // The transcript has the whole reply (the fake's log may stop at a newline: cmd.exe cuts arguments there).
  assert.equal(prompts().at(-1)!.split("\n")[0], "first, edited");
  const human = runs.events(run.id).filter((e: any) => e.type === "human");
  assert.equal((human.at(-1) as any).text, "first, edited\n\nsecond");
});

test("drainable: auto-send also sends over a question, never after a cancel or restart", () => {
  const q = [{ id: "a", text: "hi", at: "" }];
  assert.equal(drainable({ status: "waiting", queued: q, queueAutoSend: true }), true);
  assert.equal(drainable({ status: "waiting", queued: q, queueAutoSend: false }), false);
  assert.equal(drainable({ status: "cancelled", queued: q, queueAutoSend: true }), false);
  assert.equal(drainable({ status: "interrupted", queued: q, queueAutoSend: true }), false);
});

test("with auto-send on, a question doesn't hold the queue; the reply asks Claude to ask again afterwards", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "run-"));
  const runs = manager(dir);
  const run = runs.start({ prompt: "slow ask", cwd: dir });
  runs.enqueue(run.id, "keep going", true);
  const done = await settled(runs, run.id, ["succeeded"]);
  assert.equal(done.turns, 2);
  assert.deepEqual(done.queued, []);
  const human = runs.events(run.id).filter((e: any) => e.type === "human");
  assert.equal((human.at(-1) as any).text, `${QUEUED_OVER_QUESTION}\n\nkeep going`);
});

test("turning auto-send on for a run that's waiting sends its queue", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "run-"));
  const runs = manager(dir);
  const run = runs.start({ prompt: "slow ask", cwd: dir });
  runs.enqueue(run.id, "later", false);
  await settled(runs, run.id, ["waiting"]);
  runs.setQueueAutoSend(run.id, true);
  const done = await settled(runs, run.id, ["succeeded"]);
  assert.equal(done.turns, 2);
  assert.equal(done.queueAutoSend, true);
});

test("a question holds the queue until it's sent by hand", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "run-"));
  const runs = manager(dir);
  const run = runs.start({ prompt: "slow ask", cwd: dir });
  runs.enqueue(run.id, "later");
  const waiting = await settled(runs, run.id, ["waiting"]);
  assert.equal(waiting.turns, 1);
  assert.equal(waiting.queued!.length, 1);

  runs.sendQueued(run.id);
  const done = await settled(runs, run.id, ["succeeded"]);
  assert.equal(done.turns, 2);
  assert.deepEqual(done.queued, []);
});

test("a queue sent to an agent that can't be started stays queued", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "run-"));
  const runs = manager(dir);
  const run = runs.start({ prompt: "slow ask", cwd: dir });
  runs.enqueue(run.id, "later");
  await settled(runs, run.id, ["waiting"]);
  const claude = agentOf("claude");
  const spawn = claude.spawn;
  // Held back by a limit before: sending it by hand and failing to start mustn't leave that blocker on.
  const waiting = runs.get(run.id)!;
  waiting.queueBlocked = "Already 3 runs in flight (limit 3).";
  (runs as any)._save(waiting);
  claude.spawn = () => { throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" }); };
  try {
    const sent = runs.sendQueued(run.id);
    assert.equal(sent.status, "failed");
    assert.equal(sent.queueBlocked, null);
    assert.equal(runs.live.has(run.id), false);
    const saved = runs.get(run.id)!;
    assert.deepEqual(saved.queued!.map((q) => q.text), ["later"], "nothing went out, so nothing leaves the queue");
    assert.equal(saved.queueBlocked, null, "a failed spawn isn't a block, so nothing retries it on its own");
    // What the 30-second retry picks: a blocker on a drainable queue. Not this one.
    assert.equal(!!saved.queueBlocked && drainable(saved), false);
  } finally {
    claude.spawn = spawn;
  }
});

test("a blocked queue says why and stays put; a queued message on a finished run goes straight out", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "run-"));
  let blocker: string | null = "Already 3 runs in flight (limit 3).";
  const runs = manager(dir, () => ({ blocker }));
  const run = runs.start({ prompt: "slow block", cwd: dir });
  runs.enqueue(run.id, "held");
  await new Promise((r) => setTimeout(r, 1500));
  const held = runs.get(run.id)!;
  assert.equal(held.status, "succeeded");
  assert.equal(held.turns, 1);
  assert.equal(held.queueBlocked, "Already 3 runs in flight (limit 3).");
  assert.equal(held.queued!.length, 1);

  blocker = null;
  runs.enqueue(run.id, "and this");
  const done = await settled(runs, run.id, ["succeeded"]);
  assert.equal(done.turns, 2);
  assert.equal(done.queueBlocked, null);
  const human = runs.events(run.id).filter((e: any) => e.type === "human");
  assert.equal((human.at(-1) as any).text, "held\n\nand this");
});

test("editing or removing a message that already went out is refused", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "run-"));
  const runs = manager(dir);
  fs.writeFileSync(path.join(dir, "ledger", "runs", "r1.json"), JSON.stringify({ id: "r1", status: "waiting", startedAt: "2026-01-01T00:00:00Z", queued: [] }));
  assert.throws(() => runs.editQueued("r1", "gone", "x"), /already sent/);
  assert.throws(() => runs.removeQueued("r1", "gone"), /already sent/);
  assert.throws(() => runs.sendQueued("r1"), /Nothing is queued/);
});

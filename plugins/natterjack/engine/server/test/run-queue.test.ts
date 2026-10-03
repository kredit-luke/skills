import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, drainable, queuedText, normaliseMeta, QUEUED_OVER_QUESTION } from "../src/runs.ts";
import type { RunMeta } from "../../shared/api.ts";

// A fake claude: each turn writes its prompt to a log and ends with a result.
// A prompt containing "slow" keeps the turn open for a moment, so messages can be
// queued while it works; "slow ask" ends the turn with a question.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-queue-"));
const LOG = path.join(TMP, "prompts.log");
const FAKE = `
import fs from "node:fs";
const a = process.argv.slice(2);
const prompt = a[a.indexOf("-p") + 1] || "";
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(prompt) + "\\n");
const result = prompt.includes("slow ask") ? 'Which one? <<QUESTION>>{"questions":[{"question":"Which?","header":"Pick","multiSelect":false,"options":[{"label":"A","description":""}]}]}<</QUESTION>>' : "done";
setTimeout(() => {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0, num_turns: 1 }));
  process.exit(0);
}, prompt.includes("slow") ? 700 : 10);
`;

before(() => {
  const bin = path.join(TMP, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "fake-claude.mjs"), FAKE);
  const file = process.platform === "win32" ? path.join(bin, "claude.cmd") : path.join(bin, "claude");
  if (process.platform === "win32") fs.writeFileSync(file, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, { mode: 0o755 });
  process.env.DASHBOARD_CLAUDE_BIN = file;
});

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const prompts = (): string[] => {
  try { return fs.readFileSync(LOG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

/** Resolves once the run is idle in one of `statuses` (a drain may start another turn first). */
function settled(runs: RunManager, id: string, statuses = ["succeeded", "failed", "waiting", "cancelled"], ms = 15000): Promise<RunMeta> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const m = runs.get(id);
      if (m && !runs.live.has(id) && statuses.includes(m.status) && !drainable(m)) return resolve(m);
      if (Date.now() > end) return reject(new Error(`run ${id} still ${m && m.status}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

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

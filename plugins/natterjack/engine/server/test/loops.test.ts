import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunMeta } from "../../shared/api.ts";
import { findBlock, stripBlock } from "../../shared/blocks.ts";
import { daysLabel, formatMinutes, inWindow, parseDuration, parseWindow, routineDays } from "../../shared/loops.ts";
import { RunManager, applyRoutineBlock, applyWatchBlock, parseWatch } from "../src/runs.ts";
import { Watcher, commandAllowed, findBash, makeRunCommand, type RunCommand } from "../src/watches.ts";
import { loopRules } from "../src/agents/util.ts";

const T0 = new Date("2026-10-02T10:00:00Z");
const later = (min: number) => new Date(T0.getTime() + min * 60000);

// ------------------------------------------------------------ shared helpers

test("parseDuration reads minutes, hours, days and mixes; formatMinutes says them back", () => {
  assert.equal(parseDuration("15m"), 15);
  assert.equal(parseDuration("15min"), 15);
  assert.equal(parseDuration("2h"), 120);
  assert.equal(parseDuration("1h30m"), 90);
  assert.equal(parseDuration("1 day"), 1440);
  assert.equal(parseDuration("45"), 45);
  assert.equal(parseDuration(30), 30);
  for (const bad of ["", "soon", "0", "-5m", "2.5h", "5x", 0, 1.5, null]) assert.equal(parseDuration(bad), null, String(bad));
  assert.equal(formatMinutes(90), "1 h 30 min");
  assert.equal(formatMinutes(15), "15 min");
  assert.equal(formatMinutes(1440), "1 day");
});

test("windows and days", () => {
  assert.deepEqual(parseWindow("08:00-18:00"), [480, 1080]);
  assert.equal(parseWindow("8-18"), null);
  assert.ok(inWindow(480, [480, 1080]) && !inWindow(1080, [480, 1080]));
  assert.ok(inWindow(30, [1320, 120]) && !inWindow(600, [1320, 120])); // past midnight
  assert.deepEqual(routineDays("weekdays"), ["mon", "tue", "wed", "thu", "fri"]);
  assert.deepEqual(routineDays(["Monday", "thu", "nope"]), ["mon", "thu"]);
  assert.equal(daysLabel(undefined), "Daily");
  assert.equal(daysLabel(["sat", "sun"]), "Weekends");
  assert.equal(daysLabel(["thu", "mon"]), "Mon, Thu");
});

test("blocks: a marker in code is text, so mentioning one doesn't cut the answer off", () => {
  const mention = "The dashboard strips the `<<WATCH>>` marker, then shows the rest.\n\nMore text here.";
  assert.equal(findBlock(mention, "WATCH"), null);
  assert.equal(stripBlock(mention, "WATCH"), mention);
  const real = 'Proposed.\n<<ROUTINE>>\n{"label":"x"}\n<</ROUTINE>>\nAfter.';
  assert.equal(stripBlock(real, "ROUTINE"), "Proposed.\nAfter.");
});

test("the loop rules name every kind and the routine block", () => {
  const rules = loopRules("CronCreate");
  for (const s of ['"prs"', '"command"', '"until"', '"every"', '"noop":true', '"stop":true', "<<ROUTINE>>", "approves the command"]) assert.ok(rules.includes(s), s);
});

// ------------------------------------------------------------ parsing

test("parseWatch: an interval loop", () => {
  const w = parseWatch('<<WATCH>>{"every":"30m","prompt":"Check staging.","days":3}<</WATCH>>') as any;
  assert.deepEqual(w, { kind: "every", everyMinutes: 30, days: 3, prompt: "Check staging." });
  assert.match((parseWatch('<<WATCH>>{"every":"5m","prompt":"x"}<</WATCH>>') as any).error, /10 minutes to 24 hours/);
  assert.match((parseWatch('<<WATCH>>{"every":"soon","prompt":"x"}<</WATCH>>') as any).error, /interval/);
  assert.match((parseWatch('<<WATCH>>{"every":"1h"}<</WATCH>>') as any).error, /no prompt/);
  assert.equal((parseWatch('<<WATCH>>{"every":"1h","prompt":"x","days":30}<</WATCH>>') as any).days, 7);
});

test("parseWatch: a command check", () => {
  const w = parseWatch('<<WATCH>>{"command":"gh run view 1 --json status -q .status","until":"success","every":"3m"}<</WATCH>>') as any;
  assert.equal(w.kind, "check");
  assert.equal(w.until, "success");
  assert.equal(w.everyMinutes, 3);
  assert.equal(w.days, 1);
  assert.match(w.prompt, /changed/);
  assert.equal((parseWatch('<<WATCH>>{"command":"ls"}<</WATCH>>') as any).until, "change");
  assert.match((parseWatch('<<WATCH>>{"command":"ls","until":"later"}<</WATCH>>') as any).error, /until/);
  assert.match((parseWatch('<<WATCH>>{"kind":"check"}<</WATCH>>') as any).error, /no command/);
  assert.deepEqual(parseWatch('<<WATCH>>{"noop":true}<</WATCH>>'), { noop: true });
});

test("applyWatchBlock: noop counts quiet wake-ups, other turns reset the count", () => {
  const meta = { watch: null } as unknown as RunMeta;
  applyWatchBlock(meta, '<<WATCH>>{"every":"20m","prompt":"Look."}<</WATCH>>', T0);
  assert.equal(meta.watch!.kind, "every");
  assert.equal(meta.watch!.nextCheckAt, later(20).toISOString()); // this turn was the first pass
  applyWatchBlock(meta, 'Nothing new.\n<<WATCH>>{"noop":true}<</WATCH>>', later(20));
  applyWatchBlock(meta, '<<WATCH>>{"noop":true}<</WATCH>>', later(40));
  assert.equal(meta.watch!.quiet, 2);
  assert.equal(meta.watch!.endedAt, null);
  applyWatchBlock(meta, "Found something: ...", later(60));
  assert.equal(meta.watch!.quiet, 0);
  // noop with no watch on does nothing
  const none = { watch: null } as unknown as RunMeta;
  applyWatchBlock(none, '<<WATCH>>{"noop":true}<</WATCH>>', T0);
  assert.equal(none.watch, null);
});

test("applyWatchBlock: a check starts pending; the same command keeps its approval and last result, a new one doesn't", () => {
  const meta = { watch: null } as unknown as RunMeta;
  applyWatchBlock(meta, '<<WATCH>>{"command":"cat status.txt"}<</WATCH>>', T0);
  assert.equal(meta.watch!.approval, "pending");
  meta.watch!.approval = "approved";
  meta.watch!.lastResult = { exitCode: 0, output: "busy", at: T0.toISOString() };
  applyWatchBlock(meta, '<<WATCH>>{"command":"cat status.txt","everyMinutes":10}<</WATCH>>', later(1));
  assert.equal(meta.watch!.approval, "approved");
  assert.equal(meta.watch!.lastResult!.output, "busy");
  assert.equal(meta.watch!.everyMinutes, 10);
  applyWatchBlock(meta, '<<WATCH>>{"command":"rm -rf /"}<</WATCH>>', later(2));
  assert.equal(meta.watch!.approval, "pending");
  assert.equal(meta.watch!.lastResult, null);
});

test("commandAllowed: whole-command patterns from deck.json; bad ones allow nothing", () => {
  assert.ok(commandAllowed("gh run view 12 --json status", ["gh run view \\d+ --json status"]));
  assert.ok(!commandAllowed("gh run view 12 --json status; rm x", ["gh run view \\d+ --json status"]));
  assert.ok(!commandAllowed("ls", ["("]));
  assert.ok(!commandAllowed("ls", undefined));
});

test("findBash: Git Bash next to git on Windows, never System32's WSL launcher", { skip: process.platform !== "win32" }, () => {
  const files = new Set(["C:\\Tools\\Git\\cmd\\git.exe", "C:\\Tools\\Git\\bin\\bash.exe", "C:\\Windows\\System32\\bash.exe"]);
  const found = findBash({ PATH: "C:\\Windows\\System32;C:\\Tools\\Git\\cmd" }, (p) => files.has(path.resolve(String(p))));
  assert.equal(path.resolve(found!), "C:\\Tools\\Git\\bin\\bash.exe");
  assert.equal(findBash({ PATH: "C:\\Windows\\System32" }, (p) => files.has(path.resolve(String(p)))), null);
});

// ------------------------------------------------------------ routine proposals

test("applyRoutineBlock: the run fills in workspace and model; a bad block is kept with its error", () => {
  const meta = { workspace: "main", model: "opus", effort: "medium", routineProposal: null } as unknown as RunMeta;
  applyRoutineBlock(meta, 'Want this daily?\n<<ROUTINE>>\n{"label":"Morning brief","prompt":"Brief me.","at":"8:30","days":"weekdays"}\n<</ROUTINE>>', T0);
  const p = meta.routineProposal!;
  assert.equal(p.error, null);
  assert.deepEqual(p.routine, { label: "Morning brief", prompt: "Brief me.", at: "08:30", days: "weekdays", workspace: "main", model: "opus", effort: "medium" });
  applyRoutineBlock(meta, '<<ROUTINE>>{"label":"x","prompt":"y"}<</ROUTINE>>', T0);
  assert.match(meta.routineProposal!.error!, /when the routine runs/);
  assert.equal(meta.routineProposal!.routine.prompt, "y");
  applyRoutineBlock(meta, "No block this time.", T0);
  assert.equal(meta.routineProposal!.routine.prompt, "y"); // stays until the next block
});

// ------------------------------------------------------------ the watcher

function setup(block: string, opts: { allow?: (c: string) => boolean; run?: RunCommand } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-loops-"));
  const runs = new RunManager(dir);
  const meta: any = { id: "r1", sessionId: "s1", status: "succeeded", permissionMode: "auto", cwd: dir, startedAt: T0.toISOString(), endedAt: T0.toISOString(), watch: null };
  applyWatchBlock(meta, block, T0);
  fs.writeFileSync(path.join(dir, "runs", "r1.json"), JSON.stringify(meta));
  const wakes: string[] = [];
  const commands: string[] = [];
  let blocker: string | null = null;
  const out = { exitCode: 1, output: "running" };
  const run: RunCommand = opts.run || (async (command, cwd) => { commands.push(command); assert.equal(cwd, dir); return { ...out }; });
  const watcher = new Watcher(runs, {
    gh: async () => { throw new Error("no gh in these tests"); },
    runCommand: run,
    allowCommand: opts.allow,
    wake: (_id, text) => { if (blocker) return blocker; wakes.push(text); return null; },
  });
  return { dir, runs, watcher, wakes, commands, out, block: (b: string | null) => { blocker = b; }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("watcher: an interval loop wakes every interval, and a blocked wake-up retries", async () => {
  const t = setup('<<WATCH>>{"every":"15m","prompt":"Check the queue."}<</WATCH>>');
  try {
    await t.watcher.tick(later(10));
    assert.equal(t.wakes.length, 0);
    await t.watcher.tick(later(15));
    assert.equal(t.wakes.length, 1);
    assert.match(t.wakes[0], /Wake-up 1/);
    assert.match(t.wakes[0], /"noop":true/);
    assert.match(t.wakes[0], /Check the queue\.$/);
    await t.watcher.tick(later(20));
    assert.equal(t.wakes.length, 1);
    t.block("Already 3 runs in flight");
    await t.watcher.tick(later(30));
    const w = t.runs.get("r1")!.watch!;
    assert.equal(w.wakes, 1);
    assert.match(w.error!, /3 runs/);
    assert.equal(w.nextCheckAt, later(31).toISOString());
    t.block(null);
    await t.watcher.tick(later(31));
    assert.equal(t.wakes.length, 2);
    assert.match(t.wakes[1], /Wake-up 2/);
  } finally { t.done(); }
});

test("watcher: an interval loop expires", async () => {
  const t = setup('<<WATCH>>{"every":"1h","prompt":"x","days":1}<</WATCH>>');
  try {
    await t.watcher.tick(later(24 * 60));
    assert.equal(t.wakes.length, 0);
    assert.match(t.runs.get("r1")!.watch!.endReason!, /expired.*still needed/);
  } finally { t.done(); }
});

test("watcher: a check runs nothing until approved; then the first run records and a change wakes", async () => {
  const t = setup('<<WATCH>>{"command":"cat status","everyMinutes":5,"prompt":"Deal with it."}<</WATCH>>');
  try {
    await t.watcher.tick(later(0));
    await t.watcher.tick(later(30));
    assert.equal(t.commands.length, 0);
    const w0 = t.runs.get("r1")!.watch!;
    t.runs.approveWatch("r1", { startedAt: w0.startedAt, command: w0.command }, later(31));
    await t.watcher.tick(later(31)); // approving makes it due now
    assert.equal(t.commands.length, 1);
    assert.equal(t.wakes.length, 0);
    assert.equal(t.runs.get("r1")!.watch!.lastResult!.output, "running");
    const next = Date.parse(t.runs.get("r1")!.watch!.nextCheckAt);
    await t.watcher.tick(new Date(next)); // same output
    assert.equal(t.wakes.length, 0);
    t.out.output = "failed: disk full";
    await t.watcher.tick(new Date(next + 5 * 60000));
    assert.equal(t.wakes.length, 1);
    assert.match(t.wakes[0], /Output now:\n```\nfailed: disk full\n```/);
    assert.match(t.wakes[0], /Output before:\n```\nrunning\n```/);
    assert.match(t.wakes[0], /Deal with it\.$/);
    assert.equal(t.runs.get("r1")!.watch!.lastChange, "The output changed");
    assert.equal(t.runs.get("r1")!.watch!.endedAt, null);
  } finally { t.done(); }
});

test("watcher: until success wakes once when the command exits 0, then ends", async () => {
  const t = setup('<<WATCH>>{"command":"test -f done","until":"success"}<</WATCH>>', { allow: (c) => c === "test -f done" });
  try {
    await t.watcher.tick(later(0)); // allowed by deck.json: no approval needed
    assert.equal(t.commands.length, 1);
    assert.equal(t.runs.get("r1")!.watch!.approval, "approved");
    assert.equal(t.wakes.length, 0);
    t.out.exitCode = 0;
    await t.watcher.tick(later(5));
    assert.equal(t.wakes.length, 1);
    assert.match(t.wakes[0], /succeeded \(exit code 0\)/);
    const w = t.runs.get("r1")!.watch!;
    assert.ok(w.endedAt);
    assert.match(w.endReason!, /succeeded/);
  } finally { t.done(); }
});

test("watcher: a command that can't run is recorded, not woken on", async () => {
  const t = setup('<<WATCH>>{"command":"x"}<</WATCH>>', { allow: () => true, run: async () => { throw new Error("Git Bash wasn't found"); } });
  try {
    await t.watcher.tick(later(0));
    assert.equal(t.wakes.length, 0);
    assert.match(t.runs.get("r1")!.watch!.error!, /Couldn't run the check: Git Bash/);
  } finally { t.done(); }
});

test("approveWatch: only a check", () => {
  const t = setup('<<WATCH>>{"every":"1h","prompt":"x"}<</WATCH>>');
  try {
    assert.throws(() => t.runs.approveWatch("r1", {}), /no check/);
  } finally { t.done(); }
});

test("approveWatch: only the command you saw; a replaced check isn't approved", () => {
  const t = setup('<<WATCH>>{"command":"cat status"}<</WATCH>>');
  try {
    const seen = { startedAt: t.runs.get("r1")!.watch!.startedAt, command: "cat status" };
    assert.throws(() => t.runs.approveWatch("r1", {}), /changed since you looked/);
    assert.throws(() => t.runs.approveWatch("r1", { ...seen, command: "cat other" }), /changed since you looked/);
    assert.throws(() => t.runs.approveWatch("r1", { ...seen, startedAt: later(9).toISOString() }), /changed since you looked/);
    assert.equal(t.runs.get("r1")!.watch!.approval, "pending");
    assert.equal(t.runs.approveWatch("r1", seen).watch!.approval, "approved");
  } finally { t.done(); }
});

test("an interval loop always lives long enough for its first wake-up", async () => {
  const meta = { watch: null } as unknown as RunMeta;
  applyWatchBlock(meta, '<<WATCH>>{"every":"24h","prompt":"Daily look."}<</WATCH>>', T0);
  assert.equal(meta.watch!.expiresAt, later(2 * 1440).toISOString());
  applyWatchBlock(meta, '<<WATCH>>{"every":"30m","prompt":"x","days":2}<</WATCH>>', T0);
  assert.equal(meta.watch!.expiresAt, later(2 * 1440).toISOString()); // days wins when it's longer
  const t = setup('<<WATCH>>{"every":"24h","prompt":"Daily look.","days":1}<</WATCH>>');
  try {
    await t.watcher.tick(later(1440));
    assert.equal(t.wakes.length, 1);
    assert.equal(t.runs.get("r1")!.watch!.endedAt, null);
  } finally { t.done(); }
});

test("the real command runner: a timeout stops the whole tree and settles at once", { skip: !findBash() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-loops-tree-"));
  try {
    const run = makeRunCommand(1500);
    const started = Date.now();
    // A child that outlives bash's own work and holds the output pipe open.
    await assert.rejects(run("sleep 30 | cat; echo never", dir), /didn't finish within 2 s/);
    assert.ok(Date.now() - started < 10000, "settled on the timeout, not when the pipes closed");
  } finally {
    // taskkill finishes on its own time: the killed sleep can hold the folder a moment longer on Windows.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("the real command runner: output and exit code, in the run's folder", { skip: !findBash() }, async () => {
  const t = setup('<<WATCH>>{"command":"echo hi; pwd >/dev/null; exit 3"}<</WATCH>>');
  try {
    // A watcher with the default runner (setup() gives its own a fake one).
    const real = new Watcher(t.runs, { allowCommand: () => true, wake: (_id, text) => { t.wakes.push(text); return null; } });
    await real.tick(later(0));
    const r = t.runs.get("r1")!.watch!.lastResult!;
    assert.equal(r.exitCode, 3);
    assert.equal(r.output, "hi");
  } finally { t.done(); }
});

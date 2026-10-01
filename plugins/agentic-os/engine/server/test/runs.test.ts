import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseQuestion, toolLabel, backgroundWarning, normaliseMeta, lastActivity, RunManager } from "../src/runs.ts";

test("parseQuestion: {questions:[...]} with options", () => {
  const text = `I need a decision.\n<<QUESTION>>\n{"questions":[{"question":"Which DB?","header":"DB","multiSelect":false,"options":[{"label":"Postgres","description":"the usual"},{"label":"SQLite"}]}]}\n<</QUESTION>>`;
  const q = parseQuestion(text)!;
  assert.equal(q.length, 1);
  assert.equal(q[0].question, "Which DB?");
  assert.equal(q[0].header, "DB");
  assert.deepEqual(q[0].options.map((o) => o.label), ["Postgres", "SQLite"]);
  assert.equal(q[0].options[0].description, "the usual");
});

test("parseQuestion: a single question object inside a json fence", () => {
  const text = '<<QUESTION>>\n```json\n{"question":"Approve the plan?","options":["Yes","No"]}\n```\n<</QUESTION>>';
  const q = parseQuestion(text)!;
  assert.equal(q[0].question, "Approve the plan?");
  assert.deepEqual(q[0].options.map((o) => o.label), ["Yes", "No"]);
});

test("parseQuestion: unparseable body is still a free-text question", () => {
  const q = parseQuestion("Pick one.\n<<QUESTION>>\nWhich environment should I use?\n<</QUESTION>>")!;
  assert.equal(q.length, 1);
  assert.equal(q[0].question, "Which environment should I use?");
  assert.deepEqual(q[0].options, []);
});

test("parseQuestion: missing closing marker still counts", () => {
  const q = parseQuestion('<<QUESTION>>{"question":"Go ahead?","options":[{"label":"Yes"}]}')!;
  assert.equal(q[0].question, "Go ahead?");
});

test("parseQuestion: no marker is no question", () => {
  assert.equal(parseQuestion("All done."), null);
});

test("toolLabel says what a call does", () => {
  assert.equal(toolLabel("Bash", { command: "npm ci", description: "Install deps" }), "Bash · Install deps");
  assert.equal(toolLabel("Bash", { command: "git status" }), "Bash · git status");
  assert.equal(toolLabel("Read", { file_path: "C:\\x\\y\\app.ts" }), "Read · app.ts");
  assert.equal(toolLabel("Grep", { pattern: "foo", path: "/src/api" }), 'Grep · "foo" in api');
  assert.equal(toolLabel("Skill", { skill: "commit", args: "-m x" }), "Skill · /commit -m x");
  assert.equal(toolLabel("Agent", { description: "Probe agent", prompt: "..." }), "Agent · Probe agent");
});

test("backgroundWarning: killed output file, unfinished task and schedule are reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-test-"));
  const killed = path.join(dir, "a.output");
  const fine = path.join(dir, "b.output");
  fs.writeFileSync(killed, "building...\n[killed]\n");
  fs.writeFileSync(fine, "done\n");
  const w = {
    outputFiles: new Set([killed, fine]),
    bgTasks: new Map([["t1", "Copilot review"]]),
    asyncAgents: new Map<string, string>(),
    schedules: ["CronCreate"],
  };
  const msg = backgroundWarning(w)!;
  assert.match(msg, /a\.output/);
  assert.doesNotMatch(msg, /b\.output/);
  assert.match(msg, /Copilot review/);
  assert.match(msg, /CronCreate/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("backgroundWarning: nothing backgrounded is no warning", () => {
  assert.equal(backgroundWarning({ outputFiles: new Set(), bgTasks: new Map(), asyncAgents: new Map(), schedules: [] }), null);
});

test("normaliseMeta fills multi-turn fields on old runs", () => {
  const m = normaliseMeta({ id: "x", status: "succeeded", permissionMode: "plan", startedAt: "2026-01-01T00:00:00Z" });
  assert.equal(m.turns, 1);
  assert.equal(m.planMode, true);
  assert.equal(m.question, null);
  assert.equal(m.warning, null);
  assert.equal(m.flagged, false);
});

test("lastActivity is the newest of start, turn start and finish", () => {
  assert.equal(lastActivity({ startedAt: "2026-01-01T00:00:00Z", turnStartedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T01:00:00Z" }), "2026-01-01T01:00:00Z");
  // Resumed: the new turn started after the previous turn's endedAt, which is still set.
  assert.equal(lastActivity({ startedAt: "2026-01-01T00:00:00Z", turnStartedAt: "2026-01-01T05:00:00Z", endedAt: "2026-01-01T01:00:00Z" }), "2026-01-01T05:00:00Z");
  assert.equal(lastActivity({ startedAt: "2026-01-01T00:00:00Z", turnStartedAt: null, endedAt: null }), "2026-01-01T00:00:00Z");
});

test("list() sorts by latest activity, not start time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-runs-"));
  try {
    const runs = new RunManager(dir);
    const write = (m: object) => fs.writeFileSync(path.join(dir, "runs", `${(m as any).id}.json`), JSON.stringify({ status: "succeeded", permissionMode: "auto", ...m }));
    write({ id: "old-long", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T09:00:00Z" });
    write({ id: "newer", startedAt: "2026-01-01T06:00:00Z", endedAt: "2026-01-01T06:05:00Z" });
    write({ id: "old-resumed", status: "waiting", startedAt: "2026-01-01T01:00:00Z", turnStartedAt: "2026-01-01T10:00:00Z", endedAt: "2026-01-01T02:00:00Z" });
    assert.deepEqual(runs.list().map((r) => r.id), ["old-resumed", "old-long", "newer"]);
    // A run's Changes baselines live next to it; they aren't runs (they showed as an "undefined" row).
    fs.writeFileSync(path.join(dir, "runs", "newer.baselines.json"), JSON.stringify({ repos: {} }));
    fs.writeFileSync(path.join(dir, "runs", "stray.json"), JSON.stringify({ repos: {} }));
    fs.writeFileSync(path.join(dir, "runs", "copy.json"), JSON.stringify({ id: "newer", status: "succeeded", startedAt: "2026-01-01T06:00:00Z" }));
    assert.deepEqual(runs.list().map((r) => r.id), ["old-resumed", "old-long", "newer"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setFlag persists; a verdict clears the flag, clearing the verdict doesn't", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-runs-"));
  try {
    const runs = new RunManager(dir);
    fs.writeFileSync(path.join(dir, "runs", "r1.json"), JSON.stringify({ id: "r1", status: "succeeded", permissionMode: "auto", startedAt: "2026-01-01T00:00:00Z", verdict: null }));
    assert.equal(runs.setFlag("r1", true).flagged, true);
    assert.equal(runs.get("r1")!.flagged, true);
    runs.setVerdict("r1", null);
    assert.equal(runs.get("r1")!.flagged, true);
    runs.setVerdict("r1", "good");
    assert.equal(runs.get("r1")!.flagged, false);
    assert.throws(() => runs.setFlag("missing", true), /Unknown run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

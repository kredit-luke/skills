// The Loops routes on the real server (main.ts): routines (create, list, switch off a team one,
// run now, delete), creating the routine a run proposed, and approving a run's check watch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-loops-routes-")));
const ROOT = path.join(TMP, "ws");
const LEDGER = path.join(ROOT, ".claude", "ledger");
// Its own range: the other server tests use 35000-39999.
const PORT = 34000 + Math.floor(Math.random() * 1000);
const url = `http://localhost:${PORT}`;
let server: ChildProcess | null = null;
let token = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const w = (rel: string, data: unknown) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data)); };
async function get(p: string) { const r = await fetch(url + p); return { status: r.status, body: await r.json() }; }
async function post(p: string, body: unknown = {}) {
  const r = await fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Dash-Token": token }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
}

// A stand-in claude, installed and signed in, that answers any prompt with "ok".
const FAKE = `
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (a[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
console.log(JSON.stringify({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0, num_turns: 1 }));
`;
function fakeClaude(): string {
  const bin = path.join(TMP, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "fake-claude.mjs"), FAKE);
  const file = path.join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
  if (process.platform === "win32") fs.writeFileSync(file, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, { mode: 0o755 });
  return file;
}

const T = "2026-11-08T12:00:00.000Z";
const run = (o: Record<string, unknown>) => ({
  sessionId: `s-${o.id}`, presetId: null, label: String(o.id), prompt: "x", cwd: ROOT, workspace: "main", model: "opus", effort: "medium",
  permissionMode: "auto", status: "succeeded", startedAt: T, endedAt: T, turnStartedAt: T, turns: 1, toolCalls: 0, costUsd: 0, numTurns: 1, ...o,
});

before(async () => {
  w(".claude/dashboard/workspace.json", { name: "Shop", dashboard: { port: PORT }, codeHost: { kind: "none" } });
  w(".claude/dashboard/deck.json", {
    presets: [{ id: "brief", label: "Morning brief", prompt: "Brief me." }],
    routines: [{ id: "team-brief", preset: "brief", at: "08:30", days: "weekdays", enabled: true }],
  });
  w(".claude/ledger/runs/proposer.json", run({
    id: "proposer",
    routineProposal: { routine: { label: "Queue check", prompt: "Check the queue.", every: "2h", workspace: "main" }, proposedAt: T, error: null, routineId: null },
  }));
  const future = "2099-01-01T00:00:00.000Z";
  w(".claude/ledger/runs/checker.json", run({
    id: "checker",
    watch: { kind: "check", prs: [], command: "test -f done", until: "success", approval: "pending", lastResult: null, everyMinutes: 5, prompt: "Go.", startedAt: T, expiresAt: future, nextCheckAt: future, lastCheckAt: null, lastChangeAt: null, lastChange: null, wakes: 0, quiet: 0, error: null, endedAt: null, endReason: null },
  }));
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ROOT, DASHBOARD_LEDGER_DIR: LEDGER, DASHBOARD_PORT: "", DASHBOARD_CLAUDE_BIN: fakeClaude() };
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main, "--port", String(PORT)], { env, stdio: "ignore" });
  for (let i = 0; i < 80 && !token; i++) {
    try { token = (await (await fetch(url + "/api/boot")).json()).token; } catch { await sleep(250); }
  }
  assert.ok(token, "the server came up");
});

after(async () => {
  server?.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("routines: the team's are listed; yours are created, checked, switched and deleted", async () => {
  const list = await get("/api/routines");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.routines.map((r: any) => [r.id, r.source, r.schedule]), [["team-brief", "team", "Weekdays at 08:30"]]);

  const bad = await post("/api/routines", { routine: { label: "Nope", prompt: "x" } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /when the routine runs/);

  const made = await post("/api/routines", { routine: { label: "Nightly tidy", prompt: "Tidy up.", at: "23:00" } });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.body.routine.id, "nightly-tidy");
  assert.ok(made.body.routines.some((r: any) => r.id === "nightly-tidy" && r.source === "personal" && r.nextAt));
  assert.ok(fs.existsSync(path.join(LEDGER, "routines.json")));

  const off = await post("/api/routines/team-brief/enabled", { on: false });
  const brief = off.body.routines.find((r: any) => r.id === "team-brief");
  assert.equal(brief.enabled, false);
  assert.equal(brief.overridden, true);
  assert.equal((await post("/api/routines/team-brief/delete")).status, 400);

  assert.equal((await post("/api/routines/nightly-tidy/delete")).status, 200);
  assert.ok(!(await get("/api/routines")).body.routines.some((r: any) => r.id === "nightly-tidy"));
});

test("routines: Run now starts a run under the routine's trigger", async () => {
  const res = await post("/api/routines/team-brief/run");
  assert.equal(res.status, 200, res.text);
  const runId = res.body.last.runId;
  assert.ok(runId);
  const r = (await get(`/api/runs/${runId}?events=0`)).body.run;
  assert.equal(r.trigger, "routine:team-brief");
  assert.equal(r.prompt, "Brief me.");
});

test("a run's proposed routine is created once, from the run page", async () => {
  const res = await post("/api/routines/from-run", { runId: "proposer" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.routine.id, "queue-check");
  assert.equal(res.body.routine.every, "2h");
  assert.equal(res.body.run.routineProposal.routineId, "queue-check");
  assert.equal((await post("/api/routines/from-run", { runId: "proposer" })).status, 409);
});

test("a check watch is approved from the run page, only as it was shown; other runs have nothing to approve", async () => {
  const stale = await post("/api/runs/checker/watch-approve", { startedAt: T, command: "rm -rf ." });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since you looked/);
  const res = await post("/api/runs/checker/watch-approve", { startedAt: T, command: "test -f done" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.run.watch.approval, "approved");
  assert.equal((await post("/api/runs/proposer/watch-approve", {})).status, 409);
});

test("the routines topic lists every run with a watch on", async () => {
  const list = await get("/api/routines");
  assert.deepEqual(list.body.loops.map((r: any) => r.id), ["checker"]);
});

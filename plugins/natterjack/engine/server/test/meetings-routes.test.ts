// The /api/meetings/* routes on the real server (main.ts), with Roam configured and nothing
// connected, so nothing reaches Roam: id validation, bad input, and "connect again" as a 401.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort } from "./ports.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-meetings-routes-")));
const ROOT = path.join(TMP, "ws");
// The OS picks a free port, so it can't collide with another test file's server.
const PORT = await freePort();
const url = `http://localhost:${PORT}`;
let server: ChildProcess | null = null;
let token = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const w = (rel: string, data: unknown) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data)); };
async function get(p: string) { const r = await fetch(url + p); return { status: r.status, body: await r.json() }; }
async function post(p: string, body: unknown) {
  const r = await fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Dash-Token": token }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

// A stand-in claude, installed and signed in: a run started here finishes at once, and nothing real is launched.
const FAKE = `
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (a[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0, num_turns: 1 }));
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

before(async () => {
  w(".claude/dashboard/workspace.json", { name: "Shop", dashboard: { port: PORT }, codeHost: { kind: "none" } });
  w(".claude/dashboard/meetings.json", { source: "roam" });
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main, "--port", String(PORT)], {
    env: { ...process.env, WORKSPACE_ROOT: ROOT, DASHBOARD_LEDGER_DIR: path.join(ROOT, ".claude", "ledger"), DASHBOARD_PORT: "", DASHBOARD_CLAUDE_BIN: fakeClaude() },
    stdio: "ignore",
  });
  for (let i = 0; i < 80 && !token; i++) {
    try { token = (await (await fetch(url + "/api/boot")).json()).token; } catch { await sleep(250); }
  }
  assert.ok(token, "the server came up");
});

after(async () => {
  // Gone before its folder is removed (Windows won't remove files a live process holds).
  if (server && server.exitCode === null && server.signalCode === null) await new Promise((r) => { server!.once("exit", r); server!.kill(); });
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("status and connect help: configured, not connected, nothing coming soon", async () => {
  const s = await get("/api/meetings/status");
  assert.equal(s.status, 200);
  assert.equal(s.body.configured, true);
  assert.equal(s.body.connected, false);
  assert.equal(s.body.signIn, false);
  assert.ok(!("comingSoon" in s.body));
  const h = await get("/api/meetings/connect-help");
  assert.equal(h.status, 200);
  assert.match(h.body.steps.join("\n"), /meetings:read/);
});

test("not connected: reads are a 401 with the code, never a 400 or 500", async () => {
  for (const r of [await get("/api/meetings/list"), await get("/api/meetings/list?cursor=abc"), await get("/api/meetings/meeting?id=m1"),
    await post("/api/meetings/share-link", { id: "m1" }), await post("/api/meetings/ask", { id: "m1" })]) {
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.equal(r.body.code, "not_connected");
    assert.match(r.body.error, /Roam isn't connected/);
  }
  // No run was started by the refused ask.
  assert.equal((await get("/api/runs")).body.runs.length, 0);
});

test("a meeting id that isn't one is a 400 before anything else", async () => {
  for (const id of ["", "../etc/passwd", "a b", "a?b=c", "x".repeat(101)]) {
    assert.equal((await get(`/api/meetings/meeting?id=${encodeURIComponent(id)}`)).status, 400, id);
    assert.equal((await post("/api/meetings/share-link", { id })).status, 400, id);
    assert.equal((await post("/api/meetings/ask", { id })).status, 400, id);
  }
  assert.equal((await post("/api/meetings/ask", {})).status, 400);
  assert.equal((await get(`/api/meetings/list?cursor=${"c".repeat(2001)}`)).status, 400);
});

test("bad input: an empty token, sign-in without a clientId, an unknown action", async () => {
  let r = await post("/api/meetings/connect", { token: "  " });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Paste a Roam personal access token/);
  r = await post("/api/meetings/sign-in", { action: "start" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /"clientId"/);
  r = await post("/api/meetings/sign-in", { action: "status" });
  assert.equal(r.status, 200);
  assert.equal(r.body.pending, false);
  assert.equal((await post("/api/meetings/sign-in", { action: "nope" })).status, 400);
  assert.equal((await post("/api/meetings/sign-in", { action: "cancel" })).body.ok, true);
  assert.equal((await post("/api/meetings/nope", {})).status, 404);
  // Disconnecting with nothing stored is fine.
  r = await post("/api/meetings/disconnect", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, false);
});

test("a run started from the runs route can't claim a meeting: only the meetings Ask names one", async () => {
  const r = await post("/api/runs", { prompt: "List the tickets.", trigger: "meetings", meetingId: "m1" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.run.trigger, "meetings");
  assert.ok(!("meetingId" in r.body.run) || r.body.run.meetingId === undefined, JSON.stringify(r.body.run));
  // Settled (the stand-in answers at once), and still no meeting.
  let listed: any = null;
  for (let i = 0; i < 80; i++) {
    listed = (await get("/api/runs")).body.runs.find((x: any) => x.id === r.body.run.id);
    if (listed && listed.status !== "running" && listed.status !== "queued") break;
    await sleep(250);
  }
  assert.ok(listed && listed.status !== "running", JSON.stringify(listed));
  assert.ok(!listed.meetingId);
});

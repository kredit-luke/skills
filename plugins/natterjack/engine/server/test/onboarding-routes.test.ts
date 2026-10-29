// The /api/onboarding routes on the real server (main.ts): the boot field, the page, ticks,
// "I'll finish later", and the Atlassian secret (saved, never echoed, 409 when the env var sets it).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-onboarding-routes-")));
const ROOT = path.join(TMP, "ws");
const LEDGER = path.join(ROOT, ".claude", "ledger");
// Its own range: the other server tests use 36000-39999.
const PORT = 35000 + Math.floor(Math.random() * 1000);
const url = `http://localhost:${PORT}`;
let server: ChildProcess | null = null;
let token = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const w = (rel: string, data: unknown) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data)); };
async function get(p: string) { const r = await fetch(url + p); return { status: r.status, body: await r.json() }; }
async function post(p: string, body: unknown) {
  const r = await fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Dash-Token": token }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
}

// A stand-in claude, installed and signed in, so nothing real is run.
const FAKE = `
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (a[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
console.log("");
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
  w(".claude/dashboard/workspace.json", {
    name: "Shop", dashboard: { port: PORT }, codeHost: { kind: "none" },
    issues: { kind: "jira", site: "acme.atlassian.net" }, atlassian: { clientId: "cid" },
  });
  w(".claude/dashboard/onboarding.json", { steps: [{ use: "atlassian-secret" }, { id: "slack", kind: "manual", label: "Join #dev" }] });
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
  const env: NodeJS.ProcessEnv = { ...process.env, WORKSPACE_ROOT: ROOT, DASHBOARD_LEDGER_DIR: LEDGER, DASHBOARD_PORT: "", DASHBOARD_CLAUDE_BIN: fakeClaude() };
  delete env.ATLASSIAN_CLIENT_SECRET;
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main, "--port", String(PORT)], { env, stdio: "ignore" });
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

test("boot carries the Get started count once it's known; the page lists the steps", async () => {
  const page = await get("/api/onboarding");
  assert.equal(page.status, 200);
  assert.equal(page.body.enabled, true);
  assert.deepEqual(page.body.steps.map((s: any) => s.id), ["claude", "atlassian-secret", "atlassian", "slack"]);
  const boot = (await get("/api/boot")).body;
  assert.equal(boot.onboarding.enabled, true);
  assert.equal(boot.onboarding.remaining, page.body.remaining);
  assert.equal(boot.onboarding.show, page.body.show);
});

test("tick: manual steps only; dismiss and reopen", async () => {
  const r = await post("/api/onboarding/tick", { id: "slack", done: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.steps.find((s: any) => s.id === "slack").state, "done");
  assert.equal((await post("/api/onboarding/tick", { id: "atlassian", done: true })).status, 400);
  assert.ok((await post("/api/onboarding/dismiss", { dismissed: true })).body.dismissedAt);
  assert.equal((await get("/api/boot")).body.onboarding.show, false);
  assert.equal((await post("/api/onboarding/dismiss", { dismissed: false })).body.dismissedAt, null);
});

test("the Atlassian secret is saved and never sent back; Connect to Atlassian is offered straight after", async () => {
  assert.equal((await get("/api/atlassian/status")).body.signIn, false);
  assert.equal((await post("/api/onboarding/atlassian-secret", { secret: "two\nlines" })).status, 400);
  const r = await post("/api/onboarding/atlassian-secret", { secret: "very-secret-value" });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /very-secret-value/);
  assert.equal(r.body.steps.find((s: any) => s.id === "atlassian-secret").state, "done");
  assert.equal((await get("/api/atlassian/status")).body.signIn, true, "no restart needed");
  assert.match(fs.readFileSync(path.join(LEDGER, "atlassian-client-secret"), "utf-8"), /very-secret-value/);
});

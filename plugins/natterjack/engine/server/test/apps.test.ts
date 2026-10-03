// Starting and stopping apps and stacks against a scratch workspace. Every module reads
// WORKSPACE_ROOT/.claude/dashboard at import, so point it there before importing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-apps-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = path.join(ROOT, ".claude", "ledger");

const { AppLauncher, killTree, treeAlive } = await import("../src/apps.ts");

const node = (js: string) => `"${process.execPath}" -e "${js}"`;
const forever = "setInterval(() => {}, 1000)";
const APPS = ["worker", "crasher", "stubborn", "web", "hung", "ghost"];
for (const d of APPS) fs.mkdirSync(path.join(ROOT, d));
fs.writeFileSync(path.join(CFG, "apps.json"), JSON.stringify({
  apps: {
    worker: { name: "Worker", dir: "worker", launch: { cmd: node(forever) } },
    crasher: { name: "Crasher", dir: "crasher", launch: { cmd: node("process.exit(3)") } },
    stubborn: { name: "Stubborn", dir: "stubborn", launch: { cmd: node(`process.on('SIGTERM', () => {}); ${forever}`) } },
    web: { name: "Web", dir: "web", port: 4999, launch: { cmd: node(forever) } },
    hung: { name: "Hung", dir: "hung", port: 4998, bootSeconds: 1, launch: { cmd: node(forever) } },
    ghost: { name: "Ghost", dir: "ghost", launch: { cmd: node(forever) } },
  },
  stacks: {
    core: { apps: ["worker", "web"], steps: [{ start: ["worker"] }, { wait: "all" }, { start: "rest" }] },
  },
}));

const ws = { slug: "main", name: "Main", path: ROOT };
const PORTS = { web: 4999, hung: 4998 };
const launcher = new AppLauncher({
  logDir: path.join(ROOT, "logs"),
  portOf: (_ws, key) => PORTS[key] || null,
  isUp: async (port) => port === PORTS.web, // "web" always answers, so it is never launched; "hung" never does
  settleMs: 1500,
  stopGraceMs: 1000,
});

after(() => {
  for (const key of APPS) {
    const pid = launcher.runningPid(ws, key);
    if (pid) killTree(pid, "SIGKILL");
  }
});

async function finished(job) {
  const deadline = Date.now() + 15000;
  while (job.status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return job;
}

test("an app with no port counts as started once its process stays up, and as running after", async () => {
  const job = await finished(launcher.startApp(ws, "worker"));
  assert.equal(job.status, "succeeded", job.error);
  assert.deepEqual(job.steps.map((s) => s.label), ["Launch Worker", "Check Worker started"]);
  assert.ok(launcher.runningPid(ws, "worker"));

  const again = await finished(launcher.startApp(ws, "worker"));
  assert.match(again.steps[0].label, /^Worker already running \(pid \d+\)$/);
});

test("an app with no port that exits straight away fails its start", async () => {
  const job = await finished(launcher.startApp(ws, "crasher"));
  assert.equal(job.status, "failed");
  assert.match(job.error, /Crasher exited right after starting/);
  assert.equal(launcher.runningPid(ws, "crasher"), null);
  // The launcher leaves its own exit file, which no job-log pruning or shared stack log can lose.
  const { exitFile } = JSON.parse(fs.readFileSync(launcher.pidFile, "utf-8"))["main:crasher"];
  for (let i = 0; i < 20 && !fs.existsSync(exitFile); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readFileSync(exitFile, "utf-8"), "3");
});

test("a stack's wait \"all\" only waits for apps already started", async () => {
  const job = await finished(launcher.startStack(ws, "core"));
  assert.equal(job.status, "succeeded", job.error);
  const labels = job.steps.map((s) => s.label);
  assert.ok(!labels.includes("Wait for Web to listen"), labels.join(" | "));
  assert.ok(labels.includes("Web already running on :4999"), labels.join(" | "));
});

test("stop kills an app that ignores SIGTERM, and only then forgets it", async () => {
  assert.equal((await finished(launcher.startApp(ws, "stubborn"))).status, "succeeded");
  const pid = launcher.runningPid(ws, "stubborn")!;

  const stop = await finished(launcher.stopApp(ws, "stubborn"));
  assert.equal(stop.status, "succeeded", stop.error);
  // Windows stops with taskkill /F straight away, so there is no grace period to outlast.
  if (process.platform !== "win32") {
    assert.match(fs.readFileSync(stop._log, "utf-8"), /Still running after 1s; killing it\./);
  }
  assert.equal(treeAlive(pid), false);
  assert.equal(launcher.runningPid(ws, "stubborn"), null);
});

test("starting again stops an earlier launch that never answered instead of orphaning it", async () => {
  assert.equal((await finished(launcher.startApp(ws, "hung"))).status, "failed");
  const first = launcher.runningPid(ws, "hung")!;
  assert.ok(first);

  const retry = await finished(launcher.startApp(ws, "hung"));
  assert.equal(retry.steps[0].label, `Stop the earlier Hung (pid ${first}), which isn't answering`);
  assert.equal(retry.steps[0].status, "done");
  assert.equal(treeAlive(first), false);
  assert.notEqual(launcher.runningPid(ws, "hung"), first);
});

// A live process that isn't ours, standing in for whatever got a recorded pid after it was freed.
function bystander() {
  const c = spawn(process.execPath, ["-e", forever], { stdio: "ignore" });
  return { pid: c.pid!, end: () => { try { c.kill("SIGKILL"); } catch {} } };
}
function record(key: string, rec: number | object) {
  let pids = {};
  try { pids = JSON.parse(fs.readFileSync(launcher.pidFile, "utf-8")); } catch {}
  fs.writeFileSync(launcher.pidFile, JSON.stringify({ ...pids, [`main:${key}`]: rec }));
}

test("a pid recorded before the machine last booted isn't ours: not running, and Stop leaves its new owner alone", async () => {
  const other = bystander();
  try {
    record("ghost", other.pid); // an older dashboard's bare pid still counts
    assert.equal(launcher.runningPid(ws, "ghost"), other.pid);

    record("ghost", { pid: other.pid, startedAt: Date.now() - os.uptime() * 1000 - 3600_000 });
    assert.equal(launcher.runningPid(ws, "ghost"), null);
    const stop = await finished(launcher.stopApp(ws, "ghost"));
    assert.equal(stop.status, "succeeded", stop.error);
    assert.match(fs.readFileSync(stop._log, "utf-8"), /pid \d+ has already exited \(or the machine restarted since\); nothing to stop/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(treeAlive(other.pid), true, "the process that has the pid now is still running");
    assert.equal(JSON.parse(fs.readFileSync(launcher.pidFile, "utf-8"))["main:ghost"], undefined, "and the stale pid is forgotten");
  } finally { other.end(); }
});

test("on Windows, a launcher that wrote its exit file isn't ours, whoever has its pid now", { skip: process.platform !== "win32" }, async () => {
  const other = bystander();
  try {
    const exitFile = path.join(ROOT, "logs", "exited-ghost");
    record("ghost", { pid: other.pid, startedAt: Date.now(), exitFile });
    assert.equal(launcher.runningPid(ws, "ghost"), other.pid);

    fs.writeFileSync(exitFile, "0");
    assert.equal(launcher.runningPid(ws, "ghost"), null);
  } finally { other.end(); }
});

test("on Windows, Stop won't taskkill a pid whose process started at another time than our launch", { skip: process.platform !== "win32" }, async () => {
  const other = bystander();
  try {
    // No exit file (say something else killed the launcher), and the pid is alive again.
    record("ghost", { pid: other.pid, startedAt: Date.now() + 600_000, exitFile: path.join(ROOT, "logs", "exited-none") });
    assert.equal(launcher.runningPid(ws, "ghost"), other.pid);

    const stop = await finished(launcher.stopApp(ws, "ghost"));
    assert.equal(stop.status, "succeeded", stop.error);
    assert.match(fs.readFileSync(stop._log, "utf-8"), /nothing to stop/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(treeAlive(other.pid), true, "the process that has the pid now is still running");
  } finally { other.end(); }
});

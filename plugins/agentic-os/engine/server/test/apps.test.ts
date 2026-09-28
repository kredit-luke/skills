// Starting and stopping apps and stacks against a scratch workspace. Every module reads
// WORKSPACE_ROOT/.claude/dashboard at import, so point it there before importing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-apps-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = path.join(ROOT, ".claude", "ledger");

const { AppLauncher, killTree, treeAlive } = await import("../src/apps.ts");

const node = (js: string) => `"${process.execPath}" -e "${js}"`;
const forever = "setInterval(() => {}, 1000)";
const APPS = ["worker", "crasher", "stubborn", "web", "hung"];
for (const d of APPS) fs.mkdirSync(path.join(ROOT, d));
fs.writeFileSync(path.join(CFG, "apps.json"), JSON.stringify({
  apps: {
    worker: { name: "Worker", dir: "worker", launch: { cmd: node(forever) } },
    crasher: { name: "Crasher", dir: "crasher", launch: { cmd: node("process.exit(3)") } },
    stubborn: { name: "Stubborn", dir: "stubborn", launch: { cmd: node(`process.on('SIGTERM', () => {}); ${forever}`) } },
    web: { name: "Web", dir: "web", port: 4999, launch: { cmd: node(forever) } },
    hung: { name: "Hung", dir: "hung", port: 4998, bootSeconds: 1, launch: { cmd: node(forever) } },
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

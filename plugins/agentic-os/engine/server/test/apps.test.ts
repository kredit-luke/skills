// Starting apps and stacks against a scratch workspace. Every module reads
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

const { AppLauncher, killTree } = await import("../src/apps.ts");

const node = (js: string) => `"${process.execPath}" -e "${js}"`;
for (const d of ["worker", "crasher", "web"]) fs.mkdirSync(path.join(ROOT, d));
fs.writeFileSync(path.join(CFG, "apps.json"), JSON.stringify({
  apps: {
    worker: { name: "Worker", dir: "worker", launch: { cmd: node("setInterval(() => {}, 1000)") } },
    crasher: { name: "Crasher", dir: "crasher", launch: { cmd: node("process.exit(3)") } },
    web: { name: "Web", dir: "web", port: 4999, launch: { cmd: node("setInterval(() => {}, 1000)") } },
  },
  stacks: {
    core: { apps: ["worker", "web"], steps: [{ start: ["worker"] }, { wait: "all" }, { start: "rest" }] },
  },
}));

const ws = { slug: "main", name: "Main", path: ROOT };
const launcher = new AppLauncher({
  logDir: path.join(ROOT, "logs"),
  portOf: (_ws, key) => (key === "web" ? 4999 : null),
  isUp: async () => true, // "web" always answers, so it is never launched
  settleMs: 1500,
});

after(() => {
  for (const key of ["worker", "crasher", "web"]) {
    const pid = launcher.runningPid(ws, key);
    if (pid) killTree(pid);
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

// "fallback": "main" end to end: a worktree stack uses main's instance of an app it
// hasn't cloned (or isn't running), and {{port:<id>}} names whichever instance it uses.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-fallback-")));
const CFG = path.join(ROOT, ".claude", "dashboard");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = path.join(ROOT, ".claude", "ledger");

const { AppLauncher, killTree } = await import("../src/apps.ts");
const { ownPort, resolvePort } = await import("../src/workspaces.ts");

const MAIN_API = 47811, WT_API = 47821, WT2_API = 47831;
// api listens on {{port}}; web records the api port it was given, then idles.
const listen = `require('net').createServer().listen(Number(process.env.PORT), '127.0.0.1'); setInterval(() => {}, 1000)`;
const record = `require('fs').writeFileSync('api-port.txt', String(process.env.API)); setInterval(() => {}, 1000)`;
fs.writeFileSync(path.join(CFG, "apps.json"), JSON.stringify({
  apps: {
    api: { name: "API", dir: "api", port: MAIN_API, fallback: "main", bootSeconds: 10,
      launch: { cmd: `"${process.execPath}" -e "${listen}"`, env: { PORT: "{{port}}" } } },
    web: { name: "Web", dir: "web", launch: { cmd: `"${process.execPath}" -e "${record}"`, env: { API: "{{port:api}}" } } },
  },
  stacks: { app: { apps: ["api", "web"], steps: [{ start: ["api"] }, { wait: "all" }, { start: "rest" }] } },
}));

const mainWs = { slug: "main", name: "Main Workspace", path: ROOT };
const wt = { slug: "eng-9", name: "ENG-9", path: path.join(ROOT, "worktrees", "ENG-9") };   // web only
const wt2 = { slug: "eng-10", name: "ENG-10", path: path.join(ROOT, "worktrees", "ENG-10") }; // api + web
for (const d of [path.join(ROOT, "api"), path.join(ROOT, "web"), path.join(wt.path, "web"), path.join(wt2.path, "api"), path.join(wt2.path, "web")]) {
  fs.mkdirSync(d, { recursive: true });
}
const portsData = { worktrees: { "ENG-9": { workspace: wt.path, ports: { api: WT_API } }, "ENG-10": { workspace: wt2.path, ports: { api: WT2_API } } } };

const isUp = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect(port, "127.0.0.1");
  s.setTimeout(500);
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("timeout", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(false));
});

const cfg = () => JSON.parse(fs.readFileSync(path.join(CFG, "apps.json"), "utf-8")).apps;
const portOf = (ws, key) => ownPort(ws, key, cfg(), portsData, path.join(ROOT, "worktrees"));
let launcher;
launcher = new AppLauncher({
  logDir: path.join(ROOT, "logs"), portOf, isUp, settleMs: 800, stopGraceMs: 1000, mainWs,
  resolvePort: async (ws, key, starting) => (await resolvePort(ws, key, cfg(), { own: portOf, isUp, starting, cloned: (w, k) => launcher.available(w, k) })).port,
});

// main's api is already running
const mainApi = net.createServer().listen(MAIN_API, "127.0.0.1");
after(() => {
  mainApi.close();
  for (const ws of [mainWs, wt, wt2]) for (const key of ["api", "web"]) {
    const pid = launcher.runningPid(ws, key);
    if (pid) killTree(pid, "SIGKILL");
  }
});

async function finished(job) {
  const deadline = Date.now() + 20000;
  while (job.status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return job;
}
const recorded = async (ws) => {
  const f = path.join(ws.path, "web", "api-port.txt");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(f) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return Number(fs.readFileSync(f, "utf-8"));
};

test("a stack in a worktree that hasn't cloned api uses main's, and web is pointed at it", async () => {
  assert.equal(launcher.fromMain(wt, "api"), true);
  const job = await finished(launcher.startStack(wt, "app"));
  assert.equal(job.status, "succeeded", job.error);
  assert.ok(job.notes.some((n) => n.includes("main workspace's API")), job.notes.join("; "));
  assert.ok(job.steps.some((s) => s.label === "API already running on :47811"), job.steps.map((s) => s.label).join("; "));
  assert.equal(await recorded(wt), MAIN_API);
});

test("an app started on its own in a worktree that isn't running api gets main's port", async () => {
  const job = await finished(launcher.startApp(wt2, "web"));
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(await recorded(wt2), MAIN_API);
  await finished(launcher.stopApp(wt2, "web"));
  fs.unlinkSync(path.join(wt2.path, "web", "api-port.txt"));
});

test("a stack that starts the worktree's own api points web at that one", async () => {
  const job = await finished(launcher.startStack(wt2, "app"));
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(await isUp(WT2_API), true, "the worktree's api is up on its own port");
  assert.equal(await recorded(wt2), WT2_API);
});

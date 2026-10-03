// End to end: the real server (main.ts) against a scratch monorepo with a native git worktree.
// Catches wiring the unit tests can't see: discovery, "." repos, slot allocation on first start,
// and {{port:<id>}} following "fallback": "main" through an actual launch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-e2e-")));
const ROOT = path.join(TMP, "shop");
const WT = path.join(TMP, "shop-ENG-7");
// Random-ish ports so parallel runs and a developer's own apps don't collide.
const PORT = 38000 + Math.floor(Math.random() * 1000);
const BASE = 41000 + Math.floor(Math.random() * 40) * 100; // slot 1 = BASE+100..
const MAIN_API = BASE + 1, MAIN_WEB = BASE + 2, WT_API = BASE + 101, WT_WEB = BASE + 102;
const url = `http://localhost:${PORT}`;
let server: ChildProcess | null = null;
let token = "";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
const w = (rel: string, text: string) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (p: string) => (await fetch(url + p)).json();
async function job(body: object) {
  const r = await fetch(url + "/api/apps/action", { method: "POST", headers: { "Content-Type": "application/json", "X-Dash-Token": token }, body: JSON.stringify(body) });
  const { job: started } = await r.json();
  assert.equal(r.status, 202);
  for (let i = 0; i < 80; i++) {
    const j = (await get("/api/apps/jobs")).jobs.find((x) => x.id === started.id);
    if (j && j.status !== "running") return j;
    await sleep(250);
  }
  throw new Error("job timed out");
}
const recorded = (root: string) => fs.readFileSync(path.join(root, "apps", "web", "api-url.txt"), "utf-8");

before(async () => {
  w("apps/api/server.js", `require("http").createServer((q, r) => r.end("api from " + __dirname)).listen(Number(process.env.PORT), "127.0.0.1");\n`);
  w("apps/web/server.js", `require("fs").writeFileSync(__dirname + "/api-url.txt", String(process.env.API_URL));\nrequire("http").createServer((q, r) => r.end("web")).listen(Number(process.env.PORT), "127.0.0.1");\n`);
  w(".gitignore", ".claude/ledger/\napps/web/api-url.txt\n");
  w(".claude/dashboard/workspace.json", JSON.stringify({
    name: "Shop", dashboard: { port: PORT },
    worktrees: { portsFile: path.join(TMP, "ports.json"), ports: { base: BASE, slotSize: 100 } },
    codeHost: { kind: "none" },
  }));
  w(".claude/dashboard/apps.json", JSON.stringify({
    apps: {
      api: { name: "API", dir: "apps/api", port: MAIN_API, fallback: "main", bootSeconds: 20, launch: { cmd: "node server.js", env: { PORT: "{{port}}" } } },
      web: { name: "Web", dir: "apps/web", port: MAIN_WEB, bootSeconds: 20, launch: { cmd: "node server.js", env: { PORT: "{{port}}", API_URL: "http://localhost:{{port:api}}" } } },
    },
    stacks: { app: { apps: ["api", "web"], steps: [{ start: ["api"] }, { wait: "all" }, { start: "rest" }] } },
  }));
  git(ROOT, "init", "-q", "-b", "main");
  git(ROOT, "config", "user.email", "t@example.com");
  git(ROOT, "config", "user.name", "T");
  git(ROOT, "add", ".");
  git(ROOT, "commit", "-q", "-m", "init");
  git(ROOT, "worktree", "add", "-q", "-b", "feature/ENG-7", WT);

  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main, "--port", String(PORT)], {
    env: { ...process.env, WORKSPACE_ROOT: ROOT, DASHBOARD_LEDGER_DIR: path.join(ROOT, ".claude", "ledger"), DASHBOARD_PORT: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80 && !token; i++) {
    try { token = (await get("/api/boot")).token; } catch { await sleep(250); }
  }
  assert.ok(token, "the server came up");
});

after(async () => {
  try { await job({ action: "stop-all", workspace: "main" }); } catch {}
  try {
    const wt = (await get("/api/status")).workspaces.find((x) => x.name === "shop-ENG-7");
    if (wt) await job({ action: "stop-all", workspace: wt.slug });
  } catch {}
  server?.kill();
  try { git(ROOT, "worktree", "remove", "--force", WT); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("a native worktree of a monorepo: found, its ticket from the branch, its repo is the root", async () => {
  const wt = (await get("/api/status")).workspaces.find((x) => x.name === "shop-ENG-7");
  assert.ok(wt);
  assert.equal(wt._ticketId, "ENG-7");
  assert.ok(wt.apps.every((a) => a.port === null), "no ports before the first start");
  const g = await get("/api/git?workspace=" + wt.slug);
  assert.deepEqual(Object.keys(g.repos), ["."]);
  assert.equal(g.repos["."].branch, "feature/ENG-7");
});

test("first start allocates a slot; an app started alone points at main's instance of a fallback app", async () => {
  const wt = (await get("/api/status")).workspaces.find((x) => x.name === "shop-ENG-7");
  const j = await job({ action: "start", workspace: wt.slug, app: "web" });
  assert.equal(j.status, "succeeded", j.error);
  const ports = JSON.parse(fs.readFileSync(path.join(TMP, "ports.json"), "utf-8"));
  assert.deepEqual(Object.values<any>(ports.worktrees)[0].ports, { api: WT_API, web: WT_WEB });
  assert.equal(recorded(WT), `http://localhost:${MAIN_API}`);
  await job({ action: "stop", workspace: wt.slug, app: "web" });
});

test("a stack started in the worktree uses the worktree's own instance", async () => {
  const wt = (await get("/api/status")).workspaces.find((x) => x.name === "shop-ENG-7");
  const j = await job({ action: "start", workspace: wt.slug, stack: "app" });
  assert.equal(j.status, "succeeded", j.error);
  assert.equal(recorded(WT), `http://localhost:${WT_API}`);
  assert.match(await (await fetch(`http://localhost:${WT_API}`)).text(), /shop-ENG-7/);
  await job({ action: "stop-all", workspace: wt.slug });
});

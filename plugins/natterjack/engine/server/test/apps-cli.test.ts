// `bin/dashboard.mjs apps ...` (bin/apps.mjs): its argument rules, which workspace it means,
// how a job's progress and outcome come out; then end to end against the real server with a
// native worktree, as a headless run would use it (from the worktree's folder).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freeBlock, freePort } from "./ports.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "..", "bin", "dashboard.mjs");
const { parseAppsArgs, resolveWorkspace, jobOutcome, progressLines, appLine } = await import("../../bin/apps.mjs");

// ------------------------------------------------------------------ pure parts

test("parseAppsArgs: start/stop need exactly one of --stack and --app; restart an app; the rest neither", () => {
  assert.deepEqual(
    { ...parseAppsArgs(["start", "--stack", "web", "--workspace", "eng-1", "--no-wait", "--timeout", "60"]) },
    { sub: "start", workspace: "eng-1", stack: "web", app: null, wait: false, timeoutSec: 60, help: false },
  );
  assert.equal(parseAppsArgs(["stop", "--app", "api"]).app, "api");
  assert.equal(parseAppsArgs(["start", "--app", "api"]).timeoutSec, 540, "waits 9 min by default, under a headless run's 10-min command cap");
  assert.equal(parseAppsArgs(["start", "--app", "api", "--port", "4000"]).app, "api", "--port is dashboard.mjs's");
  assert.match(parseAppsArgs(["start"]).error, /--stack <id> or --app <id>/);
  assert.match(parseAppsArgs(["start", "--stack", "a", "--app", "b"]).error, /one of them/);
  assert.match(parseAppsArgs(["restart", "--stack", "a"]).error, /restart needs --app/);
  assert.match(parseAppsArgs(["status", "--app", "a"]).error, /takes no --stack/);
  assert.match(parseAppsArgs(["stop-all", "--stack", "a"]).error, /takes no --stack/);
  assert.match(parseAppsArgs(["start", "--stack"]).error, /--stack needs a value/);
  assert.match(parseAppsArgs(["start", "--stack", "--no-wait"]).error, /--stack needs a value/);
  assert.match(parseAppsArgs(["start", "--app", "a", "--timeout", "soon"]).error, /seconds/);
  assert.match(parseAppsArgs(["start", "--app", "a", "--bogus"]).error, /Unknown option --bogus/);
  assert.match(parseAppsArgs(["start", "api"]).error, /Unexpected argument "api"/);
  assert.match(parseAppsArgs(["launch"]).error, /Unknown apps command "launch"/);
  assert.equal(parseAppsArgs([]).help, true);
  assert.equal(parseAppsArgs(["status"]).sub, "status");
  assert.equal(parseAppsArgs(["setup"]).sub, "setup");
});

test("resolveWorkspace: a slug, a path, else the deepest workspace holding the current folder, else main", () => {
  const main = path.resolve("/ws/shop");
  const list = [
    { slug: "main", name: "Main Workspace", path: main },
    { slug: "eng-1", name: "ENG-1", path: path.join(main, "worktrees", "ENG-1") },
    { slug: "shop-eng-2", name: "shop-ENG-2", path: path.resolve("/ws/shop-ENG-2") },
  ];
  const at = (cwd: string, want: string | null = null) => resolveWorkspace(list, want, cwd);
  assert.equal(at(path.join(main, "worktrees", "ENG-1", "api", "src")).ws.slug, "eng-1", "a worktree inside main's folder wins over main");
  assert.equal(at(path.join(main, "web")).ws.slug, "main");
  assert.equal(at(path.resolve("/ws/shop-ENG-2/web")).ws.slug, "shop-eng-2", "a native worktree beside main");
  assert.equal(at(path.resolve("/ws/shop-ENG-20")).ws.slug, "main", "a sibling whose name only starts the same isn't inside it; nothing holds it, so main");
  assert.equal(at(path.resolve("/elsewhere")).ws.slug, "main");
  assert.equal(at(path.resolve("/elsewhere"), "eng-1").ws.slug, "eng-1");
  assert.equal(at(path.resolve("/elsewhere"), "ENG-1").ws.slug, "eng-1", "slugs are lower case");
  assert.equal(at(main, "./worktrees/ENG-1").ws.slug, "eng-1", "a path, relative to the current folder");
  assert.match(at(main, "nope").error, /Unknown workspace "nope".*main, eng-1, shop-eng-2/);
});

test("jobOutcome: running isn't done; succeeded exits 0; failed, interrupted or gone exit 1", () => {
  assert.deepEqual(jobOutcome({ status: "running" }), { done: false, code: null });
  assert.deepEqual(jobOutcome({ status: "succeeded" }), { done: true, code: 0 });
  assert.deepEqual(jobOutcome({ status: "failed" }), { done: true, code: 1 });
  assert.deepEqual(jobOutcome({ status: "interrupted" }), { done: true, code: 1 });
  assert.deepEqual(jobOutcome(null), { done: true, code: 1 });
});

test("progressLines: each step once when it starts and once when it ends; each note once", () => {
  const seen = { steps: [], notes: 0 };
  const job: any = { notes: ["Skipping (not cloned here): Web"], steps: [{ label: "Launch API", status: "running" }] };
  assert.deepEqual(progressLines(job, seen), ["  note: Skipping (not cloned here): Web", "  ... Launch API"]);
  assert.deepEqual(progressLines(job, seen), [], "nothing new");
  job.steps[0].status = "done";
  job.steps.push({ label: "Wait for API to listen", status: "failed", error: "API exited before it started listening." });
  assert.deepEqual(progressLines(job, seen), ["  ok  Launch API", "  FAILED Wait for API to listen: API exited before it started listening."]);
});

test("appLine: port, up or down, the id to pass; not cloned; a worktree app using main's", () => {
  assert.match(appLine({ key: "api", name: "API", available: true, port: 7000, running: true, url: "http://localhost:7000" }), /API {2}:7000 +up {3}http:\/\/localhost:7000 {3}\[--app api\]/);
  assert.match(appLine({ key: "web", name: "Web", available: false }), /Web {2}not cloned here/);
  assert.match(appLine({ key: "api", name: "API", available: true, port: 7100, running: false, fallback: { port: 7000, running: true } }), /down here; uses main's on :7000 \(up\)/);
});

// ------------------------------------------------------------------ end to end

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-apps-cli-")));
const ROOT = path.join(TMP, "shop");
const WT = path.join(TMP, "shop-ENG-9");
const LEDGER = path.join(ROOT, ".claude", "ledger");
const PORT = await freePort();
const BASE = await freeBlock([1, 2, 101]); // main's api and broken; the worktree's api (slot 1)
const MAIN_API = BASE + 1, WT_API = BASE + 101;
const DASH_ERR = path.join(TMP, "dash.err");
let server: ChildProcess | null = null;

const w = (rel: string, text: string) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, WORKSPACE_ROOT: ROOT, DASHBOARD_LEDGER_DIR: LEDGER, DASHBOARD_PORT: "", DASHBOARD_HOSTED: "" };
/** The CLI from a folder: { code, out, err }. */
function apps(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, "apps", ...args], { cwd, env, encoding: "utf-8", timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

before(async () => {
  w("apps/api/server.js", `require("http").createServer((q, r) => r.end("api from " + __dirname)).listen(Number(process.env.PORT), "127.0.0.1");\n`);
  w("apps/broken/server.js", `console.log("broken on purpose"); process.exit(3);\n`);
  w(".gitignore", ".claude/ledger/\n");
  w(".claude/dashboard/workspace.json", JSON.stringify({
    name: "Shop", dashboard: { port: PORT },
    worktrees: { portsFile: path.join(TMP, "ports.json"), ports: { base: BASE, slotSize: 100 } },
    codeHost: { kind: "none" },
  }));
  w(".claude/dashboard/apps.json", JSON.stringify({
    apps: {
      api: { name: "API", dir: "apps/api", port: MAIN_API, bootSeconds: 20, launch: { cmd: "node server.js", env: { PORT: "{{port}}" } } },
      broken: { name: "Broken", dir: "apps/broken", port: BASE + 2, bootSeconds: 20, launch: { cmd: "node server.js" } },
    },
    stacks: { app: { label: "App", apps: ["api"] } },
  }));
  git(ROOT, "init", "-q", "-b", "main");
  git(ROOT, "config", "user.email", "t@example.com");
  git(ROOT, "config", "user.name", "T");
  git(ROOT, "add", ".");
  git(ROOT, "commit", "-q", "-m", "init");
  git(ROOT, "worktree", "add", "-q", "-b", "feature/ENG-9", WT);

  // Its stderr goes to a file, shown in after() if it died: a dead dashboard then names its cause.
  const err = fs.openSync(DASH_ERR, "w");
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(HERE, "..", "src", "main.ts"), "--port", String(PORT)], { env, stdio: ["ignore", "ignore", err] });
  fs.closeSync(err);
  for (let i = 0; i < 80 && !(await listening(PORT)); i++) await sleep(250);
  assert.ok(await listening(PORT), "the server came up");
});

// Cleanup never fails the file: a test that failed says why on its own.
after(async () => {
  // A dashboard that stopped answering may not have reported its exit yet: give it a moment.
  const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
  if (server && alive(server) && !(await listening(PORT))) await new Promise((r) => { server!.once("exit", r); setTimeout(r, 3000); });
  if (server && !alive(server)) {
    const read = (f: string, max = 4000) => { try { return fs.readFileSync(f, "utf-8").slice(-max); } catch { return ""; } };
    const jobs = path.join(LEDGER, "apps");
    let logs = "";
    try {
      for (const f of fs.readdirSync(jobs).filter((f) => f.endsWith(".log")).sort().slice(-3)) logs += `--- ${f} (end)\n${read(path.join(jobs, f), 1500)}\n`;
    } catch {}
    const abort = server.exitCode === 0xC0000409 ? ": 0xC0000409, Node aborting natively (Node 24.15 does this at random on Windows, skills#124)" : "";
    console.error(`The dashboard exited early (code ${server.exitCode}${abort}, signal ${server.signalCode}). Its stderr:\n${read(DASH_ERR) || "(empty)"}\nIts latest app jobs:\n${logs || "(none)"}`);
  }
  const stopped = [WT, ROOT].map((cwd) => { try { return apps(cwd, "stop-all").code === 0; } catch { return false; } });
  if (stopped.includes(false)) {
    // No dashboard to stop them: kill the launchers it recorded that are still ours, checked as
    // Stop checks (stillOurs, then the start time), so a pid the OS has since handed to something
    // else isn't taken down. A record without a start time can't be checked: leave it.
    try {
      const { stillOurs, launchedAt } = await import("../src/apps.ts");
      const pids = JSON.parse(fs.readFileSync(path.join(LEDGER, "apps", "pids.json"), "utf-8"));
      for (const rec of Object.values<any>(pids)) {
        if (!rec?.pid || !rec.startedAt || !stillOurs(rec)) continue;
        if (!(await launchedAt(rec.pid, rec.startedAt).catch(() => false))) continue;
        const pid = rec.pid;
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        else try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
    } catch {}
  }
  server?.kill();
  try { git(ROOT, "worktree", "remove", "--force", WT); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

test("from a worktree's folder: status, then start a stack there, then stop it", { timeout: 180_000 }, async () => {
  // The server's view of the native worktree: its ticket from the branch, no ports until a first start, its repo the root.
  const get = async (p: string) => (await fetch(`http://localhost:${PORT}${p}`)).json();
  const wt = (await get("/api/status")).workspaces.find((x) => x.name === "shop-ENG-9");
  assert.ok(wt, "the worktree is a workspace");
  assert.equal(wt._ticketId, "ENG-9");
  assert.ok(wt.apps.every((a) => a.port === null), "no ports before the first start");
  const g = await get("/api/git?workspace=" + wt.slug);
  assert.deepEqual(Object.keys(g.repos), ["."]);
  assert.equal(g.repos["."].branch, "feature/ENG-9");

  const st = apps(path.join(WT, "apps"), "status");
  assert.equal(st.code, 0, st.err);
  assert.match(st.out, /shop-ENG-9 \(--workspace shop-eng-9\)/, "the worktree holding the current folder");
  assert.match(st.out, /API .*down .*\[--app api\]/);
  assert.match(st.out, /--stack app \(default\): App \(api\)/, "stack ids to start");

  const start = apps(WT, "start", "--stack", "app");
  assert.equal(start.code, 0, start.err + start.out);
  assert.match(start.out, /Start App in shop-ENG-9 \(job /);
  assert.match(start.out, /ok {2}Wait for API to listen/);
  assert.match(start.out, new RegExp(`API +:${WT_API} +up`), "where it's running");
  assert.match(start.out, /apps stop --stack app --workspace shop-eng-9/, "how to stop it");
  assert.match(await (await fetch(`http://localhost:${WT_API}`)).text(), /shop-ENG-9/, "the worktree's own instance");
  assert.equal(await listening(MAIN_API), false, "not main's");
  const ports = JSON.parse(fs.readFileSync(path.join(TMP, "ports.json"), "utf-8"));
  const entry = Object.values<any>(ports.worktrees)[0];
  assert.deepEqual({ slot: entry.slot, ports: entry.ports }, { slot: 1, ports: { api: WT_API, broken: BASE + 102 } },
    "the first start allocated slot 1 in the ports file, each app at its offset");

  const stop = apps(ROOT, "stop", "--stack", "app", "--workspace", "shop-eng-9");
  assert.equal(stop.code, 0, stop.err);
  assert.equal(await listening(WT_API), false, "stopped");
});

test("--no-wait returns once the job is accepted; a failing app exits 1 with its log", { timeout: 180_000 }, async () => {
  const quick = apps(ROOT, "start", "--app", "api", "--no-wait");
  assert.equal(quick.code, 0, quick.err);
  assert.match(quick.out, /Not waiting/);
  for (let i = 0; i < 80 && !(await listening(MAIN_API)); i++) await sleep(250);
  assert.ok(await listening(MAIN_API), "it starts anyway");
  for (let i = 0; i < 40 && /In progress/.test(apps(ROOT, "status").out); i++) await sleep(250); // its job ends
  assert.equal(apps(ROOT, "stop", "--app", "api").code, 0);

  const bad = apps(ROOT, "start", "--app", "broken");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Failed: Start Broken: Broken exited before it started listening/);
  assert.match(bad.err, /Log: .*\.log/);
});

test("errors: an unknown app lists the ids; bad arguments exit 2; no dashboard, another workspace's, hosted", { timeout: 120_000 }, async () => {
  const unknown = apps(ROOT, "start", "--app", "nope");
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /Unknown app nope/);
  assert.match(unknown.err, /stacks: app/);
  assert.match(unknown.err, /apps in main: api, broken/);

  const usage = apps(ROOT, "start");
  assert.equal(usage.code, 2);
  assert.match(usage.err, /Usage: node .*dashboard\.mjs apps/);

  const elsewhere = path.join(TMP, "other");
  fs.mkdirSync(path.join(elsewhere, ".claude", "dashboard"), { recursive: true });
  const free = await freePort();
  fs.writeFileSync(path.join(elsewhere, ".claude", "dashboard", "workspace.json"), JSON.stringify({ name: "Other", dashboard: { port: free } }));
  const down = spawnSync(process.execPath, [CLI, "apps", "status"], { cwd: elsewhere, encoding: "utf-8", env: { ...env, WORKSPACE_ROOT: elsewhere, DASHBOARD_LEDGER_DIR: path.join(elsewhere, "ledger") } });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /dashboard isn't running .*\n.*dashboard\.mjs start/);

  const wrong = spawnSync(process.execPath, [CLI, "apps", "status", "--port", String(PORT)], { cwd: elsewhere, encoding: "utf-8", env: { ...env, WORKSPACE_ROOT: elsewhere, DASHBOARD_LEDGER_DIR: path.join(elsewhere, "ledger") } });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /another workspace's/, "a dashboard serving some other workspace isn't used");

  const hosted = spawnSync(process.execPath, [CLI, "apps", "start", "--app", "api"], { cwd: ROOT, encoding: "utf-8", env: { ...env, DASHBOARD_HOSTED: "1" } });
  assert.equal(hosted.status, 1);
  assert.match(hosted.stderr, /hosted dashboard/);
});

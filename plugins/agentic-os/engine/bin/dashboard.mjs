#!/usr/bin/env node
/**
 * Start, stop or check the workspace dashboard, with nothing else installed:
 *
 *   node dashboard/bin/dashboard.mjs start [--port N] [--restart] [--open] [--skip-build]
 *   node dashboard/bin/dashboard.mjs stop
 *   node dashboard/bin/dashboard.mjs status
 *
 * Port: --port, else the DASHBOARD_PORT env var, else .claude/dashboard/workspace.json
 * dashboard.port, else 3333.
 *
 * start installs packages (npm ci) and builds the UI (ng build) when they're missing
 * or out of date, in the foreground (a minute or two the first time), then runs the
 * server fully detached: it keeps running after the terminal or Claude session that
 * started it closes. Running start when it's already up does nothing; --restart
 * replaces it (and ends any Claude run in progress; those show as interrupted).
 *
 * The server needs Node >= the "engines" floor in dashboard/package.json. If the
 * default node is older, a newer version installed with nvm is used for it.
 *
 * Plain JavaScript on purpose: this runs before anything is installed, on whatever
 * Node is on PATH.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DASH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(DASH_DIR, ".."));
const LEDGER = path.resolve(process.env.DASHBOARD_LEDGER_DIR || path.join(ROOT, ".claude", "ledger"));
const IS_WIN = process.platform === "win32";

// Markers of a Claude Code session; a long-lived service must not inherit them
// (a claude it starts would think it's a sub-session). Keep in step with server/src/claude.ts.
const CLAUDE_SESSION_ENV = [
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_EXECPATH", "CLAUDE_EFFORT",
];

// ------------------------------------------------------------------ args

const [cmd = "status", ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  flags[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
}

function workspacePort() {
  const fromFlag = parseInt(flags.port || "", 10);
  if (fromFlag > 0) return fromFlag;
  const fromEnv = parseInt(process.env.DASHBOARD_PORT || "", 10);
  if (fromEnv > 0) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude", "dashboard", "workspace.json"), "utf-8"));
    const p = parseInt((cfg.dashboard && cfg.dashboard.port) || "", 10);
    if (p > 0) return p;
  } catch {}
  return 3333;
}
const PORT = workspacePort();
const URL_ = `http://localhost:${PORT}`;

// ------------------------------------------------------------------ helpers

function parseVer(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function listening(port) {
  const probe = (host) => new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(800);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
  return probe("127.0.0.1").then((up) => up || probe("::1"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Node floor from package.json engines (">=24.15.0"). */
function nodeFloor() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DASH_DIR, "package.json"), "utf-8"));
    const m = /(\d+\.\d+\.\d+)/.exec((pkg.engines && pkg.engines.node) || "");
    if (m) return m[1];
  } catch {}
  return "24.15.0";
}

/**
 * A folder to put first on PATH so node/npm/npx are new enough, "" when the default
 * already is, or null when nothing suitable is installed.
 */
function nodeDir(required) {
  try {
    if (cmpVer(execFileSync("node", ["-v"], { encoding: "utf-8" }), required) >= 0) return "";
  } catch {}
  const root = IS_WIN
    ? process.env.NVM_HOME || path.join(os.homedir(), "AppData", "Roaming", "nvm")
    : path.join(process.env.NVM_DIR || path.join(os.homedir(), ".nvm"), "versions", "node");
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  const exe = IS_WIN ? "node.exe" : "node";
  const hit = dirs
    .filter((d) => /^v?\d+\.\d+\.\d+$/.test(d) && cmpVer(d, required) >= 0)
    .map((d) => (IS_WIN ? path.join(root, d) : path.join(root, d, "bin")))
    .filter((d) => fs.existsSync(path.join(d, exe)))
    .sort((a, b) => cmpVer(path.basename(IS_WIN ? b : path.dirname(b)), path.basename(IS_WIN ? a : path.dirname(a))))[0];
  return hit || null;
}

function cleanEnv(prependDir) {
  const env = { ...process.env };
  for (const k of CLAUDE_SESSION_ENV) delete env[k];
  delete env.ANTHROPIC_API_KEY;
  if (prependDir) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
    env[key] = prependDir + path.delimiter + (env[key] || "");
  }
  return env;
}

/** Newest mtime under a path, skipping installs and build output. */
function newest(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    max = Math.max(max, newest(path.join(p, e.name)));
  }
  return max;
}

function ensureBuilt(env) {
  const index = path.join(DASH_DIR, "dist", "browser", "index.html");
  const sources = () => Math.max(...["web", "shared", "angular.json", "package.json", "tsconfig.json"].map((s) => newest(path.join(DASH_DIR, s))));
  // A published UI (dist/.prebuilt.json, from snapshot publish) needs no packages: the
  // server only uses Node itself. So someone with the downloaded copy never runs npm.
  if (fs.existsSync(path.join(DASH_DIR, "dist", ".prebuilt.json")) && fs.existsSync(index) && sources() <= newest(index)) return;
  const installed = path.join(DASH_DIR, "node_modules", ".package-lock.json");
  if (!fs.existsSync(installed) || newest(path.join(DASH_DIR, "package-lock.json")) > newest(installed)) {
    console.log("Installing the dashboard's packages (npm ci)...");
    execSync("npm ci --no-audit --no-fund", { cwd: DASH_DIR, stdio: "inherit", env });
  }
  if (flags["skip-build"]) return;
  if (!fs.existsSync(index) || sources() > newest(index)) {
    console.log("Building the dashboard UI (ng build)...");
    execSync("npx ng build", { cwd: DASH_DIR, stdio: "inherit", env });
  }
}

// dashboard.pid: the pid on the first line, the port it serves on the second (older
// files have only the pid). The port is how a start after a port change finds the old one.
const pidFile = path.join(LEDGER, "dashboard.pid");
function readRecord() {
  try {
    const [pid, port] = fs.readFileSync(pidFile, "utf-8").trim().split(/\s+/).map((s) => parseInt(s, 10));
    return { pid: pid > 0 ? pid : null, port: port > 0 ? port : null };
  } catch { return { pid: null, port: null }; }
}
const readPid = () => readRecord().pid;

/** Kill the dashboard: the pid it recorded, and whatever still holds its port. */
function killDashboard(port = PORT) {
  const pids = new Set();
  const recorded = readPid();
  if (recorded) pids.add(recorded);
  try {
    if (IS_WIN) {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      for (const s of out.split(/\r?\n/)) if (Number(s.trim())) pids.add(Number(s.trim()));
    } else {
      const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      for (const s of out.split(/\s+/)) if (Number(s)) pids.add(Number(s));
    }
  } catch {}
  for (const pid of pids) {
    try {
      if (IS_WIN) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(pid, "SIGTERM");
    } catch {}
  }
  try { fs.unlinkSync(pidFile); } catch {}
  return pids.size > 0;
}

function openBrowser(url) {
  try {
    const [c, a] = IS_WIN ? ["cmd.exe", ["/C", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(c, a, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {}
}

/**
 * Runs, usage meters and autocomplete all need Claude Code installed and signed in.
 * Say so now (the dashboard still starts: its Machine page walks through the fix).
 */
function warnIfClaudeNotReady() {
  let out = null;
  try {
    out = execFileSync(IS_WIN ? "claude.exe" : "claude", ["auth", "status"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000, env: cleanEnv("") });
  } catch (e) {
    // Non-zero exit (e.g. signed out) still prints the status JSON; no output at all = not installed.
    out = e && e.stdout ? String(e.stdout) : null;
    if (out === null && IS_WIN) {
      try { out = execFileSync("claude auth status", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000, shell: true, env: cleanEnv("") }); } catch (e2) { out = e2 && e2.stdout ? String(e2.stdout) : null; }
    }
  }
  if (!out) {
    console.log("\nHeads up: Claude Code isn't installed (or isn't on PATH). Runs won't work until it is:");
    console.log(IS_WIN ? "  irm https://claude.ai/install.ps1 | iex" : "  curl -fsSL https://claude.ai/install.sh | bash");
    console.log("  then sign in: claude auth login   (the Machine page has buttons for both)");
    return;
  }
  let status = null;
  try { status = JSON.parse(out.slice(out.indexOf("{"))); } catch {}
  if (status && status.loggedIn === false) {
    console.log("\nHeads up: Claude Code isn't signed in, so dashboard runs can't start. Sign in with:");
    console.log("  claude auth login   (or the Sign in button on the Machine page)");
  }
}

// ------------------------------------------------------------------ commands

async function start() {
  if (await listening(PORT)) {
    if (!flags.restart) {
      console.log(`The dashboard is already running at ${URL_} (use --restart after pulling updates).`);
      if (flags.open) openBrowser(URL_);
      return;
    }
    killDashboard();
    await sleep(1000);
    console.log("Stopped the running dashboard.");
  }

  // The port changed (workspace.json, DASHBOARD_PORT or --port) while this workspace's
  // dashboard was up on the old one. Starting a second would orphan the first.
  const was = readRecord();
  if (was.port && was.port !== PORT && (await listening(was.port))) {
    if (!flags.restart) {
      console.log(`The dashboard is running on its previous port, http://localhost:${was.port}. Use restart to move it to ${PORT}.`);
      return;
    }
    killDashboard(was.port);
    await sleep(1000);
    console.log(`Stopped the dashboard on its previous port, ${was.port}.`);
  }

  const floor = nodeFloor();
  const dir = nodeDir(floor);
  if (dir === null) {
    let current = "none";
    try { current = execFileSync("node", ["-v"], { encoding: "utf-8" }).trim(); } catch {}
    console.error(`The dashboard needs Node.js ${floor} or newer (found: ${current}).`);
    console.error(IS_WIN ? "Install it: winget install OpenJS.NodeJS.LTS  (then open a new terminal)" : "Install it: brew install node  (or nvm install --lts)");
    process.exit(1);
  }
  const env = cleanEnv(dir);
  ensureBuilt(env);

  fs.mkdirSync(LEDGER, { recursive: true });
  const log = fs.openSync(path.join(LEDGER, "dashboard.log"), "a");
  const node = dir ? path.join(dir, IS_WIN ? "node.exe" : "node") : "node";
  const child = spawn(node, ["--disable-warning=ExperimentalWarning", path.join("server", "src", "main.ts"), "--port", String(PORT)], {
    cwd: DASH_DIR,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env,
  });
  child.unref();
  fs.writeFileSync(pidFile, `${child.pid}\n${PORT}\n`);

  for (let i = 0; i < 40 && !(await listening(PORT)); i++) await sleep(250);
  if (!(await listening(PORT))) {
    console.error(`The dashboard didn't start listening on :${PORT}. See ${path.join(LEDGER, "dashboard.log")}.`);
    process.exit(1);
  }
  console.log(`Dashboard running at ${URL_} (pid ${child.pid}). It keeps running after you close this terminal.`);
  warnIfClaudeNotReady();
  if (flags.open) openBrowser(URL_);
}

async function stop() {
  const was = readRecord();
  if (!(await listening(PORT)) && !was.pid) { console.log(`No dashboard running on :${PORT}.`); return; }
  killDashboard();
  if (was.port && was.port !== PORT) killDashboard(was.port); // started before a port change
  console.log("Dashboard stopped. Runs that were in progress show as interrupted; reply to one to carry on.");
}

async function status() {
  const up = await listening(PORT);
  console.log(up ? `Running at ${URL_}` : `Not running (port ${PORT}).`);
  process.exitCode = up ? 0 : 1;
}

const commands = { start, stop, status, restart: () => { flags.restart = true; return start(); } };
if (!commands[cmd]) {
  console.error("Usage: node dashboard/bin/dashboard.mjs <start|stop|restart|status> [--port N] [--restart] [--open] [--skip-build]");
  process.exit(2);
}
await commands[cmd]();

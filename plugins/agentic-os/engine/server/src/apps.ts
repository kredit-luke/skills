/**
 * App launcher: start/stop the workspace's apps and stacks from the dashboard.
 * What exists, and how each one starts, is .claude/dashboard/apps.json.
 *
 * Two ways to launch an app:
 *  - { launcher: "<args>" }: the team's own launcher script (apps.json
 *    launcher.script, e.g. a run-apps.js) with those args plus --workspace <path>.
 *    With detached: true it's long-running and goes through the two-hop launcher
 *    below; otherwise it's a short command that starts (and detaches) the app itself.
 *  - { cmd, cwd?, env? }: a shell command, always long-running. Stopped by
 *    killing its process tree (pid kept in <ledger>/apps/pids.json).
 *
 * Long-running apps use a two-hop launcher: a DETACHED `node -e` launcher that
 * starts the app NON-detached with windowsHide. That gives the app a hidden
 * console its children inherit, so Windows never pops a terminal window, and
 * the app is decoupled from the dashboard process: restarting the dashboard
 * leaves running apps alone.
 *
 * Every start/stop is a "job" with ordered steps and a log under
 * <ledger>/apps/, shown in the UI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { readConfigFile, WORKSPACE_ROOT } from "./config.ts";

export interface AppLaunch { launcher?: string; detached?: boolean; cmd?: string; cwd?: string; env?: Record<string, string> }
export interface AppDef {
  key: string; name: string; type: string; dir: string; workDir?: string; group: string;
  port: number | null; https: boolean; mainOnly: boolean; bootMs: number; launch: AppLaunch; logFile?: string;
}
export type StackStep = {
  setup?: boolean; start?: string[] | "rest"; wait?: string[] | "all";
  launcher?: string; cmd?: string; label?: string; timeoutMin?: number;
};
export interface StackDef { label: string; description: string; hint?: string; apps: string[]; mainOnly?: boolean; steps?: StackStep[] }
export interface AppsConfig {
  configured: boolean;
  error: string | null;
  launcher: { script: string; stop: string; workspaceArg: string | null } | null;
  setup: { label: string; launcher?: string; cmd?: string; timeoutMin: number } | null;
  groups: { id: string; label: string }[];
  defaultStack: string | null;
  apps: Record<string, AppDef>;
  stacks: Record<string, StackDef>;
}

const SAFE_KEY = /^[A-Za-z][\w-]{0,63}$/;
const safeRel = (d: unknown) => typeof d === "string" && /^[\w.-]+(\/[\w.-]+)*$/.test(d) && !d.split("/").some((s) => /^\.+$/.test(s));

/** apps.json, validated. Bad entries are dropped (and named in `error`) instead of failing the page. */
export function appsConfig(): AppsConfig {
  const { data, error } = readConfigFile("apps.json");
  const raw = data || {};
  const problems: string[] = error ? [error] : [];
  const apps: Record<string, AppDef> = {};
  for (const [key, a] of Object.entries<any>(raw.apps || {})) {
    if (!SAFE_KEY.test(key) || !a || typeof a.name !== "string" || !safeRel(a.dir)) {
      problems.push(`app "${key}" needs a name and a workspace-relative dir`);
      continue;
    }
    const launch = a.launch && typeof a.launch === "object" ? a.launch : {};
    if (typeof launch.launcher !== "string" && typeof launch.cmd !== "string") {
      problems.push(`app "${key}" needs launch.launcher or launch.cmd`);
      continue;
    }
    apps[key] = {
      key,
      name: a.name,
      type: typeof a.type === "string" ? a.type : "",
      dir: a.dir,
      workDir: safeRel(a.workDir) ? a.workDir : undefined,
      group: typeof a.group === "string" ? a.group : "apps",
      port: Number(a.port) || null,
      https: a.https === true,
      mainOnly: a.mainOnly === true,
      bootMs: (Number(a.bootSeconds) || 120) * 1000,
      launch,
      logFile: typeof a.logFile === "string" ? a.logFile : undefined,
    };
  }
  const groups: { id: string; label: string }[] = (Array.isArray(raw.groups) ? raw.groups : [])
    .filter((g: any) => g && typeof g.id === "string")
    .map((g: any) => ({ id: g.id, label: typeof g.label === "string" ? g.label : g.id }));
  for (const a of Object.values(apps)) if (!groups.some((g) => g.id === a.group)) groups.push({ id: a.group, label: a.group });

  const stacks: Record<string, StackDef> = {};
  for (const [id, s] of Object.entries<any>(raw.stacks || {})) {
    if (!SAFE_KEY.test(id) || !s || !Array.isArray(s.apps)) { problems.push(`stack "${id}" needs apps[]`); continue; }
    stacks[id] = {
      label: typeof s.label === "string" ? s.label : id,
      description: typeof s.description === "string" ? s.description : "",
      hint: typeof s.hint === "string" ? s.hint : undefined,
      apps: s.apps.filter((k: string) => apps[k]),
      mainOnly: s.mainOnly === true,
      steps: Array.isArray(s.steps) ? s.steps : undefined,
    };
  }
  const l = raw.launcher;
  const launcher = l && typeof l.script === "string"
    ? {
      script: path.resolve(WORKSPACE_ROOT, l.script),
      stop: typeof l.stop === "string" ? l.stop : "stop {app}",
      workspaceArg: l.workspaceArg === null ? null : typeof l.workspaceArg === "string" ? l.workspaceArg : "--workspace",
    }
    : null;
  const st = raw.setup;
  const setup = st && (typeof st.launcher === "string" || typeof st.cmd === "string")
    ? { label: typeof st.label === "string" ? st.label : "Setup", launcher: st.launcher, cmd: st.cmd, timeoutMin: Number(st.timeoutMin) || 15 }
    : null;
  const defaultStack = typeof raw.defaultStack === "string" && stacks[raw.defaultStack] ? raw.defaultStack : Object.keys(stacks)[0] || null;
  return {
    configured: !!data,
    error: problems.length ? `apps.json: ${problems.join("; ")}` : null,
    launcher, setup, groups, defaultStack, apps, stacks,
  };
}

const JOB_HISTORY = 30;

class AppLauncher {
  logDir: string;
  pidFile: string;
  portOf: (ws, key: string) => number | null;
  isUp: (port: number) => Promise<boolean>;
  jobs: any[];

  /**
   * @param o.logDir  where job logs go
   * @param o.portOf  current port for an app in a workspace
   * @param o.isUp    TCP check
   */
  constructor({ logDir, portOf, isUp }) {
    this.logDir = logDir;
    this.pidFile = path.join(logDir, "pids.json");
    this.portOf = portOf;
    this.isUp = isUp;
    this.jobs = [];
    fs.mkdirSync(logDir, { recursive: true });
    this._load();
  }

  get cfg() { return appsConfig(); }

  /** Reload job history (and log pointers) so Logs still work after a dashboard restart. */
  _load() {
    let files = [];
    try { files = fs.readdirSync(this.logDir).filter((f) => f.endsWith(".json") && f !== "pids.json"); } catch {}
    for (const f of files) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.logDir, f), "utf-8"));
        job._log = path.join(this.logDir, `${job.id}.log`);
        if (job.status === "running") {
          // The dashboard died mid-job. The app itself may well be up; only the watcher stopped.
          job.status = "interrupted";
          job.error = "Dashboard restarted before this finished; check the app's status.";
          job.endedAt = job.endedAt || new Date().toISOString();
          this._save(job);
        }
        this.jobs.push(job);
      } catch {}
    }
    this.jobs.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    this._prune();
  }

  _save(job) {
    const { _log, ...pub } = job;
    try { fs.writeFileSync(path.join(this.logDir, `${job.id}.json`), JSON.stringify(pub, null, 2)); } catch {}
  }

  /** Is this app usable in this workspace (repo cloned, allowed there)? */
  available(ws, key) {
    const app = this.cfg.apps[key];
    if (!app) return false;
    if (app.mainOnly && ws.slug !== "main") return false;
    return fs.existsSync(path.join(ws.path, app.dir));
  }

  busy(wsSlug, key) {
    return this.jobs.find((j) => j.status === "running" && j.workspace === wsSlug && (j.apps || []).includes(key)) || null;
  }

  list() {
    return this.jobs.map(({ _log, ...j }) => j);
  }

  /** An app's own log file (logFile in apps.json), with {tmp} and {workspace} expanded. */
  _appLogFile(key, wsPath = WORKSPACE_ROOT) {
    const app = this.cfg.apps[key];
    if (!app || !app.logFile) return null;
    return path.resolve(wsPath, app.logFile.replace(/\{tmp\}/g, os.tmpdir()).replace(/\{workspace\}/g, wsPath));
  }

  log(jobId, maxBytes = 64 * 1024) {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    const files = [job._log];
    for (const key of job.apps || []) { const f = this._appLogFile(key); if (f) files.push(f); }
    return files.map((f) => ({ file: f, text: tail(f, maxBytes) })).filter((f) => f.text);
  }

  /** Latest job log for one app in one workspace (for the per-app Logs button). */
  appLog(wsSlug, key) {
    const job = this.jobs.find((j) => j.workspace === wsSlug && (j.apps || []).includes(key));
    const files = [];
    if (job) files.push(job._log);
    const own = this._appLogFile(key);
    if (own) files.push(own);
    return files.map((f) => ({ file: f, text: tail(f, 64 * 1024) })).filter((f) => f.text);
  }

  // ------------------------------------------------------------ public actions

  startApp(ws, key) {
    const app = this._assert(ws, key);
    return this._job(ws, `Start ${app.name}`, [key], async (step) => {
      await this._startOne(ws, key, step);
    });
  }

  stopApp(ws, key) {
    const app = this._assert(ws, key);
    return this._job(ws, `Stop ${app.name}`, [key], async (step) => {
      await step(`Stop ${app.name}`, this._stopOne(ws, key));
    });
  }

  restartApp(ws, key) {
    const app = this._assert(ws, key);
    return this._job(ws, `Restart ${app.name}`, [key], async (step) => {
      await step(`Stop ${app.name}`, this._stopOne(ws, key));
      await this._startOne(ws, key, step);
    });
  }

  startStack(ws, stackId) {
    const cfg = this.cfg;
    const stack = cfg.stacks[stackId];
    if (!stack) throw new Error(`Unknown stack ${stackId}`);
    if (stack.mainOnly && ws.slug !== "main") throw new Error(`${stack.label} only runs from the main workspace.`);
    const apps = stack.apps.filter((k) => this.available(ws, k));
    if (!apps.length) throw new Error(`None of the ${stack.label} repos are cloned in ${ws.name}.`);
    const skipped = stack.apps.filter((k) => !apps.includes(k));
    const steps: StackStep[] = stack.steps && stack.steps.length ? stack.steps : [{ start: "rest" }];

    return this._job(ws, `Start ${stack.label}`, apps, async (step, note) => {
      if (skipped.length) note(`Skipping (not cloned here): ${skipped.map((k) => cfg.apps[k].name).join(", ")}`);
      const started = new Set<string>();
      for (const s of steps) {
        if (s.setup) {
          if (!cfg.setup) { note("No setup step in apps.json; skipped."); continue; }
          await step(cfg.setup.label, this._command(cfg.setup, ws, cfg.setup.timeoutMin * 60000));
        } else if (s.start) {
          const keys = (s.start === "rest" ? apps.filter((k) => !started.has(k)) : s.start.filter((k) => apps.includes(k)));
          keys.forEach((k) => started.add(k));
          await Promise.all(keys.map((k) => this._startOne(ws, k, step)));
        } else if (s.wait) {
          const keys = s.wait === "all" ? apps : s.wait.filter((k) => apps.includes(k));
          await Promise.all(keys.map((k) => this._waitUp(ws, k, step)));
        } else if (s.launcher || s.cmd) {
          // A step for an app that isn't cloned here (e.g. "ping api") is skipped with it.
          const target = s.launcher ? s.launcher.trim().split(/\s+/)[1] : null;
          if (target && cfg.apps[target] && !apps.includes(target)) continue;
          await step(s.label || (s.launcher ? `launcher ${s.launcher}` : s.cmd!), this._command(s, ws, (Number(s.timeoutMin) || 2) * 60000));
        }
      }
    });
  }

  stopStack(ws, stackId) {
    const cfg = this.cfg;
    const stack = cfg.stacks[stackId];
    if (!stack) throw new Error(`Unknown stack ${stackId}`);
    const apps = stack.apps.filter((k) => this.available(ws, k));
    return this._job(ws, `Stop ${stack.label}`, apps, async (step) => {
      await Promise.all(apps.map((k) => step(`Stop ${cfg.apps[k].name}`, this._stopOne(ws, k))));
    });
  }

  /** The apps.json setup step on its own (the Machine page's Run setup button). */
  setupWorkspace(ws) {
    const setup = this.cfg.setup;
    if (!setup) throw new Error("There's no setup step in apps.json.");
    if (this.jobs.some((j) => j.status === "running" && j.workspace === ws.slug && j.label.startsWith("Setup"))) {
      throw new Error("Setup is already running.");
    }
    return this._job(ws, `Setup ${ws.name}`, [], async (step) => {
      await step(setup.label, this._command(setup, ws, setup.timeoutMin * 60000));
    });
  }

  /** Stop every app this workspace can run (the Workspaces "Stop all" button). */
  stopWorkspace(ws) {
    const cfg = this.cfg;
    const apps = Object.keys(cfg.apps).filter((k) => this.available(ws, k));
    return this._job(ws, `Stop all in ${ws.name}`, apps, async (step) => {
      await Promise.all(apps.map((k) => step(`Stop ${cfg.apps[k].name}`, this._stopOne(ws, k))));
    });
  }

  // ------------------------------------------------------------ internals

  _assert(ws, key): AppDef {
    const app = this.cfg.apps[key];
    if (!app) throw new Error(`Unknown app ${key}`);
    if (!this.available(ws, key)) {
      throw new Error(app.mainOnly && ws.slug !== "main"
        ? `${app.name} only runs from the main workspace.`
        : `${app.dir} isn't cloned in ${ws.name}.`);
    }
    if (this.busy(ws.slug, key)) throw new Error(`${app.name} already has an action in progress.`);
    return app;
  }

  async _startOne(ws, key, step) {
    const app = this.cfg.apps[key];
    const port = this.portOf(ws, key);
    if (port && (await this.isUp(port))) {
      await step(`${app.name} already running on :${port}`, async () => {});
      return;
    }
    await step(`Launch ${app.name}`, async (log) => {
      if (app.launch.cmd) this._launchCmd(ws, app, log);
      else if (app.launch.detached) this._launchDetached(this._launcherArgs(app.launch.launcher!), ws, key, log);
      else await this._command({ launcher: app.launch.launcher }, ws, 10 * 60000)(log);
    });
    await this._waitUp(ws, key, step);
  }

  /** Stop one app: its launcher's stop command, or kill the process tree we started. */
  _stopOne(ws, key) {
    const app = this.cfg.apps[key];
    if (app && app.launch.cmd) {
      return async (log) => {
        const pids = this._pids();
        const id = `${ws.slug}:${key}`;
        const pid = pids[id];
        if (!pid) { log(`${app.name}: nothing started from here to stop.`); return; }
        log(`Stopping process tree ${pid}`);
        killTree(pid);
        delete pids[id];
        this._savePids(pids);
      };
    }
    const launcher = this.cfg.launcher;
    if (!launcher) return async (log) => { log("No launcher configured in apps.json; nothing to run."); };
    return this._command({ launcher: launcher.stop.replace(/\{app\}/g, key) }, ws);
  }

  _waitUp(ws, key, step) {
    const app = this.cfg.apps[key];
    return step(`Wait for ${app.name} to listen`, async (log) => {
      const deadline = Date.now() + app.bootMs;
      while (Date.now() < deadline) {
        // Re-read each time: setup/run may allocate a worktree port mid-job.
        const port = this.portOf(ws, key);
        if (port && (await this.isUp(port))) { log(`${app.name} is up on :${port}`); return; }
        if (this._exited(log.file, key)) throw new Error(`${app.name} exited before it started listening. See the log.`);
        await sleep(2000);
      }
      throw new Error(`${app.name} didn't start listening within ${Math.round(app.bootMs / 60000)} min. It may still be compiling; check the log.`);
    });
  }

  /** Did the launcher record that this app's process exited? */
  _exited(logFile, key) {
    try {
      return fs.readFileSync(logFile, "utf-8").includes(`[${key} exited with code`);
    } catch {
      return false;
    }
  }

  _launcherArgs(args: string): string[] {
    return String(args).trim().split(/\s+/).filter(Boolean);
  }

  /**
   * A short-lived command, output into the job log: { launcher: "<args>" } runs the
   * launcher script, { cmd } a shell command in the workspace.
   */
  _command(spec: { launcher?: string; cmd?: string }, ws, timeout = 2 * 60000) {
    return (log) => new Promise<void>((resolve, reject) => {
      const done = (label) => (err, stdout, stderr) => {
        if (stdout) log(String(stdout).trimEnd());
        if (stderr) log(String(stderr).trimEnd());
        if (err) return reject(new Error(err.killed ? `Timed out: ${label}` : `${label} failed (exit ${err.code})`));
        resolve();
      };
      if (spec.launcher) {
        const launcher = this.cfg.launcher;
        if (!launcher) return reject(new Error("apps.json has no launcher script."));
        const args = this._launcherArgs(spec.launcher);
        const full = [launcher.script, ...args, ...(launcher.workspaceArg ? [launcher.workspaceArg, fwd(ws.path)] : [])];
        log(`$ ${path.basename(launcher.script)} ${args.join(" ")}`);
        execFile(process.execPath, full, { cwd: ws.path, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, done(`${path.basename(launcher.script)} ${args[0]}`));
        return;
      }
      const cmd = expand(spec.cmd || "", ws, null, this.portOf);
      log(`$ ${cmd}`);
      execFile(cmd, [], { cwd: ws.path, timeout, windowsHide: true, shell: true, maxBuffer: 16 * 1024 * 1024 }, done(cmd.split(" ")[0]));
    });
  }

  /** The launcher script with `args`, long-running, via the two-hop launcher. */
  _launchDetached(args: string[], ws, key, log) {
    const launcher = this.cfg.launcher;
    if (!launcher) throw new Error("apps.json has no launcher script.");
    const full = [launcher.script, ...args, ...(launcher.workspaceArg ? [launcher.workspaceArg, fwd(ws.path)] : [])];
    const pid = twoHop({ file: process.execPath, args: full, cwd: ws.path, env: null, shell: false }, log.file, key);
    log(`$ ${path.basename(launcher.script)} ${args.join(" ")}  (detached, pid ${pid})`);
  }

  /** A { cmd } app, long-running, via the two-hop launcher; its pid is kept for Stop. */
  _launchCmd(ws, app: AppDef, log) {
    const cwd = path.resolve(ws.path, app.launch.cwd ? path.join(app.dir, app.launch.cwd) : app.workDir || app.dir);
    if (!cwd.startsWith(path.resolve(ws.path) + path.sep)) throw new Error(`${app.name}: launch.cwd must stay inside the workspace.`);
    const cmd = expand(app.launch.cmd!, ws, app.key, this.portOf);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(app.launch.env || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = expand(String(v), ws, app.key, this.portOf);
    const pid = twoHop({ file: cmd, args: [], cwd, env, shell: true }, log.file, app.key);
    const pids = this._pids();
    pids[`${ws.slug}:${app.key}`] = pid;
    this._savePids(pids);
    log(`$ ${cmd}  (in ${path.relative(ws.path, cwd) || "."}, detached, pid ${pid})`);
  }

  _pids(): Record<string, number> {
    try { return JSON.parse(fs.readFileSync(this.pidFile, "utf-8")); } catch { return {}; }
  }

  _savePids(pids) {
    try { fs.writeFileSync(this.pidFile, JSON.stringify(pids, null, 2)); } catch {}
  }

  _job(ws, label, apps, body) {
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
    const logFile = path.join(this.logDir, `${id}.log`);
    const job: any = {
      id, label, apps, workspace: ws.slug, workspaceName: ws.name,
      status: "running", startedAt: new Date().toISOString(), endedAt: null,
      steps: [], notes: [], error: null, _log: logFile,
    };
    fs.writeFileSync(logFile, `# ${label} — ${ws.name} — ${job.startedAt}\n`);
    this.jobs.unshift(job);
    this._prune();
    this._save(job);

    const log: any = (text) => fs.appendFileSync(logFile, String(text).replace(/\r/g, "") + "\n");
    log.file = logFile;
    const note = (text) => { job.notes.push(text); log(`note: ${text}`); this._save(job); };
    const step = async (stepLabel, fn) => {
      const s: any = { label: stepLabel, status: "running" };
      job.steps.push(s);
      this._save(job);
      log(`\n== ${stepLabel}`);
      try {
        await fn(log);
        s.status = "done";
      } catch (e) {
        s.status = "failed";
        s.error = e.message;
        log(`!! ${e.message}`);
        throw e;
      } finally {
        this._save(job);
      }
    };

    body(step, note)
      .then(() => { job.status = "succeeded"; })
      .catch((e) => { job.status = "failed"; job.error = e.message; })
      .finally(() => { job.endedAt = new Date().toISOString(); log(`\n# ${job.status}`); this._save(job); });
    return job;
  }

  _prune() {
    while (this.jobs.length > JOB_HISTORY) {
      const old = this.jobs.pop();
      try { fs.unlinkSync(old._log); } catch {}
      try { fs.unlinkSync(path.join(this.logDir, `${old.id}.json`)); } catch {}
    }
  }
}

/**
 * Start a long-running process through a DETACHED `node -e` launcher that runs it
 * NON-detached with windowsHide (a hidden console its children inherit), logging
 * to logFile and appending "[key exited with code N]" when it ends. Returns the
 * launcher's pid (the root of the app's process tree).
 */
export function twoHop(p: { file: string; args: string[]; cwd: string; env: Record<string, string> | null; shell: boolean }, logFile: string, key: string): number {
  const launcher = `
    const { spawn } = require("child_process");
    const fs = require("fs");
    const out = fs.openSync(${JSON.stringify(logFile)}, "a");
    const c = spawn(${JSON.stringify(p.file)}, ${JSON.stringify(p.args)}, {
      cwd: ${JSON.stringify(p.cwd)},
      env: Object.assign({}, process.env, ${JSON.stringify(p.env || {})}),
      shell: ${p.shell ? "true" : "false"},
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    c.on("exit", (code) => fs.appendFileSync(${JSON.stringify(logFile)}, "\\n[${key} exited with code " + code + "]\\n"));
  `;
  const child = spawn(process.execPath, ["-e", launcher], {
    cwd: p.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid!;
}

/** Kill a process and everything under it. Best effort. */
export function killTree(pid: number) {
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
    }
  } catch {}
}

/** {{port}}, {{port:<appId>}} and {{workspace}} in a launch cmd or env value. */
function expand(s: string, ws, key: string | null, portOf): string {
  return String(s)
    .replace(/\{\{\s*workspace\s*\}\}/g, ws.path)
    .replace(/\{\{\s*port(?::\s*([\w-]+))?\s*\}\}/g, (_m, id) => String(portOf(ws, id || key) ?? ""));
}

function fwd(p) {
  // run-apps rejects mangled workspace paths; forward slashes are always safe.
  return String(p).replace(/\\/g, "/");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tail(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf-8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // strip ANSI colors
  } catch {
    return "";
  }
}

export { AppLauncher };

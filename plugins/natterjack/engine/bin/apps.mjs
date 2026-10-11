/**
 * `dashboard.mjs apps ...`: start, stop and check the workspace's apps from a terminal or
 * a headless Claude run, through the running dashboard. It sends the Apps page's own
 * request (POST /api/apps/action) and follows the job it starts (GET /api/apps/jobs), so
 * the apps run exactly as they do from the page: detached, outliving whatever started
 * them, with their pids, jobs and logs on the Apps page.
 *
 * The dashboard must be running (`dashboard.mjs start`): it's what starts the apps, and
 * it isn't started silently from here. POSTs carry the per-install token the dashboard
 * keeps in the ledger (<ledger>/dashboard-token).
 *
 * The workspace: --workspace <slug or path>, else the one holding the current folder (a
 * worktree's own, else main), matched against the dashboard's own list (GET /api/status).
 *
 * Plain JavaScript, no packages, like dashboard.mjs. Kept apart from it so its pieces can
 * be tested; dashboard.mjs loads it only for `apps`.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const APPS_USAGE = `Usage: <dashboard.mjs> apps <command> [--workspace <slug|path>]
  apps status                              the workspace's apps: port, up or down; stack ids
  apps start   (--stack <id> | --app <id>) [--no-wait] [--timeout <sec>]
  apps stop    (--stack <id> | --app <id>) [--no-wait] [--timeout <sec>]
  apps restart --app <id>                  [--no-wait] [--timeout <sec>]
  apps stop-all                            every app in the workspace
  apps setup                               the apps.json setup step
The dashboard must be running. --workspace defaults to the workspace (worktree or main)
holding the current folder. Waits for the job (default --timeout 540) and exits 0 when it
succeeds, 1 when it fails, times out or can't be sent, 2 on bad arguments.`;

const ACTIONS = ["start", "stop", "restart", "stop-all", "setup"];
const VALUE_FLAGS = new Set(["workspace", "stack", "app", "timeout", "port"]);
const BOOL_FLAGS = new Set(["no-wait", "help"]);
// Under the 10-minute cap headless runs put on one command, so the wait ends with a
// report rather than a kill. The job carries on in the dashboard either way.
export const DEFAULT_TIMEOUT_SEC = 540;

/**
 * argv after `apps` → { sub, workspace, stack, app, wait, timeoutSec } or { error }.
 * (--port is dashboard.mjs's; accepted here and ignored.)
 */
export function parseAppsArgs(argv) {
  const [sub, ...rest] = argv;
  const o = { sub: sub || "", workspace: null, stack: null, app: null, wait: true, timeoutSec: DEFAULT_TIMEOUT_SEC, help: false };
  if (!sub || sub === "help" || sub === "--help") return { ...o, sub: "help", help: true };
  if (sub !== "status" && !ACTIONS.includes(sub)) return { error: `Unknown apps command "${sub}".` };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) return { error: `Unexpected argument "${a}".` };
    const key = a.slice(2);
    if (BOOL_FLAGS.has(key)) { if (key === "no-wait") o.wait = false; else o.help = true; continue; }
    if (!VALUE_FLAGS.has(key)) return { error: `Unknown option ${a}.` };
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--") || !v.trim()) return { error: `${a} needs a value.` };
    i++;
    if (key === "timeout") {
      const n = Number(v);
      if (!(n > 0)) return { error: "--timeout is a number of seconds." };
      o.timeoutSec = n;
    } else if (key !== "port") o[key] = v.trim();
  }
  if (o.help) return o;
  const target = (o.stack ? 1 : 0) + (o.app ? 1 : 0);
  if ((sub === "start" || sub === "stop") && target !== 1) return { error: `apps ${sub} needs --stack <id> or --app <id> (one of them).` };
  if (sub === "restart" && (!o.app || o.stack)) return { error: "apps restart needs --app <id> (stacks restart as stop, then start)." };
  if ((sub === "status" || sub === "stop-all" || sub === "setup") && target) return { error: `apps ${sub} takes no --stack or --app.` };
  return o;
}

/** A path for comparing: absolute, real when it exists, forward slashes, no trailing slash, case-folded where the OS is. */
export function normPath(p, platform = process.platform) {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch {}
  r = r.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
}

const inside = (child, parent) => child === parent || child.startsWith(parent + "/");

/**
 * Which of the dashboard's workspaces ([{ slug, name, path }], main first) is meant:
 * `want` as a slug, else as a path in one; with no `want`, the one holding `cwd` (the
 * deepest: worktrees usually sit inside main's folder), else main.
 * → { ws } or { error }.
 */
export function resolveWorkspace(list, want, cwd, platform = process.platform) {
  const main = list.find((w) => w.slug === "main") || list[0] || null;
  const holding = (p) => {
    const at = normPath(p, platform);
    return list
      .map((w) => ({ w, p: normPath(w.path, platform) }))
      .filter((x) => inside(at, x.p))
      .sort((a, b) => b.p.length - a.p.length)[0]?.w || null;
  };
  if (want) {
    const bySlug = list.find((w) => w.slug === want) || list.find((w) => w.slug === want.toLowerCase());
    if (bySlug) return { ws: bySlug };
    if (/[\\/.]/.test(want) || fs.existsSync(want)) {
      const ws = holding(path.resolve(cwd, want));
      if (ws) return { ws };
    }
    return { error: `Unknown workspace "${want}". The dashboard's workspaces: ${list.map((w) => w.slug).join(", ") || "(none)"}.` };
  }
  const ws = holding(cwd) || main;
  return ws ? { ws } : { error: "The dashboard listed no workspaces." };
}

/** A job's state → { done, code }: 0 when it succeeded, 1 when it failed or was cut off. */
export function jobOutcome(job) {
  if (!job) return { done: true, code: 1 };
  if (job.status === "running") return { done: false, code: null };
  return { done: true, code: job.status === "succeeded" ? 0 : 1 };
}

/**
 * Lines to print for what changed in a job since `seen` ({ steps: [status], notes: n }),
 * which it updates: each step when it starts and when it ends, each new note.
 */
export function progressLines(job, seen) {
  const out = [];
  for (let i = seen.notes; i < (job.notes || []).length; i++) out.push(`  note: ${job.notes[i]}`);
  seen.notes = (job.notes || []).length;
  (job.steps || []).forEach((s, i) => {
    if (seen.steps[i] === s.status) return;
    if (s.status === "running") out.push(`  ... ${s.label}`);
    else if (s.status === "done") out.push(`  ok  ${s.label}`);
    else out.push(`  FAILED ${s.label}${s.error ? `: ${s.error}` : ""}`);
    seen.steps[i] = s.status;
  });
  return out;
}

/** One app's line for `apps status`. */
export function appLine(a, width = 0) {
  const name = String(a.name || a.key).padEnd(width);
  if (!a.available) return `  ${name}  not cloned here`;
  const port = a.port ? `:${a.port}` : "-"; // a worker, or a worktree not given ports yet
  let state = a.running ? "up" : "down";
  if (!a.running && a.fallback) state = `down here; uses main's on :${a.fallback.port} (${a.fallback.running ? "up" : "down"})`;
  const extra = [a.running && a.url ? a.url : null, a.busy ? `busy: ${a.busy}` : null, a.blockedBy && a.blockedBy.length ? `needs: ${a.blockedBy.join(", ")}` : null].filter(Boolean);
  return `  ${name}  ${port.padEnd(7)}  ${state}${extra.length ? `   ${extra.join("   ")}` : ""}   [--app ${a.key}]`;
}

// ------------------------------------------------------------------ http

/** A request to the dashboard as its own page makes it (loopback, Host localhost:<port>). → { status, json, text } */
export function request(port, method, p, { token = null, body = undefined, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { host: `localhost:${port}`, accept: "application/json" };
    if (data !== null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
    if (token) headers["x-dash-token"] = token;
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let text = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("The dashboard didn't answer in time."), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(data === null ? undefined : data);
  });
}

const errorOf = (r) => (r.json && r.json.error) || r.text.trim() || `HTTP ${r.status}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ command

/**
 * Run `apps ...`. ctx: { argv, ports (candidates, first = configured), ledger, root, cwd,
 * env, self (how to name dashboard.mjs in messages), out, err, pollMs }. → exit code.
 */
export async function appsMain(ctx) {
  const out = ctx.out || ((s) => console.log(s));
  const err = ctx.err || ((s) => console.error(s));
  const env = ctx.env || process.env;
  const self = ctx.self || "node <engine>/bin/dashboard.mjs";
  const usage = () => APPS_USAGE.replace("<dashboard.mjs>", self);

  const args = parseAppsArgs(ctx.argv);
  if (args.error) { err(`${args.error}\n\n${usage()}`); return 2; }
  if (args.help) { out(usage()); return 0; }
  if (/^(1|true|yes)$/i.test(String(env.DASHBOARD_HOSTED || "").trim())) {
    err("Apps aren't available in the hosted dashboard: it needs the dashboard running on your own computer.");
    return 1;
  }

  // The running dashboard: the configured port, else the one it recorded at start (a --port start).
  const ports = [...new Set((ctx.ports || []).filter((p) => p > 0))];
  let port = null, status = null;
  for (const p of ports) {
    try { status = await request(p, "GET", "/api/status"); port = p; break; } catch (e) {
      if (e.code !== "ECONNREFUSED") { err(`Couldn't reach the dashboard on :${p}: ${e.message}`); return 1; }
    }
  }
  if (!port) {
    err(`The dashboard isn't running (nothing on http://localhost:${ports[0] || 3333}). Start it first, then try again:\n  ${self} start`);
    return 1;
  }
  if (status.status !== 200 || !status.json || !Array.isArray(status.json.workspaces)) {
    err(`The dashboard on :${port} refused the request: ${errorOf(status)}`);
    return 1;
  }
  const list = status.json.workspaces;
  const mainWs = list.find((w) => w.slug === "main");
  if (ctx.root && mainWs && normPath(mainWs.path) !== normPath(ctx.root)) {
    err(`The dashboard on :${port} is another workspace's (${mainWs.path}), not ${ctx.root}'s. Set its port (DASHBOARD_PORT or workspace.json dashboard.port) or start this one.`);
    return 1;
  }
  const picked = resolveWorkspace(list, args.workspace, ctx.cwd || process.cwd());
  if (picked.error) { err(picked.error); return 1; }
  const ws = picked.ws;

  const jobsView = async () => {
    const r = await request(port, "GET", "/api/apps/jobs");
    if (r.status !== 200 || !r.json) throw new Error(errorOf(r));
    return r.json;
  };

  if (args.sub === "status") return printStatus(ws, await jobsView().catch(() => null), out);

  // ---- an action
  const tokenFile = path.join(ctx.ledger, "dashboard-token");
  let token = "";
  try { token = fs.readFileSync(tokenFile, "utf-8").trim(); } catch {}
  if (!token) { err(`No dashboard token at ${tokenFile}. Is the dashboard running from this workspace (DASHBOARD_LEDGER_DIR)?`); return 1; }

  const body = { action: args.sub, workspace: ws.slug };
  if (args.stack) body.stack = args.stack;
  if (args.app) body.app = args.app;
  let r;
  try { r = await request(port, "POST", "/api/apps/action", { token, body }); } catch (e) { err(`Couldn't reach the dashboard on :${port}: ${e.message}`); return 1; }
  if (r.status === 403 && /token/i.test(errorOf(r))) {
    err(`The dashboard on :${port} didn't accept the token in ${tokenFile} (it was started with another ledger folder, DASHBOARD_LEDGER_DIR?).`);
    return 1;
  }
  if (r.status !== 202 || !r.json || !r.json.job) {
    let msg = errorOf(r);
    if (/^Unknown (stack|app) /.test(msg)) {
      const view = await jobsView().catch(() => null);
      const stacks = view ? Object.keys(view.stacks || {}) : [];
      msg += `\n  stacks: ${stacks.join(", ") || "(none)"}\n  apps in ${ws.slug}: ${(ws.apps || []).map((a) => a.key).join(", ") || "(none)"}`;
    }
    err(`The dashboard refused it: ${msg}`);
    return 1;
  }
  const job = r.json.job;
  const where = ` --workspace ${ws.slug}`;
  out(`${job.label} in ${ws.name} (job ${job.id})`);
  if (!args.wait) {
    out(`Not waiting. It carries on in the dashboard (its Apps page); check with: ${self} apps status${where}`);
    return 0;
  }

  // ---- follow the job
  const seen = { steps: [], notes: 0 };
  const deadline = Date.now() + args.timeoutSec * 1000;
  let current = job, misses = 0;
  for (const line of progressLines(current, seen)) out(line);
  while (jobOutcome(current).done === false) {
    if (Date.now() > deadline) {
      err(`Still running after ${args.timeoutSec}s. It carries on in the dashboard (job ${job.id}): check with ${self} apps status${where}, or the Apps page.`);
      return 1;
    }
    await sleep(ctx.pollMs || 1000);
    let view;
    try { view = await jobsView(); misses = 0; } catch (e) {
      if (++misses >= 5) { err(`Lost the dashboard while waiting: ${e.message}`); return 1; }
      continue;
    }
    current = (view.jobs || []).find((j) => j.id === job.id) || null;
    if (!current) { err(`The job is gone from the dashboard (was it restarted?). Check with: ${self} apps status${where}`); return 1; }
    for (const line of progressLines(current, seen)) out(line);
  }

  const { code } = jobOutcome(current);
  if (code === 0) {
    out(`Done: ${current.label}.`);
    if (args.sub === "start" || args.sub === "restart") {
      try {
        const now = await request(port, "GET", "/api/status");
        const here = (now.json.workspaces || []).find((w) => w.slug === ws.slug);
        const apps = here ? here.apps.filter((a) => (current.apps || []).includes(a.key)) : [];
        const width = Math.max(0, ...apps.map((a) => String(a.name).length));
        for (const a of apps) out(appLine(a, width));
      } catch {}
      out(`They keep running after this command (and this session) ends. Stop with: ${self} apps stop ${args.stack ? `--stack ${args.stack}` : `--app ${args.app}`}${where}`);
    }
    return 0;
  }
  err(`${current.status === "interrupted" ? "Interrupted" : "Failed"}: ${current.label}${current.error ? `: ${current.error}` : ""}`);
  try {
    const log = await request(port, "GET", `/api/apps/log?job=${encodeURIComponent(job.id)}`);
    const files = (log.json && log.json.files) || [];
    for (const f of files) err(`Log: ${f.file}`);
    if (files[0]) err(files[0].text.trimEnd().split("\n").slice(-20).map((l) => `  | ${l}`).join("\n"));
  } catch {}
  return 1;
}

function printStatus(ws, view, out) {
  out(`${ws.name} (--workspace ${ws.slug})  ${ws.path}`);
  const apps = ws.apps || [];
  if (!apps.length) out(view && view.configured === false ? "  No apps configured (.claude/dashboard/apps.json)." : "  No apps in this workspace.");
  const width = Math.max(0, ...apps.map((a) => String(a.name || a.key).length));
  for (const a of apps) out(appLine(a, width));
  if (view) {
    const stacks = Object.entries(view.stacks || {});
    if (stacks.length) {
      out("Stacks:");
      for (const [id, s] of stacks) out(`  --stack ${id}${id === view.defaultStack ? " (default)" : ""}: ${s.label}${s.apps && s.apps.length ? ` (${s.apps.join(", ")})` : ""}${s.mainOnly ? ", main workspace only" : ""}`);
    }
    for (const j of (view.jobs || []).filter((x) => x.status === "running" && x.workspace === ws.slug)) out(`In progress: ${j.label} (job ${j.id})`);
    if (view.error) out(`apps.json: ${view.error}`);
  }
  return 0;
}

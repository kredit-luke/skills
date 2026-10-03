#!/usr/bin/env node
/**
 * Is this workspace's Natterjack healthy? validate.mjs (config) plus how things
 * actually stand on this machine: Node version, dashboard installed / built /
 * running on its port, engine version vs the plugin's, repos cloned, the code
 * host CLI signed in, and what the running dashboard itself reports (Machine
 * problems, issue tracker connection).
 *
 *   node doctor.mjs <workspace> [--json]
 *
 * Read-only. Exit code 1 when something needs fixing.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { TAG_PREFIX, args, compareVersions as cmp, engineDirOf, engineVersion, isMain, latestRelease, readJson, readRepos, releaseCheck } from "./lib.mjs";
import { validate } from "./validate.mjs";

const listening = (port) => new Promise((res) => { const s = new net.Socket(); s.setTimeout(800); s.once("connect", () => { s.destroy(); res(true); }); s.once("timeout", () => { s.destroy(); res(false); }); s.once("error", () => res(false)); s.connect(port, "127.0.0.1"); });
const getJson = (port, p, timeout = 20000) => new Promise((res) => {
  const req = http.get({ host: "127.0.0.1", port, path: p, headers: { Host: `localhost:${port}` }, timeout }, (r) => {
    let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch { res(null); } });
  });
  req.on("error", () => res(null)); req.on("timeout", () => { req.destroy(); res(null); });
});
const run = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim(); } catch { return null; } };

export async function doctor(root) {
  root = path.resolve(root);
  const v = validate(root);
  const checks = [];
  const add = (status, what, detail = "", fix = "") => checks.push({ status, what, detail, fix });
  for (const e of v.errors) add("fail", "config", e);
  for (const w of v.warnings) add("warn", "config", w);
  if (!v.errors.length) add("ok", "config", `valid (${v.ok.join(", ") || "no files yet"})`);

  const dir = engineDirOf(root);
  const dash = path.join(root, dir);
  const pkg = readJson(path.join(dash, "package.json")) || {};
  const floor = (/(\d+\.\d+\.\d+)/.exec((pkg.engines && pkg.engines.node) || "") || [])[1] || "24.15.0";
  const node = run("node", ["-v"]);
  add(node && cmp(node, floor) >= 0 ? "ok" : "warn", "node", `${node || "not on PATH"} (dashboard needs ≥ ${floor})`,
    node && cmp(node, floor) >= 0 ? "" : "Install a newer Node (winget install OpenJS.NodeJS.LTS / brew install node), or nvm install; the start script also picks up a newer nvm version by itself.");

  const lock = readJson(path.join(root, ".claude", "dashboard", "engine.json"));
  const release = releaseCheck(latestRelease((lock && lock.sourceRepo) || undefined));
  if (release.stale) add("warn", "plugin", `this plugin is ${release.current}, ${TAG_PREFIX}${release.latest} is out`, `${release.update.join(" && ")}, then restart Claude Code (upgrade and doctor otherwise compare against the old copy).`);
  else if (release.latest) add("ok", "plugin", `${release.current} (latest release)`);
  else add("warn", "plugin", `${release.current}; couldn't reach the source repo to check for a newer release`);

  const shipped = engineVersion();
  if (lock && lock.version && shipped && cmp(shipped, lock.version) > 0) add("warn", "engine", `installed ${lock.version}, plugin has ${shipped}`, "Run the natterjack upgrade skill to merge it in.");
  else if (lock && lock.version && shipped && cmp(shipped, lock.version) < 0) add("warn", "engine", `installed ${lock.version}, newer than this plugin's ${shipped}`, "Update the plugin before upgrading; upgrading from this copy would downgrade.");
  else if (lock) add("ok", "engine", `version ${lock.version}`);

  const installed = fs.existsSync(path.join(dash, "node_modules", ".package-lock.json"));
  const built = fs.existsSync(path.join(dash, "dist", "browser", "index.html"));
  add(installed && built ? "ok" : "warn", "dashboard build", `${installed ? "packages installed" : "packages not installed"}, ${built ? "UI built" : "UI not built"}`, installed && built ? "" : `node ${dir}/bin/dashboard.mjs start (installs and builds on first start)`);

  const ws = readJson(path.join(root, ".claude", "dashboard", "workspace.json")) || {};
  const port = Number(process.env.DASHBOARD_PORT || (ws.dashboard && ws.dashboard.port) || 3333);
  const up = await listening(port);
  if (!up) add("warn", "dashboard", `not running on :${port}`, `node ${dir}/bin/dashboard.mjs start --open`);
  else {
    const boot = await getJson(port, "/api/boot");
    if (!boot || !boot.workspace) add("fail", "dashboard", `something else is answering on :${port} (or an old dashboard)`, "Stop it, or set dashboard.port in workspace.json to a free port.");
    else if (path.resolve(boot.workspaceRoot) !== root) add("fail", "dashboard", `:${port} is another workspace's dashboard (${boot.workspaceRoot})`, "Give this workspace its own dashboard.port in workspace.json.");
    else {
      add("ok", "dashboard", `running at http://localhost:${port} as "${boot.workspace.name}"`);
      const m = await getJson(port, "/api/machine");
      if (m && m.checks) {
        const missing = m.checks.filter((c) => c.status === "missing");
        add(missing.length ? "warn" : "ok", "machine", missing.length ? `missing: ${missing.map((c) => c.label).join(", ")}` : `${m.checks.length} checks pass`, missing.length ? "Open the Machine page: each one has an Install button or the command to run." : "");
      }
      if (fs.existsSync(path.join(root, ".claude", "dashboard", "connections.json"))) {
        // Waits for `claude mcp list`, which connects to every server.
        const cn = await getJson(port, "/api/connections?wait=1", 150000);
        if (cn && cn.connections) {
          const bad = cn.connections.filter((c) => c.required && (c.missing || c.approval === "pending" || c.approval === "rejected" || (c.state && c.state !== "connected")));
          add(bad.length ? "warn" : "ok", "connections", bad.length ? `not working for you: ${bad.map((c) => c.name).join(", ")}` : `${cn.connections.filter((c) => c.required).length} required MCP servers connected`,
            bad.length ? "Open the Connections page: each one has a Sign in, Approve or Add button, or says what to do." : "");
        }
      }
      if (boot.issues && boot.issues.configured) {
        const iss = await getJson(port, "/api/issues");
        if (iss) add(iss.connected && !iss.error ? "ok" : "warn", "issues", iss.connected ? `${boot.issues.label}: ${iss.issues.length} issues${iss.error ? ` (error: ${iss.error})` : ""}` : `${boot.issues.label} isn't connected`, iss.connected ? "" : "Open the Issues page and follow its connect steps.");
      }
    }
  }

  const repos = readRepos(root);
  // Here = a clone, or a read-only copy downloaded from the snapshot source (.snapshot.json).
  const here = (r) => fs.existsSync(path.join(root, r.relativePath, ".git")) || fs.existsSync(path.join(root, r.relativePath, ".snapshot.json"));
  const missingRepos = repos.filter((r) => !here(r));
  if (repos.length) add(missingRepos.length ? "warn" : "ok", "repos", missingRepos.length ? `not here: ${missingRepos.map((r) => r.relativePath).join(", ")}` : `${repos.length} here`, missingRepos.length ? "Open the dashboard's Repos page and click Clone missing (or remove them from repos.json)." : "");

  const host = (ws.codeHost && ws.codeHost.kind) || "github";
  if (host === "github") {
    const gh = run("gh", ["auth", "status"]);
    add(gh !== null ? "ok" : "warn", "github", gh !== null ? "gh signed in" : "gh missing or not signed in", gh !== null ? "" : "Install the GitHub CLI and run gh auth login (the Needs-you inbox uses it).");
  }
  return { root, checks, ok: !checks.some((c) => c.status === "fail") };
}

if (isMain(import.meta)) {
  const a = args();
  const r = await doctor(a._[0] || process.cwd());
  if (a.json) console.log(JSON.stringify(r, null, 2));
  else for (const c of r.checks) console.log(`${c.status === "ok" ? "  ok  " : c.status === "warn" ? " warn " : " FAIL "} ${c.what}: ${c.detail}${c.fix ? `\n        → ${c.fix}` : ""}`);
  process.exitCode = r.ok ? 0 : 1;
}

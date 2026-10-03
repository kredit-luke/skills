/**
 * Restart the dashboard from its own page: hand `bin/dashboard.mjs restart` to a
 * process that outlives this server, since that command stops this server first.
 *
 * Three hops, each for a Windows reason (macOS and Linux don't mind):
 *  1. A detached `node -e` that starts hop 2 and exits at once. Hop 2's parent is
 *     then gone, so `stop`'s kill of this server's process tree (taskkill /T) can't
 *     reach it.
 *  2. Hop 1 again, detached, so it has no console (no window). It waits a moment (so
 *     the HTTP response gets out), runs the restart and stays until it ends: Node
 *     kills a non-detached child when its parent exits.
 *  3. The restart itself, NOT detached and with windowsHide: a hidden console that
 *     every command it runs (powershell, taskkill, npm) shares. Without a console of
 *     its own, each of those would open a visible terminal window.
 * Output goes to <ledger>/dashboard-restart.log. The new server rebuilds the UI first
 * if the engine changed, like any start.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const HOP = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [stage, script, log, delay] = process.argv.slice(1);
if (stage === "launch") {
  spawn(process.execPath, ["-e", HOP_SRC, "run", script, log, delay], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  process.exit(0);
}
setTimeout(() => {
  const out = fs.openSync(log, "a");
  fs.writeSync(out, "\\n--- restart requested from the dashboard " + new Date().toISOString() + "\\n");
  const c = spawn(process.execPath, [script, "restart"], { stdio: ["ignore", out, out], windowsHide: true });
  c.on("exit", (code) => process.exit(code || 0));
  c.on("error", (e) => { fs.writeSync(out, String(e) + "\\n"); process.exit(1); });
}, Number(delay) || 0);
`;

export interface RestartOptions {
  /** The engine's bin/dashboard.mjs (tests pass a stand-in). */
  script: string;
  ledgerDir: string;
  /** The restart's environment: WORKSPACE_ROOT should be in it, so the restart finds this workspace. */
  env: NodeJS.ProcessEnv;
  delayMs?: number;
}

export function restartSelf({ script, ledgerDir, env, delayMs = 400 }: RestartOptions): void {
  fs.mkdirSync(ledgerDir, { recursive: true });
  const log = path.join(ledgerDir, "dashboard-restart.log");
  const src = `const HOP_SRC = ${JSON.stringify(HOP)};\n${HOP}`;
  spawn(process.execPath, ["-e", src, "launch", script, log, String(delayMs)], {
    cwd: path.dirname(script),
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

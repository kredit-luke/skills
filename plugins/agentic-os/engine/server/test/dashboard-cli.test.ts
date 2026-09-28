// bin/dashboard.mjs against a throwaway workspace: after the port changes, restart moves
// the running dashboard instead of leaving the old one up (and orphaned), and plain start
// says where it is instead of starting a second.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "dashboard.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-cli-")));
const LEDGER = path.join(TMP, "ledger");
fs.mkdirSync(path.join(TMP, ".claude", "dashboard"), { recursive: true });

const setPort = (port: number) =>
  fs.writeFileSync(path.join(TMP, ".claude", "dashboard", "workspace.json"), JSON.stringify({ name: "CLI test", dashboard: { port } }));
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args, "--skip-build"], {
    encoding: "utf-8",
    timeout: 90_000,
    env: { ...process.env, WORKSPACE_ROOT: TMP, DASHBOARD_LEDGER_DIR: LEDGER, DASHBOARD_PORT: "" },
  });

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}
async function until(check: () => Promise<boolean>, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await check()) return true;
  return check();
}

after(() => {
  try { cli("stop"); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("after a port change, restart moves the dashboard and start doesn't run a second", { timeout: 180_000 }, async () => {
  const a = await freePort();
  const b = await freePort();
  setPort(a);
  cli("start");
  assert.ok(await listening(a), "started on the first port");
  assert.equal(fs.readFileSync(path.join(LEDGER, "dashboard.pid"), "utf-8").split(/\s+/)[1], String(a), "the pid file records the port");

  setPort(b);
  assert.match(cli("start"), new RegExp(`previous port, http://localhost:${a}`));
  assert.equal(await listening(b), false, "plain start leaves it where it is");

  cli("restart");
  assert.ok(await listening(b), "restart starts it on the new port");
  assert.ok(await until(async () => !(await listening(a))), "and stops the one on the old port");

  cli("stop");
  assert.ok(await until(async () => !(await listening(b))), "stop stops it");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restartSelf } from "../src/self-restart.ts";

test("restartSelf runs `<script> restart` in a detached process, with the workspace in its environment and output in the ledger", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-restart-"));
  try {
    const marker = path.join(dir, "ran.json");
    const script = path.join(dir, "dashboard.mjs");
    fs.writeFileSync(script, `import fs from "node:fs";\nconsole.log("restarting");\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), root: process.env.WORKSPACE_ROOT }));\n`);
    const ledger = path.join(dir, "ledger");
    restartSelf({ script, ledgerDir: ledger, env: { ...process.env, WORKSPACE_ROOT: "/the/workspace" }, delayMs: 50 });

    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf-8")), { args: ["restart"], root: "/the/workspace" });
    let log = "";
    for (let i = 0; i < 50 && !log.includes("restarting"); i++) { await new Promise((r) => setTimeout(r, 100)); log = fs.readFileSync(path.join(ledger, "dashboard-restart.log"), "utf-8"); }
    assert.match(log, /restart requested from the dashboard/);
    assert.match(log, /restarting/);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

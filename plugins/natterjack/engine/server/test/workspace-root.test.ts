// The engine folder is the team's choice (natterjack/, tools/ops, or dashboard/ in older
// workspaces): the workspace is found from .claude/dashboard/, which never moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engineDirOf, findWorkspaceRoot, safeEngineDir } from "../src/workspace-root.ts";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-root-")));

test("findWorkspaceRoot: the nearest folder above the engine with .claude/dashboard/, else its parent", () => {
  const ws = scratch();
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  for (const dir of ["dashboard", "natterjack", path.join("tools", "ops"), path.join("a", "b", "c")]) {
    fs.mkdirSync(path.join(ws, dir), { recursive: true });
    assert.equal(findWorkspaceRoot(path.join(ws, dir)), ws, dir);
  }
  // A workspace inside another: the nearest wins.
  const inner = path.join(ws, "inner");
  fs.mkdirSync(path.join(inner, ".claude", "dashboard"), { recursive: true });
  assert.equal(findWorkspaceRoot(path.join(inner, "tools", "ops")), inner);
  // No config anywhere above (a fresh copy): the parent, as before the folder was configurable.
  const bare = scratch();
  assert.equal(findWorkspaceRoot(path.join(bare, "x", "natterjack")), path.join(bare, "x"));
});

test("engineDirOf: engine.json dir when it's a safe relative folder, else dashboard", () => {
  const ws = scratch();
  assert.equal(engineDirOf(ws), "dashboard");
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  const lock = (data: unknown) => fs.writeFileSync(path.join(ws, ".claude", "dashboard", "engine.json"), JSON.stringify(data));
  lock({ version: "0.7.1" });
  assert.equal(engineDirOf(ws), "dashboard");
  lock({ dir: "tools\\ops/" });
  assert.equal(engineDirOf(ws), "tools/ops");
  lock({ dir: "natterjack" });
  assert.equal(engineDirOf(ws), "natterjack");
  for (const bad of ["../x", "/x", "C:/x", ".claude/x", "a/./b", "", 3]) assert.equal(safeEngineDir(bad), null, String(bad));
});

test("bin/dashboard.mjs finds the workspace above a nested engine folder without WORKSPACE_ROOT", () => {
  const ws = scratch();
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "workspace.json"), JSON.stringify({ dashboard: { port: 3907 } }));
  const bin = path.join(ws, "tools", "ops", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(BIN, "dashboard.mjs"), path.join(bin, "dashboard.mjs"));
  const env: NodeJS.ProcessEnv = { ...process.env, DASHBOARD_PORT: "" };
  delete env.WORKSPACE_ROOT;
  let out = "";
  try { out = execFileSync(process.execPath, [path.join(bin, "dashboard.mjs"), "status"], { encoding: "utf-8", env, timeout: 30_000 }); }
  catch (e: any) { out = String(e.stdout || ""); } // exit 1: not running
  assert.match(out, /port 3907|:3907/, "the port came from the workspace's workspace.json, two levels up");
});

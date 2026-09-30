// The reader profile: skillOverrides in settings.local.json (only ours are ever removed),
// and workspace.json profiles.reader defaults. config.ts reads WORKSPACE_ROOT at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-profile-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
const LEDGER = path.join(ROOT, ".claude", "ledger");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = LEDGER;

const { workspaceConfig } = await import("../src/config.ts");
const { readProfile, setProfile, syncSkillOverrides } = await import("../src/profile.ts");

const settingsFile = path.join(ROOT, ".claude", "settings.local.json");
const settings = () => JSON.parse(fs.readFileSync(settingsFile, "utf-8"));

test("profiles.reader: Apps and Workspaces hidden by default, both lists configurable", () => {
  assert.deepEqual(workspaceConfig().profiles.reader, { hiddenPages: ["apps", "workspaces"], hiddenSkills: [] });
  fs.writeFileSync(path.join(CFG, "workspace.json"), JSON.stringify({ profiles: { reader: { hiddenPages: ["/apps", "machine"], hiddenSkills: ["run", 3, "pr"] } } }));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(CFG, "workspace.json"), t, t);
  assert.deepEqual(workspaceConfig().profiles.reader, { hiddenPages: ["apps", "machine"], hiddenSkills: ["run", "pr"] });
});

test("reader turns skills off in settings.local.json and developer takes back only ours", () => {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  // Someone's own settings: an env block, their own "pr" override, and another skill they hid.
  fs.writeFileSync(settingsFile, "﻿" + JSON.stringify({ env: { A: "1" }, skillOverrides: { pr: "name-only", legacy: "off" } }));
  assert.equal(readProfile(LEDGER).chosen, false);
  assert.equal(readProfile(LEDGER).profile, "developer");

  setProfile(LEDGER, ROOT, "reader", ["run", "pr", "worktree"]);
  let s = settings();
  assert.deepEqual(s.env, { A: "1" }, "the rest of the file is kept");
  assert.deepEqual(s.skillOverrides, { pr: "name-only", legacy: "off", run: "off", worktree: "off" }, "their own pr setting wins");
  const p = readProfile(LEDGER);
  assert.equal(p.profile, "reader");
  assert.deepEqual(p.skillsOff.sort(), ["run", "worktree"]);

  // The team drops worktree from the list: it comes back on; run stays off.
  setProfile(LEDGER, ROOT, "reader", ["run", "pr"]);
  assert.deepEqual(settings().skillOverrides, { pr: "name-only", legacy: "off", run: "off" });

  setProfile(LEDGER, ROOT, "developer", ["run", "pr"]);
  s = settings();
  assert.deepEqual(s.skillOverrides, { pr: "name-only", legacy: "off" }, "only what the reader profile added is removed");
  assert.deepEqual(readProfile(LEDGER).skillsOff, []);
});

test("an override someone changed after we set it is theirs; a broken settings file is never overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-profile-b-"));
  const file = path.join(root, ".claude", "settings.local.json");
  const ours = syncSkillOverrides(root, ["run"], []);
  assert.deepEqual(ours, ["run"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { skillOverrides: { run: "off" } });
  // They switched it to name-only themselves: switching back to developer leaves it.
  fs.writeFileSync(file, JSON.stringify({ skillOverrides: { run: "name-only" } }));
  assert.deepEqual(syncSkillOverrides(root, [], ours), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { skillOverrides: { run: "name-only" } });
  // With nothing left, the key goes; unrelated keys stay.
  fs.writeFileSync(file, JSON.stringify({ model: "x", skillOverrides: { run: "off" } }));
  syncSkillOverrides(root, [], ["run"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { model: "x" });

  fs.writeFileSync(file, "{ broken");
  assert.throws(() => syncSkillOverrides(root, ["run"], []), /isn't valid JSON/);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ broken");
  assert.throws(() => syncSkillOverrides(root, ["bad name!"], []), /isn't valid JSON/, "still refuses before anything else");
});

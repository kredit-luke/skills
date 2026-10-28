// factory.mjs: one manifest per ticket in the source workspace's ledger, updated a step at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { intakeCheck, manifestPath, sourceWorkspace, ticketFile, update } from "../factory.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "factory.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "factory-mjs-"));

/** A workspace with a dashboard, and a worktree folder that points back at it. */
function workspace({ dashboard = true, policy = null } = {}) {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "repos.json"), "[]");
  if (dashboard) fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  if (policy) fs.writeFileSync(path.join(ws, ".claude", "dashboard", "factory.json"), JSON.stringify(policy));
  const wt = path.join(ws, "worktrees", "eng-1");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".worktree.json"), JSON.stringify({ name: "eng-1", ticketId: "ENG-1", sourceWorkspace: ws }));
  return { ws, wt };
}

test("ticket ids become safe file names", () => {
  assert.equal(ticketFile("ENG-12"), "ENG-12.json");
  assert.equal(ticketFile("acme/api#7"), "acme_api_7.json");
  assert.equal(ticketFile("../x"), "__x.json");
  assert.ok(!ticketFile("../../etc").includes("/"));
});

test("from a worktree, the manifest goes to the source workspace's ledger", () => {
  const { ws, wt } = workspace();
  assert.equal(sourceWorkspace(wt), ws);
  assert.equal(manifestPath(ws, "ENG-1"), path.join(ws, ".claude", "ledger", "factory", "ENG-1.json"));
});

test("a workspace without a dashboard is skipped, nothing written", () => {
  const { ws, wt } = workspace({ dashboard: false });
  const r = update("start", { ticket: "ENG-1" }, { start: wt });
  assert.match(r.skipped, /no Natterjack dashboard/);
  assert.equal(fs.existsSync(path.join(ws, ".claude", "ledger")), false);
});

test("start, stages, gates, PRs and done build up one manifest", () => {
  const { ws, wt } = workspace({ policy: { preset: "risk-tiered", gates: { merge: "approver" } } });
  const t = (n) => `2026-10-27T10:0${n}:00.000Z`;
  update("start", { ticket: "ENG-1", title: "Retries", mode: "autonomous", branch: "feature/ENG-1", repos: "api,web", workroot: wt }, { start: wt, now: t(0) });
  update("stage", { ticket: "ENG-1", stage: "build", status: "running", repo: "api", agent: "claude" }, { start: wt, now: t(1) });
  update("stage", { ticket: "ENG-1", stage: "build", status: "failed", repo: "api", note: "tests red" }, { start: wt, now: t(2) });
  update("stage", { ticket: "ENG-1", stage: "build", status: "running", repo: "api" }, { start: wt, now: t(3) });
  update("stage", { ticket: "ENG-1", stage: "build", status: "done", repo: "api" }, { start: wt, now: t(4) });
  update("stage", { ticket: "ENG-1", stage: "review", status: "running", repo: "worker" }, { start: wt, now: t(4) });
  update("gate", { ticket: "ENG-1", gate: "merge", decision: "pending" }, { start: wt, now: t(5) });
  update("gate", { ticket: "ENG-1", gate: "merge", decision: "approved", by: "kim", risk: "low", rationale: "Small" }, { start: wt, now: t(6) });
  update("pr", { ticket: "ENG-1", url: "https://github.com/acme/api/pull/42", repo: "api" }, { start: wt, now: t(7) });
  update("pr", { ticket: "ENG-1", url: "https://github.com/acme/api/pull/42", state: "merged" }, { start: wt, now: t(8) });
  const { manifest: m } = update("done", { ticket: "ENG-1" }, { start: wt, now: t(9) });

  const file = path.join(ws, ".claude", "ledger", "factory", "ENG-1.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), m);
  assert.deepEqual([m.title, m.mode, m.branch, m.workroot, m.startedAt, m.updatedAt], ["Retries", "autonomous", "feature/ENG-1", wt, t(0), t(9)]);
  assert.equal(m.policy.preset, "risk-tiered");
  assert.deepEqual(m.repos, ["api", "web", "worker"]);
  const build = m.stages.find((s) => s.id === "build");
  assert.deepEqual([build.status, build.agent, build.note, build.startedAt, build.endedAt], ["done", "claude", "tests red", t(3), t(4)]);
  assert.equal(m.stages.length, 2, "one row per stage and repo");
  assert.deepEqual(m.gates.map((g) => [g.decision, g.mode, g.by, g.risk]), [["pending", "approver", null, null], ["approved", "approver", "kim", "low"]]);
  assert.deepEqual(m.prs, [{ repo: "api", url: "https://github.com/acme/api/pull/42", number: 42, state: "merged" }]);
  assert.equal(m.done, true);
});

test("bad arguments are usage errors (exit 2) and change nothing", () => {
  const { wt } = workspace();
  assert.throws(() => update("stage", { ticket: "ENG-1", stage: "deploy", status: "done" }, { start: wt }), /--stage must be/);
  assert.throws(() => update("gate", { ticket: "ENG-1", gate: "plan", decision: "maybe" }, { start: wt }), /--decision must be/);
  assert.throws(() => update("pr", { ticket: "ENG-1", url: "javascript:x" }, { start: wt }), /--url/);
  assert.throws(() => update("stage", { stage: "build", status: "done" }, { start: wt }), /--ticket is required/);
  const r = (() => { try { execFileSync(process.execPath, [SCRIPT, "launch", "--ticket", "ENG-1", "--root", wt], { stdio: "pipe" }); return 0; } catch (e) { return e.status; } })();
  assert.equal(r, 2);
  assert.equal(update("show", { ticket: "ENG-1" }, { start: wt }).manifest.stages.length, 0);
});

test("policy prints factory.json, or exists: false", () => {
  const { wt } = workspace({ policy: { enabled: true, preset: "supervised" } });
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, "policy", "--root", wt], { encoding: "utf-8" }));
  assert.deepEqual([out.exists, out.enabled, out.preset], [true, true, "supervised"]);
  const none = workspace();
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [SCRIPT, "policy", "--root", none.wt], { encoding: "utf-8" })), { exists: false });
});

test("reports made at the same moment (one subagent per repo) are all kept", async () => {
  const { ws, wt } = workspace();
  const { spawn } = await import("node:child_process");
  const repos = ["a", "b", "c", "d", "e", "f"];
  await Promise.all(repos.map((r) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCRIPT, "stage", "--ticket", "ENG-1", "--stage", "build", "--status", "running", "--repo", r, "--root", wt], { stdio: "ignore" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  })));
  const m = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "ledger", "factory", "ENG-1.json"), "utf-8"));
  assert.deepEqual(m.stages.map((s) => s.repo).sort(), repos);
  assert.equal(fs.existsSync(path.join(ws, ".claude", "ledger", "factory", "ENG-1.json.lock")), false);
});

test("a stage's failures are counted, and a retro is recorded", () => {
  const { ws } = workspace();
  const run = (cmd, args) => update(cmd, { ticket: "ENG-9", ...args }, { start: ws });
  run("stage", { stage: "review", repo: "api", status: "running" });
  run("stage", { stage: "review", repo: "api", status: "failed" });
  run("stage", { stage: "review", repo: "api", status: "failed" });
  run("stage", { stage: "review", repo: "api", status: "running" });
  const m = run("stage", { stage: "review", repo: "api", status: "done" }).manifest;
  assert.equal(m.stages[0].failures, 1, "failing twice in a row is one failure");
  const r = run("retro", { caught: "a race; missing index ", wrong: "the API was paged", approver: "held up", proposals: "" }).manifest.retro;
  assert.deepEqual({ ...r, at: undefined }, { caught: ["a race", "missing index"], wrong: ["the API was paged"], approver: "held up", proposals: [], at: undefined });
  assert.ok(run("done", {}).manifest.finishedAt, "done records when it finished");
  assert.equal(run("start", {}).manifest.finishedAt, null, "picked up again: not finished");
});

test("intake: a ticket in the factory, or pulled in before (by the dashboard too), isn't taken again", () => {
  const { ws } = workspace();
  assert.deepEqual(intakeCheck(ws, "ENG-20"), { ok: true, why: null });
  assert.deepEqual(intakeCheck(ws, "ENG-20", { record: true, now: "2026-10-27T10:00:00.000Z" }), { ok: true, why: null });
  assert.match(intakeCheck(ws, "eng-20").why, /pulled in before \(2026-10-27T10:00:00\.000Z\)/);
  // The dashboard's history is the same file.
  fs.writeFileSync(path.join(ws, ".claude", "ledger", "factory-intake.json"), JSON.stringify({ "eng-21": "2026-10-27T11:00:00.000Z", "eng-20": "x" }));
  assert.equal(intakeCheck(ws, "ENG-21").ok, false);
  update("stage", { ticket: "ENG-22", stage: "plan", status: "done" }, { start: ws });
  assert.match(intakeCheck(ws, "ENG-22").why, /already in the factory/);
});

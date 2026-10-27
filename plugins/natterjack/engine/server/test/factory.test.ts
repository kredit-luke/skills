// factory.ts: factory.json defaults, presets and saving; manifests; the pipeline's order; placing items on the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyPreset, boardColumns, buildBoard, defaultFactoryConfig, factoryConfigProblems, factoryConfigState, normalizeFactoryConfig,
  GATE_IDS, SPEC_CHECKS, STAGE_IDS, normalizeManifest, pipeline, placeItem, readManifests, saveFactoryConfig,
} from "../src/factory.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "factory-"));

test("no factory.json: the Supervised preset, off", () => {
  const s = factoryConfigState(true, tmp());
  assert.equal(s.exists, false);
  assert.equal(s.config.enabled, false);
  assert.equal(s.config.preset, "supervised");
  assert.deepEqual(Object.values(s.config.gates), ["human", "human", "human", "human"]);
  assert.ok(s.config.security.scanners.some((x) => x.command.startsWith("npm audit")));
  assert.equal(s.presets["lights-out"].mode, "autonomous");
});

test("normalize keeps good values, drops bad ones and fills the rest", () => {
  const c = normalizeFactoryConfig({
    enabled: true, preset: "nope", mode: "autonomous",
    intake: { states: ["Ready", "Ready", 3, " "], labels: ["factory"] },
    limits: { wip: 0, itemBudgetUsd: "12.5", dayBudgetUsd: -4, itemHours: 2 },
    stages: [{ id: "build" }, { id: "qa", on: true, agent: "codex", model: " gpt-5 " }, { id: "bogus" }, { id: "build", on: false }],
    security: { scanners: [{ command: "  osv-scanner -r .  ", failOn: "urgent" }, { name: "x" }], failOn: "medium" },
    gates: { plan: "approver", merge: "sometimes" },
    approver: { enabled: true, samplingPct: 250, mergeMethod: "rebase" },
  });
  assert.equal(c.preset, "custom");
  assert.deepEqual(c.intake, { states: ["Ready"], labels: ["factory"] });
  assert.deepEqual(c.limits, { wip: 1, itemBudgetUsd: 12.5, dayBudgetUsd: null, itemHours: 2 });
  assert.deepEqual(c.stages.slice(0, 3).map((s) => [s.id, s.on, s.agent, s.model]), [["build", true, null, null], ["qa", true, "codex", "gpt-5"], ["align", false, null, null]]);
  assert.equal(c.stages.length, 10);
  assert.deepEqual(c.security.scanners, [{ name: "osv-scanner -r", command: "osv-scanner -r .", when: null, failOn: "high" }]);
  assert.deepEqual(c.gates, { spec: "human", plan: "approver", prePr: "human", merge: "human" });
  assert.equal(c.approver.samplingPct, 100);
  assert.equal(c.approver.mergeMethod, "rebase");
});

test("presets set gates, mode and the Approver, and keep the rest", () => {
  const base = { ...defaultFactoryConfig(), requiredChecks: ["build"] };
  const lo = applyPreset(base, "lights-out");
  assert.equal(lo.mode, "autonomous");
  assert.equal(lo.gates.spec, "off");
  assert.equal(lo.approver.mergeAction, "auto-merge");
  assert.equal(lo.stages.find((s) => s.id === "approve")!.on, true);
  assert.deepEqual(lo.requiredChecks, ["build"]);
  assert.deepEqual(factoryConfigProblems(lo), []);
  const sup = applyPreset(lo, "supervised");
  assert.equal(sup.approver.enabled, false);
  assert.equal(sup.stages.find((s) => s.id === "approve")!.on, false);
});

test("problems: build off, a gate on the Approver while it's off, merging without the merge gate", () => {
  const c = defaultFactoryConfig();
  c.stages.find((s) => s.id === "build")!.on = false;
  c.gates.plan = "approver";
  c.approver.mergeAction = "merge";
  assert.equal(factoryConfigProblems(c).length, 3);
});

test("save writes factory.json and refuses a stale edit or a config with problems", () => {
  const dir = tmp();
  const first = saveFactoryConfig({ config: { ...defaultFactoryConfig(), enabled: true }, mtimeMs: null }, dir);
  assert.equal(first.exists, true);
  assert.equal(first.config.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "factory.json"), "utf-8")).enabled, true);
  assert.throws(() => saveFactoryConfig({ config: first.config, mtimeMs: null }, dir), (e: any) => e.status === 409);
  const bad = { ...first.config, gates: { ...first.config.gates, merge: "approver" } };
  assert.throws(() => saveFactoryConfig({ config: bad, mtimeMs: first.mtimeMs }, dir), (e: any) => e.status === 400 && /Approver is off/.test(e.message));
  assert.equal(saveFactoryConfig({ config: { ...first.config, mode: "autonomous" }, mtimeMs: first.mtimeMs }, dir).config.mode, "autonomous");
});

test("the pipeline places each gate where it guards, and leaves out gates that are off", () => {
  const ids = (c = defaultFactoryConfig()) => pipeline(c).map((s) => (s.kind === "gate" ? `gate:${s.id}` : s.id));
  assert.deepEqual(ids(), ["gate:spec", "plan", "gate:plan", "build", "review", "security", "guide", "gate:prePr", "pr", "gate:merge", "merge"]);
  const lo = applyPreset(defaultFactoryConfig(), "lights-out");
  assert.deepEqual(ids(lo), ["plan", "gate:plan", "build", "review", "security", "guide", "gate:prePr", "pr", "approve", "gate:merge", "merge"]);
  const noPr = defaultFactoryConfig();
  noPr.stages.filter((s) => s.id === "pr" || s.id === "merge").forEach((s) => (s.on = false));
  assert.deepEqual(ids(noPr).slice(-2), ["gate:prePr", "gate:merge"]);
  const cols = boardColumns(defaultFactoryConfig());
  assert.deepEqual([cols[0].id, cols.at(-1)!.id, cols[1].label], ["queued", "done", "Spec gate"]);
});

const at = "2026-10-27T10:00:00.000Z";
function manifest(over: any = {}) {
  return normalizeManifest({ ticket: "ENG-1", title: "Retries", startedAt: at, updatedAt: at, repos: ["api", "web"], stages: [], gates: [], prs: [], ...over })!;
}

test("placeItem: queued, moving, failing, waiting on a gate, skipped steps, done", () => {
  const steps = pipeline(defaultFactoryConfig());
  const gate = (id: string, decision: string, extra = {}) => ({ id, mode: "human", decision, at, ...extra });
  const st = (id: string, status: string, repo = "api") => ({ id, repo, status });
  assert.deepEqual(placeItem(manifest(), steps), { column: "queued", state: "idle", reason: null });
  assert.deepEqual(placeItem(manifest({ gates: [gate("spec", "pending")] }), steps), { column: "gate:spec", state: "waiting", reason: "Waiting on you" });
  const planned = { gates: [gate("spec", "approved"), gate("plan", "approved")], stages: [st("plan", "done")] };
  assert.deepEqual(placeItem(manifest({ ...planned, stages: [...planned.stages, st("build", "running")] }), steps).column, "build");
  // A later write for the same repo wins: failed, then running again.
  const retried = manifest({ ...planned, stages: [...planned.stages, st("build", "failed"), st("build", "running")] });
  assert.equal(placeItem(retried, steps).state, "moving");
  assert.deepEqual(placeItem(manifest({ ...planned, stages: [...planned.stages, st("build", "done"), st("build", "failed", "web")] }), steps), { column: "build", state: "failing", reason: "Building failed" });
  // Security and guide never ran but the PR did: they count as skipped.
  const atPr = manifest({ ...planned, stages: [...planned.stages, st("build", "done"), st("review", "done"), st("pr", "done")], gates: [...planned.gates, gate("prePr", "approved"), gate("merge", "pending", { mode: "approver", risk: "low" })] });
  assert.deepEqual(placeItem(atPr, steps), { column: "gate:merge", state: "waiting", reason: "Waiting on the Approver" });
  assert.equal(placeItem(manifest({ gates: [gate("spec", "rejected", { by: "kim" })] }), steps).reason, "Rejected by kim");
  assert.equal(placeItem(manifest({ done: true }), steps).column, "done");
  assert.equal(placeItem(manifest({ stages: [st("plan", "done")], prs: [{ url: "https://x/1", state: "merged" }] }), steps).column, "done");
});

test("buildBoard joins runs by ticket and rolls up repos, cost, risk and WIP", () => {
  const cfg = { ...defaultFactoryConfig(), enabled: true };
  const m = manifest({
    gates: [{ id: "spec", decision: "approved", at }, { id: "plan", decision: "approved", at, risk: "medium", rationale: "Touches auth" }],
    stages: [{ id: "plan", status: "done" }, { id: "build", repo: "api", status: "done", agent: "claude" }, { id: "review", repo: "api", status: "running" }, { id: "build", repo: "web", status: "running" }],
  });
  const runs = [
    { id: "r1", ticket: "eng-1", status: "succeeded" as const, costUsd: 1.234, startedAt: "2026-10-27T09:00:00Z", agent: "claude", model: "opus" },
    { id: "r2", ticket: "ENG-1", status: "waiting" as const, costUsd: 2, startedAt: "2026-10-27T11:00:00Z", agent: "codex", model: null },
    { id: "r3", ticket: "ENG-2", status: "running" as const, costUsd: 9, startedAt: at, agent: "claude", model: null },
  ];
  const b = buildBoard(cfg, true, [m, manifest({ ticket: "ENG-3" })], runs);
  const [item, queued] = b.items;
  assert.equal(b.enabled, true);
  assert.deepEqual([item.column, item.state, item.reason], ["build", "waiting", "Question waiting"]);
  assert.deepEqual(item.runIds, ["r2", "r1"]);
  assert.equal(item.costUsd, 3.23);
  assert.equal(item.agent, "codex");
  assert.deepEqual(item.repos, [{ repo: "api", status: "running", stage: "review" }, { repo: "web", status: "running", stage: "build" }]);
  assert.deepEqual(item.risk, { level: "medium", rationale: "Touches auth" });
  assert.equal(queued.column, "queued");
  assert.deepEqual(b.wip, { inFlight: 1, limit: 3 });
  assert.equal(buildBoard(cfg, false, [], []).enabled, false);
});

test("readManifests reads the folder newest first and reports files it can't read", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "ENG-1.json"), JSON.stringify({ ticket: "ENG-1", updatedAt: "2026-10-01T00:00:00Z" }));
  fs.writeFileSync(path.join(dir, "ENG-2.json"), JSON.stringify({ ticket: "ENG-2", updatedAt: "2026-10-02T00:00:00Z" }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  fs.writeFileSync(path.join(dir, "other.json"), "{}");
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  const { manifests, errors } = readManifests(dir);
  assert.deepEqual(manifests.map((m) => m.ticket), ["ENG-2", "ENG-1"]);
  assert.equal(errors.length, 2);
  assert.deepEqual(readManifests(path.join(dir, "missing")), { manifests: [], errors: [] });
});

test("itemSteps gives every step its state, times, repo rows and gate decisions", () => {
  const cfg = defaultFactoryConfig();
  const m = manifest({
    gates: [
      { id: "spec", decision: "approved", by: "kim", at: "2026-10-27T10:01:00.000Z" },
      { id: "plan", decision: "pending", at: "2026-10-27T10:05:00.000Z" },
      { id: "plan", decision: "approved", by: "kim", rationale: "Looks right", at: "2026-10-27T10:06:00.000Z" },
    ],
    stages: [
      { id: "plan", status: "done", startedAt: "2026-10-27T10:02:00.000Z", endedAt: "2026-10-27T10:04:00.000Z", note: "3 steps" },
      { id: "build", repo: "api", status: "done", startedAt: "2026-10-27T10:07:00.000Z", endedAt: "2026-10-27T10:20:00.000Z" },
      { id: "build", repo: "web", status: "running", startedAt: "2026-10-27T10:21:00.000Z" },
    ],
  });
  const b = buildBoard(cfg, true, [m], []);
  const s = Object.fromEntries(b.items[0].steps.map((x) => [x.id, x]));
  assert.deepEqual(b.items[0].steps.map((x) => x.id), ["gate:spec", "plan", "gate:plan", "build", "review", "security", "guide", "gate:prePr", "pr", "gate:merge", "merge"]);
  assert.deepEqual([s["gate:spec"].state, s.plan.state, s["gate:plan"].state, s.build.state, s.review.state], ["done", "done", "done", "running", "pending"]);
  assert.equal(s.build.current, true);
  assert.equal(s.plan.current, false);
  assert.deepEqual([s.build.startedAt, s.build.endedAt], ["2026-10-27T10:07:00.000Z", null]);
  assert.deepEqual([s.plan.startedAt, s.plan.endedAt, s.plan.repos[0].note], ["2026-10-27T10:02:00.000Z", "2026-10-27T10:04:00.000Z", "3 steps"]);
  assert.deepEqual(s["gate:plan"].decisions.map((d) => [d.decision, d.by]), [["pending", null], ["approved", "kim"]]);
  assert.deepEqual([s["gate:plan"].startedAt, s["gate:plan"].endedAt], ["2026-10-27T10:05:00.000Z", "2026-10-27T10:06:00.000Z"]);
  assert.deepEqual(s.build.repos.map((r) => [r.repo, r.status]), [["api", "done"], ["web", "running"]]);
  // A step it never reported, before one it did, counts as skipped.
  const skip = buildBoard(cfg, true, [manifest({ stages: [{ id: "build", repo: "api", status: "running" }] })], []).items[0].steps;
  assert.deepEqual(skip.slice(0, 4).map((x) => x.state), ["skipped", "skipped", "skipped", "running"]);
});

test("spec readiness: the team's levels and weights, checked; a manifest's score carried to its item", () => {
  const c = normalizeFactoryConfig({ spec: { readyAt: "85", needsWorkAt: 60, minScore: 55.4, weights: { scope: 0, constraints: "8", bogus: 5, verify: -3 } } });
  assert.deepEqual(c.spec, { readyAt: 85, needsWorkAt: 60, minScore: 55, weights: { scope: 0, constraints: 8, verify: 0 } });
  assert.deepEqual(defaultFactoryConfig().spec, { readyAt: 80, needsWorkAt: 50, minScore: null, weights: {} });
  const bad = normalizeFactoryConfig({ spec: { readyAt: 50, needsWorkAt: 70 } });
  assert.match(factoryConfigProblems(bad).join(" "), /Needs work" has to start below/);
  const off = normalizeFactoryConfig({ spec: { weights: Object.fromEntries(["problem", "outcome", "criteria", "scope", "constraints", "affected", "questions", "verify"].map((k) => [k, 0])) } });
  assert.match(factoryConfigProblems(off).join(" "), /at least one check/);
  assert.equal(factoryConfigState(true, tmp()).specChecks.reduce((s, x) => s + x.weight, 0), 100);

  const m = manifest({ spec: { score: 64.6, level: "needs-work", readyAt: 80, needsWorkAt: 50, minScore: null, at,
    checks: [{ id: "criteria", label: "Acceptance criteria", weight: 25, score: 0.5, finding: "2 of 4 testable", override: { from: 1, reason: "AC 2 contradicts AC 3" } }, { id: "nope", score: 1 }] } });
  assert.equal(m.spec!.score, 65);
  assert.deepEqual(m.spec!.checks.map((x) => [x.id, x.override?.reason]), [["criteria", "AC 2 contradicts AC 3"]]);
  assert.equal(normalizeManifest({ ticket: "X", spec: { score: "high" } })!.spec, null);
  assert.equal(buildBoard(defaultFactoryConfig(), true, [m], []).items[0].spec!.level, "needs-work");
});

test("a ticket that stopped short stays where it stopped, failing, with why", () => {
  const steps = pipeline(defaultFactoryConfig());
  const m = manifest({ gates: [{ id: "spec", decision: "rejected", by: "auto", at }], done: true, error: "spec not ready" });
  assert.deepEqual(placeItem(m, steps), { column: "gate:spec", state: "failing", reason: "Stopped: spec not ready" });
  assert.deepEqual(placeItem(manifest({ done: true }), steps), { column: "done", state: "done", reason: null });
});

test("readManifests parses only the newest files, and re-reads one only when it changes", () => {
  const dir = tmp();
  for (let i = 0; i < 305; i++) {
    const f = path.join(dir, `T-${i}.json`);
    fs.writeFileSync(f, JSON.stringify({ ticket: `T-${i}`, title: "v1" }));
    fs.utimesSync(f, new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000));
  }
  const first = readManifests(dir).manifests;
  assert.equal(first.length, 300);
  assert.ok(!first.some((m) => ["T-0", "T-4"].includes(m.ticket)), "the oldest files are left out");
  const f = path.join(dir, "T-304.json");
  fs.writeFileSync(f, JSON.stringify({ ticket: "T-304", title: "v2" }));
  fs.utimesSync(f, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
  assert.equal(readManifests(dir).manifests.find((m) => m.ticket === "T-304")!.title, "v2");
});

// The multirepo plugin's scripts (in this repo) write what the engine reads: their lists must match.
test("the multirepo scripts' stages, gates and spec checks match the engine's", async (t) => {
  const scripts = path.join(import.meta.dirname, "..", "..", "..", "..", "multirepo", "scripts");
  if (!fs.existsSync(path.join(scripts, "spec-check.mjs"))) return t.skip("no multirepo plugin next to this engine");
  const { STAGES, GATES } = await import(pathToFileURL(path.join(scripts, "factory.mjs")).href);
  const { CHECKS } = await import(pathToFileURL(path.join(scripts, "spec-check.mjs")).href);
  assert.deepEqual(STAGES, STAGE_IDS);
  assert.deepEqual(GATES, GATE_IDS);
  assert.deepEqual(CHECKS.map((c: any) => [c.id, c.label, c.weight]), SPEC_CHECKS.map((c) => [c.id, c.label, c.weight]));
});

test("Copilot on #112: plan gate without planning, retried rows, a deleted policy", () => {
  const ids = (c: ReturnType<typeof defaultFactoryConfig>) => pipeline(c).map((s) => (s.kind === "gate" ? `gate:${s.id}` : s.id));
  const noPlan = defaultFactoryConfig();
  noPlan.stages.find((s) => s.id === "plan")!.on = false;
  assert.deepEqual(ids(noPlan).slice(0, 3), ["gate:spec", "gate:plan", "build"]);

  // An appended retry (not an in-place update) still counts: the latest row per repo decides.
  const m = manifest({ stages: [{ id: "build", repo: "api", status: "failed" }, { id: "build", repo: "api", status: "done", endedAt: at }] });
  const build = buildBoard(defaultFactoryConfig(), true, [m], []).items[0].steps.find((s) => s.id === "build")!;
  assert.deepEqual([build.state, build.repos.length], ["done", 1]);

  const dir = tmp();
  const first = saveFactoryConfig({ config: defaultFactoryConfig(), mtimeMs: null }, dir);
  fs.unlinkSync(path.join(dir, "factory.json"));
  assert.throws(() => saveFactoryConfig({ config: first.config, mtimeMs: first.mtimeMs }, dir), (e: any) => e.status === 409);
});

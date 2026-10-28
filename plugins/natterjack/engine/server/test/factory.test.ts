// factory.ts: factory.json defaults, presets and saving; manifests; the pipeline's order; placing items on the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyPreset, boardColumns, buildBoard, defaultFactoryConfig, factoryConfigProblems, factoryConfigState, normalizeFactoryConfig,
  GATE_IDS, SPEC_CHECKS, STAGE_IDS, approverStats, auditCsv, auditRows, factoryMetrics, factoryNotices, intakeCandidates, relatedPrs, setPrStates, webhookTarget, NOTICE_EVENTS, factoryLaunchBlocker, manifestFile, normalizeManifest, overridableGate, overrideGateDecision, rateAssessment, readPlan, recordGateDecision, ticketFile, pipeline, placeItem, readManifests, saveFactoryConfig,
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
  assert.deepEqual(c.intake, { states: ["Ready"], labels: ["factory"], auto: false, everyMinutes: 30, unassigned: false });
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

test("the factory refuses a launch over the ticket's budget or hours, the day's budget, or the WIP limit", () => {
  const cfg = { ...defaultFactoryConfig(), enabled: true, limits: { wip: 1, itemBudgetUsd: 10, dayBudgetUsd: 30, itemHours: 2 } };
  const now = Date.parse("2026-10-27T15:00:00");
  const run = (id: string, ticket: string, costUsd: number, startedAt = "2026-10-27T09:00:00", durationMs = 0) =>
    ({ id, ticket, status: "succeeded" as const, costUsd, startedAt: new Date(startedAt).toISOString(), agent: "claude", model: null, durationMs });
  const started = (t: string) => manifest({ ticket: t, stages: [{ id: "build", status: "running" }] });

  assert.equal(factoryLaunchBlocker(cfg, true, "ENG-1", [], [], now), null);
  assert.equal(factoryLaunchBlocker({ ...cfg, enabled: false }, true, "ENG-1", [started("ENG-2")], [run("a", "ENG-1", 99)], now), null, "off: no limits");
  assert.match(factoryLaunchBlocker(cfg, true, "ENG-1", [], [run("a", "eng-1", 6), run("b", "ENG-1", 4.5)], now)!, /ENG-1 has used \$10\.50 of its \$10\.00 budget/);
  assert.match(factoryLaunchBlocker(cfg, true, "ENG-1", [], [run("a", "ENG-1", 1, undefined, 2.5 * 3_600_000)], now)!, /2\.5 of its 2 agent hours/);
  // Today's spend counts runs of tickets on the board, started since midnight.
  const day = [run("a", "ENG-2", 9), run("b", "ENG-3", 9), run("c", "ENG-4", 9), run("d", "ENG-5", 9, "2026-10-26T20:00:00"), run("e", "OTHER-1", 50)];
  const board = ["ENG-2", "ENG-3", "ENG-4", "ENG-5"].map((t) => manifest({ ticket: t, done: true }));
  assert.equal(factoryLaunchBlocker(cfg, true, "ENG-1", board, day, now), null);
  assert.match(factoryLaunchBlocker(cfg, true, "ENG-1", board, [...day, run("f", "ENG-2", 4)], now)!, /spent \$31\.00 of its \$30\.00 budget today/);
  // WIP: another ticket in flight blocks a new one, but not one that's already in flight.
  assert.match(factoryLaunchBlocker(cfg, true, "ENG-1", [started("ENG-2")], [], now)!, /1 ticket is already in the factory \(WIP limit 1\): ENG-2/);
  assert.equal(factoryLaunchBlocker(cfg, true, "ENG-2", [started("ENG-2"), started("ENG-3")], [], now), null);
});

test("WIP counts implement runs that are going but haven't reported yet", () => {
  const cfg = { ...defaultFactoryConfig(), enabled: true, limits: { ...defaultFactoryConfig().limits, wip: 1 } };
  const going = (ticket: string, implement = true, status: "running" | "succeeded" = "running") =>
    ({ id: ticket, ticket, status, costUsd: 0, startedAt: at, agent: "claude", model: null, implement });
  assert.match(factoryLaunchBlocker(cfg, true, "ENG-2", [], [going("ENG-1")])!, /WIP limit 1\): ENG-1/);
  assert.equal(factoryLaunchBlocker(cfg, true, "ENG-2", [], [going("ENG-1", false)]), null, "an Explain run isn't in flight");
  assert.equal(factoryLaunchBlocker(cfg, true, "ENG-2", [], [going("ENG-1", true, "succeeded")]), null);
  assert.equal(factoryLaunchBlocker(cfg, true, "ENG-1", [], [going("ENG-1")]), null, "carrying on with its own ticket");
});

// factory.mjs reads factory.json for the pipeline: it must read it as the dashboard does.
test("the multirepo scripts read the policy as the dashboard does", async (t) => {
  const scripts = path.join(import.meta.dirname, "..", "..", "..", "..", "multirepo", "scripts");
  if (!fs.existsSync(path.join(scripts, "factory.mjs"))) return t.skip("no multirepo plugin next to this engine");
  const { normalizePolicy } = await import(pathToFileURL(path.join(scripts, "factory.mjs")).href);
  const inputs = [
    null, {}, { enabled: true },
    { enabled: true, limits: { wip: 0 }, gates: { plan: "sometimes", merge: "auto" }, stages: [{ id: "security", on: false }, { id: "qa" }] },
    { limits: { wip: "7.6" }, security: { failOn: "medium", secretScan: false, agentReview: false, scanners: [{ command: "  osv-scanner -r .  ", when: " go.mod ", failOn: "x" }, { name: "n" }] } },
    { security: { scanners: [] } },
    { requiredChecks: [" build ", "build", 3], reviewers: { bots: ["copilot"], pipeline: false, noUnresolved: false },
      approver: { enabled: true, enforce: true, identity: " approver-bot ", highRiskPaths: [], highRiskLabels: ["Security", ""], maxFiles: "0", maxLines: 99.6, maxRepos: 500, mergeAction: "merge", mergeMethod: "fast", samplingPct: 101 } },
    { approver: { enforce: "yes", identity: "", highRiskLabels: "security" } },
    { intake: { states: ["Ready", " ready "], labels: ["factory"], auto: true, everyMinutes: 2 } }, { intake: { auto: "yes", everyMinutes: "45", unassigned: true } },
  ];
  for (const raw of inputs) {
    const d = normalizeFactoryConfig(raw);
    const cli = normalizePolicy(raw);
    assert.deepEqual(cli, {
      enabled: d.enabled, gates: d.gates,
      stages: STAGE_IDS.map((id) => ({ id, on: d.stages.find((s) => s.id === id)!.on })),
      limits: { wip: d.limits.wip },
      security: { agentReview: d.security.agentReview, secretScan: d.security.secretScan, failOn: d.security.failOn, scanners: d.security.scanners },
      intake: d.intake, requiredChecks: d.requiredChecks, reviewers: d.reviewers, approver: d.approver,
    }, JSON.stringify(raw));
  }
});

test("a person's gate decision: recorded only where the ticket waits, a rejection ends it, the item shows where it waits", async () => {
  const dir = tmp();
  const file = path.join(dir, "acme_api_7.json");
  fs.writeFileSync(file, JSON.stringify({ ticket: "acme/api#7", startedAt: at, updatedAt: at, stages: [{ id: "plan", status: "done" }],
    gates: [{ id: "spec", decision: "approved", at }, { id: "plan", mode: "human", decision: "pending", rationale: "A person decides the plan gate.", at }] }));
  assert.equal(ticketFile("acme/api#7"), "acme_api_7.json");
  // Case-insensitive file systems (Windows, macOS by default) find it whatever the case: the same file either way.
  const samePath = (a: string | null, b: string) => !!a && fs.statSync(a).ino === fs.statSync(b).ino && fs.statSync(a).dev === fs.statSync(b).dev;
  assert.ok(samePath(manifestFile("ACME/API#7", dir), file), "found whatever the ticket's case");
  fs.writeFileSync(path.join(dir, "custom-name.json"), JSON.stringify({ ticket: "OPS-3" }));
  assert.equal(manifestFile("OPS-3", dir), path.join(dir, "custom-name.json"), "another writer's file name");

  const item = buildBoard(defaultFactoryConfig(), true, readManifests(dir).manifests, [], [], true).items.find((i) => i.ticket === "acme/api#7")!;
  assert.deepEqual(item.waitingGate, { id: "plan", label: "Plan gate", mode: "human", since: at, reason: "A person decides the plan gate." });

  await assert.rejects(recordGateDecision("acme/api#7", "prePr", "approved", "kim", null, { dir }), (e: any) => e.status === 409 && /isn't waiting at the pre-pr gate/.test(e.message));
  await assert.rejects(recordGateDecision("ENG-404", "plan", "approved", "kim", null, { dir }), (e: any) => e.status === 404);
  const m = await recordGateDecision("acme/api#7", "plan", "approved", "kim", " looks right ", { dir, now: "2026-10-27T11:00:00.000Z" });
  assert.deepEqual(m.gates.at(-1), { id: "plan", mode: "human", decision: "approved", by: "kim", risk: null, rationale: "looks right", sha: null, at: "2026-10-27T11:00:00.000Z" });
  assert.equal(buildBoard(defaultFactoryConfig(), true, readManifests(dir).manifests, []).items.find((i) => i.ticket === "acme/api#7")!.waitingGate, null);
  await assert.rejects(recordGateDecision("acme/api#7", "plan", "rejected", "kim", null, { dir }), (e: any) => e.status === 409, "decided already");
  assert.equal(fs.existsSync(`${file}.lock`), false);

  // factory.mjs holding the lock: the decision waits (without blocking), then gives up with a 409.
  fs.writeFileSync(`${file}.lock`, "held");
  const started = Date.now();
  let ticked = 0;
  const tick = setInterval(() => ticked++, 50);
  fs.writeFileSync(file, JSON.stringify({ ticket: "acme/api#7", gates: [{ id: "spec", mode: "human", decision: "pending", at }] }));
  await assert.rejects(recordGateDecision("acme/api#7", "spec", "approved", "kim", null, { dir }), (e: any) => e.status === 409 && /busy/.test(e.message));
  clearInterval(tick);
  assert.ok(Date.now() - started >= 4_000 && ticked > 20, "the event loop kept running while it waited");
  fs.unlinkSync(`${file}.lock`);

  const r = await recordGateDecision("acme/api#7", "spec", "rejected", "kim", "too vague", { dir });
  assert.deepEqual([r.done, r.error], [true, "Spec gate rejected by kim: too vague"]);
});

test("a new round leaves earlier gate decisions in the trail but out of the ticket's place", () => {
  const t = (n: number) => `2026-10-27T1${n}:00:00.000Z`;
  const m = manifest({ roundStartedAt: t(5), gates: [{ id: "spec", decision: "pending", at: t(1) }, { id: "spec", decision: "rejected", by: "kim", at: t(2) }] });
  assert.equal(m.roundStartedAt, t(5));
  const item = buildBoard(defaultFactoryConfig(), true, [m], []).items[0];
  assert.deepEqual([item.column, item.state], ["queued", "idle"], "the old rejection doesn't fail it");
});

test("readPlan reads a plan in ~/.claude/plans or a workspace's own work folder, nothing else", () => {
  const home = tmp();
  const plans = path.join(home, ".claude", "plans");
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, "ENG-1-retries.md"), "# Plan\nRetry with backoff.");
  fs.mkdirSync(path.join(home, ".ssh"));
  fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "secret");
  const m = (plan: string | null, workroot: string | null = null) => manifest({ plan, workroot });
  assert.deepEqual(readPlan(m("~/.claude/plans/ENG-1-retries.md"), home, []), { path: fs.realpathSync(path.join(plans, "ENG-1-retries.md")), text: "# Plan\nRetry with backoff." });
  assert.throws(() => readPlan(m("~/.ssh/id_rsa"), home, []), (e: any) => e.status === 403);
  assert.throws(() => readPlan(m("~/.claude/plans/../../.ssh/id_rsa"), home, []), (e: any) => e.status === 403);
  assert.throws(() => readPlan(m("~/.claude/plans/missing.md"), home, []), (e: any) => e.status === 404);
  assert.throws(() => readPlan(m(null), home, []), (e: any) => e.status === 404);
  // The manifest's own workroot isn't trusted: only a folder of this workspace's.
  assert.throws(() => readPlan(m(path.join(home, ".ssh", "id_rsa"), home), home, []), (e: any) => e.status === 403);
  const ws = tmp();
  const wt = path.join(ws, "worktrees", "eng-1");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, "PLAN.md"), "in the worktree");
  assert.equal(readPlan(m(path.join(wt, "PLAN.md"), wt), home, [ws]).text, "in the worktree");
  assert.throws(() => readPlan(m(path.join(wt, "PLAN.md"), wt), home, [tmp()]), (e: any) => e.status === 403);
  // A symlink in ~/.claude/plans pointing out is followed to where it points, and refused.
  try { fs.symlinkSync(path.join(home, ".ssh", "id_rsa"), path.join(plans, "sneaky.md")); } catch { return; }
  assert.throws(() => readPlan(m("~/.claude/plans/sneaky.md"), home, []), (e: any) => e.status === 403);
});

test("Copilot on #114: only this round's request can be answered; the guard runs in the lock; the asking run is named", async () => {
  const dir = tmp();
  const t = (n: number) => `2026-10-27T1${n}:00:00.000Z`;
  const file = path.join(dir, "ENG-1.json");
  fs.writeFileSync(file, JSON.stringify({ ticket: "ENG-1", roundStartedAt: t(5), gates: [{ id: "plan", mode: "human", decision: "pending", at: t(1) }] }));
  await assert.rejects(recordGateDecision("ENG-1", "plan", "rejected", "kim", null, { dir }), (e: any) => e.status === 409, "an earlier round's request");
  fs.writeFileSync(file, JSON.stringify({ ticket: "ENG-1", roundStartedAt: t(5), gates: [{ id: "plan", mode: "human", decision: "pending", at: t(6) }] }));
  await assert.rejects(recordGateDecision("ENG-1", "plan", "approved", "kim", null, { dir, guard: () => { throw Object.assign(new Error("run started"), { status: 409 }); } }), /run started/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).gates.length, 1, "nothing written when the guard refuses");
  assert.equal((await recordGateDecision("ENG-1", "plan", "approved", "kim", null, { dir })).gates.length, 2);

  const run = (id: string, status: "waiting" | "running" | "succeeded", implement: boolean, startedAt: string) => ({ id, ticket: "ENG-2", status, costUsd: 0, startedAt, agent: "claude", model: null, implement });
  const item = (runs: any[]) => buildBoard(defaultFactoryConfig(), true, [manifest({ ticket: "ENG-2" })], runs).items[0];
  const a = item([run("impl", "waiting", true, t(1)), run("explain", "succeeded", false, t(2))]);
  assert.deepEqual([a.askingRunId, a.implementLive, a.runIds[0]], ["impl", true, "explain"]);
  const b = item([run("explain", "waiting", false, t(2)), run("impl", "succeeded", true, t(1))]);
  assert.deepEqual([b.askingRunId, b.implementLive], ["explain", false], "an Explain question doesn't hold the gate");
});

test("the Approver's assessments: read and checked, the newest this round shows on the item and sets its risk", () => {
  const a = (over: object) => ({ gate: "merge", level: "low", rulesLevel: null, judged: "low", rules: [], rationale: "Small.", concerns: [], wouldApprove: true, blockers: [], sampled: false, enforced: false, action: "handoff", reason: "Advisory.", by: "sam", sha: "abc", at, ...over });
  const m = normalizeManifest({
    ticket: "T-9", startedAt: at, roundStartedAt: "2026-10-27T11:00:00.000Z", stages: [{ id: "build", status: "done" }],
    gates: [{ id: "merge", decision: "pending", risk: "medium", rationale: "gate", at: "2026-10-27T11:30:00.000Z" }],
    assessments: [
      a({ level: "high", at: "2026-10-27T10:30:00.000Z" }),
      a({ at: "2026-10-27T12:00:00.000Z", rules: [{ id: "path", level: "high", detail: "x" }, { id: "nope", level: "x", detail: "y" }], concerns: ["c", 3], action: "jump" }),
      { gate: "nope", level: "low" }, { gate: "plan", level: "extreme" },
    ],
  })!;
  assert.equal(m.assessments.length, 2, "unknown gates and levels dropped");
  assert.deepEqual(m.assessments[1].rules, [{ id: "path", level: "high", detail: "x" }]);
  assert.deepEqual(m.assessments[1].concerns, ["c"]);
  assert.equal(m.assessments[1].action, "handoff");
  const item = buildBoard(defaultFactoryConfig(), true, [m], []).items[0];
  assert.equal(item.approver!.at, "2026-10-27T12:00:00.000Z");
  assert.deepEqual(item.risk, { level: "low", rationale: "Small." });
  // An assessment from before this round doesn't count; the gate's rating does.
  const old = normalizeManifest({ ...m, assessments: [a({ at: "2026-10-27T10:30:00.000Z" })] })!;
  const oldItem = buildBoard(defaultFactoryConfig(), true, [old], []).items[0];
  assert.equal(oldItem.approver, null);
  assert.deepEqual(oldItem.risk, { level: "medium", rationale: "gate" });
});

test("an enforced Approver needs an identity", () => {
  const c = normalizeFactoryConfig({ approver: { enabled: true, enforce: true } });
  assert.ok(factoryConfigProblems(c).some((p) => /name its identity/.test(p)));
  assert.ok(!factoryConfigProblems(normalizeFactoryConfig({ approver: { enabled: true, enforce: true, identity: "bot" } })).some((p) => /identity/.test(p)));
});

test("a person overrides an automatic approval (with why), and rates the Approver's calls", async () => {
  const dir = tmp();
  const file = path.join(dir, "T-11.json");
  const assessment = { gate: "plan", level: "low", rules: [], concerns: [], wouldApprove: true, blockers: [], sampled: false, enforced: true, action: "pass", reason: "ok", at: "2026-10-27T10:05:00.000Z" };
  fs.writeFileSync(file, JSON.stringify({ ticket: "T-11", startedAt: at, roundStartedAt: at, stages: [{ id: "plan", status: "done" }],
    gates: [{ id: "spec", decision: "approved", by: "sam", at }, { id: "plan", decision: "approved", by: "approver", mode: "approver", risk: "low", at: "2026-10-27T10:05:00.000Z" }],
    assessments: [assessment] }));
  const item = () => buildBoard(defaultFactoryConfig(), true, readManifests(dir).manifests, []).items[0];
  assert.deepEqual(item().overridable, { gate: "plan", by: "approver", at: "2026-10-27T10:05:00.000Z" });
  await assert.rejects(overrideGateDecision("T-11", "plan", "sam", "  ", { dir }), /Say why/);
  await assert.rejects(overrideGateDecision("T-11", "spec", "sam", "no", { dir }), /isn't an automatic approval/, "a person's approval isn't overridden here");
  // Rating first: right, then someone else says it should have asked; the newest counts.
  await rateAssessment("T-11", assessment.at, "right", "ann", null, { dir, now: "2026-10-27T11:00:00.000Z" });
  await rateAssessment("T-11", assessment.at, "should-have-asked", "sam", " touches billing ", { dir, now: "2026-10-27T11:01:00.000Z" });
  await assert.rejects(rateAssessment("T-11", "2020-01-01T00:00:00.000Z", "right", "sam", null, { dir }), /isn't there/);
  await assert.rejects(rateAssessment("T-11", assessment.at, "meh" as any, "sam", null, { dir }), /Rate it/);
  assert.deepEqual({ ...item().approverRating, at: undefined }, { assessmentAt: assessment.at, gate: "plan", level: "low", wouldApprove: true, rating: "should-have-asked", by: "sam", note: "touches billing", at: undefined });
  const m = await overrideGateDecision("T-11", "plan", "sam", "touches billing", { dir, now: "2026-10-27T11:02:00.000Z" });
  assert.equal(m.done, true);
  assert.match(m.error!, /sam overrode the Approver's approval: touches billing/);
  assert.deepEqual(m.gates.at(-1), { id: "plan", mode: "human", decision: "rejected", by: "sam", risk: "low", rationale: "Overrode the Approver's approval: touches billing", sha: null, at: "2026-10-27T11:02:00.000Z", override: true });
  assert.equal(item().overridable, null, "a stopped ticket has nothing to override");
  assert.equal(item().state, "failing");
  await assert.rejects(overrideGateDecision("T-11", "plan", "sam", "again", { dir }), /finished/);
  assert.deepEqual(approverStats(readManifests(dir).manifests), { assessed: 1, judged: 1, tooLenient: 1, tooStrict: 0 });
});

test("overridableGate: the gate's latest row this round, pending ones included, must be an automatic approval", () => {
  const m = (gates: object[], extra = {}) => normalizeManifest({ ticket: "T-12", startedAt: at, roundStartedAt: at, gates, ...extra })!;
  const auto = { id: "prePr", decision: "approved", by: "auto", at: "2026-10-27T10:10:00.000Z" };
  assert.equal(overridableGate(m([auto]))!.id, "prePr");
  assert.equal(overridableGate(m([auto, { id: "prePr", decision: "pending", at: "2026-10-27T10:20:00.000Z" }])), null, "asked again since");
  assert.equal(overridableGate(m([{ ...auto, by: "sam" }])), null, "a person's approval");
  assert.equal(overridableGate(m([{ ...auto, at: "2026-10-27T09:00:00.000Z" }])), null, "an earlier round's");
  assert.equal(overridableGate(m([auto], { done: true })), null, "a finished ticket");
});

test("approverStats: an override counts against the assessment only when it reversed that gate's Approver approval", () => {
  const a = { gate: "merge", level: "low", wouldApprove: true, enforced: true, action: "handoff", at: "2026-10-27T10:00:00.000Z" };
  const plan = normalizeManifest({ ticket: "S-1", startedAt: at, assessments: [a], gates: [
    { id: "plan", decision: "approved", by: "auto", at: "2026-10-27T09:00:00.000Z" },
    { id: "plan", decision: "rejected", by: "sam", override: true, at: "2026-10-27T11:00:00.000Z" }] })!;
  assert.deepEqual(approverStats([plan]), { assessed: 1, judged: 0, tooLenient: 0, tooStrict: 0 }, "another gate's automatic approval");
  const merge = normalizeManifest({ ticket: "S-2", startedAt: at, assessments: [a], gates: [
    { id: "merge", decision: "approved", by: "approver", at: "2026-10-27T10:00:00.000Z" },
    { id: "merge", decision: "rejected", by: "sam", override: true, at: "2026-10-27T11:00:00.000Z" }] })!;
  assert.deepEqual(approverStats([merge]), { assessed: 1, judged: 1, tooLenient: 1, tooStrict: 0 });
});

test("readManifests returns as many as asked for (the board's cap is only its default)", () => {
  const dir = tmp();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `L-${i}.json`), JSON.stringify({ ticket: `L-${i}`, startedAt: at, updatedAt: at }));
  assert.equal(readManifests(dir, 2).manifests.length, 2);
  assert.equal(readManifests(dir, Infinity).manifests.length, 3);
});

test("the line's metrics: finished items, lead time, first-pass review, the Approver alone, cost per merged item", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const mk = (ticket: string, over: object) => normalizeManifest({ ticket, startedAt: day(3), updatedAt: day(1), ...over })!;
  const ms = [
    mk("A-1", { done: true, prs: [{ url: "https://x/1", state: "merged" }], stages: [{ id: "review", repo: "api", status: "done" }],
      assessments: [{ gate: "merge", level: "low", enforced: true, action: "pass", at: day(1) }, { gate: "plan", level: "low", enforced: false, action: "ask", at: day(2) }] }),
    mk("A-2", { done: true, startedAt: day(5), updatedAt: day(2), stages: [{ id: "review", repo: "api", status: "done", failures: 1 }],
      assessments: [{ gate: "merge", level: "medium", enforced: true, action: "handoff", at: day(2) }] }),
    mk("A-3", { done: true, error: "rejected", stages: [{ id: "review", repo: "web", status: "failed", failures: 1 }] }),
    mk("A-4", { done: true, updatedAt: day(40), startedAt: day(41) }),
  ];
  const runs = [{ id: "r1", ticket: "A-1", status: "succeeded", costUsd: 3.5 }, { id: "r2", ticket: "a-1", status: "succeeded", costUsd: 1.5 }] as any;
  const m = factoryMetrics(ms, runs, now);
  assert.equal(m.done7d, 2, "stopped short and older than 30 days don't count");
  assert.equal(m.leadTimeHours, 60, "median of 48h and 72h");
  assert.deepEqual(m.firstPassReview, { rate: 0.33, n: 3 });
  assert.deepEqual(m.autoApproved, { rate: 0.5, n: 2 });
  assert.equal(m.costPerMergedUsd, 5);
  assert.equal(m.merged, 1);
  // A retro or a rating later doesn't move when it finished.
  const later = factoryMetrics([mk("B-1", { done: true, startedAt: day(10), finishedAt: day(9), updatedAt: day(0) })], [], now);
  assert.equal(later.leadTimeHours, 24);
  assert.equal(later.done7d, 0);
  assert.deepEqual(factoryMetrics([], [], now), { done7d: 0, leadTimeHours: null, firstPassReview: null, autoApproved: null, costPerMergedUsd: null, merged: 0 });
});

test("intake: tickets in its states with its labels, not in the factory yet, no run going; nothing without either", () => {
  const cfg = (intake: object) => normalizeFactoryConfig({ intake });
  // The tracker already narrowed these to this person's (assignee set) and, with intake.unassigned, unassigned ones.
  const issues = [
    { id: "ENG-1", title: "a", url: "https://t/1", state: "Ready", labels: [{ name: "Factory" }], assignee: "Sam" },
    { id: "ENG-2", title: "b", state: "ready", labels: [], assignee: "Sam" },
    { id: "ENG-3", title: "c", state: "In Progress", labels: ["factory"], assignee: "Sam" },
    { id: "ENG-4", title: "d", state: "Ready", labels: ["factory"], assignee: "Sam" },
    { id: "ENG-5", title: "e", state: "Ready", labels: ["factory"], assignee: "Sam" },
  ];
  const ms = [normalizeManifest({ ticket: "eng-4", done: true, error: "rejected" })!];
  const runs = [{ id: "r", ticket: "ENG-5", status: "running" }] as any;
  assert.deepEqual(intakeCandidates(cfg({ states: ["Ready"] }), issues, ms, runs).map((c) => c.ticket), ["ENG-1", "ENG-2"]);
  assert.deepEqual(intakeCandidates(cfg({ labels: ["factory"] }), issues, ms, runs).map((c) => c.ticket), ["ENG-1", "ENG-3"]);
  assert.deepEqual(intakeCandidates(cfg({ states: ["Ready"], labels: ["factory"] }), issues, ms, runs), [{ ticket: "ENG-1", title: "a", url: "https://t/1", state: "Ready", unassigned: false }]);
  assert.deepEqual(intakeCandidates(cfg({}), issues, [], []), []);
  // No states: any open one (a finished ticket that kept its label isn't pulled); a ticket pulled before isn't pulled again.
  const closed = [...issues, { id: "ENG-6", title: "f", state: "Done", labels: ["factory"], assignee: "Sam" }, { id: "ENG-7", title: "g", state: "Canceled", labels: ["factory"], assignee: "Sam" }];
  assert.deepEqual(intakeCandidates(cfg({ labels: ["factory"] }), closed, ms, runs, new Set(["eng-3"])).map((c) => c.ticket), ["ENG-1"]);
  // Unassigned ones come in only with intake.unassigned, marked to be claimed first.
  const pool = [{ id: "ENG-8", title: "h", state: "Ready", labels: [] }];
  assert.deepEqual(intakeCandidates(cfg({ states: ["Ready"] }), pool, [], []), []);
  assert.deepEqual(intakeCandidates(cfg({ states: ["Ready"], unassigned: true }), pool, [], []).map((c) => [c.ticket, c.unassigned]), [["ENG-8", true]]);
});

test("a retro is read and checked, and shows on a merged item", () => {
  const m = normalizeManifest({ ticket: "R-1", startedAt: at, done: true, prs: [{ url: "https://x/1", state: "merged" }],
    retro: { caught: ["a race", "", 3], wrong: ["the API was paged"], approver: " held up ", proposals: ["add **/billing/** to high-risk paths"], at } })!;
  assert.deepEqual(m.retro, { caught: ["a race"], wrong: ["the API was paged"], approver: "held up", proposals: ["add **/billing/** to high-risk paths"], at });
  const it = buildBoard(defaultFactoryConfig(), true, [m], []).items[0];
  assert.equal(it.merged, true);
  assert.equal(it.retro!.approver, "held up");
  assert.equal(normalizeManifest({ ticket: "R-2" })!.retro, null);
});

test("metrics count each figure by its own time; a late retro doesn't bring an old ticket back", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const old = normalizeManifest({ ticket: "O-1", startedAt: day(45), finishedAt: day(40), updatedAt: day(0), done: true,
    prs: [{ url: "https://x/1", state: "merged" }], stages: [{ id: "review", repo: "api", status: "done", endedAt: day(41) }] })!;
  const m = factoryMetrics([old], [{ id: "r", ticket: "O-1", status: "succeeded", costUsd: 9 } as any], now);
  assert.deepEqual([m.done7d, m.firstPassReview, m.costPerMergedUsd, m.merged], [0, null, null, 0]);
});

test("Linear's finished state types aren't intake candidates, whatever the state is called", () => {
  const cfg = normalizeFactoryConfig({ intake: { labels: ["factory"] } });
  const issues = [{ id: "L-1", state: "Shipped", stateType: "completed", labels: ["factory"], assignee: "Sam" }, { id: "L-2", state: "Ready", stateType: "unstarted", labels: ["factory"], assignee: "Sam" }];
  assert.deepEqual(intakeCandidates(cfg, issues, [], []).map((c) => c.ticket), ["L-2"]);
});

test("setPrStates writes the code host's PR states and when everything merged", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "P-1.json"), JSON.stringify({ ticket: "P-1", startedAt: at, prs: [{ url: "https://github.com/a/b/pull/1", state: "open" }, { url: "https://github.com/a/c/pull/2", state: "open" }] }));
  let m = await setPrStates("P-1", { "https://github.com/a/b/pull/1": "merged" }, { dir, now: "2026-10-27T11:00:00.000Z" });
  assert.deepEqual(m.prs.map((p) => p.state), ["merged", "open"]);
  assert.equal(m.finishedAt, null);
  m = await setPrStates("P-1", { "https://github.com/a/c/pull/2": "merged" }, { dir, now: "2026-10-27T12:00:00.000Z" });
  assert.equal(m.finishedAt, "2026-10-27T12:00:00.000Z");
});

test("notices: a gate waiting on a person, a stage failed twice, a budget reached, a ticket stopped, PRs merged; one key per occurrence", () => {
  const cfg = normalizeFactoryConfig({ enabled: true, limits: { itemBudgetUsd: 5 } });
  const ms = [
    normalizeManifest({ ticket: "N-1", title: "Plan me", startedAt: at, gates: [{ id: "spec", decision: "approved", by: "sam", at }, { id: "plan", mode: "human", decision: "pending", rationale: "A person decides.", at }], stages: [{ id: "plan", status: "done" }] })!,
    normalizeManifest({ ticket: "N-2", startedAt: at, stages: [{ id: "review", repo: "api", status: "failed", failures: 2, note: "tests fail" }] })!,
    normalizeManifest({ ticket: "N-3", startedAt: at, done: true, error: "Plan rejected by sam", finishedAt: at })!,
    normalizeManifest({ ticket: "N-4", startedAt: at, done: true, finishedAt: at, prs: [{ url: "https://x/4", state: "merged" }] })!,
    normalizeManifest({ ticket: "N-5", startedAt: at, stages: [{ id: "build", status: "running" }] })!,
  ];
  const runs = [{ id: "r", ticket: "N-5", status: "succeeded", costUsd: 6, startedAt: at }] as any;
  const board = buildBoard(cfg, true, ms, runs);
  const notices = factoryNotices(cfg, ms, board.items, runs, Date.parse(at));
  assert.deepEqual(notices.map((n) => [n.ticket, n.event]).sort(), [["N-1", "gate-waiting"], ["N-2", "stage-failed"], ["N-3", "stopped"], ["N-4", "merged"], ["N-5", "budget"]]);
  assert.match(notices.find((n) => n.event === "gate-waiting")!.text, /N-1 \(Plan me\) waits for a person at the plan gate/);
  assert.match(notices.find((n) => n.event === "stage-failed")!.text, /Reviewing \(api\) has failed 2 times: tests fail/);
  // The same state again is the same notice; another failure is a new one.
  assert.deepEqual(factoryNotices(cfg, ms, board.items, runs, Date.parse(at)).map((n) => n.key), notices.map((n) => n.key));
});

test("the audit log: gate decisions, assessments and ratings in time order, and as CSV that a spreadsheet won't run", () => {
  const m = normalizeManifest({ ticket: "A-1", startedAt: at,
    gates: [{ id: "plan", mode: "human", decision: "approved", by: "sam", rationale: '=HYPERLINK("x"), "quoted"', at: "2026-10-27T10:02:00.000Z" }],
    assessments: [{ gate: "plan", level: "low", rules: [], concerns: [], blockers: ["No judgement"], action: "ask", reason: "r", at: "2026-10-27T10:01:00.000Z" }],
    ratings: [{ assessmentAt: "2026-10-27T10:01:00.000Z", gate: "plan", level: "low", rating: "right", by: "ann", at: "2026-10-27T10:03:00.000Z" }] })!;
  const rows = auditRows([m, normalizeManifest({ ticket: "B-1", startedAt: at, gates: [{ id: "spec", decision: "approved", by: "auto", at }] })!], "a-1");
  assert.deepEqual(rows.map((r) => [r.kind, r.decision, r.by]), [["assessment", "ask", null], ["gate", "approved", "sam"], ["rating", "right", "ann"]]);
  assert.match(rows[0].rationale!, /Blockers: No judgement/);
  const csv = auditCsv(rows);
  assert.ok(csv.startsWith("at,ticket,kind,gate,decision,by,mode,risk,override,sha,rationale\r\n"));
  assert.ok(csv.includes(`"'=HYPERLINK(""x""), ""quoted"""`), "formula neutralised and quotes doubled");
});

test("relatedPrs: a PR's factory ticket and its other PRs, this one marked", () => {
  const m = normalizeManifest({ ticket: "R-9", title: "Retries", startedAt: at, prs: [{ url: "https://github.com/a/api/pull/1", repo: "api", number: 1 }, { url: "https://github.com/a/web/pull/2", repo: "web", number: 2 }] })!;
  const r = relatedPrs([m], "https://github.com/A/Web/pull/2/")!;
  assert.equal(r.ticket, "R-9");
  assert.deepEqual(r.prs.map((p) => [p.repo, p.current]), [["api", false], ["web", true]]);
  assert.equal(relatedPrs([m], "https://github.com/a/other/pull/3"), null);
});

test("notifications are read and checked: an http(s) address or an env variable; no events listed means the ones that need someone, an empty list mutes", () => {
  const c = normalizeFactoryConfig({ notifications: { inbox: false, webhooks: [
    { url: " https://hooks.example/x " }, { url: "ftp://nope" }, { url: "http://host:badport" }, { url: "https://h/y", events: ["merged", "nope", "merged"] },
    { env: "FACTORY_SLACK", events: [] }, { env: "not a name" }] } });
  assert.deepEqual(c.notifications, { inbox: false, webhooks: [
    { url: "https://hooks.example/x", env: null, events: ["gate-waiting", "stage-failed", "budget", "stopped"] },
    { url: "https://h/y", env: null, events: ["merged"] },
    { url: null, env: "FACTORY_SLACK", events: [] }] });
  assert.equal(normalizeFactoryConfig({}).notifications.inbox, true);
  assert.equal(webhookTarget(c.notifications.webhooks[2], { FACTORY_SLACK: "https://hooks.slack.com/services/T/B/x" }), "https://hooks.slack.com/services/T/B/x");
  assert.equal(webhookTarget(c.notifications.webhooks[2], {}), null);
});

test("a read-only viewer sees only a webhook's host; a stage that failed twice and passed since isn't a notice", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "factory.json"), JSON.stringify({ notifications: { webhooks: [{ url: "https://hooks.slack.com/services/T0/B0/secret" }] } }));
  assert.equal(factoryConfigState(false, dir).config.notifications.webhooks[0].url, "https://hooks.slack.com/…");
  assert.equal(factoryConfigState(true, dir).config.notifications.webhooks[0].url, "https://hooks.slack.com/services/T0/B0/secret");
  const cfg = normalizeFactoryConfig({ enabled: true });
  const ms = [normalizeManifest({ ticket: "F-1", startedAt: at, stages: [{ id: "build", repo: "api", status: "failed", failures: 2 }, { id: "build", repo: "api", status: "done", failures: 2 }] })!];
  assert.deepEqual(factoryNotices(cfg, ms, buildBoard(cfg, true, ms, []).items, []), []);
});

// validate.mjs keeps its own copy of the notice events (it runs without the engine): they must agree.
test("validate.mjs knows every notice event", (t) => {
  const script = path.join(import.meta.dirname, "..", "..", "..", "scripts", "validate.mjs");
  if (!fs.existsSync(script)) return t.skip("no plugin scripts next to this engine");
  const src = fs.readFileSync(script, "utf-8");
  const list = /const NOTICE_EVENTS = (\[[^\]]*\])/.exec(src);
  assert.ok(list, "validate.mjs has its NOTICE_EVENTS");
  assert.deepEqual(JSON.parse(list![1]), NOTICE_EVENTS);
});

// spec-check.mjs: a ticket's spec readiness, scored on what any good spec has, under the team's weights and levels.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSpec, runChecks } from "../spec-check.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spec-check.mjs");

const GOOD = {
  id: "ENG-7",
  title: "Retry failed webhook deliveries",
  description: [
    "## Problem",
    "Merchants lose orders when a webhook delivery fails once: we never retry, so the order sits unpaid.",
    "",
    "## Outcome",
    "A failed delivery is retried with backoff, so that a short outage no longer loses orders.",
    "",
    "## Acceptance criteria",
    "- Given a 500 from the merchant, when the delivery fails, then it is retried within 1 minute",
    "- Retries stop after 5 attempts and the delivery is marked failed",
    "- The dashboard shows the attempt count",
    "",
    "## Out of scope",
    "- Retrying deliveries that failed before this ships",
    "",
    "## Constraints",
    "- No more than 10 retries per second per merchant (rate limit)",
    "",
    "## How to test",
    "Point a merchant at a stub that fails twice, then succeeds.",
  ].join("\n"),
  comments: [{ body: "Looks good, go ahead." }],
};

test("a complete spec scores every check and is ready", () => {
  const r = checkSpec(GOOD, { repos: [{ name: "webhooks" }, { name: "dashboard" }] });
  assert.deepEqual(r.checks.filter((c) => c.score < 1).map((c) => c.id), []);
  assert.equal(r.score, 100);
  assert.equal(r.level, "ready");
  assert.match(r.checks.find((c) => c.id === "affected").finding, /dashboard/);
  assert.match(r.checks.find((c) => c.id === "criteria").finding, /3 acceptance criteria, 3 testable/);
});

test("a vague ticket is not ready, and each finding says what's missing", () => {
  const r = checkSpec({ title: "Make retries better", description: "Retries should work better. TBD which service." }, { repos: [{ name: "webhooks" }] });
  assert.equal(r.level, "not-ready");
  assert.ok(r.score < 50, `score ${r.score}`);
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(by.criteria.score, 0);
  assert.equal(by.questions.score, 0);
  assert.match(by.questions.finding, /TBD/);
  assert.equal(by.outcome.score, 0.5);
});

test("vague acceptance criteria count half; a question in the newest comment counts half", () => {
  const t = { title: "x", description: "## Acceptance criteria\n- It works well\n- Nice and fast\n- Returns 200", comments: [{ body: "Should this cover refunds too?" }] };
  const c = runChecks(t);
  assert.equal(c.criteria.score, 0.5);
  assert.match(c.criteria.finding, /only 1 read as testable/);
  assert.equal(c.questions.score, 0.5);
  assert.match(c.questions.finding, /newest comment/);
});

test("the team's weights, levels and the agent's overrides apply", () => {
  const policy = { spec: { readyAt: 95, needsWorkAt: 70, minScore: 60, weights: { scope: 0, constraints: 0 } } };
  const t = { ...GOOD, description: GOOD.description.replace(/## Out of scope[\s\S]*?## Constraints\n- [^\n]*\n/, "") };
  const r = checkSpec(t, { repos: [{ name: "dashboard" }], policy });
  assert.equal(r.score, 100, "scope and constraints are off");
  assert.deepEqual([r.readyAt, r.needsWorkAt, r.minScore], [95, 70, 60]);
  const o = checkSpec(GOOD, { repos: [{ name: "dashboard" }], policy, overrides: { criteria: { score: 0.5, reason: "AC 1 and 2 disagree on the cap" }, verify: { score: 0 } } });
  const ac = o.checks.find((c) => c.id === "criteria");
  assert.deepEqual([ac.score, ac.override], [0.5, { from: 1, reason: "AC 1 and 2 disagree on the cap" }]);
  assert.equal(o.checks.find((c) => c.id === "verify").score, 1, "an override without a reason is ignored");
  assert.equal(o.level, "needs-work");
});

test("the CLI reads the team's policy and repos, and --ticket records the result for the Factory board", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "spec-check-"));
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "dashboard", relativePath: "dashboard" }] }));
  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "factory.json"), JSON.stringify({ spec: { readyAt: 90 } }));
  const file = path.join(ws, "ticket.json");
  fs.writeFileSync(file, JSON.stringify(GOOD));
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, file, "--root", ws, "--ticket", "ENG-7", "--json"], { encoding: "utf-8" }));
  assert.deepEqual([out.score, out.readyAt, out.level], [100, 90, "ready"]);
  const m = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "ledger", "factory", "ENG-7.json"), "utf-8"));
  assert.deepEqual([m.spec.score, m.spec.level, m.spec.checks.length], [100, "ready", 8]);
  const text = execFileSync(process.execPath, [SCRIPT, "-", "--root", ws], { encoding: "utf-8", input: JSON.stringify({ title: "x" }) });
  assert.match(text, /^Spec readiness: \d+\/100 \(not ready; ready at 90; no minimum for unattended runs\)/);
  assert.match(text, /✗ Acceptance criteria: No acceptance criteria\./);
});

test("open questions: 'None.' counts as none, '??' as a blank, and the align comment settles rather than asks", () => {
  assert.equal(runChecks({ description: "## Open questions\n- None.\n" }).questions.score, 1);
  assert.equal(runChecks({ description: "## Open questions\n- None at this time\n" }).questions.score, 1);
  assert.equal(runChecks({ description: "## Open questions\n- Which queue?\n" }).questions.score, 0);
  assert.equal(runChecks({ description: "Retry count: ??" }).questions.score, 0);
  const align = { id: "c2", body: "<!-- GENERATED-BY-ALIGN-SKILL -->\nAgreed. Any last concerns?" };
  // Through JSON, so planComment/alignComment aren't the same objects as the comments[] entries.
  const t = JSON.parse(JSON.stringify({ description: "x", comments: [{ id: "c1", body: "ok" }, align], alignComment: align }));
  assert.equal(runChecks(t).questions.score, 1);
});

test("a repo named like a common word counts only when it's written as the repo", () => {
  const repos = [{ name: "api" }, { name: "webhooks" }];
  assert.equal(runChecks({ description: "When the API returns 500 we fail." }, { repos }).affected.score, 0);
  assert.match(runChecks({ description: "Change the `api` repo's retry policy." }, { repos }).affected.finding, /Names api/);
  assert.match(runChecks({ description: "Change the api service." }, { repos }).affected.finding, /Names api/);
  assert.match(runChecks({ description: "Retry in Webhooks." }, { repos }).affected.finding, /Names webhooks/);
});

test("the text output says when a score is below the team's minimum for unattended runs", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "spec-check-min-"));
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "factory.json"), JSON.stringify({ spec: { minScore: 60 } }));
  const text = execFileSync(process.execPath, [SCRIPT, "-", "--root", ws], { encoding: "utf-8", input: JSON.stringify({ title: "x" }) });
  assert.match(text, /unattended runs need 60: BELOW IT\)/);
});

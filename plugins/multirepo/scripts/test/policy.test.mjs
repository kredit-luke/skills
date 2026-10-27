// The factory policy driving the pipeline: factory.mjs decide / wip, and security-scan.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, normalizePolicy, stageOn, wip } from "../factory.mjs";
import { changedFiles, runScanner, scanSecrets, securityScan } from "../security-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const on = (gates, extra = {}) => ({ enabled: true, gates, ...extra });
const spec = (score, level, minScore = null) => ({ score, level, readyAt: 80, needsWorkAt: 50, minScore });

test("decide: no policy on means the skill's own rules; off gates skip; merge always hands off", () => {
  assert.equal(decide(null, null, "plan").action, "own-rules");
  assert.equal(decide({ enabled: false, gates: { plan: "auto" } }, null, "plan").action, "own-rules");
  assert.equal(decide(on({ plan: "off" }), null, "plan").action, "skip");
  assert.equal(decide(on({ merge: "auto" }), null, "merge").action, "handoff");
  assert.throws(() => decide(on({}), null, "deploy"), /--gate must be/);
});

test("decide: a person's gate asks when the run can ask, else stops; the Approver's is a person's for now", () => {
  assert.equal(decide(on({ plan: "human" }), null, "plan").action, "ask");
  const auto = decide(on({ plan: "human" }), null, "plan", { run: "autonomous" });
  assert.equal(auto.action, "stop");
  assert.match(auto.reason, /waiting at the plan gate/);
  assert.equal(decide(on({ plan: "human" }), null, "plan", { run: "autonomous", canAsk: true }).action, "ask", "a dashboard run can ask through a question card");
  assert.match(decide(on({ prePr: "approver" }), null, "prePr").reason, /Approver isn't running yet/);
  assert.equal(on({}).gates.plan, undefined);
  assert.equal(decide(on({}), null, "plan").mode, "human", "a gate the policy doesn't name is a person's");
});

test("decide: automatic gates pass on their checks", () => {
  const p = on({ spec: "auto", plan: "auto", prePr: "auto" });
  assert.equal(decide(p, { spec: spec(85, "ready") }, "spec").action, "pass");
  assert.equal(decide(p, { spec: spec(60, "needs-work") }, "spec").action, "ask");
  assert.equal(decide(p, { spec: spec(60, "needs-work") }, "spec", { run: "autonomous" }).action, "stop");
  assert.match(decide(p, {}, "spec").reason, /no spec score yet/);
  assert.equal(decide(p, null, "plan").action, "pass");
  const rows = (...r) => ({ stages: r.map(([id, repo, status]) => ({ id, repo, status })) });
  const built = [["build", "api", "done"], ["build", "web", "done"]];
  assert.match(decide(p, rows(), "prePr").reason, /no repo's build is recorded/);
  // Every repo that was built needs a passed review: one missing, one failed.
  assert.match(decide(p, rows(...built, ["review", "api", "done"]), "prePr").reason, /review hasn't passed for web \(not run\)/);
  assert.match(decide(p, rows(...built, ["review", "api", "done"], ["review", "web", "failed"]), "prePr").reason, /web \(failed\)/);
  const reviewed = [...built, ["review", "api", "done"], ["review", "web", "done"]];
  assert.match(decide(p, rows(...reviewed, ["security", "api", "done"]), "prePr").reason, /security stage hasn't passed for web \(not run\)/);
  assert.match(decide(p, rows(...reviewed, ["security", "api", "done"], ["security", "web", "running"]), "prePr").reason, /web \(running\)/);
  // The latest row per repo counts: failed, then done.
  assert.equal(decide(p, rows(...reviewed, ["security", "api", "failed"], ["security", "api", "done"], ["security", "web", "done"]), "prePr").action, "pass");
  // Without build rows, the manifest's repos are the ones that need it.
  assert.match(decide(p, { repos: ["api"], stages: [] }, "prePr").reason, /review hasn't passed for api/);
  const noSec = { ...p, stages: [{ id: "security", on: false }] };
  assert.equal(stageOn(noSec, "security"), false);
  assert.equal(decide(noSec, rows(...reviewed), "prePr").action, "pass");
});

test("decide: an unattended run below the team's minimum spec score stops whatever the spec gate is", () => {
  const r = decide(on({ spec: "off" }), { spec: spec(40, "not-ready", 60) }, "spec", { run: "autonomous" });
  assert.equal(r.action, "stop");
  assert.match(r.reason, /below the team's minimum/);
  assert.equal(decide(on({ spec: "off" }), { spec: spec(40, "not-ready", 60) }, "spec").action, "skip", "interactive runs aren't stopped by it");
});

test("wip counts other started tickets that aren't done, against the limit", () => {
  const ws = tmp("wip-");
  const dir = path.join(ws, ".claude", "ledger", "factory");
  fs.mkdirSync(dir, { recursive: true });
  const put = (t, m) => fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify({ ticket: t, stages: [], gates: [], ...m }));
  put("ENG-1", { stages: [{ id: "build" }] });
  put("ENG-2", { gates: [{ id: "spec" }] });
  put("ENG-3", { stages: [{ id: "build" }], done: true });
  put("ENG-4", {});
  put("ENG-9", { stages: [{ id: "plan" }] });
  const r = wip(ws, "ENG-10", { enabled: true, limits: { wip: 2 } });
  assert.deepEqual([r.inFlight.sort(), r.limit, r.self, r.ok], [["ENG-1", "ENG-2", "ENG-9"], 2, false, false]);
  // A ticket already in flight carries on, even when the others fill the limit (the limit was lowered).
  const own = wip(ws, "eng-9", { enabled: true, limits: { wip: 2 } });
  assert.deepEqual([own.inFlight.sort(), own.self, own.ok], [["ENG-1", "ENG-2"], true, true]);
  assert.equal(wip(ws, "ENG-9", { enabled: false, limits: { wip: 2 } }).ok, true, "no limit without a policy on");
});

function repo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  g("checkout", "-q", "-b", "feature/x");
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return dir;
}

test("a scanner passes on exit 0, finds on any other exit, and is skipped when it isn't installed", () => {
  const dir = repo(tmp("scan-"));
  const s = (command) => runScanner({ name: "x", command, failOn: "high" }, dir);
  assert.equal(s(`node -e "process.exit(0)"`).status, "passed");
  const found = s(`node -e "console.log('1 high severity vulnerability'); process.exit(1)"`);
  assert.deepEqual([found.status, found.severity], ["found", "high"]);
  assert.match(found.detail, /1 high severity vulnerability/);
  assert.equal(s("definitely-not-a-scanner-xyz --audit").status, "skipped");
});

test("the security stage runs the scanners that apply per repo, fails at the policy's severity, and records it", () => {
  const ws = tmp("secws-");
  fs.mkdirSync(path.join(ws, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "api", relativePath: "api" }, { name: "web", relativePath: "web" }] }));
  repo(path.join(ws, "api"), { "package-lock.json": "{}" });
  repo(path.join(ws, "web"), { "new.ts": "export const a = 1;\n" });
  const policy = { enabled: true, security: { failOn: "high", secretScan: false, scanners: [
    { name: "audit", command: `node -e "process.exit(1)"`, when: "package-lock.json", failOn: "high" },
    { name: "lint-sec", command: `node -e "process.exit(2)"`, when: null, failOn: "low" },
  ] } };
  const r = securityScan({ root: ws, policy });
  const by = Object.fromEntries(r.repos.map((x) => [x.repo, x]));
  assert.deepEqual(r.failed, ["api"]);
  assert.deepEqual(by.api.scanners.map((s) => [s.name, s.status]), [["audit", "found"], ["lint-sec", "found"]]);
  assert.match(by.api.note, /Fails at high: audit \(high\)/);
  assert.deepEqual(by.web.scanners.map((s) => s.name), ["lint-sec"], "audit only where its file is");
  assert.equal(by.web.status, "done", "a low finding doesn't fail at high");
  assert.equal(by.web.secrets.status, "skipped");
  assert.deepEqual(changedFiles(path.join(ws, "web"), "main"), ["new.ts"]);

  fs.writeFileSync(path.join(ws, ".claude", "dashboard", "factory.json"), JSON.stringify(policy));
  const cli = spawnSync(process.execPath, [path.join(HERE, "..", "security-scan.mjs"), "--root", ws, "--ticket", "ENG-5"], { encoding: "utf-8" });
  assert.equal(cli.status, 1, "a failing repo exits 1");
  assert.match(cli.stdout, /api: FAILED/);
  const m = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "ledger", "factory", "ENG-5.json"), "utf-8"));
  assert.deepEqual(m.stages.map((s) => [s.id, s.repo, s.status]), [["security", "api", "failed"], ["security", "web", "done"]]);
});

test("the policy is read by the dashboard's rules: clamped WIP, default scanners, unknown modes", () => {
  const p = normalizePolicy({ enabled: true, limits: { wip: 0 }, gates: { plan: "sometimes" }, security: { failOn: "urgent" } });
  assert.deepEqual([p.limits.wip, p.gates.plan, p.security.failOn], [1, "human", "high"]);
  assert.deepEqual(normalizePolicy(null).security.scanners.map((s) => s.when), ["package-lock.json", "requirements.txt", "go.mod"]);
  assert.equal(normalizePolicy({ limits: { wip: 2.5 } }).limits.wip, 3);
});

test("a scanner that can't finish fails closed; output mentioning 'not found' is still a finding", () => {
  const dir = repo(tmp("scan2-"));
  const timedOut = runScanner({ name: "slow", command: "x", failOn: "high" }, dir, () => ({ error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), status: null, stdout: "", stderr: "" }));
  assert.deepEqual([timedOut.status, timedOut.severity], ["error", "high"]);
  const notFoundText = runScanner({ name: "x", command: `node -e "console.log('package not found: foo'); process.exit(1)"`, failOn: "high" }, dir);
  assert.equal(notFoundText.status, "found");
  // A scan that errors fails the repo's stage.
  const ws = tmp("secws2-");
  fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "api", relativePath: "api" }] }));
  repo(path.join(ws, "api"));
  const r = securityScan({ root: ws, policy: { security: { secretScan: false, scanners: [{ name: "slow", command: "x" }] } },
    run: () => ({ error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), status: null, stdout: "", stderr: "" }) });
  assert.deepEqual(r.failed, ["api"]);
  assert.match(r.repos[0].note, /slow \(couldn't finish\)/);
});

test("secret scanning: one gitleaks run over the changed files; older gitleaks is reported, not trusted", () => {
  const dir = repo(tmp("leaks-"), { "clé config.env": "KEY=x\n", "b.ts": "1" });
  assert.deepEqual(changedFiles(dir, "main").sort(), ["b.ts", "clé config.env"]);
  const calls = [];
  const fake = (version, dirOk, scanStatus) => (cmd, args, opts) => {
    calls.push(args);
    if (args[0] === "version") return { status: 0, stdout: version };
    if (args[1] === "--help") return dirOk ? { status: 0, stdout: "" } : { status: 1, stdout: "", stderr: 'Error: unknown command "dir" for "gitleaks"' };
    const report = args[args.indexOf("--report-path") + 1];
    fs.writeFileSync(report, JSON.stringify(scanStatus === 3 ? [{ File: path.join(args[1], "clé config.env") }] : []));
    return { status: scanStatus, stdout: "", stderr: scanStatus === 1 ? "boom" : "" };
  };
  assert.match(scanSecrets(dir, ["b.ts"], fake("8.18.0", false, 0)).detail, /older than 8\.19/);
  calls.length = 0;
  const found = scanSecrets(dir, ["b.ts", "clé config.env"], fake("8.21.0", true, 3));
  assert.deepEqual([found.status, found.detail], ["found", "Possible secrets in clé config.env."]);
  assert.equal(calls.filter((a) => a[0] === "dir" && a[1] !== "--help").length, 1, "one gitleaks run for all the files");
  assert.equal(scanSecrets(dir, ["b.ts"], fake("8.21.0", true, 0)).status, "passed");
  assert.equal(scanSecrets(dir, ["b.ts"], fake("8.21.0", true, 1)).status, "error");
});

test("Copilot on #113: errors fail at any threshold, a broken gitleaks isn't 'not installed', names kept exactly", () => {
  const ws = tmp("secws3-");
  fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({ repos: [{ name: "api", relativePath: "api" }] }));
  repo(path.join(ws, "api"));
  const timeout = () => ({ error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), status: null, stdout: "", stderr: "" });
  const strict = securityScan({ root: ws, policy: { security: { failOn: "critical", secretScan: false, scanners: [{ name: "slow", command: "x", failOn: "low" }] } }, run: timeout });
  assert.deepEqual(strict.failed, ["api"], "a scan that didn't finish fails even below the threshold");

  const eacces = () => ({ error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }), status: null, stdout: "", stderr: "" });
  assert.equal(scanSecrets(ws, ["a"], eacces).status, "error");
  const missing = () => ({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), status: null });
  assert.equal(scanSecrets(ws, ["a"], missing).status, "skipped");

  // Tabs and quotes can't be in Windows file names; elsewhere they're names git would C-quote.
  const odd = process.platform === "win32" ? [" lead.env", "clé space.env"] : [" lead.env", "tab\tname.env", 'quo"te.env', "clé.env"];
  const dir = repo(tmp("names-"), Object.fromEntries(odd.map((f) => [f, "x"])));
  assert.deepEqual(changedFiles(dir, "main").sort(), [...odd].sort());
});

test("pre-PR: a failed build blocks, and a scan older than the last change doesn't count", () => {
  const p = on({ prePr: "auto" });
  const t = (n) => `2026-10-27T10:0${n}:00.000Z`;
  const row = (id, repo, status, end) => ({ id, repo, status, endedAt: end });
  const ok = [row("build", "api", "done", t(1)), row("review", "api", "done", t(2)), row("security", "api", "done", t(3))];
  assert.equal(decide(p, { stages: ok }, "prePr").action, "pass");
  assert.match(decide(p, { stages: [...ok, row("build", "web", "failed", t(1))] }, "prePr").reason, /build hasn't finished for web \(failed\)/);
  // A second-opinion review after the scan: scan again.
  assert.match(decide(p, { stages: [row("build", "api", "done", t(1)), row("security", "api", "done", t(3)), row("review", "api", "done", t(4))] }, "prePr").reason, /api \(older than the last change\)/);
});

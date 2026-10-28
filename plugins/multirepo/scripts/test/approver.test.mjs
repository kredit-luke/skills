// approver.mjs: the risk rules, the conditions for approving without a person, and what the pipeline does next.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assess, dependencies, evaluateRules, globRegex, isBot, prBlockers, repoChanges, sampledFor } from "../approver.mjs";
import { normalizePolicy } from "../factory.mjs";

const AP = normalizePolicy({}).approver;

test("globs: ** spans folders, * stays in one, {a,b} picks", () => {
  const m = (g, p) => globRegex(g).test(p);
  assert.ok(m("**/migrations/**", "db/migrations/001.sql"));
  assert.ok(m("**/migrations/**", "migrations/001.sql"), "** at the start matches no folder too");
  assert.ok(m("**/*.lock", "yarn.lock"));
  assert.ok(m("**/*.lock", "a/b/Cargo.lock"));
  assert.ok(m("infra/**", "infra/main.tf"));
  assert.ok(!m("infra/**", "src/infra/main.tf"));
  assert.ok(m("src/*.ts", "src/a.ts"));
  assert.ok(!m("src/*.ts", "src/x/a.ts"));
  assert.ok(m("src/{auth,login}/*.ts", "src/login/a.ts"));
  assert.ok(m(".github/workflows/**", ".github/workflows/ci.yml"));
  assert.ok(!m("a.b", "aXb"), "dots are literal");
});

test("dependencies are read from the usual manifests", () => {
  assert.deepEqual([...dependencies("web/package.json", '{"dependencies":{"a":"1"},"devDependencies":{"b":"2"}}')], ["a", "b"]);
  assert.deepEqual([...dependencies("requirements-dev.txt", "# c\nrequests>=2\n-r base.txt\nDjango[argon2]==5\n")], ["requests", "django"]);
  assert.deepEqual([...dependencies("go.mod", "module x\nrequire golang.org/x/net v1\nrequire (\n  github.com/a/b v2 // indirect\n)\n")], ["golang.org/x/net", "github.com/a/b"]);
  assert.deepEqual([...dependencies("Api.csproj", '<PackageReference Include="Serilog" Version="3" />')], ["serilog"]);
  assert.equal(dependencies("src/index.ts", "x"), null);
  assert.deepEqual([...dependencies("package.json", "not json")], []);
});

test("the rules: paths, labels and a failed scan are high; size, repos and new dependencies medium", () => {
  const files = (n, lines = 1) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, lines }));
  assert.equal(evaluateRules(AP, { repos: [{ name: "api", files: files(3) }] }).level, null, "nothing trips: could be low");
  const big = evaluateRules(AP, { repos: [{ name: "api", files: files(21, 30) }, { name: "web", files: files(1) }] });
  assert.equal(big.level, "medium");
  assert.deepEqual(big.rules.map((r) => r.id), ["files", "lines", "repos"]);
  assert.deepEqual(big.stats, { files: 22, lines: 631, repos: 2 });
  const risky = evaluateRules(AP, {
    repos: [{ name: "api", files: [{ path: "db/migrations/1.sql", lines: 3 }], newDeps: [{ file: "package.json", name: "left-pad" }] }],
    labels: ["Security"], securityFailed: ["api"],
  });
  assert.equal(risky.level, "high");
  assert.deepEqual(risky.rules.map((r) => r.id), ["path", "label", "security", "dependency"]);
  assert.match(risky.rules[0].detail, /db\/migrations\/1\.sql matches \*\*\/migrations\/\*\*/);
});

test("a PR's conditions: checks, review bots, threads, drafts and the Approver's own PRs", () => {
  const p = (over = {}) => normalizePolicy({ reviewers: { bots: ["copilot"] }, ...over });
  const pr = (over = {}) => ({ url: "https://github.com/acme/api/pull/7", author: { login: "sam" }, isDraft: false, unresolved: 0,
    statusCheckRollup: [{ name: "build", conclusion: "SUCCESS" }, { context: "lint", state: "SUCCESS" }],
    reviews: [{ author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED" }], ...over });
  assert.deepEqual(prBlockers(p(), pr(), "approver-bot"), []);
  assert.match(prBlockers(p(), pr({ statusCheckRollup: [{ name: "build", conclusion: "FAILURE" }] }), null)[0], /1 check not green \(build\)/);
  const req = p({ requiredChecks: ["build", "e2e"] });
  assert.deepEqual(prBlockers(req, pr({ statusCheckRollup: [{ name: "build", conclusion: null, status: "IN_PROGRESS" }] }), null),
    ["acme/api/pull/7: required check build is still running", "acme/api/pull/7: required check e2e hasn't run"]);
  assert.match(prBlockers(p(), pr({ reviews: [] }), null)[0], /copilot hasn't reviewed/);
  assert.match(prBlockers(p(), pr({ reviews: [{ author: { login: "Copilot" }, state: "CHANGES_REQUESTED" }] }), null)[0], /requested changes/);
  assert.match(prBlockers(p(), pr({ unresolved: 2 }), null)[0], /2 unresolved review threads/);
  assert.deepEqual(prBlockers(p({ reviewers: { bots: ["copilot"], noUnresolved: false } }), pr({ unresolved: 2 }), null), []);
  assert.match(prBlockers(p(), pr({ isDraft: true }), null)[0], /is a draft/);
  assert.match(prBlockers(p(), pr({ author: { login: "Approver-Bot" } }), "approver-bot")[0], /can't approve its own PR/);
});

const RULES_NONE = { level: null, rules: [], stats: { files: 1, lines: 2, repos: 1 } };
const policy = (approver, gates = { plan: "approver", merge: "approver" }) => ({ enabled: true, gates, approver: { enabled: true, ...approver } });
const reviewed = { stages: [{ id: "review", repo: "api", status: "done" }] };
const goodPr = { url: "https://github.com/acme/api/pull/7", headRefOid: "abc1234ffff", author: { login: "sam" }, isDraft: false, unresolved: 0, statusCheckRollup: [], reviews: [] };

test("assess: advisory unless enforced, and says what it would have done", () => {
  const a = assess(policy({}), reviewed, "merge", { rules: RULES_NONE, risk: "low", rationale: "Small.", prs: [goodPr], judgedShas: ["abc1234"], ghUser: "sam" });
  assert.equal(a.level, "low");
  assert.equal(a.wouldApprove, true);
  assert.equal(a.enforced, false);
  assert.equal(a.action, "handoff");
  assert.match(a.reason, /Advisory: the Approver would have approved it/);
  const plan = assess(policy({}), null, "plan", { rules: RULES_NONE, risk: "medium", run: "autonomous" });
  assert.equal(plan.action, "stop");
  assert.match(plan.reason, /wouldn't approve it \(The Approver rated it medium risk\)/);
});

test("assess: the rules outrank the judgement, and no judgement is medium", () => {
  const tripped = { level: "high", rules: [{ id: "path", level: "high", detail: "db/migrations/1.sql matches **/migrations/**" }], stats: null };
  const a = assess(policy({}), reviewed, "merge", { rules: tripped, risk: "low", prs: [goodPr], judgedShas: ["abc1234"] });
  assert.equal(a.level, "high");
  assert.match(a.blockers[0], /The risk rules say high: db\/migrations/);
  assert.equal(assess(policy({}), null, "plan", { rules: RULES_NONE }).level, "medium");
});

test("assess: enforced, it passes only as its identity, with every condition met, outside the sample", () => {
  const enforce = policy({ enforce: true, identity: "approver-bot", mergeAction: "auto-merge", samplingPct: 10 });
  const pass = assess(enforce, reviewed, "merge", { rules: RULES_NONE, risk: "low", prs: [goodPr], judgedShas: ["abc1234"], ghUser: "Approver-Bot", sampleKey: "k0" });
  assert.equal(pass.action, "pass");
  assert.equal(pass.enforced, true);
  assert.equal(pass.mergeAction, "auto-merge");
  const sampled = assess(enforce, reviewed, "merge", { rules: RULES_NONE, risk: "low", prs: [goodPr], judgedShas: ["abc1234"], ghUser: "approver-bot", sampleKey: "k1" });
  assert.equal(sampled.sampled, true);
  assert.equal(sampled.wouldApprove, true);
  assert.equal(sampled.action, "handoff");
  assert.match(sampled.reason, /Sampled for a person \(10%/);
  const asSam = assess(enforce, reviewed, "merge", { rules: RULES_NONE, risk: "low", prs: [goodPr], judgedShas: ["abc1234"], ghUser: "sam", sampleKey: "k0" });
  assert.equal(asSam.action, "handoff");
  assert.match(asSam.blockers[0], /runs as sam, but the Approver acts only as approver-bot/);
  const noId = assess(policy({ enforce: true }), reviewed, "plan", { rules: RULES_NONE, risk: "low", ghUser: "sam", canAsk: true });
  assert.equal(noId.action, "ask");
  assert.match(noId.blockers[0], /names no identity/);
  // The gate must be the Approver's for it to act there.
  assert.equal(assess(policy({ enforce: true, identity: "approver-bot" }, { plan: "human" }), null, "plan", { rules: RULES_NONE, risk: "low", ghUser: "approver-bot" }).enforced, false);
  // The merge gate needs an open PR and the pipeline's review.
  const none = assess(enforce, { stages: [{ id: "review", repo: "api", status: "failed" }] }, "merge", { rules: RULES_NONE, risk: "low", prs: [], ghUser: "approver-bot", sampleKey: "k0" });
  assert.deepEqual(none.blockers, ["The pipeline's review hasn't passed for api", "There's no open PR to approve"]);
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approver-"));
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "package.json"), '{"dependencies":{"a":"1"}}\n');
  fs.writeFileSync(path.join(dir, "keep.ts"), Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join(""));
  g("add", "."); g("commit", "-qm", "base");
  g("checkout", "-qb", "feat");
  return { dir, g };
}

test("repoChanges counts committed, uncommitted and untracked changes since the default branch", () => {
  const { dir, g } = repo();
  fs.appendFileSync(path.join(dir, "keep.ts"), "line 10\nline 11\n");
  g("commit", "-qam", "more");
  g("mv", "keep.ts", "renamed.ts");
  fs.mkdirSync(path.join(dir, "db", "migrations"), { recursive: true });
  fs.writeFileSync(path.join(dir, "db", "migrations", "1.sql"), "create\n");
  const { mergeBase, files } = repoChanges(dir, "main");
  assert.ok(mergeBase);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.lines]));
  assert.equal(byPath["renamed.ts"], 2, "a rename is its new name, counting the lines it changed");
  assert.ok(!("keep.ts" in byPath));
  assert.equal(byPath["db/migrations/1.sql"], 1, "untracked files count");
});

test("the CLI: rules over a repo's changes, and an advisory assessment recorded with the gate left to a person", () => {
  const { dir, g } = repo();
  fs.mkdirSync(path.join(dir, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "dashboard", "factory.json"), JSON.stringify({ enabled: true, gates: { plan: "approver" }, approver: { enabled: true } }));
  fs.writeFileSync(path.join(dir, "package.json"), '{"dependencies":{"a":"1","b":"2"}}\n');
  g("commit", "-qam", "dep");
  const script = fileURLToPath(new URL("../approver.mjs", import.meta.url));
  const run = (...a) => JSON.parse(execFileSync(process.execPath, [script, ...a], { cwd: dir, encoding: "utf-8", env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" } }));
  const rules = run("rules", "--root", dir);
  assert.equal(rules.level, "medium");
  assert.deepEqual(rules.rules.map((r) => r.detail), ["New dependency b (package.json)"]);
  const a = run("assess", "--root", dir, "--ticket", "ENG-5", "--gate", "plan", "--risk", "low", "--rationale", "Tiny plan.", "--concern", "one; two", "--concern", "three", "--run", "autonomous");
  assert.equal(a.enforced, false);
  assert.equal(a.wouldApprove, true, "before building, only labels are rules: the plan is judged");
  assert.equal(a.action, "stop");
  assert.deepEqual(a.concerns, ["one", "two", "three"], "a repeated --concern keeps each");
  const m = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "ledger", "factory", "ENG-5.json"), "utf-8"));
  assert.equal(m.assessments.length, 1);
  assert.equal(m.assessments[0].level, "low");
  assert.deepEqual(m.gates.map((x) => [x.id, x.decision, x.mode, x.risk]), [["plan", "pending", "human", "low"]]);
});

test("the review's fixes: exact bots, a check's newest run, closed PRs, no review at all, unknown changes, a steady sample", () => {
  assert.ok(isBot("copilot-pull-request-reviewer", "copilot"));
  assert.ok(isBot("coderabbitai[bot]", "coderabbitai"));
  assert.ok(!isBot("copilot-fan", "copilot"));
  const p = normalizePolicy({ requiredChecks: ["build"] });
  const pr = (over) => ({ url: "https://github.com/acme/api/pull/7", state: "OPEN", author: { login: "sam" }, reviews: [], unresolved: 0, ...over });
  const runs = [{ name: "build", conclusion: "SUCCESS", completedAt: "2026-10-27T10:00:00Z" }, { name: "build", conclusion: "FAILURE", completedAt: "2026-10-27T11:00:00Z" }];
  assert.match(prBlockers(p, pr({ statusCheckRollup: runs }), null)[0], /required check build is not green/);
  assert.deepEqual(prBlockers(p, pr({ statusCheckRollup: [...runs].reverse().map((r, i) => ({ ...r, conclusion: i ? "FAILURE" : "SUCCESS", completedAt: i ? "2026-10-27T10:00:00Z" : "2026-10-27T12:00:00Z" })) }), null), []);
  assert.match(prBlockers(p, pr({ state: "CLOSED", statusCheckRollup: runs.slice(0, 1) }), null)[0], /is closed/);
  const a = assess({ enabled: true, gates: { merge: "approver" }, approver: { enabled: true } }, { stages: [] }, "merge", { rules: RULES_NONE, risk: "low", prs: [goodPr], judgedShas: ["abc1234"] });
  assert.ok(a.blockers.includes("The pipeline's review hasn't run"));
  const unknown = evaluateRules(AP, { repos: [{ name: "api", files: [], unknown: true }] });
  assert.equal(unknown.level, "high");
  assert.match(unknown.rules[0].detail, /Couldn't tell what changed in api/);
  assert.equal(sampledFor(10, "same"), sampledFor(10, "same"));
  assert.equal(sampledFor(0, "k1"), false);
  assert.equal(sampledFor(100, "k0"), true);
});

test("Copilot's fixes: judged commits, a bot's standing request, a check's newest start, a review per changed repo", () => {
  const enforce = policy({ enforce: true, identity: "approver-bot" });
  const other = assess(enforce, reviewed, "merge", { rules: RULES_NONE, risk: "low", prs: [goodPr], judgedShas: ["0000000"], ghUser: "approver-bot", sampleKey: "k0" });
  assert.equal(other.action, "handoff");
  assert.match(other.blockers[0], /The judgement wasn't of acme\/api\/pull\/7 at abc1234/);
  assert.match(assess(enforce, reviewed, "merge", { rules: RULES_NONE, risk: "low", prs: [goodPr], ghUser: "approver-bot", sampleKey: "k0" }).blockers[0], /pass --judged/);
  const p = normalizePolicy({ reviewers: { bots: ["copilot"] } });
  const pr = (reviews, checks = []) => ({ url: "https://github.com/acme/api/pull/7", state: "OPEN", author: { login: "sam" }, unresolved: 0, statusCheckRollup: checks, reviews });
  const bot = (state) => ({ author: { login: "copilot-pull-request-reviewer" }, state });
  assert.match(prBlockers(p, pr([bot("CHANGES_REQUESTED"), bot("COMMENTED")]), null)[0], /requested changes/, "a comment doesn't withdraw it");
  assert.deepEqual(prBlockers(p, pr([bot("CHANGES_REQUESTED"), bot("APPROVED"), bot("COMMENTED")]), null), []);
  const checks = [{ name: "build", conclusion: "SUCCESS", startedAt: "2026-10-27T10:00:00Z", completedAt: "2026-10-27T11:00:00Z" }, { name: "build", status: "IN_PROGRESS", startedAt: "2026-10-27T10:30:00Z" }];
  assert.match(prBlockers(normalizePolicy({ requiredChecks: ["build"] }), pr([], checks), null)[0], /build is still running/, "the newer run, by start, decides");
  const twoRepos = { repos: ["api", "web"], stages: [{ id: "build", repo: "api", status: "done" }, { id: "build", repo: "web", status: "done" }, { id: "review", repo: "api", status: "done" }] };
  assert.ok(assess(policy({}), twoRepos, "prePr", { rules: RULES_NONE, risk: "low" }).blockers.includes("The pipeline's review hasn't passed for web"));
  const unknown = evaluateRules(AP, { repos: [{ name: "api", files: [], unknown: "couldn't read package.json: HTTP 502" }] });
  assert.match(unknown.rules[0].detail, /Couldn't tell what changed in api \(couldn't read package\.json: HTTP 502\)/);
});

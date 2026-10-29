// The Get started page (onboarding.ts) against a scratch workspace: every module reads
// WORKSPACE_ROOT/.claude/dashboard at import, so point it there before importing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-onboarding-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
const LEDGER = path.join(ROOT, ".claude", "ledger");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = LEDGER;
delete process.env.ATLASSIAN_CLIENT_SECRET;

const { BUILTIN_STEPS, Onboarding, evaluate, remainingOf, resolveSteps, saveClientSecret } = await import("../src/onboarding.ts");
const { Atlassian, clientSecret } = await import("../src/atlassian-auth.ts");
type StepContext = import("../src/onboarding.ts").StepContext;
type Probes = import("../src/onboarding.ts").Probes;

const write = (name: string, data: unknown) => {
  const file = path.join(CFG, name);
  fs.writeFileSync(file, JSON.stringify(data));
  // Config is cached by mtime; make sure a rewrite within the same tick is seen.
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(file, t, t);
};

const CHECKS = [
  { id: "claude", label: "Claude Code", kind: "claude-code", use: "claude" },
  { id: "gh", label: "GitHub CLI", kind: "command", use: "gh", hostedSignIn: "github" },
  { id: "node", label: "Node.js", kind: "node", use: "node" },
  { id: "vpn", label: "VPN client", kind: "command" },
];
const ctx = (o: Partial<StepContext> = {}): StepContext => ({
  root: ROOT, hosted: false, profile: "developer", role: "eng", os: "win",
  rolesConfigured: true, roleLocked: false, codeHost: "github",
  atlassian: { used: true, clientId: true }, secretFromEnv: false,
  repos: { clone: 2, download: 0 },
  machine: { configured: true, checks: CHECKS },
  connectionsRequired: 1,
  ...o,
});
const ids = (file: unknown, o?: Partial<StepContext>) => resolveSteps(file, ctx(o)).steps.map((s) => s.id);
const ALL = ["role", "claude", "github", "atlassian-secret", "atlassian", "repos", "machine", "connections"];

const probes = (o: Partial<Probes> = {}): Probes => ({
  claudeAuth: async () => ({ installed: true, loggedIn: true }),
  machine: async () => ({ checks: [] }),
  connections: async () => ({ connections: [], checkedAt: 1 }),
  atlassian: () => ({ connected: false, viewer: null, signInProblem: null }),
  snapshot: () => null,
  secret: () => false,
  repos: () => [],
  repoState: () => "cloned",
  profile: () => ({ roleChosen: true, roleLabel: "Engineering" }),
  ticks: () => ({}),
  ...o,
});
/** Only the dashboard's own probes: the rest (profile, secret, repos, ticks) come from the scratch workspace and ledger. */
const dashProbes = (o: Partial<Probes> = {}) => {
  const { claudeAuth, machine, connections, atlassian, snapshot } = probes(o);
  return { claudeAuth, machine, connections, atlassian, snapshot };
};
const check = (id: string, status: string, extra: any = {}) => ({ id, label: id, status, detail: `${id} ${status}`, fix: "", ...extra });

test("with no onboarding.json, every built-in that applies, in the default order", () => {
  assert.deepEqual(Object.keys(BUILTIN_STEPS), ALL);
  const r = resolveSteps(null, ctx());
  assert.equal(r.enabled, true);
  assert.deepEqual(r.steps.map((s) => s.id), ALL);
  assert.deepEqual(r.problems, []);
  // A fresh clone with no roles, Atlassian or connections.json: role → claude, gh, code, machine (the issue's acceptance).
  assert.deepEqual(ids(null, { rolesConfigured: true, atlassian: { used: false, clientId: false }, connectionsRequired: 0 }), ["role", "claude", "github", "repos", "machine"]);
  const claude = r.steps.find((s) => s.id === "claude")!;
  assert.equal(claude.checkId, "claude", "the Machine check it mirrors");
  assert.equal(r.steps.find((s) => s.id === "github")!.checkId, "gh");
});

test('"steps": false turns the page off', () => {
  const r = resolveSteps({ steps: false, intro: "Hi" }, ctx());
  assert.deepEqual([r.enabled, r.steps, r.intro], [false, [], "Hi"]);
});

test("built-ins the file doesn't list go right after the nearest earlier one it does", () => {
  assert.deepEqual(ids({ steps: [{ use: "machine" }, { use: "role" }, { id: "slack", kind: "manual", label: "Join #dev" }] }),
    ["machine", "connections", "role", "claude", "github", "atlassian-secret", "atlassian", "repos", "slack"]);
  assert.deepEqual(ids({ steps: [{ id: "vpn-manual", label: "Install the VPN" }, { use: "repos" }] }),
    ["role", "claude", "github", "atlassian-secret", "atlassian", "vpn-manual", "repos", "machine", "connections"], "none earlier listed: at the start");
});

test('"off": true removes a built-in (and it isn\'t put back as unlisted)', () => {
  assert.deepEqual(ids({ steps: [{ use: "connections", off: true }, { use: "atlassian-secret", off: true }] }), ALL.filter((id) => id !== "connections" && id !== "atlassian-secret"));
});

test("use overrides wording, contact and optional; {contact} is filled in", () => {
  const file = {
    contacts: { lead: { label: "Your engineering lead", how: "Ask in #eng-help" } },
    steps: [{ use: "github", label: "GitHub", detail: "Ask {contact} to add you to the org.", contact: "lead", optional: true }, { use: "atlassian-secret" }],
  };
  const steps = resolveSteps(file, ctx()).steps;
  const gh = steps.find((s) => s.id === "github")!;
  assert.deepEqual([gh.label, gh.detail, gh.optional], ["GitHub", "Ask Your engineering lead to add you to the org.", true]);
  assert.deepEqual(gh.contact, { id: "lead", label: "Your engineering lead", how: "Ask in #eng-help" });
  assert.match(steps.find((s) => s.id === "atlassian-secret")!.detail!, /Ask someone on your team for it/, "no contact: a generic one");
});

test("when: access, role, hosted and os", () => {
  const file = { steps: [
    { id: "vpn", label: "VPN", when: { access: "full" } },
    { id: "pm-tool", label: "PM tool", when: { role: ["pm"] } },
    { id: "hosted-only", label: "H", when: { hosted: true } },
    { id: "mac-only", label: "M", when: { os: "mac" } },
  ] };
  const extra = (o?: Partial<StepContext>) => ids(file, o).filter((id) => !ALL.includes(id));
  assert.deepEqual(extra(), ["vpn"]);
  assert.deepEqual(extra({ profile: "reader" }), []);
  assert.deepEqual(extra({ role: "pm" }), ["vpn", "pm-tool"]);
  assert.deepEqual(extra({ hosted: true }), ["vpn", "hosted-only"]);
  assert.deepEqual(extra({ os: "mac" }), ["vpn", "mac-only"]);
  assert.deepEqual(ids({ steps: [{ use: "role", when: { hosted: true } }] }).includes("role"), false, "a built-in's when too");
});

test("hosted: no repos, machine or secret step", () => {
  assert.deepEqual(ids(null, { hosted: true }), ["role", "claude", "github", "atlassian", "connections"]);
  assert.deepEqual(ids(null, { secretFromEnv: true }).includes("atlassian-secret"), false, "the env var supplies it");
});

test("reader: Download the code only when there's a snapshot source; developers clone", () => {
  assert.equal(ids(null, { profile: "reader" }).includes("repos"), false);
  const repos = resolveSteps(null, ctx({ profile: "reader", repos: { clone: 2, download: 2 } })).steps.find((s) => s.id === "repos")!;
  assert.deepEqual([repos.via, repos.label], ["download", "Download the code"]);
  assert.equal(resolveSteps(null, ctx()).steps.find((s) => s.id === "repos")!.via, "clone");
  assert.equal(ids(null, { repos: { clone: 0, download: 0 } }).includes("repos"), false, "no repos.json repos, no step");
});

test("repos applies only with repos this person can get: with a remote to clone, or in the snapshot to download", () => {
  assert.equal(ids(null, { repos: { clone: 0, download: 2 } }).includes("repos"), false, "no remotes: nothing to clone");
  assert.equal(ids(null, { profile: "reader", repos: { clone: 2, download: 0 } }).includes("repos"), false, "none in the snapshot");
});

test("github: off for readers (they download), unless a step turns it on for them with a when that names their access", () => {
  const reader = { profile: "reader", repos: { clone: 2, download: 2 } };
  assert.equal(ids(null, reader).includes("github"), false);
  assert.equal(ids({ steps: [{ use: "github" }] }, reader).includes("github"), false, "listed without a when");
  assert.equal(ids({ steps: [{ use: "github", when: { os: "win" } }] }, reader).includes("github"), false, "a when that doesn't name the access");
  assert.equal(ids({ steps: [{ use: "github", when: { access: "read" } }] }, reader).includes("github"), true);
  assert.equal(ids({ steps: [{ use: "github", when: { profile: ["developer", "reader"] } }] }, reader).includes("github"), true);
  assert.equal(ids({ steps: [{ use: "github", when: { access: "full" } }] }, reader).includes("github"), false, "it still has to match");
  assert.equal(ids({ steps: [{ use: "github", when: { access: "full" } }] }).includes("github"), true);
});

test("a check step's id follows the manual steps' rules: letters, digits, - and _, and not a built-in's", () => {
  const r = resolveSteps({ steps: [{ check: "vpn", id: "has space" }, { check: "node", id: "machine" }, { check: "vpn", id: "vpn-ok" }] }, ctx());
  const p = r.problems.join("\n");
  assert.match(p, /step "has space": an "id" is letters, digits, - and _/);
  assert.match(p, /step "machine": "machine" is a built-in step's id/);
  assert.deepEqual(r.steps.filter((s) => s.kind === "check").map((s) => s.id), ["vpn-ok"]);
  assert.equal(r.steps.find((s) => s.id === "machine")!.kind, "machine", "the built-in keeps its place");
  assert.match(resolveSteps({ steps: [{ id: "claude", label: "Mine" }] }, ctx({ machine: { configured: true, checks: [] } })).problems.join(), /"claude" is a built-in step's id/, "a manual one too");
});

test("derived defaults: role only with roles and no assigned role; github only with a gh check; machine only with machine.json", () => {
  assert.equal(ids(null, { roleLocked: true }).includes("role"), false);
  assert.equal(ids(null, { rolesConfigured: false }).includes("role"), false);
  assert.equal(ids(null, { machine: { configured: true, checks: CHECKS.filter((c) => c.id !== "gh") } }).includes("github"), false);
  assert.equal(ids(null, { codeHost: "none" }).includes("github"), false);
  assert.equal(ids(null, { machine: { configured: false, checks: [] } }).includes("machine"), false);
  assert.equal(ids(null, { atlassian: { used: true, clientId: false } }).some((id) => id.startsWith("atlassian")), false);
});

test("check steps mirror a Machine check by id; a check that isn't there for this person leaves the step out", () => {
  const steps = resolveSteps({ steps: [{ check: "vpn", detail: "Ask IT." }, { check: "not-listed" }] }, ctx()).steps;
  const vpn = steps.find((s) => s.id === "vpn")!;
  assert.deepEqual([vpn.kind, vpn.label, vpn.checkId, vpn.detail], ["check", "VPN client", "vpn", "Ask IT."]);
  assert.equal(steps.some((s) => s.id === "not-listed"), false);
});

test("a broken onboarding.json says what's wrong and keeps the rest: unknown use, unknown contact, duplicate ids, manual without a label", () => {
  const r = resolveSteps({ steps: [
    { use: "slack" }, { id: "a", label: "A", contact: "nobody" }, { id: "a", label: "Again" }, { id: "b" }, { id: "c", kind: "magic", label: "C" },
  ] }, ctx());
  const p = r.problems.join("\n");
  assert.match(p, /"use": "slack" isn't a built-in step/);
  assert.match(p, /contact "nobody" isn't in contacts/);
  assert.match(p, /two steps have the id "a"/);
  assert.match(p, /a manual step needs an "id".*and a "label" \(b\)/);
  assert.match(p, /kind "magic" isn't a step kind/);
  assert.deepEqual(r.steps.filter((s) => s.kind === "manual").map((s) => [s.id, s.label]), [["a", "A"]]);
  assert.match(resolveSteps({ steps: { role: {} } }, ctx()).problems.join(), /"steps" must be a list/);
});

test("evaluate: states from the probes; machine leaves out what the claude, github and check steps show", async () => {
  const steps = resolveSteps({ steps: [{ check: "vpn" }] }, ctx()).steps;
  const out = await evaluate(steps, probes({
    claudeAuth: async () => ({ installed: true, loggedIn: false }),
    machine: async () => ({ checks: [check("claude", "missing", { install: { label: "Sign in" } }), check("gh", "warn"), check("node", "missing"), check("vpn", "missing"), check("docker", "info")] }),
    secret: () => true,
    atlassian: () => ({ connected: true, viewer: "Ana", signInProblem: null }),
    repos: () => [{ name: "api", relativePath: "api", remote: "https://github.com/acme/api.git", layer: null, defaultBranch: null, dependencies: [], snapshot: true },
      { name: "web", relativePath: "web", remote: "git@github.com:acme/web.git", layer: null, defaultBranch: null, dependencies: [], snapshot: true }],
    repoState: (rel) => (rel === "api" ? "missing" : "cloned"),
    connections: async () => ({ connections: [{ name: "claude.ai Linear", required: { why: "", add: null, vars: [], alternatives: [] }, missing: true } as any], checkedAt: 1 }),
  }));
  const by = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.equal(by.claude.state, "todo");
  assert.deepEqual(by.claude.check, { id: "claude", label: "claude", status: "missing", detail: "claude missing", install: "Sign in", fix: "" });
  assert.equal(by.github.state, "todo", "gh signed out (warn) isn't done");
  assert.deepEqual(by.machine.machine!.missing.map((c) => c.id), ["node"], "not claude, gh or vpn: their own steps show them");
  assert.equal(by["atlassian-secret"].state, "done");
  assert.deepEqual([by.atlassian.state, by.atlassian.status], ["done", "Connected as Ana."]);
  assert.deepEqual(by.repos.repos, { via: "clone", missing: ["api"], source: null });
  assert.deepEqual([by.repos.state, by.repos.blockedBy], ["blocked", ["github"]], "an https GitHub remote waits for the GitHub sign-in");
  assert.deepEqual([by.connections.state, by.connections.blockedBy, by.connections.connections], ["blocked", ["claude"], { attention: ["claude.ai Linear"] }]);
  assert.equal(by.vpn.state, "todo");
  assert.equal(by.role.state, "done");
});

test("evaluate: connections are checking until `claude mcp list` ran; atlassian waits for its secret; hosted sign-ins are in the page", async () => {
  const steps = resolveSteps(null, ctx({ hosted: true })).steps;
  const out = await evaluate(steps, probes({
    connections: async () => ({ connections: [], checkedAt: null }),
    claudeAuth: async () => ({ installed: true, loggedIn: false }),
    machine: async () => ({ checks: [check("gh", "warn", { signIn: "github" })] }),
  }), { hosted: true });
  const by = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.equal(by.claude.signIn, "claude");
  assert.equal(by.github.signIn, "github");
  assert.equal(by.connections.state, "blocked", "claude isn't signed in");
  const known = await evaluate(steps, probes({ connections: async () => ({ connections: [], checkedAt: null }) }), { hosted: true });
  assert.equal(known.find((s) => s.id === "connections")!.state, "checking");

  const local = await evaluate(resolveSteps(null, ctx()).steps, probes());
  assert.deepEqual(local.find((s) => s.id === "atlassian")!.blockedBy, ["atlassian-secret"]);
});

test("evaluate: Download the code doesn't wait for the GitHub sign-in (only cloning does)", async () => {
  const reader = ctx({ profile: "reader", repos: { clone: 1, download: 1 } });
  const steps = resolveSteps({ steps: [{ use: "github", when: { access: "read" } }] }, reader).steps;
  const out = await evaluate(steps, probes({
    machine: async () => ({ checks: [check("gh", "warn")] }),
    repos: () => [{ name: "api", relativePath: "api", remote: "https://github.com/acme/api.git", layer: null, defaultBranch: null, dependencies: [], snapshot: true }],
    repoState: () => "missing",
    snapshot: () => ({ label: "Confluence", connected: true }),
  }));
  const repos = out.find((s) => s.id === "repos")!;
  assert.equal(out.find((s) => s.id === "github")!.state, "todo");
  assert.deepEqual([repos.repos!.via, repos.state, repos.blockedBy], ["download", "todo", []]);
});

test("remaining counts required steps that are todo or blocked: not optional, done or checking ones", () => {
  const s = (state: string, optional = false) => ({ state, optional }) as any;
  assert.equal(remainingOf([s("todo"), s("blocked"), s("todo", true), s("done"), s("checking")]), 2);
});

test("Onboarding: tick a manual step and untick it; anything else is refused; dismiss and reopen; the boot count", async () => {
  write("workspace.json", { name: "T", roles: { eng: { label: "Engineering" } } });
  write("onboarding.json", { steps: [{ use: "claude" }, { id: "slack", kind: "manual", label: "Join #dev" }, { id: "extra", label: "Optional", optional: true }] });
  const ob = new Onboarding({ root: ROOT, ledgerDir: LEDGER, hosted: false, roleLocked: false, probes: dashProbes() });
  assert.deepEqual(ob.boot(), { enabled: true, remaining: null, show: false }, "before the first evaluation");

  let r = await ob.get();
  assert.deepEqual(r.steps.map((s) => [s.id, s.state]), [["role", "todo"], ["claude", "done"], ["slack", "todo"], ["extra", "todo"]]);
  assert.equal(r.remaining, 2);
  assert.equal(r.show, true);
  assert.deepEqual(ob.boot(), { enabled: true, remaining: 2, show: true });

  r = await ob.tick("slack", true);
  const slack = r.steps.find((s) => s.id === "slack")!;
  assert.equal(slack.state, "done");
  assert.ok(slack.doneAt);
  assert.equal(r.remaining, 1);
  assert.equal((await ob.tick("slack", false)).steps.find((s) => s.id === "slack")!.state, "todo");
  await assert.rejects(ob.tick("claude", true), (e: any) => e.status === 400);
  await assert.rejects(ob.tick("nope", true), (e: any) => e.status === 400);

  r = await ob.dismiss(true);
  assert.ok(r.dismissedAt);
  assert.equal(r.show, false);
  assert.equal(ob.boot().show, false);
  assert.equal((await ob.dismiss(false)).show, true, "Settings → Reopen");

  write("onboarding.json", { steps: false });
  assert.deepEqual(ob.boot(), { enabled: false, remaining: 0, show: false });
  assert.deepEqual((await ob.get()).steps, []);
  fs.rmSync(path.join(CFG, "onboarding.json"));
});

test("Onboarding: refresh() hands the new page to onChange (the live topic), so open pages don't keep a stale count", async () => {
  write("workspace.json", { name: "T" });
  const ob = new Onboarding({ root: ROOT, ledgerDir: LEDGER, hosted: false, roleLocked: false, probes: dashProbes() });
  const seen: any[] = [];
  ob.onChange = (r) => seen.push(r);
  await ob.refresh();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].remaining, ob.boot().remaining);
  await ob.get();
  assert.equal(seen.length, 1, "a GET answers its own caller");
});

test("Onboarding: the startup warm-up doesn't ask for the MCP health check, and fills the boot count", async () => {
  write("workspace.json", { name: "T" });
  write("connections.json", { required: [{ name: "linear" }] });
  let asked = 0;
  const ob = new Onboarding({ root: ROOT, ledgerDir: LEDGER, hosted: false, roleLocked: false,
    probes: dashProbes({ connections: async () => { asked++; return { connections: [], checkedAt: 1 }; } }) });
  const steps = await ob.warm();
  assert.equal(asked, 0, "no `claude mcp list` at startup");
  assert.notEqual(ob.boot().remaining, null);
  assert.equal(steps.find((s) => s.kind === "connections")!.state, "checking", "not known yet, so not counted");
  fs.rmSync(path.join(CFG, "connections.json"));
});

test("a manual step named like an Object property (constructor, toString, valueOf) is todo until ticked", async () => {
  write("workspace.json", { name: "T" });
  write("onboarding.json", { steps: [{ id: "constructor", label: "C" }, { id: "toString", label: "T" }, { id: "valueOf", label: "V" }] });
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "dash-onboarding-ticks-"));
  const ob = new Onboarding({ root: ROOT, ledgerDir: ledger, hosted: false, roleLocked: false, probes: dashProbes() });
  const states = (r: any) => r.steps.filter((s: any) => s.kind === "manual").map((s: any) => [s.id, s.state]);
  assert.deepEqual(states(await ob.get()), [["constructor", "todo"], ["toString", "todo"], ["valueOf", "todo"]]);
  assert.deepEqual(states(await ob.tick("constructor", true)), [["constructor", "done"], ["toString", "todo"], ["valueOf", "todo"]]);
  assert.deepEqual(states(await ob.tick("constructor", false)), [["constructor", "todo"], ["toString", "todo"], ["valueOf", "todo"]]);
  fs.rmSync(path.join(CFG, "onboarding.json"));
});

test("the Atlassian secret: a failed write leaves no temp file holding it", () => {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "dash-onboarding-secret-"));
  fs.mkdirSync(path.join(ledger, "atlassian-client-secret")); // rename and copy over a directory both fail
  assert.throws(() => saveClientSecret(ledger, "s3cr3t"));
  assert.deepEqual(fs.readdirSync(ledger).filter((f) => f.endsWith(".tmp")), [], "no temp file left");
});

test("the Atlassian secret: saved owner-only, never sent back, read at once by Connect to Atlassian; refused when the env var sets it", async () => {
  write("workspace.json", { name: "T", issues: { kind: "jira", site: "acme.atlassian.net" }, atlassian: { clientId: "cid" } });
  const atlassian = new Atlassian(LEDGER, { hosted: false });
  const auth = atlassian.get();
  assert.equal(auth.status().signIn, false, "no secret yet");

  const ob = new Onboarding({ root: ROOT, ledgerDir: LEDGER, hosted: false, roleLocked: false, probes: dashProbes({ atlassian: () => atlassian.get().status() }) });
  assert.equal((await ob.get()).steps.find((s) => s.id === "atlassian-secret")!.state, "todo");
  const secret = "s3cr3t-#value";
  const r = await ob.saveSecret(`  ${secret}  `);
  assert.doesNotMatch(JSON.stringify(r), /s3cr3t/, "the response never carries it");
  assert.equal(r.steps.find((s) => s.id === "atlassian-secret")!.state, "done");
  assert.equal(r.steps.find((s) => s.id === "atlassian")!.state, "todo", "no longer blocked: connect next");
  assert.equal(clientSecret(LEDGER), secret);
  assert.equal(auth.status().signIn, true, "the same AtlassianAuth sees it: no restart");
  const file = path.join(LEDGER, "atlassian-client-secret");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(LEDGER).filter((f) => f.endsWith(".tmp")), [], "no temp file left");

  for (const bad of ["", "two\nlines", "x".repeat(513), 42]) assert.throws(() => saveClientSecret(LEDGER, bad), (e: any) => e.status === 400, JSON.stringify(bad));
  process.env.ATLASSIAN_CLIENT_SECRET = "from-env";
  try {
    assert.throws(() => saveClientSecret(LEDGER, "other"), (e: any) => e.status === 409);
    assert.equal(clientSecret(LEDGER), "from-env");
  } finally { delete process.env.ATLASSIAN_CLIENT_SECRET; }
  assert.equal(clientSecret(LEDGER), secret, "the saved one is untouched");
});

test("the Atlassian secret: a pasted KEY=value line or a quoted value saves the secret alone, and reads back the same", () => {
  for (const [pasted, saved] of [
    ["ATLASSIAN_CLIENT_SECRET=abc", "abc"],
    [" ATLASSIAN_CLIENT_SECRET=\"abc\" ", "abc"],
    ["'abc'", "abc"],
    ['"abc', '"abc'],
    ["#abc", "#abc"],
  ]) {
    saveClientSecret(LEDGER, pasted);
    assert.equal(clientSecret(LEDGER), saved, JSON.stringify(pasted));
  }
  for (const bad of ["ATLASSIAN_CLIENT_SECRET=", '""', "ATLASSIAN_CLIENT_SECRET=''"]) {
    assert.throws(() => saveClientSecret(LEDGER, bad), (e: any) => e.status === 400, JSON.stringify(bad));
  }
});

test("a manual step's link must be https", () => {
  const r = resolveSteps({ steps: [
    { id: "a", label: "A", link: "http://example.com" }, { id: "b", label: "B", link: "https://example.com" },
  ] }, ctx());
  assert.match(r.problems.join("\n"), /step "a": link must start with https:\/\//);
  const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
  assert.deepEqual([by.a.link, by.b.link], [null, "https://example.com"]);
});

#!/usr/bin/env node
/**
 * factory.mjs: a work item's progress for the Natterjack dashboard's Factory board.
 *
 * Pipelines (implement) call this at each step instead of editing JSON by hand. It keeps one
 * manifest per ticket in the source workspace's ledger,
 *   <workspace>/.claude/ledger/factory/<ticket>.json
 * (never committed; the same file whether the work is in a worktree or the workspace itself).
 * A workspace without a Natterjack dashboard (.claude/dashboard/) has no board: every command
 * is then a no-op that prints { skipped }, so pipelines call it unconditionally.
 *
 * Usage (every command takes --ticket, and --root <dir> to start from somewhere other than cwd):
 *   node factory.mjs start --ticket <id> [--title t] [--url u] [--mode interactive|autonomous]
 *                          [--branch b] [--repos a,b] [--plan <file>] [--workroot <dir>]
 *   node factory.mjs stage --ticket <id> --stage <stage> --status running|done|failed|skipped|pending
 *                          [--repo r] [--agent a] [--note "..."]
 *   node factory.mjs gate  --ticket <id> --gate spec|plan|prePr|merge --decision pending|approved|rejected
 *                          [--by who] [--mode human|approver|auto] [--risk low|medium|high] [--rationale "..."] [--sha s]
 *   node factory.mjs pr    --ticket <id> --url <pr url> [--repo r] [--number n] [--state open|merged|closed]
 *   node factory.mjs done  --ticket <id> [--error "why it stopped"]
 *   (spec readiness is recorded by spec-check.mjs --ticket <id>)
 *   node factory.mjs show  --ticket <id>
 *   node factory.mjs policy [--root <dir>]     the workspace's factory.json (or { exists: false })
 *   node factory.mjs decide --ticket <id> --gate spec|plan|prePr|merge [--run interactive|autonomous] [--can-ask yes|no]
 *                          what to do at a gate by the policy: { action: own-rules|skip|pass|ask|stop|handoff, reason }
 *   node factory.mjs wip   --ticket <id>       other tickets in flight vs the policy's WIP limit: { inFlight, limit, ok }
 *   node factory.mjs stage-on --stage <stage>   whether the policy runs a stage: { policy, on } (on: null with no policy on)
 *
 * Stages: align plan build review security qa guide pr approve merge. A stage is one row per
 * repo (updated in place); a gate decision is appended (the history is the audit log).
 * Prints the manifest (or the policy) as JSON. Exits 2 on a usage error.
 */
import fs from "node:fs";
import path from "node:path";
import { findRoot, isMain, parseArgs, readJson, readWorktreeMeta } from "./lib.mjs";
import { withFileLock } from "./worktree.mjs";

export const STAGES = ["align", "plan", "build", "review", "security", "qa", "guide", "pr", "approve", "merge"];
export const GATES = ["spec", "plan", "prePr", "merge"];
const STEP = ["pending", "running", "done", "failed", "skipped"];
const DECISIONS = ["pending", "approved", "rejected"];
const GATE_MODES = ["human", "approver", "auto"];
const RISKS = ["low", "medium", "high"];

const usage = (msg) => Object.assign(new Error(msg), { usage: true });

/** The workspace whose ledger holds the manifests: a worktree's source workspace, else the root itself. */
export function sourceWorkspace(start) {
  const root = findRoot(start);
  const src = readWorktreeMeta(root)?.sourceWorkspace;
  return typeof src === "string" && src && fs.existsSync(src) ? path.resolve(src) : root;
}

/** A ticket id as a file name: owner/repo#7 → owner_repo_7. */
export function ticketFile(ticket) {
  return String(ticket).trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_") + ".json";
}

/** Where the ticket's manifest lives, or null when the workspace has no dashboard. */
export function manifestPath(ws, ticket) {
  if (!fs.existsSync(path.join(ws, ".claude", "dashboard"))) return null;
  return path.join(ws, ".claude", "ledger", "factory", ticketFile(ticket));
}

/** factory.json for the workspace, as written (the dashboard fills defaults), or null. */
export function readPolicy(ws) {
  const file = path.join(ws, ".claude", "dashboard", "factory.json");
  const data = readJson(file);
  if (!data) return null;
  let updatedAt = null;
  try { updatedAt = fs.statSync(file).mtime.toISOString(); } catch {}
  return { ...data, updatedAt };
}

function write(file, m) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}

const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function fresh(ticket, now, policy) {
  return {
    version: 1, ticket, title: null, url: null, mode: "interactive",
    policy: policy ? { preset: policy.preset ?? null, updatedAt: policy.updatedAt } : null,
    workroot: null, branch: null, repos: [], plan: null,
    startedAt: now, updatedAt: now, spec: null, stages: [], gates: [], prs: [], done: false, error: null,
  };
}

/** Applies one command to the ticket's manifest and saves it. Returns { manifest, file } or { skipped }. */
export function update(command, args, { start = process.cwd(), now = new Date().toISOString() } = {}) {
  const ticket = str(args.ticket);
  if (!ticket) throw usage("--ticket is required");
  const ws = sourceWorkspace(start);
  const file = manifestPath(ws, ticket);
  if (!file) return { skipped: "This workspace has no Natterjack dashboard (.claude/dashboard), so there's no Factory board to report to." };
  const policy = readPolicy(ws);
  if (command === "show") return { manifest: readJson(file) || fresh(ticket, now, policy), file };
  // Subagents report in parallel (one per repo): read, change and write under a lock so no report is lost.
  return withFileLock(file, () => {
    const m = readJson(file) || fresh(ticket, now, policy);
    apply(command, args, m, policy, now);
    m.updatedAt = now;
    write(file, m);
    return { manifest: m, file };
  });
}

/** One command's change to a manifest (throws a usage error for bad arguments). */
function apply(command, args, m, policy, now) {
  if (command === "start") {
    for (const k of ["title", "url", "branch", "plan"]) if (str(args[k])) m[k] = str(args[k]);
    if (args.mode === "autonomous" || args.mode === "interactive") m.mode = args.mode;
    if (str(args.workroot)) m.workroot = path.resolve(args.workroot);
    if (list(args.repos).length) m.repos = [...new Set([...m.repos, ...list(args.repos)])];
    m.policy = policy ? { preset: policy.preset ?? null, updatedAt: policy.updatedAt } : m.policy;
    m.done = false;
    m.error = null;
  } else if (command === "stage") {
    if (!STAGES.includes(args.stage)) throw usage(`--stage must be one of ${STAGES.join(", ")}`);
    if (!STEP.includes(args.status)) throw usage(`--status must be one of ${STEP.join(", ")}`);
    const repo = str(args.repo);
    let row = m.stages.find((s) => s.id === args.stage && (s.repo ?? null) === repo);
    if (!row) { row = { id: args.stage, repo, agent: null, status: "pending", startedAt: null, endedAt: null, note: null }; m.stages.push(row); }
    row.status = args.status;
    if (str(args.agent)) row.agent = str(args.agent);
    if (str(args.note)) row.note = str(args.note);
    if (args.status === "running") { row.startedAt = row.startedAt && row.endedAt == null ? row.startedAt : now; row.endedAt = null; }
    if (["done", "failed", "skipped"].includes(args.status)) { row.startedAt ??= now; row.endedAt = now; }
    if (repo && !m.repos.includes(repo)) m.repos.push(repo);
  } else if (command === "gate") {
    if (!GATES.includes(args.gate)) throw usage(`--gate must be one of ${GATES.join(", ")}`);
    if (!DECISIONS.includes(args.decision)) throw usage(`--decision must be one of ${DECISIONS.join(", ")}`);
    const policyMode = policy?.gates?.[args.gate];
    m.gates.push({
      id: args.gate,
      mode: GATE_MODES.includes(args.mode) ? args.mode : GATE_MODES.includes(policyMode) ? policyMode : null,
      decision: args.decision,
      by: str(args.by),
      risk: RISKS.includes(args.risk) ? args.risk : null,
      rationale: str(args.rationale),
      sha: str(args.sha),
      at: now,
    });
  } else if (command === "pr") {
    const url = str(args.url);
    if (!url || !/^https?:\/\//.test(url)) throw usage("--url must be the PR's web address");
    const n = Number(args.number ?? (/\/pull\/(\d+)/.exec(url) || [])[1]);
    const state = ["open", "merged", "closed"].includes(args.state) ? args.state : "open";
    const have = m.prs.find((p) => p.url === url);
    if (have) { have.state = state; if (str(args.repo)) have.repo = str(args.repo); }
    else m.prs.push({ repo: str(args.repo), url, number: Number.isInteger(n) ? n : null, state });
  } else if (command === "spec") {
    // spec-check.mjs's result: kept as is (the board shows the score, level and each check).
    const r = args.result;
    if (!r || typeof r !== "object" || !Number.isFinite(r.score) || !Array.isArray(r.checks)) throw usage("spec needs spec-check.mjs's result");
    m.spec = { score: r.score, level: r.level, readyAt: r.readyAt, needsWorkAt: r.needsWorkAt, minScore: r.minScore ?? null, checks: r.checks, at: now };
  } else if (command === "done") {
    m.done = true;
    m.error = str(args.error);
  } else {
    throw usage(`Unknown command "${command}". Use start, stage, gate, pr, done, show or policy.`);
  }
}

// ------------------------------------------------------------------ the policy's decisions

const GATE_NAMES = { spec: "spec", plan: "plan", prePr: "pre-PR", merge: "merge" };
const ALL_GATE_MODES = ["human", "approver", "auto", "off"];
const SEVERITIES = ["critical", "high", "medium", "low"];
/** Stages the dashboard has off by default. */
const DEFAULT_OFF = ["align", "qa", "approve"];
/** The scanners the dashboard suggests (Factory → Policy) when the policy names none. */
export const DEFAULT_SCANNERS = [
  { name: "npm audit", command: "npm audit --audit-level=high", when: "package-lock.json", failOn: "high" },
  { name: "pip-audit", command: "pip-audit -r requirements.txt", when: "requirements.txt", failOn: "high" },
  { name: "govulncheck", command: "govulncheck ./...", when: "go.mod", failOn: "high" },
];

/**
 * factory.json as the dashboard reads it (engine factory.ts normalizeFactoryConfig), for the
 * parts the pipeline acts on: enabled, gates, stages, the WIP limit and the security stage.
 * The engine's tests check the two agree.
 */
export function normalizePolicy(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const num = (v, d, min, max) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };
  const opt = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  const sec = r.security && typeof r.security === "object" ? r.security : {};
  const listed = Array.isArray(r.stages) ? r.stages : [];
  return {
    enabled: r.enabled === true,
    gates: Object.fromEntries(GATES.map((g) => [g, ALL_GATE_MODES.includes(r.gates && r.gates[g]) ? r.gates[g] : "human"])),
    stages: STAGES.map((id) => { const s = listed.find((x) => x && x.id === id); return { id, on: s ? s.on !== false : !DEFAULT_OFF.includes(id) }; }),
    limits: { wip: Math.round(num(r.limits && r.limits.wip, 3, 1, 50)) },
    security: {
      agentReview: sec.agentReview !== false,
      secretScan: sec.secretScan !== false,
      failOn: SEVERITIES.includes(sec.failOn) ? sec.failOn : "high",
      scanners: Array.isArray(sec.scanners)
        ? sec.scanners.filter((s) => s && typeof s.command === "string" && s.command.trim()).slice(0, 30).map((s) => ({
          name: opt(s.name) || s.command.trim().split(/\s+/).slice(0, 2).join(" "),
          command: s.command.trim().slice(0, 500),
          when: opt(s.when),
          failOn: SEVERITIES.includes(s.failOn) ? s.failOn : "high",
        }))
        : DEFAULT_SCANNERS.map((s) => ({ ...s })),
    },
  };
}

/** The newest row per repo of one stage. */
function latestRows(m, stage) {
  const by = new Map();
  for (const r of (m && m.stages) || []) if (r.id === stage) by.set(r.repo ?? "", r);
  return [...by.values()];
}

/** Whether the policy turns a stage on (stages it doesn't list keep the dashboard's defaults). */
export function stageOn(policy, id) {
  const s = normalizePolicy(policy).stages.find((x) => x.id === id);
  return !!(s && s.on);
}

/**
 * What the pipeline does at a gate, by the team's policy:
 *   own-rules  no policy is on: the skill's own interactive/--auto rules
 *   skip       the gate is off
 *   pass       carry on (record it approved --by auto)
 *   ask        ask the person (AskUserQuestion; a question card in the dashboard)
 *   stop       stop here and say on the ticket why (record it pending, or rejected)
 *   handoff    nothing more for this run (the merge gate: implement never merges)
 * `run` is how this run goes (interactive | autonomous); `canAsk` whether it can ask a person.
 */
export function decide(policy, manifest, gate, { run = "interactive", canAsk = run === "interactive" } = {}) {
  if (!GATES.includes(gate)) throw usage(`--gate must be one of ${GATES.join(", ")}`);
  const name = GATE_NAMES[gate];
  const p = normalizePolicy(policy);
  if (!p.enabled) return { gate, mode: null, action: "own-rules", reason: "No factory policy is on: follow this skill's own rules." };
  const mode = p.gates[gate];
  const out = (action, reason) => ({ gate, mode, action, reason });
  const askOrStop = (why) => (canAsk ? out("ask", why) : out("stop", `${why} This run can't ask anyone: stop, and say on the ticket that it's waiting at the ${name} gate.`));
  const spec = manifest && manifest.spec;

  // The team's minimum spec score stops unattended runs whatever the gate's mode.
  if (gate === "spec" && run === "autonomous" && spec && spec.minScore != null && spec.score < spec.minScore) {
    return out("stop", `Spec readiness ${spec.score} is below the team's minimum for unattended runs (${spec.minScore}).`);
  }
  if (mode === "off") return out("skip", `The ${name} gate is off.`);
  if (gate === "merge") return out("handoff", mode === "auto" ? "The merge gate passes when the required checks are green; this run never merges." : "A person (or the Approver, once it runs) merges; this run never merges.");
  if (mode === "human" || mode === "approver") {
    const who = mode === "approver" ? "The Approver isn't running yet, so a person decides." : `A person decides the ${name} gate.`;
    return askOrStop(who);
  }
  // auto: passes when its checks pass.
  if (gate === "spec") {
    if (!spec) return askOrStop("The spec gate is automatic, but the ticket has no spec score yet (run spec-check.mjs --ticket).");
    if (spec.level === "ready") return out("pass", `Spec readiness ${spec.score} is Ready (${spec.readyAt}+).`);
    return askOrStop(`Spec readiness ${spec.score} is below Ready (${spec.readyAt}).`);
  }
  if (gate === "plan") return out("pass", "The plan gate is automatic.");
  // prePr: every repo's build finished, each has a passed review, and a passed security stage
  // (when it's on) that's newer than the repo's last build or review: a later fix needs a new scan.
  const builds = latestRows(manifest, "build");
  const unbuilt = builds.filter((r) => r.status !== "done" && r.status !== "skipped").map((r) => `${r.repo || "build"} (${r.status})`);
  if (unbuilt.length) return askOrStop(`The build hasn't finished for ${unbuilt.join(", ")}.`);
  const changed = builds.length ? builds.filter((r) => r.status === "done").map((r) => r.repo || "") : ((manifest && manifest.repos) || []);
  if (!changed.length) return askOrStop("The pre-PR gate is automatic, but no repo's build is recorded.");
  const rowsOf = (stage) => new Map(latestRows(manifest, stage).map((r) => [r.repo || "", r]));
  const reviews = rowsOf("review");
  const unreviewed = changed.filter((repo) => reviews.get(repo)?.status !== "done").map((repo) => `${repo || "review"} (${reviews.get(repo)?.status || "not run"})`);
  if (unreviewed.length) return askOrStop(`The review hasn't passed for ${unreviewed.join(", ")}.`);
  if (p.stages.find((s) => s.id === "security").on) {
    const scans = rowsOf("security");
    const builtAt = new Map(builds.map((r) => [r.repo || "", r.endedAt]));
    const stale = (repo) => {
      const s = scans.get(repo);
      const last = [builtAt.get(repo), reviews.get(repo)?.endedAt].filter(Boolean).sort().at(-1);
      return !!(s && s.endedAt && last && s.endedAt < last);
    };
    const unscanned = changed.filter((repo) => scans.get(repo)?.status !== "done" || stale(repo))
      .map((repo) => `${repo || "security"} (${stale(repo) ? "older than the last change" : scans.get(repo)?.status || "not run"})`);
    if (unscanned.length) return askOrStop(`The security stage hasn't passed for ${unscanned.join(", ")}.`);
  }
  return out("pass", "Every repo's build, review and security stage passed.");
}

/**
 * Tickets in flight (started, not done) other than this one, against the policy's WIP limit.
 * A ticket that's already in flight may always carry on (as the dashboard allows).
 */
export function wip(ws, ticket, policy) {
  const dir = path.join(ws, ".claude", "ledger", "factory");
  const same = (t) => String(t).toLowerCase() === String(ticket).toLowerCase();
  let started = [];
  try {
    started = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => readJson(path.join(dir, f)))
      .filter((m) => m && m.ticket && !m.done && ((m.stages || []).length || (m.gates || []).length));
  } catch {}
  const inFlight = started.filter((m) => !same(m.ticket)).map((m) => m.ticket);
  const self = started.some((m) => same(m.ticket));
  const p = normalizePolicy(policy);
  return { inFlight, limit: p.limits.wip, self, ok: !p.enabled || self || inFlight.length < p.limits.wip };
}

async function main(argv) {
  const args = parseArgs(argv);
  const [command] = args._;
  const start = typeof args.root === "string" ? path.resolve(args.root) : process.cwd();
  if (command === "policy") {
    const ws = sourceWorkspace(start);
    const p = readPolicy(ws);
    process.stdout.write(JSON.stringify(p ? { exists: true, ...p } : { exists: false }, null, 2) + "\n");
    return;
  }
  if (command === "stage-on") {
    if (!STAGES.includes(args.stage)) throw usage(`--stage must be one of ${STAGES.join(", ")}`);
    const policy = readPolicy(sourceWorkspace(start));
    const enabled = normalizePolicy(policy).enabled;
    process.stdout.write(JSON.stringify({ stage: args.stage, policy: enabled, on: enabled ? stageOn(policy, args.stage) : null }, null, 2) + "\n");
    return;
  }
  if (command === "decide" || command === "wip") {
    if (typeof args.ticket !== "string" || !args.ticket.trim()) throw usage("--ticket is required");
    const ws = sourceWorkspace(start);
    const policy = readPolicy(ws);
    const file = manifestPath(ws, args.ticket);
    const canAsk = args["can-ask"] === undefined ? undefined : args["can-ask"] !== "no";
    const r = command === "wip"
      ? wip(ws, args.ticket, policy)
      : decide(policy, file ? readJson(file) : null, args.gate, { run: args.run === "autonomous" ? "autonomous" : "interactive", ...(canAsk === undefined ? {} : { canAsk }) });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return;
  }
  const out = update(command, args, { start });
  process.stdout.write(JSON.stringify(out.skipped ? { skipped: out.skipped } : out.manifest, null, 2) + "\n");
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = e.usage ? 2 : 1;
  });
}

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
  const out = update(command, args, { start });
  process.stdout.write(JSON.stringify(out.skipped ? { skipped: out.skipped } : out.manifest, null, 2) + "\n");
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = e.usage ? 2 : 1;
  });
}

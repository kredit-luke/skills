/**
 * The software factory: agent work from ticket to merged PR, under a policy the team sets.
 *
 * - Policy: .claude/dashboard/factory.json (Settings → Factory), committed with the workspace
 *   so changes to it are reviewed. No file = the factory is off and these defaults (the
 *   Supervised preset) are what Settings starts from.
 * - Progress: each work item's manifest, <workspace>/.claude/ledger/factory/<ticket>.json,
 *   written by the pipeline as it goes (/multirepo:implement through its factory.mjs script;
 *   any pipeline that writes the same shape gets the board). The engine never scrapes transcripts.
 * - Board: one card per manifest, in the column of the first stage or gate it hasn't finished,
 *   joined with the runs for its ticket (cost, agent, a question waiting).
 */

import fs from "node:fs";
import path from "node:path";
import type {
  AgentId, FactoryAssessment, FactoryBoard, FactoryColumn, FactoryConfig, FactoryConfigState, FactoryGateId, FactoryGateMode, FactoryItem,
  FactoryItemStep, FactoryManifest, FactoryPreset, FactoryPresetPatch, FactoryRiskRule, FactoryScanner, FactorySpec, FactoryStageConfig, FactoryStageId, FactoryStepStatus, MergeMethod, RunStatus, Severity, SpecCheckId,
} from "../../shared/api.ts";
import { pipelineOrder, withPresetPatch } from "../../shared/factory-rules.ts";
import { CONFIG_DIR, LEDGER_DIR, readConfigFile, writeConfigFile } from "./config.ts";

export const FACTORY_FILE = "factory.json";
export const STAGE_IDS: FactoryStageId[] = ["align", "plan", "build", "review", "security", "qa", "guide", "pr", "approve", "merge"];
export const GATE_IDS: FactoryGateId[] = ["spec", "plan", "prePr", "merge"];
const GATE_MODES: FactoryGateMode[] = ["human", "approver", "auto", "off"];
const PRESETS: FactoryPreset[] = ["supervised", "risk-tiered", "lights-out", "custom"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const AGENTS: AgentId[] = ["claude", "copilot", "codex"];
const STEP: FactoryStepStatus[] = ["pending", "running", "done", "failed", "skipped"];
/** Manifests read at most (the newest). */
const MAX_MANIFESTS = 300;

export const STAGE_LABELS: Record<FactoryStageId, string> = {
  align: "Align", plan: "Planning", build: "Building", review: "Reviewing", security: "Security",
  qa: "QA", guide: "Guide", pr: "PR", approve: "Approver", merge: "Merge",
};
export const GATE_LABELS: Record<FactoryGateId, string> = { spec: "Spec gate", plan: "Plan gate", prePr: "Pre-PR gate", merge: "Merge gate" };

/** Scanners suggested by stack: each runs only in repos with the named file. */
export const SUGGESTED_SCANNERS: FactoryScanner[] = [
  { name: "npm audit", command: "npm audit --audit-level=high", when: "package-lock.json", failOn: "high" },
  { name: "pip-audit", command: "pip-audit -r requirements.txt", when: "requirements.txt", failOn: "high" },
  { name: "dotnet vulnerable packages", command: "dotnet list package --vulnerable --include-transitive", when: null, failOn: "high" },
  { name: "govulncheck", command: "govulncheck ./...", when: "go.mod", failOn: "high" },
];

/** spec-check.mjs's checks (multirepo plugin): what each looks for, and its default weight. */
export const SPEC_CHECKS: { id: SpecCheckId; label: string; help: string; weight: number }[] = [
  { id: "problem", label: "Problem", help: "What's wrong or needed, and for whom.", weight: 15 },
  { id: "outcome", label: "Outcome", help: "What's true when it's done.", weight: 15 },
  { id: "criteria", label: "Acceptance criteria", help: "Present, and testable: a behaviour, a value, or given/when/then.", weight: 25 },
  { id: "scope", label: "Scope", help: "What's in and what's out.", weight: 10 },
  { id: "constraints", label: "Constraints", help: "Performance, security, compatibility, data.", weight: 5 },
  { id: "affected", label: "Affected areas", help: "The repos, APIs or screens it touches.", weight: 10 },
  { id: "questions", label: "Open questions", help: "None left: no TBD, no unanswered question.", weight: 10 },
  { id: "verify", label: "How to verify", help: "Test or QA steps.", weight: 10 },
];
const SPEC_IDS = SPEC_CHECKS.map((c) => c.id);

const stage = (id: FactoryStageId, on: boolean): FactoryStageConfig => ({ id, on, agent: null, model: null, effort: null });

/** The Supervised preset with the factory off: what Settings starts from. */
export function defaultFactoryConfig(): FactoryConfig {
  return {
    enabled: false,
    preset: "supervised",
    mode: "interactive",
    intake: { states: [], labels: [] },
    limits: { wip: 3, itemBudgetUsd: null, dayBudgetUsd: null, itemHours: null },
    stages: STAGE_IDS.map((id) => stage(id, !["align", "qa", "approve"].includes(id))),
    security: { agentReview: true, secretScan: true, scanners: SUGGESTED_SCANNERS.filter((s) => s.when).map((s) => ({ ...s })), failOn: "high" },
    gates: { spec: "human", plan: "human", prePr: "human", merge: "human" },
    requiredChecks: [],
    reviewers: { bots: [], pipeline: true, noUnresolved: true },
    spec: { readyAt: 80, needsWorkAt: 50, minScore: null, weights: {} },
    approver: {
      enabled: false, enforce: false, identity: null,
      highRiskPaths: ["**/migrations/**", "**/auth/**", "infra/**", ".github/workflows/**", "**/*.lock"],
      highRiskLabels: ["security"],
      maxFiles: 20, maxLines: 400, maxRepos: 1,
      mergeAction: "none", mergeMethod: "squash", samplingPct: 0,
    },
  };
}

/** What each preset sets: gates, mode and the Approver. Everything else in the config is kept. */
export const PRESET_PATCHES: Record<Exclude<FactoryPreset, "custom">, FactoryPresetPatch> = {
  supervised: {
    label: "Supervised", description: "Every gate is a person. Agents do the work; you decide every step.",
    mode: null, gates: { spec: "human", plan: "human", prePr: "human", merge: "human" },
    approver: { enabled: false, mergeAction: "none", samplingPct: 0 }, approve: false,
  },
  "risk-tiered": {
    label: "Risk-tiered", description: "You approve the spec and plan; the Approver rates each PR's risk, and a person merges.",
    mode: null, gates: { spec: "human", plan: "human", prePr: "auto", merge: "approver" },
    approver: { enabled: true, mergeAction: "none", samplingPct: 0 }, approve: true,
  },
  "lights-out": {
    label: "Lights-out", description: "Runs unattended. The Approver auto-merges low-risk work and sends 10% to a person anyway.",
    mode: "autonomous", gates: { spec: "off", plan: "approver", prePr: "auto", merge: "approver" },
    approver: { enabled: true, mergeAction: "auto-merge", samplingPct: 10 }, approve: true,
  },
};

/** A preset applied to a config (the same as Settings does). */
export function applyPreset(c: FactoryConfig, preset: FactoryPreset): FactoryConfig {
  if (preset === "custom") return { ...JSON.parse(JSON.stringify(c)), preset };
  return withPresetPatch(c, preset, PRESET_PATCHES[preset]);
}

// ------------------------------------------------------------------ reading factory.json

const strs = (v: unknown, max = 50) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean))].slice(0, max) : null);
const pick = <T>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const optStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
function num(v: unknown, d: number, min: number, max: number): number {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
}
function numOrNull(v: unknown, min: number, max: number): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : null;
}

/** factory.json (any shape, maybe partial) with every default filled in and every value checked. */
export function normalizeFactoryConfig(raw: any): FactoryConfig {
  const d = defaultFactoryConfig();
  if (!raw || typeof raw !== "object") return d;
  const lim = raw.limits || {};
  const sec = raw.security || {};
  const rev = raw.reviewers || {};
  const ap = raw.approver || {};
  const gates = raw.gates || {};
  const sp = raw.spec || {};
  const weights: Partial<Record<SpecCheckId, number>> = {};
  for (const id of SPEC_IDS) {
    const w = sp.weights && sp.weights[id];
    if (w != null && w !== "" && Number.isFinite(Number(w))) weights[id] = Math.round(Math.min(Math.max(Number(w), 0), 100));
  }
  // Stages: the file's order for the ones it lists, the rest after in the default order; unknown ids dropped.
  const listed: FactoryStageConfig[] = [];
  for (const s of Array.isArray(raw.stages) ? raw.stages : []) {
    if (!s || !STAGE_IDS.includes(s.id) || listed.some((x) => x.id === s.id)) continue;
    listed.push({
      id: s.id, on: s.on !== false,
      agent: AGENTS.includes(s.agent) ? s.agent : null, model: optStr(s.model), effort: optStr(s.effort),
    });
  }
  const stages = [...listed, ...d.stages.filter((s) => !listed.some((x) => x.id === s.id))];
  const scanners = Array.isArray(sec.scanners)
    ? sec.scanners.filter((s: any) => s && typeof s.command === "string" && s.command.trim()).slice(0, 30).map((s: any): FactoryScanner => ({
      name: optStr(s.name) || s.command.trim().split(/\s+/).slice(0, 2).join(" "),
      command: s.command.trim().slice(0, 500),
      when: optStr(s.when),
      failOn: pick(s.failOn, SEVERITIES, "high"),
    }))
    : d.security.scanners;
  return {
    enabled: raw.enabled === true,
    preset: pick(raw.preset, PRESETS, "custom"),
    mode: pick(raw.mode, ["interactive", "autonomous"] as const, d.mode),
    intake: { states: strs(raw.intake?.states) ?? [], labels: strs(raw.intake?.labels) ?? [] },
    limits: {
      wip: Math.round(num(lim.wip, d.limits.wip, 1, 50)),
      itemBudgetUsd: numOrNull(lim.itemBudgetUsd, 0.01, 100_000),
      dayBudgetUsd: numOrNull(lim.dayBudgetUsd, 0.01, 1_000_000),
      itemHours: numOrNull(lim.itemHours, 0.1, 168),
    },
    stages,
    security: {
      agentReview: sec.agentReview !== false,
      secretScan: sec.secretScan !== false,
      scanners,
      failOn: pick(sec.failOn, SEVERITIES, d.security.failOn),
    },
    gates: Object.fromEntries(GATE_IDS.map((g) => [g, pick(gates[g], GATE_MODES, d.gates[g])])) as Record<FactoryGateId, FactoryGateMode>,
    requiredChecks: strs(raw.requiredChecks) ?? [],
    reviewers: { bots: strs(rev.bots) ?? [], pipeline: rev.pipeline !== false, noUnresolved: rev.noUnresolved !== false },
    spec: {
      readyAt: Math.round(num(sp.readyAt, d.spec.readyAt, 1, 100)),
      needsWorkAt: Math.round(num(sp.needsWorkAt, d.spec.needsWorkAt, 0, 100)),
      minScore: numOrNull(sp.minScore, 0, 100) == null ? null : Math.round(numOrNull(sp.minScore, 0, 100)!),
      weights,
    },
    approver: {
      enabled: ap.enabled === true,
      enforce: ap.enforce === true,
      identity: optStr(ap.identity),
      highRiskPaths: strs(ap.highRiskPaths, 100) ?? d.approver.highRiskPaths,
      highRiskLabels: strs(ap.highRiskLabels) ?? d.approver.highRiskLabels,
      maxFiles: Math.round(num(ap.maxFiles, d.approver.maxFiles, 1, 10_000)),
      maxLines: Math.round(num(ap.maxLines, d.approver.maxLines, 1, 1_000_000)),
      maxRepos: Math.round(num(ap.maxRepos, d.approver.maxRepos, 1, 100)),
      mergeAction: pick(ap.mergeAction, ["none", "auto-merge", "merge"] as const, "none"),
      mergeMethod: pick(ap.mergeMethod, ["squash", "merge", "rebase"] as MergeMethod[], "squash"),
      samplingPct: Math.round(num(ap.samplingPct, 0, 0, 100)),
    },
  };
}

/** Problems with a config that normalizing can't fix by itself (shown on save). */
export function factoryConfigProblems(c: FactoryConfig): string[] {
  const out: string[] = [];
  const on = (id: FactoryStageId) => c.stages.some((s) => s.id === id && s.on);
  if (!on("build")) out.push("The Build stage can't be turned off: it's where the work happens.");
  if (Object.values(c.gates).includes("approver") && !c.approver.enabled) out.push("A gate is set to the Approver, but the Approver is off.");
  if (c.approver.mergeAction !== "none" && c.gates.merge !== "approver") out.push("The Approver can only merge when the merge gate is set to the Approver.");
  if (c.approver.enabled && c.approver.enforce && !c.approver.identity) out.push("The Approver decides only as its own account: name its identity, or leave it advisory.");
  if (c.spec.needsWorkAt >= c.spec.readyAt) out.push("Spec readiness: \"Needs work\" has to start below \"Ready\".");
  if (SPEC_IDS.every((id) => (c.spec.weights[id] ?? SPEC_CHECKS.find((x) => x.id === id)!.weight) === 0)) out.push("Spec readiness: at least one check needs a weight.");
  return out;
}

export function factoryConfigState(canEdit: boolean, dir = CONFIG_DIR): FactoryConfigState {
  const f = readConfigFile(FACTORY_FILE, dir);
  let mtimeMs: number | null = null;
  try { mtimeMs = fs.statSync(f.file).mtimeMs; } catch {}
  return {
    config: normalizeFactoryConfig(f.data), exists: f.data != null || !!f.error, error: f.error, canEdit, mtimeMs,
    presets: PRESET_PATCHES, suggestedScanners: SUGGESTED_SCANNERS, stageLabels: STAGE_LABELS, gateLabels: GATE_LABELS, specChecks: SPEC_CHECKS,
  };
}

/** Saves factory.json; refuses a stale edit (the file changed since `mtimeMs`) and a config with problems. */
export function saveFactoryConfig(body: any, dir = CONFIG_DIR): FactoryConfigState {
  const bad = (status: number, message: string) => Object.assign(new Error(message), { status });
  const file = path.join(dir, FACTORY_FILE);
  let now: number | null = null;
  try { now = fs.statSync(file).mtimeMs; } catch {}
  const seen = body && body.mtimeMs != null ? Number(body.mtimeMs) : null;
  // Created, changed or deleted since the editor loaded it (a draft loaded without a file may create it).
  if ((now ?? null) !== (seen ?? null)) throw bad(409, "factory.json changed since you opened it. Reload and make your change again.");
  const config = normalizeFactoryConfig(body && body.config);
  const problems = factoryConfigProblems(config);
  if (problems.length) throw bad(400, problems.join(" "));
  writeConfigFile(FACTORY_FILE, config, dir);
  return factoryConfigState(true, dir);
}

// ------------------------------------------------------------------ manifests

export function manifestDir(ledgerDir = LEDGER_DIR): string { return path.join(ledgerDir, "factory"); }

const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** A manifest's spec readiness, or null when it has none (or isn't readable). */
export function normalizeSpec(raw: any): FactorySpec | null {
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.score) || !Array.isArray(raw.checks)) return null;
  const pct = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Math.round(Number(v)), 0), 100) : d);
  return {
    score: pct(raw.score, 0),
    level: pick(raw.level, ["ready", "needs-work", "not-ready"] as const, "not-ready"),
    readyAt: pct(raw.readyAt, 80), needsWorkAt: pct(raw.needsWorkAt, 50),
    minScore: raw.minScore == null ? null : pct(raw.minScore, 0),
    checks: raw.checks.filter((c: any) => c && SPEC_IDS.includes(c.id)).map((c: any) => ({
      id: c.id, label: optStr(c.label) || c.id, weight: Number.isFinite(c.weight) ? c.weight : 0,
      score: Number.isFinite(c.score) ? Math.min(Math.max(c.score, 0), 1) : 0,
      finding: typeof c.finding === "string" ? c.finding.slice(0, 500) : "",
      ...(c.override && typeof c.override.reason === "string" ? { override: { from: Number(c.override.from) || 0, reason: c.override.reason.slice(0, 500) } } : {}),
    })),
    at: iso(raw.at) || new Date(0).toISOString(),
  };
}

/** A manifest file's JSON as a FactoryManifest (unknown values dropped), or null when it isn't one. */
export function normalizeManifest(raw: any): FactoryManifest | null {
  if (!raw || typeof raw !== "object" || typeof raw.ticket !== "string" || !raw.ticket.trim()) return null;
  const started = iso(raw.startedAt) || new Date(0).toISOString();
  return {
    version: 1,
    ticket: raw.ticket.trim(),
    title: optStr(raw.title),
    url: typeof raw.url === "string" && /^https?:\/\//.test(raw.url) ? raw.url : null,
    mode: raw.mode === "autonomous" ? "autonomous" : "interactive",
    policy: raw.policy && typeof raw.policy === "object" ? { preset: PRESETS.includes(raw.policy.preset) ? raw.policy.preset : null, updatedAt: iso(raw.policy.updatedAt) } : null,
    workroot: typeof raw.workroot === "string" ? raw.workroot : null,
    branch: optStr(raw.branch),
    repos: strs(raw.repos, 100) ?? [],
    plan: typeof raw.plan === "string" ? raw.plan : null,
    startedAt: started,
    updatedAt: iso(raw.updatedAt) || started,
    roundStartedAt: iso(raw.roundStartedAt),
    spec: normalizeSpec(raw.spec),
    stages: (Array.isArray(raw.stages) ? raw.stages : []).filter((s: any) => s && STAGE_IDS.includes(s.id)).slice(0, 500).map((s: any) => ({
      id: s.id, repo: optStr(s.repo), agent: optStr(s.agent), status: pick(s.status, STEP, "pending"),
      startedAt: iso(s.startedAt), endedAt: iso(s.endedAt), note: typeof s.note === "string" ? s.note.slice(0, 4000) : null,
    })),
    gates: (Array.isArray(raw.gates) ? raw.gates : []).filter((g: any) => g && GATE_IDS.includes(g.id)).slice(0, 200).map((g: any) => ({
      id: g.id, mode: GATE_MODES.includes(g.mode) ? g.mode : null,
      decision: pick(g.decision, ["pending", "approved", "rejected"] as const, "pending"),
      by: optStr(g.by), risk: pick(g.risk, ["low", "medium", "high", null] as const, null),
      rationale: typeof g.rationale === "string" ? g.rationale.slice(0, 4000) : null,
      sha: optStr(g.sha), at: iso(g.at) || started,
    })),
    prs: (Array.isArray(raw.prs) ? raw.prs : []).filter((p: any) => p && typeof p.url === "string" && /^https?:\/\//.test(p.url)).slice(0, 50).map((p: any) => ({
      repo: optStr(p.repo), url: p.url, number: Number.isInteger(p.number) ? p.number : null,
      state: pick(p.state, ["open", "merged", "closed", null] as const, null),
    })),
    assessments: (Array.isArray(raw.assessments) ? raw.assessments : []).filter((a: any) => a && GATE_IDS.includes(a.gate) && RISK_LEVELS.includes(a.level)).slice(-100).map(normalizeAssessment),
    done: raw.done === true,
    error: optStr(raw.error),
  };
}

const RISK_LEVELS = ["low", "medium", "high"] as const;
const RULE_IDS: FactoryRiskRule["id"][] = ["path", "label", "security", "unknown", "files", "lines", "repos", "dependency"];
const texts = (v: unknown, n: number, max = 1000) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n).map((x: string) => x.trim().slice(0, max)) : []);

function normalizeAssessment(a: any): FactoryAssessment {
  return {
    gate: a.gate, level: a.level,
    rulesLevel: pick(a.rulesLevel, ["medium", "high", null] as const, null),
    judged: pick(a.judged, [...RISK_LEVELS, null], null),
    rules: (Array.isArray(a.rules) ? a.rules : []).filter((r: any) => r && RULE_IDS.includes(r.id)).slice(0, 50)
      .map((r: any) => ({ id: r.id, level: r.level === "high" ? "high" : "medium", detail: typeof r.detail === "string" ? r.detail.slice(0, 500) : "" })),
    rationale: typeof a.rationale === "string" ? a.rationale.slice(0, 2000) : null,
    concerns: texts(a.concerns, 10),
    wouldApprove: a.wouldApprove === true,
    blockers: texts(a.blockers, 20),
    sampled: a.sampled === true,
    enforced: a.enforced === true,
    action: pick(a.action, ["pass", "ask", "stop", "handoff"] as const, "handoff"),
    reason: typeof a.reason === "string" ? a.reason.slice(0, 1000) : "",
    by: optStr(a.by), sha: optStr(a.sha), at: iso(a.at) || new Date(0).toISOString(),
  };
}

/** Parsed manifests by file, kept until the file's mtime changes (the board reloads every few seconds). */
const parsed = new Map<string, { mtimeMs: number; manifest: FactoryManifest | null; error: string | null }>();

/**
 * The newest manifests in the folder (by file time, at most `limit`: the board's MAX_MANIFESTS; limits
 * are checked against all of them), newest first, plus the files that couldn't be read.
 */
export function readManifests(dir = manifestDir(), limit = MAX_MANIFESTS): { manifests: FactoryManifest[]; errors: string[] } {
  let files: { f: string; mtimeMs: number }[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => { try { return { f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return null; } })
      .filter((x): x is { f: string; mtimeMs: number } => !!x)
      .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  } catch { return { manifests: [], errors: [] }; }
  const manifests: FactoryManifest[] = [];
  const errors: string[] = [];
  for (const { f, mtimeMs } of files) {
    const file = path.join(dir, f);
    let hit = parsed.get(file);
    if (!hit || hit.mtimeMs !== mtimeMs) {
      try {
        const m = normalizeManifest(JSON.parse(fs.readFileSync(file, "utf-8")));
        hit = { mtimeMs, manifest: m, error: m ? null : `${f}: not a factory manifest (no ticket).` };
      } catch (e) { hit = { mtimeMs, manifest: null, error: `${f}: ${(e as Error).message}` }; }
      parsed.set(file, hit);
    }
    if (hit.manifest) manifests.push(hit.manifest);
    if (hit.error) errors.push(hit.error);
  }
  manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { manifests: manifests.slice(0, MAX_MANIFESTS), errors };
}

// ------------------------------------------------------------------ decisions from the dashboard

/** factory.mjs's lock on a manifest: `<file>.lock`, created exclusively, broken when older than this. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fn holding `<file>.lock` (the lock factory.mjs takes), waiting without blocking the server. */
async function withLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try { fd = fs.openSync(lock, "wx"); } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw Object.assign(new Error("The ticket's progress file is busy; try again."), { status: 409 });
      await sleep(25);
    }
  }
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

/** A ticket id as factory.mjs names its file: owner/repo#7 → owner_repo_7.json. */
export function ticketFile(ticket: string): string {
  return String(ticket).trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_") + ".json";
}

/** The manifest file for a ticket: by factory.mjs's file name, else (another writer's name) the newest manifests' tickets. */
export function manifestFile(ticket: string, dir = manifestDir()): string | null {
  const named = path.join(dir, ticketFile(ticket));
  const want = ticket.trim().toLowerCase();
  const holds = (file: string) => { try { return String(JSON.parse(fs.readFileSync(file, "utf-8")).ticket || "").toLowerCase() === want; } catch { return false; } };
  if (fs.existsSync(named) && holds(named)) return named;
  readManifests(dir, Infinity);
  for (const [file, hit] of parsed) if (path.dirname(file) === dir && hit.manifest && hit.manifest.ticket.toLowerCase() === want) return file;
  return null;
}

/** The gate rows of the ticket's current round (picking a finished ticket up again starts a new one). */
export function roundGates(m: FactoryManifest): FactoryManifest["gates"] {
  return m.roundStartedAt ? m.gates.filter((g) => g.at >= m.roundStartedAt!) : m.gates;
}

/**
 * Records a person's decision at the gate a ticket is waiting at: appended to its gates (the audit
 * trail). A rejection ends the item (done, with why). Refused when the ticket isn't waiting there;
 * `guard` runs inside the lock, just before writing (it throws to refuse).
 */
export async function recordGateDecision(ticket: string, gate: FactoryGateId, decision: "approved" | "rejected", by: string, note: string | null,
  { dir = manifestDir(), now = new Date().toISOString(), guard }: { dir?: string; now?: string; guard?: () => void } = {}): Promise<FactoryManifest> {
  const bad = (status: number, message: string) => Object.assign(new Error(message), { status });
  if (!GATE_IDS.includes(gate)) throw bad(400, "Unknown gate.");
  if (decision !== "approved" && decision !== "rejected") throw bad(400, "Decide approved or rejected.");
  const file = manifestFile(ticket, dir);
  if (!file) throw bad(404, `${ticket} isn't in the factory.`);
  return withLock(file, () => {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const gates = Array.isArray(raw.gates) ? raw.gates : [];
    const last = [...gates].reverse().find((g: any) => g && g.id === gate);
    if (raw.done) throw bad(409, `${ticket} is finished.`);
    // Only the gate's latest request, in the ticket's current round, can be answered.
    const round = typeof raw.roundStartedAt === "string" ? raw.roundStartedAt : null;
    if (!last || last.decision !== "pending" || (round && !(typeof last.at === "string" && last.at >= round))) throw bad(409, `${ticket} isn't waiting at the ${GATE_LABELS[gate].toLowerCase()}.`);
    guard?.();
    const why = note && note.trim() ? note.trim().slice(0, 2000) : null;
    gates.push({ id: gate, mode: last.mode ?? null, decision, by, risk: null, rationale: why, sha: null, at: now });
    raw.gates = gates;
    if (decision === "rejected") { raw.done = true; raw.error = `${GATE_LABELS[gate]} rejected by ${by}${why ? `: ${why}` : ""}`; }
    raw.updatedAt = now;
    writeConfigFile(path.basename(file), raw, path.dirname(file));
    return normalizeManifest(raw)!;
  });
}

/**
 * The plan file a ticket's manifest names: { path, text }. Only from ~/.claude/plans, or from the
 * ticket's work folder when that's one of this workspace's own (`workspaces`: main and its
 * worktrees). The manifest's word alone isn't trusted, and symlinks are resolved first.
 */
export function readPlan(m: FactoryManifest, home: string, workspaces: string[], maxBytes = 300_000): { path: string; text: string } {
  const bad = (status: number, message: string) => Object.assign(new Error(message), { status });
  if (!m.plan) throw bad(404, `${m.ticket} has no plan file recorded.`);
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
  const p = real(path.resolve(m.plan.replace(/^~(?=$|[\\/])/, home)));
  if (!p) throw bad(404, `The plan file isn't there: ${m.plan}`);
  const under = (root: string | null, x: string) => { if (!root) return false; const r = path.relative(root, x); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const roots = workspaces.map(real).filter((x): x is string => !!x);
  const workroot = m.workroot ? real(m.workroot) : null;
  const workOk = !!workroot && roots.some((r) => under(r, workroot));
  const plans = real(path.join(home, ".claude", "plans"));
  if (!(plans && under(plans, p) && p !== plans) && !(workOk && under(workroot, p))) throw bad(403, "The plan isn't in ~/.claude/plans or the ticket's work folder.");
  const st = fs.statSync(p);
  if (!st.isFile()) throw bad(404, `The plan isn't a file: ${m.plan}`);
  const text = fs.readFileSync(p, "utf-8");
  return { path: p, text: st.size > maxBytes ? text.slice(0, maxBytes) + "\n\n…(cut here)" : text };
}

// ------------------------------------------------------------------ the board

/** One step of the pipeline: a stage that's on, or a gate that isn't off. */
export type PipelineStep = { kind: "stage"; id: FactoryStageId } | { kind: "gate"; id: FactoryGateId; mode: FactoryGateMode };

/**
 * The pipeline in order: the stages that are on, with each gate that isn't off placed where it
 * guards: spec before planning, plan after it, pre-PR before the PR, merge before merging.
 */
export function pipeline(c: FactoryConfig): PipelineStep[] {
  // shared/factory-rules.ts: the Factory policy page previews the same order.
  return pipelineOrder(c) as PipelineStep[];
}

export function boardColumns(c: FactoryConfig): FactoryColumn[] {
  return [
    { id: "queued", label: "Queued", kind: "queued" },
    ...pipeline(c).map((s): FactoryColumn => s.kind === "stage"
      ? { id: s.id, label: STAGE_LABELS[s.id], kind: "stage" }
      : { id: `gate:${s.id}`, label: GATE_LABELS[s.id], kind: "gate" }),
    { id: "done", label: "Done", kind: "done" },
  ];
}

/** A run of the item's ticket, as the board needs it. */
export interface FactoryRun {
  id: string; ticket: string | null; status: RunStatus; costUsd: number; startedAt: string; agent: string | null; model: string | null;
  durationMs?: number;
  /** An implement run (counts toward WIP while it's going, before it has reported anything). */
  implement?: boolean;
}

const WHO: Record<FactoryGateMode, string> = { human: "you", approver: "the Approver", auto: "its checks", off: "" };

/** Where an item is: the first step it hasn't finished, and whether it's moving, waiting or failing. */
export function placeItem(full: FactoryManifest, steps: PipelineStep[]): { column: string; state: FactoryItem["state"]; reason: string | null } {
  const m = { ...full, gates: roundGates(full) };
  // Stopped short (spec or plan rejected, aborted): it stays where it stopped, failing, with why.
  if (m.done && m.error) {
    const at = placeItem({ ...m, done: false, error: null }, steps);
    return { column: at.column, state: "failing", reason: `Stopped: ${m.error}` };
  }
  if (m.done || (m.prs.length && m.prs.every((p) => p.state === "merged"))) return { column: "done", state: "done", reason: null };
  const hasActivity = (i: number) => steps.slice(i).some((s) => (s.kind === "stage" ? m.stages.some((x) => x.id === s.id) : m.gates.some((g) => g.id === s.id)));
  const nothing = !m.stages.length && !m.gates.length;
  if (nothing) return { column: "queued", state: "idle", reason: null };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const col = s.kind === "stage" ? s.id : `gate:${s.id}`;
    if (s.kind === "stage") {
      const rows = m.stages.filter((x) => x.id === s.id);
      if (!rows.length) { if (hasActivity(i + 1)) continue; return { column: col, state: "idle", reason: null }; }
      // The latest row per repo decides (a failed review then a passing one is passing).
      const latest = new Map<string, FactoryStepStatus>();
      for (const r of rows) latest.set(r.repo || "", r.status);
      const states = [...latest.values()];
      if (states.includes("failed")) return { column: col, state: "failing", reason: `${STAGE_LABELS[s.id]} failed` };
      if (states.includes("running")) return { column: col, state: "moving", reason: null };
      if (states.includes("pending")) return { column: col, state: "idle", reason: null };
      continue;
    }
    const last = m.gates.filter((g) => g.id === s.id).at(-1);
    if (!last) { if (hasActivity(i + 1)) continue; return { column: col, state: "idle", reason: null }; }
    if (last.decision === "approved") continue;
    if (last.decision === "rejected") return { column: col, state: "failing", reason: `Rejected${last.by ? ` by ${last.by}` : ""}` };
    const mode = last.mode || s.mode;
    return { column: col, state: "waiting", reason: `Waiting on ${WHO[mode] || "a decision"}` };
  }
  // Every step finished: waiting on the PR to merge.
  return { column: "done", state: m.prs.length ? "waiting" : "done", reason: m.prs.length ? "PR open" : null };
}

/** The newest row per repo, in first-seen order (a pipeline may append a retry instead of updating its row). */
function latestPerRepo<T extends { repo: string | null }>(rows: T[]): T[] {
  const by = new Map<string, T>();
  for (const r of rows) by.set(r.repo ?? "", r);
  return [...by.values()];
}

const sameTicket = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Why the factory won't start another run for a ticket, or null. Only with the factory on:
 * the ticket's budget or agent hours are used up, the day's factory budget is spent (runs of
 * tickets on the board, started today), or the WIP limit is full and this ticket isn't already
 * in flight (carrying on with one in flight is fine). In flight: a manifest that has started and
 * isn't done, or an implement run that's going (it may not have reported yet).
 */
export function factoryLaunchBlocker(cfg: FactoryConfig, configured: boolean, ticket: string, manifests: FactoryManifest[], runs: FactoryRun[], now = Date.now()): string | null {
  if (!configured || !cfg.enabled) return null;
  const mine = runs.filter((r) => sameTicket(r.ticket, ticket));
  const { itemBudgetUsd, dayBudgetUsd, itemHours, wip } = cfg.limits;
  const spent = mine.reduce((s, r) => s + (r.costUsd || 0), 0);
  if (itemBudgetUsd != null && spent >= itemBudgetUsd) return `${ticket} has used ${money(spent)} of its ${money(itemBudgetUsd)} budget (Factory policy). Raise the budget on Factory → Policy to carry on.`;
  const hours = mine.reduce((s, r) => s + (r.durationMs || 0), 0) / 3_600_000;
  if (itemHours != null && hours >= itemHours) return `${ticket} has had ${hours.toFixed(1)} of its ${itemHours} agent hours (Factory policy). Raise the limit on Factory → Policy to carry on.`;
  if (dayBudgetUsd != null) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const onBoard = (t: string | null) => manifests.some((m) => sameTicket(m.ticket, t));
    const today = runs.filter((r) => Date.parse(r.startedAt) >= day.getTime() && onBoard(r.ticket)).reduce((s, r) => s + (r.costUsd || 0), 0);
    if (today >= dayBudgetUsd) return `The factory has spent ${money(today)} of its ${money(dayBudgetUsd)} budget today (Factory policy).`;
  }
  const started = (m: FactoryManifest) => !m.done && (m.stages.length > 0 || m.gates.length > 0);
  const going = (r: FactoryRun) => !!r.implement && !!r.ticket && (r.status === "running" || r.status === "waiting");
  const inFlight = new Map<string, string>();
  for (const m of manifests) if (started(m)) inFlight.set(m.ticket.toLowerCase(), m.ticket);
  for (const r of runs) if (going(r)) inFlight.set(r.ticket!.toLowerCase(), r.ticket!);
  if (!inFlight.has(ticket.toLowerCase())) {
    const others = [...inFlight.values()];
    if (others.length >= wip) return `${others.length} ${others.length === 1 ? "ticket is" : "tickets are"} already in the factory (WIP limit ${wip}): ${others.slice(0, 5).join(", ")}. Finish one first, or raise the limit on Factory → Policy.`;
  }
  return null;
}

/** The gate an item waits at for a decision: its current step, a gate whose last decision is pending. */
export function waitingGate(m: FactoryManifest, steps: FactoryItemStep[]): FactoryItem["waitingGate"] {
  const s = steps.find((x) => x.current && x.kind === "gate" && x.state === "waiting");
  if (!s || m.done) return null;
  const last = s.decisions.at(-1)!;
  return { id: s.id.replace(/^gate:/, "") as FactoryGateId, label: s.label, mode: last.mode, since: last.at, reason: last.rationale };
}

/** Every pipeline step for one item: its state, times, per-repo rows and gate decisions. */
export function itemSteps(m: FactoryManifest, steps: PipelineStep[], column: string): FactoryItemStep[] {
  const colId = (s: PipelineStep) => (s.kind === "stage" ? s.id : `gate:${s.id}`);
  const laterActivity = (i: number) => steps.slice(i + 1).some((s) => (s.kind === "stage" ? m.stages.some((x) => x.id === s.id) : m.gates.some((g) => g.id === s.id)));
  const minIso = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort()[0] ?? null;
  const maxIso = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
  return steps.map((s, i): FactoryItemStep => {
    const id = colId(s);
    const base = { id, kind: s.kind as FactoryItemStep["kind"], label: s.kind === "stage" ? STAGE_LABELS[s.id] : GATE_LABELS[s.id], current: id === column, repos: [] as FactoryItemStep["repos"], decisions: [] as FactoryItemStep["decisions"] };
    if (s.kind === "stage") {
      const rows = latestPerRepo(m.stages.filter((x) => x.id === s.id));
      const repos = rows.map((r) => ({ repo: r.repo, status: r.status, agent: r.agent, note: r.note, startedAt: r.startedAt, endedAt: r.endedAt }));
      const st = rows.map((r) => r.status);
      const state: FactoryItemStep["state"] = !rows.length ? (laterActivity(i) || m.done ? "skipped" : "pending")
        : st.includes("failed") ? "failed" : st.includes("running") ? "running" : st.includes("pending") ? "pending"
        : st.every((x) => x === "skipped") ? "skipped" : "done";
      const finished = state === "done" || state === "skipped" || state === "failed";
      return { ...base, repos, state, startedAt: minIso(rows.map((r) => r.startedAt)), endedAt: finished ? maxIso(rows.map((r) => r.endedAt)) : null };
    }
    const hist = roundGates(m).filter((g) => g.id === s.id).map((g) => ({ decision: g.decision, mode: g.mode, by: g.by, risk: g.risk, rationale: g.rationale, at: g.at }));
    const last = hist.at(-1);
    const state: FactoryItemStep["state"] = !last ? (laterActivity(i) || m.done ? "skipped" : "pending")
      : last.decision === "approved" ? "done" : last.decision === "rejected" ? "failed" : "waiting";
    return { ...base, decisions: hist, state, startedAt: hist[0]?.at ?? null, endedAt: last && last.decision !== "pending" ? last.at : null };
  });
}

/** The Factory board: every manifest placed in its column, joined with its ticket's runs. */
export function buildBoard(cfg: FactoryConfig, configured: boolean, manifests: FactoryManifest[], runs: FactoryRun[], errors: string[] = [], canDecide = false): FactoryBoard {
  const steps = pipeline(cfg);
  const order = new Map(steps.map((s, i) => [s.kind === "stage" ? s.id : `gate:${s.id}`, i]));
  const items = manifests.map((m): FactoryItem => {
    const mine = runs.filter((r) => r.ticket && r.ticket.toLowerCase() === m.ticket.toLowerCase()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    let { column, state, reason } = placeItem(m, steps);
    // A live run says more than the manifest's last write: a question waiting, or work going on.
    const live = mine.find((r) => r.status === "waiting" || r.status === "running");
    if (state !== "done" && live) {
      if (live.status === "waiting") { state = "waiting"; reason = "Question waiting"; }
      else if (state === "idle") state = "moving";
    }
    const repos = [...new Set([...m.repos, ...m.stages.map((s) => s.repo).filter((r): r is string => !!r)])].map((repo) => {
      const rows = m.stages.filter((s) => s.repo === repo);
      let best: (typeof rows)[number] | null = null;
      for (const r of rows) if (!best || (order.get(r.id) ?? -1) >= (order.get(best.id) ?? -1)) best = r;
      return { repo, status: best ? best.status : "pending" as FactoryStepStatus, stage: best ? best.id : null };
    });
    const assessed = m.assessments.filter((a) => !m.roundStartedAt || a.at >= m.roundStartedAt).at(-1) || null;
    const gateRisk = m.gates.filter((g) => g.risk).at(-1);
    const risk = assessed ? { risk: assessed.level, rationale: assessed.rationale || assessed.reason } : gateRisk;
    const itemStepList = itemSteps(m, steps, column);
    return {
      ticket: m.ticket, title: m.title, url: m.url, column, state, reason,
      branch: m.branch, workroot: m.workroot, repos,
      agent: mine[0]?.agent ?? m.stages.filter((s) => s.agent).at(-1)?.agent ?? null,
      model: mine[0]?.model ?? null,
      startedAt: m.startedAt, updatedAt: m.updatedAt,
      costUsd: Math.round(mine.reduce((sum, r) => sum + (r.costUsd || 0), 0) * 100) / 100,
      budgetUsd: cfg.limits.itemBudgetUsd,
      prs: m.prs,
      risk: risk ? { level: risk.risk!, rationale: risk.rationale } : null,
      approver: assessed,
      runIds: mine.map((r) => r.id),
      askingRunId: (mine.find((r) => r.status === "waiting" && r.implement) || mine.find((r) => r.status === "waiting"))?.id ?? null,
      implementLive: mine.some((r) => r.implement && (r.status === "running" || r.status === "waiting")),
      steps: itemStepList,
      waitingGate: waitingGate(m, itemStepList),
      mode: m.mode, spec: m.spec, plan: m.plan, error: m.error,
    };
  });
  return {
    enabled: configured && cfg.enabled,
    configured,
    preset: configured ? cfg.preset : null,
    columns: boardColumns(cfg),
    items,
    wip: { inFlight: items.filter((i) => i.column !== "done" && i.column !== "queued").length, limit: cfg.limits.wip },
    errors,
    canDecide,
  };
}

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
  AgentId, FactoryAssessment, FactoryAuditRow, FactoryBoard, FactoryNotice, FactoryNoticeEvent, FactoryWebhook, FactoryIntake, FactoryMetrics, FactoryRating, FactoryRatingValue, FactoryColumn, FactoryConfig, FactoryConfigState, FactoryGateId, FactoryGateMode, FactoryItem,
  FactoryItemStep, FactoryManifest, FactoryPreset, FactoryPresetPatch, FactoryRiskRule, FactoryScanner, FactorySpec, FactoryStageConfig, FactoryStageId, FactoryStepStatus, MergeMethod, ReviewRelated, RunStatus, Severity, SpecCheckId,
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
    intake: { states: [], labels: [], auto: false, everyMinutes: 30, unassigned: false },
    limits: { wip: 3, itemBudgetUsd: null, dayBudgetUsd: null, itemHours: null },
    stages: STAGE_IDS.map((id) => stage(id, !["align", "qa", "approve"].includes(id))),
    security: { agentReview: true, secretScan: true, scanners: SUGGESTED_SCANNERS.filter((s) => s.when).map((s) => ({ ...s })), failOn: "high" },
    gates: { spec: "human", plan: "human", prePr: "human", merge: "human" },
    requiredChecks: [],
    reviewers: { bots: [], pipeline: true, noUnresolved: true },
    spec: { readyAt: 80, needsWorkAt: 50, minScore: null, weights: {} },
    notifications: { inbox: true, webhooks: [] },
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
    intake: {
      states: strs(raw.intake?.states) ?? [], labels: strs(raw.intake?.labels) ?? [],
      auto: raw.intake?.auto === true, everyMinutes: Math.round(num(raw.intake?.everyMinutes, d.intake.everyMinutes, 5, 1440)),
      unassigned: raw.intake?.unassigned === true,
    },
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
    notifications: {
      inbox: raw.notifications?.inbox !== false,
      webhooks: (Array.isArray(raw.notifications?.webhooks) ? raw.notifications.webhooks : [])
        .filter((w: any) => w && (webhookUrl(w.url) || ENV_NAME.test(String(w.env || "")))).slice(0, 10)
        .map((w: any): FactoryWebhook => ({
          url: webhookUrl(w.url), env: ENV_NAME.test(String(w.env || "")) ? String(w.env) : null,
          // No events listed: the ones that need someone. An empty list: muted.
          events: Array.isArray(w.events) ? [...new Set(w.events.filter((e: any) => NOTICE_EVENTS.includes(e)))] as FactoryNoticeEvent[] : [...DEFAULT_NOTICE_EVENTS],
        })),
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

export const NOTICE_EVENTS: FactoryNoticeEvent[] = ["gate-waiting", "stage-failed", "budget", "stopped", "merged"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/** An http(s) address that parses, trimmed; else null. */
export function webhookUrl(v: unknown): string | null {
  if (typeof v !== "string" || !/^https?:\/\//i.test(v.trim())) return null;
  try { new URL(v.trim()); return v.trim(); } catch { return null; }
}

/** Where a webhook posts: its address, or its env variable's (when that's set to one); null when neither. */
export function webhookTarget(w: FactoryWebhook, env: Record<string, string | undefined> = process.env): string | null {
  return w.env ? webhookUrl(env[w.env]) : w.url;
}
/** A webhook that names no events gets these: the ones that need someone. */
const DEFAULT_NOTICE_EVENTS: FactoryNoticeEvent[] = ["gate-waiting", "stage-failed", "budget", "stopped"];

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
  const config = normalizeFactoryConfig(f.data);
  // A webhook address is a secret: a read-only viewer sees only its host.
  if (!canEdit) config.notifications.webhooks = config.notifications.webhooks.map((w) => ({ ...w, url: w.url ? `${new URL(w.url).origin}/…` : null }));
  return {
    config, exists: f.data != null || !!f.error, error: f.error, canEdit, mtimeMs,
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
      ...(Number.isInteger(s.failures) && s.failures > 0 ? { failures: s.failures } : {}),
    })),
    gates: (Array.isArray(raw.gates) ? raw.gates : []).filter((g: any) => g && GATE_IDS.includes(g.id)).slice(0, 200).map((g: any) => ({
      id: g.id, mode: GATE_MODES.includes(g.mode) ? g.mode : null,
      decision: pick(g.decision, ["pending", "approved", "rejected"] as const, "pending"),
      by: optStr(g.by), risk: pick(g.risk, ["low", "medium", "high", null] as const, null),
      rationale: typeof g.rationale === "string" ? g.rationale.slice(0, 4000) : null,
      sha: optStr(g.sha), at: iso(g.at) || started,
      ...(g.override === true ? { override: true } : {}),
    })),
    prs: (Array.isArray(raw.prs) ? raw.prs : []).filter((p: any) => p && typeof p.url === "string" && /^https?:\/\//.test(p.url)).slice(0, 50).map((p: any) => ({
      repo: optStr(p.repo), url: p.url, number: Number.isInteger(p.number) ? p.number : null,
      state: pick(p.state, ["open", "merged", "closed", null] as const, null),
    })),
    assessments: (Array.isArray(raw.assessments) ? raw.assessments : []).filter((a: any) => a && GATE_IDS.includes(a.gate) && RISK_LEVELS.includes(a.level)).slice(-100).map(normalizeAssessment),
    ratings: (Array.isArray(raw.ratings) ? raw.ratings : []).filter((r: any) => r && iso(r.assessmentAt) && GATE_IDS.includes(r.gate) && RATINGS.includes(r.rating)).slice(-200).map((r: any): FactoryRating => ({
      assessmentAt: iso(r.assessmentAt)!, gate: r.gate, level: pick(r.level, RISK_LEVELS, "medium"), wouldApprove: r.wouldApprove === true,
      rating: r.rating, by: optStr(r.by) || "someone", note: typeof r.note === "string" ? r.note.slice(0, 1000) : null, at: iso(r.at) || started,
    })),
    finishedAt: iso(raw.finishedAt),
    retro: raw.retro && typeof raw.retro === "object" ? {
      caught: texts(raw.retro.caught, 20), wrong: texts(raw.retro.wrong, 20), approver: typeof raw.retro.approver === "string" && raw.retro.approver.trim() ? raw.retro.approver.trim().slice(0, 1000) : null,
      proposals: texts(raw.retro.proposals, 20), at: iso(raw.retro.at) || started,
    } : null,
    done: raw.done === true,
    error: optStr(raw.error),
  };
}

const RISK_LEVELS = ["low", "medium", "high"] as const;
const RATINGS: FactoryRatingValue[] = ["right", "should-have-asked", "could-have-approved"];
/** Who approves without a person: a gate's checks ("auto") or the Approver. */
const AUTOMATIC = ["auto", "approver"];
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

/**
 * Parsed manifests by file, kept until the file's mtime or size changes (the board reloads every few
 * seconds). Size too: two writes can land in the same mtime tick, which on Windows is coarse. And a
 * file whose mtime was within RACY_MS of when it was cached is read again every time (git's "racy"
 * rule): another process can rewrite it at the same size inside that tick. Within RACY_MS either
 * way, so a future mtime (clock skew) is cached like any other rather than re-read on every poll.
 */
const parsed = new Map<string, { mtimeMs: number; size: number; cachedAt: number; manifest: FactoryManifest | null; error: string | null }>();
const RACY_MS = 2000;

/**
 * The newest manifests in the folder (by file time, at most `limit`: the board's MAX_MANIFESTS; limits
 * are checked against all of them), newest first, plus the files that couldn't be read.
 */
export function readManifests(dir = manifestDir(), limit = MAX_MANIFESTS): { manifests: FactoryManifest[]; errors: string[] } {
  let files: { f: string; mtimeMs: number; size: number }[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => { try { const s = fs.statSync(path.join(dir, f)); return { f, mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } })
      .filter((x): x is { f: string; mtimeMs: number; size: number } => !!x)
      .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  } catch { return { manifests: [], errors: [] }; }
  const manifests: FactoryManifest[] = [];
  const errors: string[] = [];
  for (const { f, mtimeMs, size } of files) {
    const file = path.join(dir, f);
    let hit = parsed.get(file);
    if (!hit || hit.mtimeMs !== mtimeMs || hit.size !== size || Math.abs(mtimeMs - hit.cachedAt) < RACY_MS) {
      const cachedAt = Date.now();
      try {
        const m = normalizeManifest(JSON.parse(fs.readFileSync(file, "utf-8")));
        hit = { mtimeMs, size, cachedAt, manifest: m, error: m ? null : `${f}: not a factory manifest (no ticket).` };
      } catch (e) { hit = { mtimeMs, size, cachedAt, manifest: null, error: `${f}: ${(e as Error).message}` }; }
      parsed.set(file, hit);
    }
    if (hit.manifest) manifests.push(hit.manifest);
    if (hit.error) errors.push(hit.error);
  }
  manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { manifests: manifests.slice(0, limit), errors };
}

// ------------------------------------------------------------------ decisions from the dashboard

/** factory.mjs's lock on a manifest: `<file>.lock`, created exclusively, broken when older than this. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_DELETE_WAIT_MS = 500; // Windows EPERM/EACCES/EBUSY while another writer deletes its lock
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fn holding `<file>.lock` (the lock factory.mjs takes), waiting without blocking the server. */
async function withLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  let deletingSince = 0;
  while (fd === null) {
    try { fd = fs.openSync(lock, "wx"); } catch (e: any) {
      // On Windows, opening a lock another writer is deleting fails with EPERM (or EACCES, EBUSY): wait it out
      // too, but only briefly; one that lasts is a real permission error, so it's rethrown.
      const deleting = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(e.code);
      if (e.code !== "EEXIST" && !deleting) throw e;
      deletingSince = deleting ? deletingSince || Date.now() : 0;
      if (deleting && Date.now() - deletingSince > LOCK_DELETE_WAIT_MS) throw e;
      if (!deleting) try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw Object.assign(new Error(`The ticket's progress file is busy${deleting ? ` (last error: ${e.code})` : ""}; try again.`), { status: 409 });
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

const httpErr = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Changes a ticket's manifest under its lock: `change` gets the file's JSON (and it read as a
 * manifest), changes the JSON or throws to refuse; the file is written back with updatedAt.
 */
async function updateManifest(ticket: string, dir: string, now: string, change: (raw: any, m: FactoryManifest) => void): Promise<FactoryManifest> {
  const file = manifestFile(ticket, dir);
  if (!file) throw httpErr(404, `${ticket} isn't in the factory.`);
  return withLock(file, () => {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const m = normalizeManifest(raw);
    if (!m) throw httpErr(404, `${ticket} isn't in the factory.`);
    change(raw, m);
    raw.updatedAt = now;
    writeConfigFile(path.basename(file), raw, path.dirname(file));
    parsed.delete(file); // the next read sees this write, even within the same mtime and size
    return normalizeManifest(raw)!;
  });
}

const appendGate = (raw: any, row: object) => { raw.gates = [...(Array.isArray(raw.gates) ? raw.gates : []), row]; };

/**
 * Records a person's decision at the gate a ticket is waiting at: appended to its gates (the audit
 * trail). A rejection ends the item (done, with why). Refused when the ticket isn't waiting there;
 * `guard` runs inside the lock, just before writing (it throws to refuse).
 */
export async function recordGateDecision(ticket: string, gate: FactoryGateId, decision: "approved" | "rejected", by: string, note: string | null,
  { dir = manifestDir(), now = new Date().toISOString(), guard }: { dir?: string; now?: string; guard?: () => void } = {}): Promise<FactoryManifest> {
  if (!GATE_IDS.includes(gate)) throw httpErr(400, "Unknown gate.");
  if (decision !== "approved" && decision !== "rejected") throw httpErr(400, "Decide approved or rejected.");
  return updateManifest(ticket, dir, now, (raw) => {
    const gates = Array.isArray(raw.gates) ? raw.gates : [];
    const last = [...gates].reverse().find((g: any) => g && g.id === gate);
    if (raw.done) throw httpErr(409, `${ticket} is finished.`);
    // Only the gate's latest request, in the ticket's current round, can be answered.
    const round = typeof raw.roundStartedAt === "string" ? raw.roundStartedAt : null;
    if (!last || last.decision !== "pending" || (round && !(typeof last.at === "string" && last.at >= round))) throw httpErr(409, `${ticket} isn't waiting at the ${GATE_LABELS[gate].toLowerCase()}.`);
    guard?.();
    const why = note && note.trim() ? note.trim().slice(0, 2000) : null;
    appendGate(raw, { id: gate, mode: last.mode ?? null, decision, by, risk: null, rationale: why, sha: null, at: now });
    if (decision === "rejected") { raw.done = true; raw.finishedAt = now; raw.error = `${GATE_LABELS[gate]} rejected by ${by}${why ? `: ${why}` : ""}`; }
  });
}

/**
 * The automatic approval (by the gate's checks or the Approver) a person may override: a gate
 * whose latest row this round, pending ones included, is one. The newest such gate, or null.
 */
export function overridableGate(m: FactoryManifest): FactoryManifest["gates"][number] | null {
  if (m.done) return null;
  const last = new Map<FactoryGateId, FactoryManifest["gates"][number]>();
  for (const g of roundGates(m)) last.set(g.id, g);
  return [...last.values()].filter((g) => g.decision === "approved" && AUTOMATIC.includes(g.by || "")).sort((a, b) => b.at.localeCompare(a.at))[0] || null;
}

/**
 * A person overrides an automatic approval at a gate (see overridableGate): it's recorded as their
 * rejection, marked as an override, and the ticket stops, as any rejection does.
 */
export async function overrideGateDecision(ticket: string, gate: FactoryGateId, by: string, note: string | null,
  { dir = manifestDir(), now = new Date().toISOString(), guard }: { dir?: string; now?: string; guard?: () => void } = {}): Promise<FactoryManifest> {
  if (!GATE_IDS.includes(gate)) throw httpErr(400, "Unknown gate.");
  const why = note && note.trim() ? note.trim().slice(0, 2000) : null;
  if (!why) throw httpErr(400, "Say why you're overriding it: it goes in the audit log.");
  return updateManifest(ticket, dir, now, (raw, m) => {
    if (m.done) throw httpErr(409, `${ticket} is finished: rate the Approver's call instead.`);
    const last = roundGates(m).filter((g) => g.id === gate).at(-1);
    if (!last || last.decision !== "approved" || !AUTOMATIC.includes(last.by || "")) throw httpErr(409, `The ${GATE_LABELS[gate].toLowerCase()}'s latest decision isn't an automatic approval.`);
    guard?.();
    const what = last.by === "auto" ? "its checks'" : "the Approver's";
    appendGate(raw, { id: gate, mode: "human", decision: "rejected", by, risk: last.risk, rationale: `Overrode ${what} approval: ${why}`, sha: last.sha, at: now, override: true });
    raw.done = true;
    raw.finishedAt = now;
    raw.error = `${GATE_LABELS[gate]}: ${by} overrode ${what} approval: ${why}`;
  });
}

/** A person's rating of one of the Approver's assessments (found by when it was made), appended. */
export async function rateAssessment(ticket: string, assessmentAt: string, rating: FactoryRatingValue, by: string, note: string | null,
  { dir = manifestDir(), now = new Date().toISOString() }: { dir?: string; now?: string } = {}): Promise<FactoryManifest> {
  if (!RATINGS.includes(rating)) throw httpErr(400, "Rate it right, should-have-asked or could-have-approved.");
  return updateManifest(ticket, dir, now, (raw, m) => {
    const a = m.assessments.find((x) => x.at === assessmentAt);
    if (!a) throw httpErr(404, "That assessment isn't there any more.");
    raw.ratings = [...(Array.isArray(raw.ratings) ? raw.ratings : []),
      { assessmentAt, gate: a.gate, level: a.level, wouldApprove: a.wouldApprove, rating, by, note: note && note.trim() ? note.trim().slice(0, 1000) : null, at: now }];
  });
}

/**
 * The code host's word on a ticket's PRs (url → open, merged or closed), written to its manifest:
 * nothing else updates a PR row once it's opened, and Merged, the retro and the metrics go by them.
 */
export async function setPrStates(ticket: string, states: Record<string, "open" | "merged" | "closed">,
  { dir = manifestDir(), now = new Date().toISOString() }: { dir?: string; now?: string } = {}): Promise<FactoryManifest> {
  return updateManifest(ticket, dir, now, (raw) => {
    for (const p of Array.isArray(raw.prs) ? raw.prs : []) if (p && states[p.url]) p.state = states[p.url];
    // Every PR merged and the run long gone: it's finished then, if nothing said so.
    if (!raw.finishedAt && (raw.prs || []).length && raw.prs.every((p: any) => p.state === "merged")) raw.finishedAt = now;
  });
}

/** The newest rating of an assessment (each person's newest counts; the newest of those wins). */
export function ratingOf(m: FactoryManifest, a: FactoryAssessment | null): FactoryRating | null {
  return a ? m.ratings.filter((r) => r.assessmentAt === a.at).at(-1) || null : null;
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

/** Tickets in flight (lower-cased id → id): a manifest that has started and isn't done, or an implement run that's going. */
export function inFlightTickets(manifests: FactoryManifest[], runs: FactoryRun[]): Map<string, string> {
  const inFlight = new Map<string, string>();
  for (const m of manifests) if (!m.done && (m.stages.length > 0 || m.gates.length > 0)) inFlight.set(m.ticket.toLowerCase(), m.ticket);
  for (const r of runs) if (r.implement && r.ticket && (r.status === "running" || r.status === "waiting")) inFlight.set(r.ticket.toLowerCase(), r.ticket);
  return inFlight;
}

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
  const inFlight = inFlightTickets(manifests, runs);
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
export function buildBoard(cfg: FactoryConfig, configured: boolean, manifests: FactoryManifest[], runs: FactoryRun[], errors: string[] = [], canDecide = false,
  /** The metrics' data when the board's own lists are capped for display: every manifest and run. */
  all: { manifests: FactoryManifest[]; runs: FactoryRun[] } = { manifests, runs }): FactoryBoard {
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
    const overridable = overridableGate(m);
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
      approverRating: ratingOf(m, assessed),
      overridable: overridable ? { gate: overridable.id, by: overridable.by!, at: overridable.at } : null,
      runIds: mine.map((r) => r.id),
      askingRunId: (mine.find((r) => r.status === "waiting" && r.implement) || mine.find((r) => r.status === "waiting"))?.id ?? null,
      implementLive: mine.some((r) => r.implement && (r.status === "running" || r.status === "waiting")),
      steps: itemStepList,
      waitingGate: waitingGate(m, itemStepList),
      mode: m.mode, spec: m.spec, plan: m.plan, error: m.error,
      merged: m.prs.length > 0 && m.prs.every((p) => p.state === "merged"),
      retro: m.retro,
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
    approverStats: approverStats(all.manifests),
    metrics: factoryMetrics(all.manifests, all.runs),
  };
}

/**
 * What's worth telling someone about the board's items now, one notice per occurrence (its key
 * changes when it happens again): a gate waiting on a person, a stage that failed twice, a ticket
 * over its budget or hours, a ticket stopped short, every PR merged.
 */
export function factoryNotices(cfg: FactoryConfig, manifests: FactoryManifest[], items: FactoryItem[], runs: FactoryRun[], now = Date.now()): FactoryNotice[] {
  const out: FactoryNotice[] = [];
  const byTicket = new Map(manifests.map((m) => [m.ticket, m]));
  for (const it of items) {
    const m = byTicket.get(it.ticket);
    if (!m) continue;
    const base = { ticket: it.ticket, title: it.title, url: it.url };
    const name = `${it.ticket}${it.title ? ` (${it.title})` : ""}`;
    const g = it.waitingGate;
    if (g && g.mode !== "approver" && g.mode !== "auto" && !it.implementLive) {
      out.push({ ...base, key: `${it.ticket}|gate-waiting|${g.id}|${g.since}`, event: "gate-waiting", severity: "action", at: g.since,
        text: `${name} waits for a person at the ${g.label.toLowerCase()}${g.reason ? `: ${g.reason}` : ""}.` });
    }
    if (!m.done) {
      // Each stage's newest row per repo: one that failed twice and has passed since is fine.
      for (const s of STAGE_IDS.flatMap((id) => latestPerRepo(m.stages.filter((x) => x.id === id)))) {
        if (s.status === "failed" && (s.failures || 0) >= 2) {
          out.push({ ...base, key: `${it.ticket}|stage-failed|${s.id}|${s.repo || ""}|${s.failures}`, event: "stage-failed", severity: "alert", at: s.endedAt || m.updatedAt,
            text: `${name}: ${STAGE_LABELS[s.id]}${s.repo ? ` (${s.repo})` : ""} has failed ${s.failures} times${s.note ? `: ${s.note.slice(0, 200)}` : ""}.` });
        }
      }
      const blocked = factoryLaunchBlocker(cfg, true, it.ticket, manifests, runs, now);
      // The day's budget is the factory's, not the ticket's: one notice a day. A ticket's budget or hours: once each.
      if (blocked && /today/.test(blocked)) {
        // The local day, as the day's budget counts it.
        const day = new Date(now);
        day.setHours(0, 0, 0, 0);
        const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
        out.push({ ticket: "factory", title: null, url: null, key: `factory|budget|${dayKey}`, event: "budget", severity: "alert", at: day.toISOString(), text: blocked });
      } else if (blocked && !/WIP limit/.test(blocked)) {
        out.push({ ...base, key: `${it.ticket}|budget|${/hours/.test(blocked) ? "hours" : "usd"}`, event: "budget", severity: "alert", at: m.updatedAt, text: blocked });
      }
    }
    if (m.done && m.error) {
      out.push({ ...base, key: `${it.ticket}|stopped|${m.finishedAt || m.updatedAt}`, event: "stopped", severity: "alert", at: m.finishedAt || m.updatedAt, text: `${name} stopped: ${m.error}` });
    }
    if (it.merged) {
      out.push({ ...base, key: `${it.ticket}|merged|${m.prs.map((p) => p.url).join(",")}`, event: "merged", severity: "info", at: m.finishedAt || m.updatedAt, text: `${name}: every PR merged.` });
    }
  }
  return [...new Map(out.map((n) => [n.key, n])).values()];
}

/** The gate audit log: every gate decision, Approver assessment and rating, oldest first (one ticket's, or all). */
export function auditRows(manifests: FactoryManifest[], ticket: string | null = null): FactoryAuditRow[] {
  const rows: FactoryAuditRow[] = [];
  for (const m of manifests) {
    if (ticket && !sameTicket(m.ticket, ticket)) continue;
    for (const g of m.gates) rows.push({ ticket: m.ticket, at: g.at, kind: "gate", gate: g.id, decision: g.decision, by: g.by, mode: g.mode, risk: g.risk, rationale: g.rationale, sha: g.sha, override: !!g.override });
    for (const a of m.assessments) rows.push({ ticket: m.ticket, at: a.at, kind: "assessment", gate: a.gate, decision: a.action, by: a.by, mode: "approver", risk: a.level,
      rationale: [a.rationale, a.blockers.length ? `Blockers: ${a.blockers.join("; ")}` : "", a.rules.length ? `Rules: ${a.rules.map((r) => r.detail).join("; ")}` : ""].filter(Boolean).join(" | ") || a.reason, sha: a.sha, override: false });
    for (const r of m.ratings) rows.push({ ticket: m.ticket, at: r.at, kind: "rating", gate: r.gate, decision: r.rating, by: r.by, mode: null, risk: r.level, rationale: r.note, sha: null, override: false });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at) || a.ticket.localeCompare(b.ticket));
}

/** The audit log as CSV (RFC 4180; a cell a spreadsheet would run as a formula is quoted as text). */
export function auditCsv(rows: FactoryAuditRow[]): string {
  const cols: (keyof FactoryAuditRow)[] = ["at", "ticket", "kind", "gate", "decision", "by", "mode", "risk", "override", "sha", "rationale"];
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

/** The factory ticket a PR belongs to and its PRs (this one marked), or null. */
export function relatedPrs(manifests: FactoryManifest[], url: string): ReviewRelated | null {
  const same = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  const m = manifests.find((x) => x.prs.some((p) => same(p.url) === same(url)));
  if (!m) return null;
  return { ticket: m.ticket, title: m.title, prs: m.prs.map((p) => ({ repo: p.repo, number: p.number, url: p.url, state: p.state, current: same(p.url) === same(url) })) };
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const share = (hits: number, n: number) => (n ? { rate: Math.round((hits / n) * 100) / 100, n } : null);

/**
 * The line's throughput from the manifests (and runs, for cost), over the last 30 days: items
 * finished, lead time, first-pass review, how much the Approver approved alone, cost per merged item.
 */
export function factoryMetrics(manifests: FactoryManifest[], runs: FactoryRun[], now = Date.now()): FactoryMetrics {
  const since = now - 30 * 86_400_000;
  const merged = (m: FactoryManifest) => m.prs.length > 0 && m.prs.every((p) => p.state === "merged");
  // Each figure by its own stable time (a later retro or rating rewrites updatedAt): when it finished
  // (done, a rejection or an override), when a review ended, when an assessment was made. Older
  // manifests without them: their last write.
  const end = (m: FactoryManifest) => Date.parse(m.finishedAt || m.updatedAt);
  const finished = manifests.filter((m) => ((m.done && !m.error) || merged(m)) && end(m) >= since);
  const reviews = manifests.flatMap((m) => latestPerRepo(m.stages.filter((s) => s.id === "review"))
    .filter((s) => (s.status === "done" || s.status === "failed") && Date.parse(s.endedAt || m.updatedAt) >= since));
  // Only where it was allowed to decide: advisory calls never approve alone.
  const assessments = manifests.flatMap((m) => m.assessments.filter((a) => a.enforced && Date.parse(a.at) >= since));
  const mergedItems = manifests.filter((m) => merged(m) && end(m) >= since);
  const cost = (m: FactoryManifest) => runs.filter((r) => sameTicket(r.ticket, m.ticket)).reduce((s, r) => s + (r.costUsd || 0), 0);
  const lead = median(finished.map((m) => (end(m) - Date.parse(m.startedAt)) / 3_600_000).filter((h) => h >= 0));
  return {
    done7d: finished.filter((m) => end(m) >= now - 7 * 86_400_000).length,
    leadTimeHours: lead == null ? null : Math.round(lead * 10) / 10,
    firstPassReview: share(reviews.filter((s) => s.status === "done" && !s.failures).length, reviews.length),
    autoApproved: share(assessments.filter((a) => a.action === "pass").length, assessments.length),
    costPerMergedUsd: mergedItems.length ? Math.round((mergedItems.reduce((s, m) => s + cost(m), 0) / mergedItems.length) * 100) / 100 : null,
    merged: mergedItems.length,
  };
}

/** States that mean a ticket is finished, on any tracker (used when the intake names no states). */
const CLOSED_STATE = /^(done|closed|complete(d)?|cancel(l)?ed|canceled|resolved|merged|released|won'?t (do|fix)|duplicate)$/i;

/**
 * The tracker tickets the factory would pull in: in an intake state (when states are set; else
 * any state that isn't a finished one) and with an intake label (when labels are set), not already
 * in the factory (any progress file: a rejected one isn't retried on its own), never pulled in
 * before (`pulled`: a run that ended before reporting isn't retried on its own either) and with no
 * run going. `issues` are already this person's (and, with intake.unassigned, unassigned ones:
 * marked, to be claimed first). Neither states nor labels: none (only tickets sent by hand).
 */
export function intakeCandidates(cfg: FactoryConfig, issues: any[], manifests: FactoryManifest[], runs: FactoryRun[], pulled: Set<string> = new Set()): FactoryIntake["candidates"] {
  const { states, labels } = cfg.intake;
  if (!states.length && !labels.length) return [];
  const want = (list: string[]) => new Set(list.map((s) => s.toLowerCase()));
  const st = want(states), lb = want(labels);
  const known = new Set(manifests.map((m) => m.ticket.toLowerCase()));
  const going = new Set(runs.filter((r) => r.ticket && (r.status === "running" || r.status === "waiting")).map((r) => r.ticket!.toLowerCase()));
  return issues
    .filter((i) => i && typeof i.id === "string")
    // The tracker's own idea of finished (Linear's state types) wins; else the usual names.
    .filter((i) => !["completed", "canceled"].includes(String(i.stateType || "")))
    .filter((i) => (st.size ? st.has(String(i.state || "").toLowerCase()) : !CLOSED_STATE.test(String(i.state || "").trim())))
    .filter((i) => !lb.size || (Array.isArray(i.labels) ? i.labels : []).some((l: any) => lb.has(String(typeof l === "string" ? l : l?.name || "").toLowerCase())))
    .filter((i) => !known.has(i.id.toLowerCase()) && !going.has(i.id.toLowerCase()) && !pulled.has(i.id.toLowerCase()))
    .filter((i) => cfg.intake.unassigned || !!i.assignee)
    .map((i) => ({ ticket: i.id, title: String(i.title || ""), url: typeof i.url === "string" ? i.url : null, state: i.state ? String(i.state) : null, unassigned: !i.assignee }));
}

/**
 * How the Approver's calls have held up: per ticket and round, its newest assessment, judged by
 * the newest rating of it, or by a person overriding an automatic approval after it (too lenient).
 */
export function approverStats(manifests: FactoryManifest[]): FactoryBoard["approverStats"] {
  let assessed = 0, judged = 0, tooLenient = 0, tooStrict = 0;
  for (const m of manifests) {
    const a = m.assessments.filter((x) => !m.roundStartedAt || x.at >= m.roundStartedAt).at(-1);
    if (!a) continue;
    assessed++;
    const r = ratingOf(m, a);
    // An override counts against it only when it reversed this gate's Approver approval.
    const overridden = m.gates.some((g, i) => g.override && g.id === a.gate && g.at >= a.at
      && m.gates.slice(0, i).filter((x) => x.id === g.id).at(-1)?.by === "approver");
    if (!r && !overridden) continue;
    judged++;
    if (r ? r.rating === "should-have-asked" : overridden) tooLenient++;
    else if (r && r.rating === "could-have-approved") tooStrict++;
  }
  return { assessed, judged, tooLenient, tooStrict };
}

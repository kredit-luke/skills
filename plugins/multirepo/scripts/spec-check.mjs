#!/usr/bin/env node
/**
 * spec-check.mjs: how ready a ticket is for an agent to start on, as a score out of 100.
 *
 * The team's spec format is its own; this only looks for what any good spec has, under
 * whatever heading the team uses: the problem, the outcome, testable acceptance criteria, the
 * scope, constraints, the affected areas, no open questions, and how to verify. Each check
 * scores 0, 0.5 or 1 and carries a weight; the score is the weighted share, and the level comes
 * from the team's thresholds. The orchestrating agent may correct a check the text fooled
 * (--overrides), always with a reason, so the score stays explainable.
 *
 * Policy (the workspace's .claude/dashboard/factory.json `spec`): readyAt (80), needsWorkAt (50),
 * weights per check (0 turns one off). Repo names for "affected areas" come from repos.json.
 *
 * Usage:
 *   node spec-check.mjs [<ticket.json>|-] [--root <dir>] [--overrides '<json>'] [--ticket <id>] [--json]
 *
 *   <ticket.json>  fetch-ticket / parse-ticket output (stdin when none or "-").
 *   --overrides    {"criteria": {"score": 0.5, "reason": "AC 2 and 3 contradict"}}
 *   --ticket       Also record the result on the ticket's Factory manifest (factory.mjs).
 *
 * Prints { score, level, readyAt, needsWorkAt, checks: [{ id, label, weight, score, finding, override? }] }.
 */
import fs from "node:fs";
import path from "node:path";
import { isMain, parseArgs, readReposJson } from "./lib.mjs";
import { readPolicy, sourceWorkspace, update } from "./factory.mjs";

export const CHECKS = [
  { id: "problem", label: "Problem", weight: 15 },
  { id: "outcome", label: "Outcome", weight: 15 },
  { id: "criteria", label: "Acceptance criteria", weight: 25 },
  { id: "scope", label: "Scope", weight: 10 },
  { id: "constraints", label: "Constraints", weight: 5 },
  { id: "affected", label: "Affected areas", weight: 10 },
  { id: "questions", label: "Open questions", weight: 10 },
  { id: "verify", label: "How to verify", weight: 10 },
];
export const DEFAULT_LEVELS = { readyAt: 80, needsWorkAt: 50 };

/**
 * A heading (Markdown #, bold line, or "Label:" line) matching re, and the text under it: up to the
 * next heading at its level or above (a Markdown heading's subsections are part of it).
 */
function section(md, re) {
  const lines = md.split(/\r?\n/);
  // [title, level]: Markdown headings by their #s; bold and "Label:" lines rank below any of them.
  const head = (l) => {
    const m = /^\s*(#{1,6})\s+(.+)$/.exec(l);
    if (m) return [m[2], m[1].length];
    const b = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__):?\s*$/.exec(l) || /^\s*([A-Z][\w /&'’-]{2,40}):\s*$/.exec(l);
    return b ? [b[1], 7] : null;
  };
  for (let i = 0; i < lines.length; i++) {
    const h = head(lines[i]);
    if (!h || !re.test(h[0])) continue;
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const n = head(lines[j]);
      if (n && n[1] <= h[1]) break;
      out.push(lines[j]);
    }
    return out.join("\n").trim();
  }
  return null;
}

const items = (text) => String(text || "").split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)]|\[[ x]\])\s*/i, "").trim()).filter((l) => l.length > 3);
const TESTABLE = /\bgiven\b.*\bwhen\b|\bthen\b|\b(should|must|shall|returns?|responds?|shows?|displays?|rejects?|accepts?|fails?|errors?|redirects?|saves?|sends?|creates?|within|at most|at least|no more than)\b|\d/i;
/** Repo names that are also everyday words. */
const COMMON = /^(api|apis|web|app|apps|ui|docs?|core|server|client|backend|frontend|mobile|admin|common|shared|infra|site|data|jobs?|worker)$/i;
const VAGUE = /\b(works?( well| properly| correctly)?|better|improved?|nice|clean|fast|user[- ]friendly|as expected|etc)\b\.?$/i;

/** The ticket's spec text: description, acceptance criteria and the align comment (the agreed problem statement). */
function specText(t) {
  return [t.title, t.description, t.acceptanceCriteria, t.alignComment && t.alignComment.body].filter(Boolean).join("\n\n");
}

/** Every check's score (0, 0.5 or 1) and a one-line finding. */
export function runChecks(ticket, { repos = [] } = {}) {
  const t = ticket || {};
  const text = specText(t);
  const body = [t.description, t.alignComment && t.alignComment.body].filter(Boolean).join("\n\n");
  const prose = body.replace(/^\s*#.*$/gm, "").replace(/\s+/g, " ").trim();
  const out = {};
  const set = (id, score, finding) => { out[id] = { score, finding }; };

  // Problem: a section for it, a user story, or at least a few sentences of description.
  if (section(text, /problem|background|context|motivation|why\b|user story|summary/i) || /\bas an?\b.{3,80}\bi want\b/i.test(text)) set("problem", 1, "Says what's wrong or needed.");
  else if (prose.length >= 200) set("problem", 0.5, "A description, but no stated problem: who has it and why it matters.");
  else set("problem", 0, prose ? "Too little description to know the problem." : "No description.");

  // Outcome: what's true when it's done.
  if (section(text, /outcome|goal|objective|expected (behaviou?r|result)|definition of done|success|result/i) || /\bso that\b/i.test(text)) set("outcome", 1, "Says what's true when it's done.");
  else if (/\b(should|needs? to|must|will)\b/i.test(prose)) set("outcome", 0.5, "Implies the outcome, but doesn't state it.");
  else set("outcome", 0, "Doesn't say what's true when it's done.");

  // Acceptance criteria: present, and most of them testable.
  // An "Acceptance criteria" heading wins over a broader one ("Business requirements") that comes before it.
  const acText = t.acceptanceCriteria || section(text, /acceptance criteria|\bac\b/i) || section(text, /definition of done|requirements|criteria|what.?s needed|deliverables/i);
  const ac = items(acText);
  if (!ac.length) set("criteria", 0, "No acceptance criteria.");
  else {
    const testable = ac.filter((a) => TESTABLE.test(a) && !VAGUE.test(a)).length;
    if (testable / ac.length >= 0.6) set("criteria", 1, `${ac.length} acceptance ${ac.length === 1 ? "criterion" : "criteria"}, ${testable} testable.`);
    else set("criteria", 0.5, `${ac.length} acceptance ${ac.length === 1 ? "criterion" : "criteria"}, but only ${testable} read as testable (a behaviour, a value or given/when/then).`);
  }

  // Scope: what's in and out.
  if (section(text, /scope|non-?goals|out of scope|not included|in scope/i) || /\b(out of scope|not in scope|non-?goals?)\b/i.test(text)) set("scope", 1, "Says what's in or out.");
  else set("scope", 0, "Doesn't say what's out of scope.");

  // Constraints: performance, security, compatibility, data.
  if (section(text, /constraints?|non-?functional|performance|security/i)) set("constraints", 1, "States its constraints.");
  else if (/\b(performance|latency|security|permission|backward[s]?[- ]compat|compatib|migration|backfill|privacy|pii|rate limit|timeout|load)\b/i.test(text)) set("constraints", 0.5, "Mentions a constraint, but doesn't spell them out.");
  else set("constraints", 0, "No constraints (performance, security, compatibility, data).");

  // Affected areas: repos, APIs, screens, files.
  const names = repos.map((r) => (typeof r === "string" ? r : r && r.name)).filter(Boolean);
  // A repo is named when it's written as such: `api`, "the api repo", or a distinctive name. Common words
  // (api, web, app) only count in backticks or next to "repo"/"service", or prose like "the API returns" would.
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = names.filter((n) => {
    const e = esc(n);
    if (new RegExp(`\`${e}\`|\\b${e}\\s+(repo|repository|service|project)\\b|\\b(repo|repository|service)\\s+${e}\\b`, "i").test(text)) return true;
    return n.length > 4 && !COMMON.test(n) && new RegExp(`(^|[^\\w-])${e}([^\\w-]|$)`, "i").test(text);
  });
  if (named.length) set("affected", 1, `Names ${named.join(", ")}.`);
  else if (section(text, /affected|impact|components?|areas?|systems?/i) || /(\/api\/|\b[\w-]+\.(ts|js|cs|py|go|java|rb|tsx|vue)\b|\bendpoint\b|\bscreen\b|\bpage\b|\btable\b|\bservice\b)/i.test(text) || (t.components || []).length) set("affected", 0.5, "Hints at what it touches, but names no repo.");
  else set("affected", 0, "Doesn't say which repos, APIs or screens it touches.");

  // Open questions: none left in the spec, or in the newest comment.
  const qSection = section(text, /open questions?|questions|unknowns|tbd/i);
  // The plan and align comments settle questions rather than ask them (compared by id: the ticket has been through JSON).
  const settled = new Set([t.planComment, t.alignComment].filter(Boolean).map((c) => c.id ?? c.body));
  const lastComment = (t.comments || []).filter((c) => c && c.body && !settled.has(c.id ?? c.body)).at(-1);
  const markers = [...String(body).matchAll(/\b(TBD|TBC|TODO|to be decided|to be confirmed)\b|\?\?/gi)].length;
  const asked = items(t.description).filter((l) => /\?\s*$/.test(l)).length;
  const listed = items(qSection).filter((l) => !/^(none|n\/a|nothing|no open questions|-)\b/i.test(l));
  if (listed.length) set("questions", 0, `Open questions are listed: ${listed.length}.`);
  else if (markers) set("questions", 0, `${markers} TBD/TODO ${markers === 1 ? "marker" : "markers"} left.`);
  else if (asked || (lastComment && /\?\s*$/m.test(lastComment.body))) set("questions", 0.5, asked ? `${asked} ${asked === 1 ? "question" : "questions"} in the description.` : "The newest comment asks a question.");
  else set("questions", 1, "No open questions.");

  // How to verify: test or QA steps.
  if (section(text, /how to (test|verify|qa)|test(ing)? (plan|steps|notes)|verification|qa|steps to reproduce|repro/i)) set("verify", 1, "Says how to verify it.");
  else if (/\b(unit|integration|e2e|regression) tests?\b|\bverify\b|\bqa\b/i.test(text)) set("verify", 0.5, "Mentions testing, but no steps.");
  else set("verify", 0, "Doesn't say how to verify it.");
  return out;
}

/** The weighted score, level and checks, with the team's weights and levels and the agent's overrides applied. */
export function checkSpec(ticket, { repos = [], policy = null, overrides = {} } = {}) {
  const sp = (policy && policy.spec) || {};
  const readyAt = Number.isFinite(sp.readyAt) ? sp.readyAt : DEFAULT_LEVELS.readyAt;
  const needsWorkAt = Number.isFinite(sp.needsWorkAt) ? sp.needsWorkAt : DEFAULT_LEVELS.needsWorkAt;
  const raw = runChecks(ticket, { repos });
  const checks = CHECKS.map((c) => {
    const w = sp.weights && Number.isFinite(sp.weights[c.id]) ? Math.max(0, sp.weights[c.id]) : c.weight;
    const o = overrides && overrides[c.id];
    const base = { id: c.id, label: c.label, weight: w, score: raw[c.id].score, finding: raw[c.id].finding };
    if (o && Number.isFinite(o.score) && typeof o.reason === "string" && o.reason.trim()) {
      return { ...base, score: Math.min(1, Math.max(0, o.score)), override: { from: base.score, reason: o.reason.trim() } };
    }
    return base;
  });
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const score = total ? Math.round((checks.reduce((s, c) => s + c.weight * c.score, 0) / total) * 100) : 0;
  const level = score >= readyAt ? "ready" : score >= needsWorkAt ? "needs-work" : "not-ready";
  return { score, level, readyAt, needsWorkAt, minScore: Number.isFinite(sp.minScore) ? sp.minScore : null, checks };
}

async function main(argv) {
  const args = parseArgs(argv, { booleans: ["json"] });
  const file = args._[0];
  const input = !file || file === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(path.resolve(file), "utf-8");
  let ticket;
  try { ticket = JSON.parse(input.replace(/^﻿/, "")); } catch { throw Object.assign(new Error("The ticket isn't JSON: pass fetch-ticket / parse-ticket output."), { usage: true }); }
  let overrides = {};
  if (typeof args.overrides === "string") {
    try { overrides = JSON.parse(args.overrides); } catch { throw Object.assign(new Error("--overrides must be JSON"), { usage: true }); }
  }
  const start = typeof args.root === "string" ? path.resolve(args.root) : process.cwd();
  const ws = sourceWorkspace(start);
  const result = checkSpec(ticket, { repos: readReposJson(ws), policy: readPolicy(ws), overrides });
  if (typeof args.ticket === "string") update("spec", { ticket: args.ticket, result }, { start });
  if (args.json) return process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  const min = result.minScore == null ? "no minimum for unattended runs" : `unattended runs need ${result.minScore}${result.score < result.minScore ? ": BELOW IT" : ""}`;
  const lines = [`Spec readiness: ${result.score}/100 (${result.level.replace("-", " ")}; ready at ${result.readyAt}; ${min})`];
  for (const c of result.checks) if (c.weight) lines.push(`  ${c.score === 1 ? "✓" : c.score ? "~" : "✗"} ${c.label}: ${c.finding}${c.override ? ` (agent: ${c.override.reason})` : ""}`);
  process.stdout.write(lines.join("\n") + "\n");
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = e.usage ? 2 : 1;
  });
}

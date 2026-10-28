import type { FactoryAssessment, FactoryColumn, FactoryConfig, FactoryGateId, FactoryItem, FactoryMetrics, FactoryPreset, FactoryPresetPatch, FactoryStageId, SpecLevel } from '../../../../../shared/api';
import { pipelineOrder, withPresetPatch } from '../../../../../shared/factory-rules';

export const GATE_IDS: FactoryGateId[] = ['spec', 'plan', 'prePr', 'merge'];

const SPEC_LEVELS: Record<SpecLevel, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'good' }, 'needs-work': { label: 'Needs work', cls: 'amber' }, 'not-ready': { label: 'Not ready', cls: 'bad' },
};
/** A spec readiness level's words and tag colour. */
export function specLevel(l: SpecLevel): { label: string; cls: string } { return SPEC_LEVELS[l] || SPEC_LEVELS['not-ready']; }

/** A check's mark: met, partly, missing. */
export function checkMark(score: number): string { return score >= 1 ? '✓' : score > 0 ? '~' : '✗'; }

/** The preset a config matches (its gates, mode and Approver settings), else 'custom'. */
export function matchingPreset(c: FactoryConfig, presets: Record<string, FactoryPresetPatch>): FactoryPreset {
  for (const [id, p] of Object.entries(presets)) {
    const approve = c.stages.find((s) => s.id === 'approve')?.on ?? false;
    if (p.mode && p.mode !== c.mode) continue;
    if (GATE_IDS.some((g) => p.gates[g] !== c.gates[g])) continue;
    if (p.approver.enabled !== c.approver.enabled || p.approver.mergeAction !== c.approver.mergeAction || p.approver.samplingPct !== c.approver.samplingPct) continue;
    if (p.approve !== approve) continue;
    return id as FactoryPreset;
  }
  return 'custom';
}

/** A preset applied to a config: its gates, mode and Approver settings; everything else kept (the server's rule). */
export function withPreset(c: FactoryConfig, id: Exclude<FactoryPreset, 'custom'>, presets: Record<string, FactoryPresetPatch>): FactoryConfig {
  return withPresetPatch(c, id, presets[id]);
}

/** The board's columns for a config, in order (the server's rule, shared/factory-rules.ts). */
export function pipelineSteps(c: FactoryConfig): ({ kind: 'stage'; id: FactoryStageId } | { kind: 'gate'; id: FactoryGateId })[] {
  return pipelineOrder(c) as ({ kind: 'stage'; id: FactoryStageId } | { kind: 'gate'; id: FactoryGateId })[];
}

/**
 * The Reviews page's guided review of a factory PR (its query params), or null: only for an open
 * GitHub PR, which the Reviews page reads. A guide the review-guide skill posted shows there.
 */
export function guideLink(pr: { url: string; state: string | null }): { repo: string; n: number; view: 'guide' } | null {
  if (pr.state === 'merged' || pr.state === 'closed') return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(pr.url || '');
  return m ? { repo: m[1], n: Number(m[2]), view: 'guide' } : null;
}

const GATE_NAMES: Record<FactoryGateId, string> = { spec: 'spec', plan: 'plan', prePr: 'pre-PR', merge: 'merge' };
/** A gate's name in a sentence ("the pre-PR gate"). */
export function gateName(id: FactoryGateId): string { return GATE_NAMES[id] || id; }

/** What the Approver's assessment came to, in a few words and a tag colour. */
export function approverVerdict(a: FactoryAssessment): { label: string; cls: string } {
  if (a.enforced && a.action === 'pass') return { label: 'Approved', cls: 'good' };
  if (a.wouldApprove && a.sampled) return { label: 'Sampled for a person', cls: 'amber' };
  // Enforced but not passed (it stopped partway): a person has it.
  if (a.wouldApprove && !a.enforced) return { label: 'Would have approved', cls: 'good' };
  return { label: 'Needs a person', cls: 'amber' };
}

/**
 * A lane of the Line view: what's being worked on at a stage (or gate), what waits there on a
 * person or a merge, what's failing, and what's idle there (not started; not counted as waiting).
 */
export interface LineLane {
  id: string; label: string; kind: FactoryColumn['kind'];
  working: { ticket: string; title: string | null; repos: string[] }[];
  waiting: { ticket: string; reason: string | null }[];
  failing: { ticket: string; reason: string | null }[];
  idle: { ticket: string; reason: string | null }[];
}

/**
 * The Line view: a lane per stage and gate (the board's columns, without the ends), each item in
 * the lane of the step it's on, plus a last lane for open PRs waiting to merge. The bottleneck is
 * the lane where the most work waits on a person or a merge (ties: the earliest); none when nothing waits.
 */
export function lineLanes(columns: FactoryColumn[], items: FactoryItem[]): { lanes: LineLane[]; bottleneck: string | null } {
  const lane = (id: string, label: string, kind: FactoryColumn['kind']): LineLane => ({ id, label, kind, working: [], waiting: [], failing: [], idle: [] });
  const lanes = columns.filter((c) => c.kind === 'stage' || c.kind === 'gate').map((c) => lane(c.id, c.label, c.kind));
  const merging = lane('merging', 'Waiting to merge', 'done');
  const byId = new Map(lanes.map((l) => [l.id, l]));
  for (const it of items) {
    // Finished, but a PR still open (the run reports done once it opens them): waiting to merge.
    if (it.column === 'done') {
      if (it.state === 'waiting' || it.prs.some((p) => p.state !== 'merged' && p.state !== 'closed')) merging.waiting.push({ ticket: it.ticket, reason: it.reason || 'PR open' });
      continue;
    }
    const l = byId.get(it.column);
    if (!l) continue;
    if (it.state === 'failing') l.failing.push({ ticket: it.ticket, reason: it.reason });
    else if (it.state === 'moving') l.working.push({ ticket: it.ticket, title: it.title, repos: it.repos.filter((r) => r.status === 'running' && r.stage === it.column).map((r) => r.repo) });
    else if (it.state === 'waiting') l.waiting.push({ ticket: it.ticket, reason: it.reason });
    else l.idle.push({ ticket: it.ticket, reason: it.reason });
  }
  lanes.push(merging);
  let bottleneck: string | null = null, most = 0;
  for (const l of lanes) if (l.waiting.length > most) { most = l.waiting.length; bottleneck = l.id; }
  return { lanes, bottleneck };
}

/** The throughput strip's figures, in reading order (leaving out what there's no data for yet). */
export function metricLine(m: FactoryMetrics): { label: string; value: string; title: string }[] {
  const pct = (x: { rate: number; n: number }) => `${Math.round(x.rate * 100)}%`;
  const out: { label: string; value: string; title: string }[] = [
    { label: 'done this week', value: String(m.done7d), title: 'Items finished (not stopped short) in the last 7 days' },
  ];
  if (m.leadTimeHours != null) out.push({ label: 'lead time', value: m.leadTimeHours < 48 ? `${m.leadTimeHours}h` : `${Math.round(m.leadTimeHours / 24)}d`, title: 'Median from start to finished, last 30 days' });
  if (m.firstPassReview) out.push({ label: 'first-pass review', value: pct(m.firstPassReview), title: `Repos whose review passed without failing first (${m.firstPassReview.n}), last 30 days` });
  if (m.autoApproved) out.push({ label: 'approved by the Approver', value: pct(m.autoApproved), title: `Of its ${m.autoApproved.n} assessments, the ones it approved without a person, last 30 days` });
  if (m.costPerMergedUsd != null) out.push({ label: 'per merged item', value: `$${m.costPerMergedUsd.toFixed(2)}`, title: `Agent cost of the ${m.merged} items whose PRs all merged, last 30 days` });
  return out;
}

/** One per line, commas kept (commands, globs like src/{a,b}/**). */
export function splitLines(text: string): string[] {
  return [...new Set(String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

/** "a, b,, c" or one per line → ['a', 'b', 'c'] (no duplicates). */
export function splitList(text: string): string[] {
  return [...new Set(String(text || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
}

/** A number field's value: null when empty or not a number. */
export function numOrNull(v: unknown): number | null {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** How long a step took (or has been going, when it hasn't ended): "45s", "13m", "2h 5m", "3d 4h"; '' without a start. */
export function duration(start: string | null, end: string | null, now = Date.now()): string {
  if (!start) return '';
  const ms = (end ? Date.parse(end) : now) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

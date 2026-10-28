import type { FactoryAssessment, FactoryConfig, FactoryGateId, FactoryPreset, FactoryPresetPatch, FactoryStageId, SpecLevel } from '../../../../../shared/api';
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

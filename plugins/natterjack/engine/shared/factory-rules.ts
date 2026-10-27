// No imports: the server (Node type stripping, .ts extensions) and the web build both
// compile this file, and they disagree on how a relative import is written.

/** The parts of factory.json the pipeline's order depends on (FactoryConfig fits). */
export interface PipelineConfig { stages: { id: string; on: boolean }[]; gates: Record<string, string> }

/** One step of the pipeline: a stage that's on, or a gate that isn't off. */
export type PipelineOrderStep = { kind: 'stage'; id: string } | { kind: 'gate'; id: string; mode: string };

/**
 * The pipeline in order: the stages that are on, with each gate that isn't off placed where it
 * guards: spec before planning (or building), plan right after planning (or before building when
 * planning is off), pre-PR before the PR, merge before merging. A gate with nothing to guard goes
 * at the end, in that order.
 */
export function pipelineOrder(c: PipelineConfig): PipelineOrderStep[] {
  const out: PipelineOrderStep[] = [];
  const gate = (id: string) => { if (c.gates[id] && c.gates[id] !== 'off') out.push({ kind: 'gate', id, mode: c.gates[id] }); };
  let spec = false, plan = false, prePr = false, merge = false;
  for (const s of c.stages.filter((x) => x.on)) {
    if (!spec && (s.id === 'plan' || s.id === 'build')) { gate('spec'); spec = true; }
    // Planning off: its gate still guards building.
    if (!plan && s.id === 'build') { gate('plan'); plan = true; }
    if (!prePr && s.id === 'pr') { gate('prePr'); prePr = true; }
    if (!merge && s.id === 'merge') { gate('merge'); merge = true; }
    out.push({ kind: 'stage', id: s.id });
    if (s.id === 'plan') { gate('plan'); plan = true; }
  }
  if (!spec) gate('spec');
  if (!plan) gate('plan');
  if (!prePr) gate('prePr');
  if (!merge) gate('merge');
  return out;
}

/** What a preset sets (FactoryPresetPatch fits). */
export interface PresetPatchLike { mode: string | null; gates: Record<string, string>; approver: Record<string, unknown>; approve: boolean }

/** A config with a preset applied: its gates, mode and Approver settings; everything else kept (a copy). */
export function withPresetPatch<T extends { preset: string; mode: string; gates: Record<string, string>; approver: object; stages: { id: string; on: boolean }[] }>(c: T, id: string, p: PresetPatchLike): T {
  const out: T = JSON.parse(JSON.stringify(c));
  out.preset = id;
  if (p.mode) out.mode = p.mode;
  out.gates = { ...p.gates };
  out.approver = { ...out.approver, ...p.approver };
  const approve = out.stages.find((s) => s.id === 'approve');
  if (approve) approve.on = p.approve;
  return out;
}

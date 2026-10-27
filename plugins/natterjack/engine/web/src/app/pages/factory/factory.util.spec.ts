import { describe, expect, it } from 'vitest';
import type { FactoryConfig, FactoryPresetPatch } from '../../../../../shared/api';
import { checkMark, duration, matchingPreset, specLevel, numOrNull, pipelineSteps, splitLines, splitList, withPreset } from './factory.util';

const STAGES = ['align', 'plan', 'build', 'review', 'security', 'qa', 'guide', 'pr', 'approve', 'merge'] as const;

function config(): FactoryConfig {
  return {
    enabled: false, preset: 'supervised', mode: 'interactive', intake: { states: [], labels: [] },
    limits: { wip: 3, itemBudgetUsd: null, dayBudgetUsd: null, itemHours: null },
    stages: STAGES.map((id) => ({ id, on: !['align', 'qa', 'approve'].includes(id), agent: null, model: null, effort: null })),
    security: { agentReview: true, secretScan: true, scanners: [], failOn: 'high' },
    gates: { spec: 'human', plan: 'human', prePr: 'human', merge: 'human' },
    requiredChecks: [], reviewers: { bots: [], pipeline: true, noUnresolved: true },
    approver: { enabled: false, highRiskPaths: [], maxFiles: 20, maxLines: 400, maxRepos: 1, mergeAction: 'none', mergeMethod: 'squash', samplingPct: 0 },
  };
}

const PRESETS: Record<string, FactoryPresetPatch> = {
  supervised: { label: 'Supervised', description: '', mode: null, gates: { spec: 'human', plan: 'human', prePr: 'human', merge: 'human' }, approver: { enabled: false, mergeAction: 'none', samplingPct: 0 }, approve: false },
  'lights-out': { label: 'Lights-out', description: '', mode: 'autonomous', gates: { spec: 'off', plan: 'approver', prePr: 'auto', merge: 'approver' }, approver: { enabled: true, mergeAction: 'auto-merge', samplingPct: 10 }, approve: true },
};

describe('factory presets', () => {
  it('recognises the preset a config matches, and custom once a gate changes', () => {
    const c = config();
    expect(matchingPreset(c, PRESETS)).toBe('supervised');
    c.gates.prePr = 'auto';
    expect(matchingPreset(c, PRESETS)).toBe('custom');
  });

  it('applies a preset and keeps everything else', () => {
    const c = { ...config(), requiredChecks: ['build'] };
    const lo = withPreset(c, 'lights-out', PRESETS);
    expect([lo.preset, lo.mode, lo.gates.spec, lo.approver.mergeAction, lo.requiredChecks]).toEqual(['lights-out', 'autonomous', 'off', 'auto-merge', ['build']]);
    expect(lo.stages.find((s) => s.id === 'approve')!.on).toBe(true);
    expect(matchingPreset(lo, PRESETS)).toBe('lights-out');
    expect(c.gates.spec).toBe('human');
  });
});

describe('pipelineSteps', () => {
  it('puts each gate where it guards and leaves out gates that are off', () => {
    const ids = (c: FactoryConfig) => pipelineSteps(c).map((s) => (s.kind === 'gate' ? `gate:${s.id}` : s.id));
    expect(ids(config())).toEqual(['gate:spec', 'plan', 'gate:plan', 'build', 'review', 'security', 'guide', 'gate:prePr', 'pr', 'gate:merge', 'merge']);
    expect(ids(withPreset(config(), 'lights-out', PRESETS))[0]).toBe('plan');
  });
});

describe('fields', () => {
  it('splits lists on commas and lines', () => {
    expect(splitList('Ready, ready\nIn Review,, Ready')).toEqual(['Ready', 'ready', 'In Review']);
  });
  it('reads empty numbers as none', () => {
    expect([numOrNull(''), numOrNull('2.5'), numOrNull('x'), numOrNull(0)]).toEqual([null, 2.5, null, 0]);
  });
});

describe('duration', () => {
  it('reads short and long spans, and runs to now without an end', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 27, 10, 0) + m * 60_000).toISOString();
    expect(duration(t(0), t(0.5))).toBe('30s');
    expect(duration(t(0), t(13))).toBe('13m');
    expect(duration(t(0), t(125))).toBe('2h 5m');
    expect(duration(t(0), t(60 * 76))).toBe('3d 4h');
    expect(duration(t(0), null, Date.parse(t(7)))).toBe('7m');
    expect(duration(null, t(1))).toBe('');
  });
});

describe('spec readiness', () => {
  it('names levels and marks checks', () => {
    expect([specLevel('ready').label, specLevel('needs-work').cls, specLevel('not-ready').cls]).toEqual(['Ready', 'amber', 'bad']);
    expect([checkMark(1), checkMark(0.5), checkMark(0)]).toEqual(['✓', '~', '✗']);
  });
});

describe('splitLines', () => {
  it('keeps commas in commands and globs', () => {
    expect(splitLines('node -e "console.log(1, 2)"\nsrc/{auth,payments}/**\n\n')).toEqual(['node -e "console.log(1, 2)"', 'src/{auth,payments}/**']);
  });
});

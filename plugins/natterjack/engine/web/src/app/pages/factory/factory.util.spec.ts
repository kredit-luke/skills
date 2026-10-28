import { describe, expect, it } from 'vitest';
import type { FactoryConfig, FactoryPresetPatch } from '../../../../../shared/api';
import { approverVerdict, checkMark, duration, gateName, guideLink, lineLanes, metricLine, matchingPreset, specLevel, numOrNull, pipelineSteps, splitLines, splitList, withPreset } from './factory.util';

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

describe('guideLink', () => {
  it('opens an open GitHub PR on the Reviews page, guided', () => {
    expect(guideLink({ url: 'https://github.com/acme/api/pull/42', state: 'open' })).toEqual({ repo: 'acme/api', n: 42, view: 'guide' });
    expect(guideLink({ url: 'https://github.com/acme/api/pull/42/files', state: null })).toEqual({ repo: 'acme/api', n: 42, view: 'guide' });
  });
  it('has none for a merged or closed PR, or another host', () => {
    expect(guideLink({ url: 'https://github.com/acme/api/pull/42', state: 'merged' })).toBeNull();
    expect(guideLink({ url: 'https://github.com/acme/api/pull/42', state: 'closed' })).toBeNull();
    expect(guideLink({ url: 'https://gitlab.com/acme/api/-/merge_requests/4', state: 'open' })).toBeNull();
    expect(guideLink({ url: 'https://github.com/acme/api/pull/42x', state: 'open' })).toBeNull();
  });
});

describe('the Approver', () => {
  const a = (over: object) => ({ enforced: false, action: 'handoff', wouldApprove: false, sampled: false, ...over }) as any;
  it('says what its assessment came to', () => {
    expect(approverVerdict(a({ enforced: true, action: 'pass', wouldApprove: true }))).toEqual({ label: 'Approved', cls: 'good' });
    expect(approverVerdict(a({ wouldApprove: true }))).toEqual({ label: 'Would have approved', cls: 'good' });
    expect(approverVerdict(a({ wouldApprove: true, sampled: true }))).toEqual({ label: 'Sampled for a person', cls: 'amber' });
    expect(approverVerdict(a({}))).toEqual({ label: 'Needs a person', cls: 'amber' });
    expect(approverVerdict(a({ enforced: true, wouldApprove: true, action: 'handoff' }))).toEqual({ label: 'Needs a person', cls: 'amber' });
    expect(gateName('prePr')).toBe('pre-PR');
  });
});

describe('the Line view and the throughput strip', () => {
  const item = (ticket: string, column: string, state: string, repos: object[] = []) => ({ ticket, column, state, title: null, reason: state === 'waiting' ? 'Waiting on you' : null, repos, prs: [] }) as any;
  const cols = [{ id: 'queued', label: 'Queued', kind: 'queued' }, { id: 'build', label: 'Building', kind: 'stage' }, { id: 'gate:prePr', label: 'Pre-PR gate', kind: 'gate' }, { id: 'done', label: 'Done', kind: 'done' }] as any;
  it('puts each item in its lane by state, and marks where the most waits', () => {
    const { lanes, bottleneck } = lineLanes(cols, [
      item('A-1', 'build', 'moving', [{ repo: 'api', status: 'running', stage: 'build' }, { repo: 'web', status: 'done', stage: 'build' }]),
      item('A-2', 'gate:prePr', 'waiting'), item('A-3', 'gate:prePr', 'idle'), item('A-4', 'build', 'failing'), item('A-5', 'done', 'done'),
      item('A-6', 'done', 'waiting'), item('A-7', 'done', 'waiting'), item('A-8', 'build', 'idle'), item('A-9', 'build', 'idle'),
      { ...item('A-10', 'done', 'done'), prs: [{ url: 'u', state: 'open' }] }, { ...item('A-11', 'done', 'done'), prs: [{ url: 'u', state: 'merged' }] },
    ]);
    expect(lanes.map((l) => l.id)).toEqual(['build', 'gate:prePr', 'merging']);
    expect(lanes[2].waiting.map((x) => x.ticket)).toEqual(['A-6', 'A-7', 'A-10']);
    expect(lanes[0].idle.map((x) => x.ticket)).toEqual(['A-8', 'A-9']);
    expect(lanes[0].working).toEqual([{ ticket: 'A-1', title: null, repos: ['api'] }]);
    expect(lanes[0].failing.map((x) => x.ticket)).toEqual(['A-4']);
    expect(lanes[1].waiting.map((x) => x.ticket)).toEqual(['A-2']);
    expect(lanes[1].idle.map((x) => x.ticket)).toEqual(['A-3']);
    expect(bottleneck).toBe('merging', 'idle items are not waiting');
    expect(lineLanes(cols, []).bottleneck).toBeNull();
  });
  it('shows only the figures there is data for', () => {
    const none = { done7d: 0, leadTimeHours: null, firstPassReview: null, autoApproved: null, costPerMergedUsd: null, merged: 0 };
    expect(metricLine(none).map((m) => m.label)).toEqual(['done this week']);
    const all = metricLine({ done7d: 3, leadTimeHours: 60, firstPassReview: { rate: 0.75, n: 4 }, autoApproved: { rate: 0.5, n: 2 }, costPerMergedUsd: 4.5, merged: 2 });
    expect(all.map((m) => m.value)).toEqual(['3', '3d', '75%', '50%', '$4.50']);
  });
});

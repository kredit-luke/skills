import { describe, expect, it } from 'vitest';
import type { OnboardingResponse, OnboardingStep } from '../../../../shared/api';
import { allRequiredDone, currentStepId, focusReload, helpRequest, navLabel, onboardingNow, rolePromptWanted, shouldAutoOpen } from './onboarding';

const step = (id: string, over: Partial<OnboardingStep> = {}): OnboardingStep => ({
  id, kind: 'manual', label: id, detail: null, contact: null, link: null, optional: false,
  state: 'todo', blockedBy: [], status: null, doneAt: null, check: null, signIn: null, ...over,
});
const page = (over: Partial<OnboardingResponse> = {}): OnboardingResponse => ({
  enabled: true, intro: null, steps: [], remaining: 0, dismissedAt: null, show: false, error: null, checkedAt: 0, ...over,
});

describe('navLabel', () => {
  it('counts what is left', () => {
    expect(navLabel(3)).toBe('Get started (3 left)');
    expect(navLabel(1)).toBe('Get started (1 left)');
  });
  it('is gone when nothing is left or the count is not known yet', () => {
    expect(navLabel(0)).toBeNull();
    expect(navLabel(null)).toBeNull();
    expect(navLabel(undefined)).toBeNull();
  });
});

describe('onboardingNow', () => {
  it('uses the page once it is loaded, over the boot payload', () => {
    const boot = { enabled: true, remaining: 4, show: true };
    expect(onboardingNow(boot, page({ remaining: 1, show: false, dismissedAt: 'x' }))).toEqual({ enabled: true, remaining: 1, show: false });
  });
  it('falls back to the boot payload, then to off', () => {
    expect(onboardingNow({ enabled: true, remaining: null, show: false }, null)).toEqual({ enabled: true, remaining: null, show: false });
    expect(onboardingNow(undefined, null)).toEqual({ enabled: false, remaining: null, show: false });
  });
  it('shows nothing when the page is turned off', () => {
    expect(onboardingNow({ enabled: true, remaining: 2, show: true }, page({ enabled: false, remaining: 0 }))).toEqual({ enabled: false, remaining: 0, show: false });
  });
});

describe('shouldAutoOpen', () => {
  const on = { enabled: true, remaining: 2, show: true };
  it('opens on Home when there is something to do and it has not opened this session', () => {
    expect(shouldAutoOpen(on, '/', false)).toBe(true);
    expect(shouldAutoOpen(on, '/?x=1', false)).toBe(true);
  });
  it('leaves a deep link alone', () => {
    expect(shouldAutoOpen(on, '/issues', false)).toBe(false);
    expect(shouldAutoOpen(on, '/runs/abc', false)).toBe(false);
  });
  it('opens once per session', () => {
    expect(shouldAutoOpen(on, '/', true)).toBe(false);
  });
  it('stays shut when dismissed, done or turned off', () => {
    expect(shouldAutoOpen({ ...on, show: false }, '/', false)).toBe(false);
    expect(shouldAutoOpen({ ...on, remaining: 0 }, '/', false)).toBe(false);
    expect(shouldAutoOpen({ ...on, enabled: false }, '/', false)).toBe(false);
  });
});

describe('rolePromptWanted', () => {
  const boot = (enabled: boolean, ask = true) => ({ profile: { ask }, onboarding: { enabled, remaining: 3, show: true } });
  const roleStep = (over: Partial<OnboardingStep> = {}) => step('role', { kind: 'role', ...over });
  it('is the old modal when the page is off', () => {
    expect(rolePromptWanted(boot(false), null, '/')).toBe(true);
    expect(rolePromptWanted(boot(true), page({ enabled: false }), '/issues')).toBe(true);
  });
  it('asks nothing when the person has a role already, or before boot', () => {
    expect(rolePromptWanted(boot(false, false), null, '/')).toBe(false);
    expect(rolePromptWanted(boot(true, false), page({ steps: [roleStep()] }), '/issues')).toBe(false);
    expect(rolePromptWanted(undefined, null, '/')).toBe(false);
  });
  it('leaves Get started to ask while they are on it', () => {
    expect(rolePromptWanted(boot(true), page({ steps: [roleStep()] }), '/setup')).toBe(false);
    expect(rolePromptWanted(boot(true), page({ steps: [roleStep()] }), '/setup?x=1')).toBe(false);
    expect(rolePromptWanted(boot(true), null, '/setup')).toBe(false);
  });
  it('asks elsewhere while the role step is to do: a deep link, or after "I\'ll finish later"', () => {
    expect(rolePromptWanted(boot(true), page({ steps: [roleStep()] }), '/issues')).toBe(true);
    expect(rolePromptWanted(boot(true), page({ steps: [roleStep()], dismissedAt: 'x' }), '/')).toBe(true);
  });
  it("never asks on /setup while its role step is there, even after \"I'll finish later\" and reopening it", () => {
    expect(rolePromptWanted(boot(true), page({ steps: [roleStep()], dismissedAt: 'x' }), '/setup')).toBe(false);
  });
  it('waits on Home while Get started may open by itself, so the modal does not flash before /setup', () => {
    expect(rolePromptWanted(boot(true), null, '/', true)).toBe(false);
    expect(rolePromptWanted(boot(true), page({ steps: [roleStep()] }), '/', true)).toBe(false);
    expect(rolePromptWanted(boot(true), null, '/issues', true), 'a deep link still asks').toBe(true);
    expect(rolePromptWanted(boot(true), null, '/'), 'it did not open (or the request failed): Home asks').toBe(true);
    expect(rolePromptWanted(boot(false), null, '/', true), 'the page is off: nothing opens').toBe(true);
  });
  it('does not ask once the role step is done', () => {
    expect(rolePromptWanted(boot(true), page({ steps: [roleStep({ state: 'done' })] }), '/issues')).toBe(false);
  });
  it('falls back to the profile when Get started has not loaded', () => {
    expect(rolePromptWanted(boot(true), null, '/issues')).toBe(true);
  });
  it('still asks when the team turned the role step off', () => {
    expect(rolePromptWanted(boot(true), page({ steps: [step('claude', { kind: 'claude' })] }), '/setup')).toBe(true);
  });
});

describe('currentStepId', () => {
  it('is the first required step to do, skipping done and blocked ones', () => {
    const steps = [step('a', { state: 'done' }), step('b', { state: 'blocked', blockedBy: ['x'] }), step('c', { optional: true }), step('d'), step('e')];
    expect(currentStepId(steps)).toBe('d');
  });
  it('falls back to an optional step, then to none', () => {
    expect(currentStepId([step('a', { state: 'done' }), step('b', { optional: true })])).toBe('b');
    expect(currentStepId([step('a', { state: 'done' }), step('b', { state: 'checking' })])).toBeNull();
  });
});

describe('allRequiredDone', () => {
  it('ignores optional steps', () => {
    expect(allRequiredDone([step('a', { state: 'done' }), step('b', { optional: true })])).toBe(true);
  });
  it('is false while a required step is to do, blocked or still checking', () => {
    expect(allRequiredDone([step('a', { state: 'done' }), step('b')])).toBe(false);
    expect(allRequiredDone([step('a', { state: 'blocked' })])).toBe(false);
    expect(allRequiredDone([step('a', { state: 'checking' })])).toBe(false);
  });
  it('is false with no steps at all', () => {
    expect(allRequiredDone([])).toBe(false);
  });
});

describe('helpRequest', () => {
  it('asks for the Atlassian client secret by name', () => {
    expect(helpRequest(step('atlassian-secret', { kind: 'atlassian-secret', label: 'Get the Atlassian client secret' }), 'Acme'))
      .toBe("Hi, I'm setting up the Acme dashboard and need the Atlassian client secret. Could you send it to me in a direct message?");
  });
  it('names the step otherwise', () => {
    expect(helpRequest(step('vpn', { label: 'Install the VPN' }), 'Acme'))
      .toBe("Hi, I'm setting up the Acme dashboard and need a hand with this step: Install the VPN. Could you help?");
  });
  it('copes without a workspace name', () => {
    expect(helpRequest(step('vpn', { label: 'Install the VPN' }), '')).toMatch(/^Hi, I'm setting up the team dashboard /);
  });
});

describe('focusReload', () => {
  const at = 100_000;
  it('checks everything again only when coming back from a terminal or sign-in it opened', () => {
    expect(focusReload(page({ checkedAt: at - 6000 }), at, true)).toBe('force');
    expect(focusReload(page({ checkedAt: at - 6000 }), at, false)).toBe('quiet');
  });
  it('does nothing within 5 s of the last load, or with the page off', () => {
    expect(focusReload(page({ checkedAt: at - 1000 }), at, true)).toBeNull();
    expect(focusReload(page({ enabled: false, checkedAt: 0 }), at, true)).toBeNull();
    expect(focusReload(null, at, true)).toBeNull();
  });
});

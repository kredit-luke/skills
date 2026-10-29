import type { OnboardingBoot, OnboardingResponse, OnboardingStep } from '../../../../shared/api';

/** The Get started page as the sidebar, Home and the auto-open need it. */
export interface OnboardingNow { enabled: boolean; remaining: number | null; show: boolean }

/** The sidebar item's label while required steps are left ("Get started (3 left)"); null hides it. */
export function navLabel(remaining: number | null | undefined): string | null {
  return remaining && remaining > 0 ? `Get started (${remaining} left)` : null;
}

/** GET /api/onboarding once it's loaded (it's fresher), else the boot payload's cached count. */
export function onboardingNow(boot: OnboardingBoot | null | undefined, page: OnboardingResponse | null): OnboardingNow {
  if (page) return { enabled: page.enabled, remaining: page.remaining, show: page.enabled && page.show };
  return boot ? { enabled: boot.enabled, remaining: boot.remaining, show: boot.enabled && boot.show } : { enabled: false, remaining: null, show: false };
}

/**
 * Open /setup by itself: there's something to do, they haven't said "I'll finish later", they landed
 * on Home (a deep link is where they meant to go) and it hasn't opened already this session.
 */
export function shouldAutoOpen(o: OnboardingNow, url: string, openedThisSession: boolean): boolean {
  return o.enabled && o.show && (o.remaining ?? 0) > 0 && url.split(/[?#]/)[0] === '/' && !openedThisSession;
}

/**
 * The first-start role modal, while boot.profile.ask: when the page is off (onboarding.json "steps": false)
 * or the team turned its role step off; else while that step is still to do (or the page hasn't loaded)
 * and they aren't on /setup, where it asks inline. autoOpening: the app is still deciding whether to open
 * /setup by itself, so Home waits for that rather than flash the modal first.
 */
export function rolePromptWanted(
  boot: { profile?: { ask: boolean } | null; onboarding?: OnboardingBoot | null } | null | undefined,
  page: OnboardingResponse | null,
  url: string,
  autoOpening = false,
): boolean {
  if (!boot?.profile?.ask) return false;
  if (!(page ? page.enabled : boot.onboarding?.enabled)) return true;
  const role = page?.steps.find((s) => s.kind === 'role');
  if (page && !role) return true;
  const path = url.split(/[?#]/)[0];
  if (path === '/setup' || (path === '/' && autoOpening)) return false;
  return !role || role.state !== 'done';
}

/**
 * Coming back to the Get started tab: 'force' (run the Machine checks and `claude auth status` again)
 * when the last thing they did there opened a terminal or a sign-in, else 'quiet' (cached checks);
 * null within 5 s of the last load, or with the page off.
 */
export function focusReload(page: OnboardingResponse | null, now: number, openedElsewhere: boolean): 'force' | 'quiet' | null {
  if (!page?.enabled || now - page.checkedAt <= 5000) return null;
  return openedElsewhere ? 'force' : 'quiet';
}

/** The step the page opens: the first required one to do now, else the first optional one; null when there's none. */
export function currentStepId(steps: OnboardingStep[]): string | null {
  const todo = steps.filter((s) => s.state === 'todo');
  return (todo.find((s) => !s.optional) || todo[0])?.id ?? null;
}

/** Every required step is done (the "what next" card). */
export function allRequiredDone(steps: OnboardingStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.optional || s.state === 'done');
}

/** The Copy request button's message to the step's contact; nothing is sent by the dashboard. */
export function helpRequest(step: OnboardingStep, workspaceName: string): string {
  const intro = `Hi, I'm setting up the ${workspaceName.trim() || 'team'} dashboard and need`;
  if (step.kind === 'atlassian-secret') return `${intro} the Atlassian client secret. Could you send it to me in a direct message?`;
  return `${intro} a hand with this step: ${step.label.replace(/[.\s]+$/, '')}. Could you help?`;
}

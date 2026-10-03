import { describe, expect, it } from 'vitest';
import { siteEditLaunch, siteEditPrompt } from './site-edit';

describe('siteEditPrompt', () => {
  it('names the repo, asks for the latest main first, and ends ready for the user to type', () => {
    const p = siteEditPrompt('marketing-site');
    expect(p.startsWith('Working in repo marketing-site.')).toBe(true);
    expect(p).toContain('git pull --ff-only origin main');
    expect(p).toContain('stop and ask me');
    expect(p.endsWith('Then make these changes: ')).toBe(true);
  });

  it('mentions the page when there is one', () => {
    expect(siteEditPrompt('Release-Notes', 'releases/2026-09.html')).toContain('(page releases/2026-09.html)');
  });

  it('launches in the main workspace with the cursor at the end', () => {
    const o = siteEditLaunch('roadmap', 'Roadmap');
    expect(o).toMatchObject({ title: 'Make edits · Roadmap', workspace: 'main', focusPrompt: true });
    expect(o.planMode).toBeUndefined();
  });
});

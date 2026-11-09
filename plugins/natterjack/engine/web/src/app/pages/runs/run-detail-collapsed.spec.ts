import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A collapsed run header hides everything but the title line. The cards that wait on you (a watch to
// approve, a routine to create) must stay, or the only button that moves the run on is out of sight.
// No TestBed here (vitest.config.ts), so this checks the template and the stylesheet together.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'run-detail.component.html'), 'utf8');
const scss = readFileSync(join(here, 'run-detail.component.scss'), 'utf8');

/** The opening tag of the element that holds `marker` (the nearest `<div` before it). */
const cardFor = (marker: string) => {
  const at = html.indexOf(marker);
  expect(at, `template has ${marker}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div', at);
  return html.slice(open, html.indexOf('>', open) + 1);
};

describe('run header collapsed', () => {
  it('hides everything except the title line and cards that need you', () => {
    expect(scss).toMatch(/\.collapsed > :not\(\.ttl\):not\(\.needs-you\) \{ display: none; \}/);
    expect(scss).not.toMatch(/\.collapsed > :not\(\.ttl\) \{/);
  });

  it('keeps a watch waiting for approval', () => {
    expect(cardFor('approveWatch()')).toContain(`[class.needs-you]="w.approval === 'pending' && !r.remote"`);
  });

  it('keeps a routine waiting to be created', () => {
    expect(cardFor('Claude proposes a routine')).toMatch(/class="[^"]*\bneeds-you\b/);
  });
});

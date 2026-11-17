import { describe, expect, it } from 'vitest';
import { changeMapLabel, changeMapUrl, changeMaps } from './change-map';

const out = (name: string, modifiedAt: string) => ({ name, size: 1, modifiedAt });

describe('changeMaps', () => {
  it('keeps only change-map pages, newest first', () => {
    const list = [out('report.pdf', '2026-11-16T10:00:00Z'), out('ENG-1.change-map.html', '2026-11-16T09:00:00Z'), out('maps/pr-4.change-map.html', '2026-11-16T11:00:00Z'), out('notes.html', '2026-11-16T12:00:00Z')];
    expect(changeMaps(list).map((m) => m.name)).toEqual(['maps/pr-4.change-map.html', 'ENG-1.change-map.html']);
  });
});

describe('changeMapLabel', () => {
  it('drops the folder and the suffix', () => {
    expect(changeMapLabel('maps/ENG-12.change-map.html')).toBe('ENG-12');
    expect(changeMapLabel('x.Change-Map.HTML')).toBe('x');
  });
});

describe('changeMapUrl', () => {
  it('points at the sandboxed route, each path part encoded, versioned, light', () => {
    expect(changeMapUrl('r1', out('my maps/a#b.change-map.html', '2026-11-16T09:00:00Z')))
      .toBe('/api/runs/r1/change-map/my%20maps/a%23b.change-map.html?v=2026-11-16T09%3A00%3A00Z#theme=light');
  });
});

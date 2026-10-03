import { describe, expect, it } from 'vitest';
import { buildThread } from '../runs/thread';
import { bytes, pastedName } from './util';

describe('bytes', () => {
  it('picks a readable unit', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(2048)).toBe('2 KB');
    expect(bytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});

describe('pastedName', () => {
  it('names a pasted screenshot by time, with the right extension', () => {
    const at = new Date(2026, 8, 26, 14, 5, 9);
    expect(pastedName('image/png', at)).toBe('screenshot-2026-09-26-140509.png');
    expect(pastedName('image/jpeg', at)).toBe('screenshot-2026-09-26-140509.jpg');
  });
});

describe('reply attachments in the transcript', () => {
  it('keep a reply that is only files, with its attachments', () => {
    const f = { id: 'abc', name: 'x.png', file: 'abc-x.png', size: 1, kind: 'image', path: '/x.png' };
    const t = buildThread([{ type: 'human', text: '', turn: 2, uuid: 'u', attachments: [f] }]);
    expect(t.items).toHaveLength(1);
    const h = t.items[0];
    expect(h.kind).toBe('human');
    if (h.kind === 'human') expect(h.attachments).toEqual([f]);
  });
});

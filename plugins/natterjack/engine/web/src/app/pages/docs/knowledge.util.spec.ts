import { describe, expect, it } from 'vitest';
import type { DocSite, KnowledgeNote } from '../../../../../shared/api';
import { renderMd } from '../../core/markdown';
import { buildTree, byArea, filterNotes, joinNote, reach, relFromDocId, resolveWiki } from './knowledge.util';

const note = (rel: string, over: Partial<KnowledgeNote> = {}): KnowledgeNote => ({
  rel, title: rel.split('/').pop()!.replace(/\.md$/, ''), owner: null, reviewed: null, tags: [], updatedAt: null,
  links: [], unresolved: [], backlinks: [], summary: '', since: null, dueAt: null, stale: false, ...over,
});
const site = (over: Partial<DocSite>): DocSite => ({
  key: 'k', name: 'K', repo: null, kind: 'notes', type: '', live: null, url: null, provider: null, description: null,
  available: true, previewUrl: null, docs: 0, ...over,
});

describe('knowledge tree and links', () => {
  it('builds a folder tree, folders first and sorted', () => {
    const t = buildTree([note('b.md'), note('Finance/Policies/Refunds.md'), note('Finance/Close.md'), note('a.md')]);
    expect(t.notes.map((n) => n.rel)).toEqual(['a.md', 'b.md']);
    expect(t.folders.map((f) => f.path)).toEqual(['Finance']);
    expect(t.folders[0].notes.map((n) => n.rel)).toEqual(['Finance/Close.md']);
    expect(t.folders[0].folders[0].path).toBe('Finance/Policies');
  });
  it('resolves wikilinks like the server', () => {
    const rels = ['Company/Mission.md', 'Finance/Refunds.md', 'Finance/old/Refunds.md', 'plans/q4.md'];
    expect(resolveWiki('refunds', 'Company/Mission.md', rels)).toBe('Finance/Refunds.md');
    expect(resolveWiki('Refunds', 'Finance/old/x.md', rels)).toBe('Finance/old/Refunds.md');
    expect(resolveWiki('plans/q4', 'x.md', rels)).toBe('plans/q4.md');
    expect(resolveWiki('nope', 'x.md', rels)).toBeNull();
    expect(joinNote('Finance/Close.md', '../plans/q4.md#goals')).toBe('plans/q4.md');
    expect(joinNote('Close.md', '../../etc/passwd')).toBeNull();
  });
  it('renders wikilinks through the resolver: alias, heading, missing, embeds', () => {
    const html = renderMd('See [[Refunds|our policy]], [[Mission#Why]], [[Ghost]] and ![[chart.png]].', {
      image: (src) => '/img/' + src, link: () => null,
      wiki: (t) => (t === 'Ghost' ? null : '#' + t),
    });
    expect(html).toContain('<a class="wl-a" href="#Refunds" data-wiki="Refunds">our policy</a>');
    expect(html).toContain('>Mission › Why</a>');
    expect(html).toContain('<span class="wl-missing" title="No note called Ghost yet">Ghost</span>');
    expect(html).toContain('<img src="/img/chart.png" alt="chart.png" loading="lazy">');
    expect(renderMd('[[Plain]]')).toContain('<span class="wl">Plain</span>');
  });
});

describe('knowledge filters and sources', () => {
  it('filters by words, tag and staleness', () => {
    const ns = [note('Refunds.md', { tags: ['policy'], owner: 'Dana' }), note('Close.md', { stale: true, summary: 'month end' })];
    expect(filterNotes(ns, 'dana', null).map((n) => n.rel)).toEqual(['Refunds.md']);
    expect(filterNotes(ns, 'month', null).map((n) => n.rel)).toEqual(['Close.md']);
    expect(filterNotes(ns, '', 'policy').map((n) => n.rel)).toEqual(['Refunds.md']);
    expect(filterNotes(ns, '', null, true).map((n) => n.rel)).toEqual(['Close.md']);
  });
  it('maps search result ids back to notes', () => {
    expect(relFromDocId('doc:knowledge/fin/Policies/Refunds.md', site({ kind: 'store', key: 'fin' }))).toBe('Policies/Refunds.md');
    expect(relFromDocId('doc:handbook/a/b.md', site({ repo: 'handbook' }))).toBe('a/b.md');
    expect(relFromDocId('doc:other/x.md', site({ repo: 'handbook' }))).toBeNull();
  });
  it('reads connector status from the Connections check', () => {
    const c = { checkedAt: 1, connections: [{ name: 'claude.ai Notion', state: 'connected', missing: false, approval: null }] } as any;
    expect(reach(site({ connection: 'claude.ai notion' }), c)).toBe('ok');
    expect(reach(site({ connection: 'claude.ai Slack' }), c)).toBe('bad');
    expect(reach(site({ connection: 'claude.ai Notion' }), { checkedAt: null, connections: [] } as any)).toBe('checking');
    expect(reach(site({}), c)).toBe('none');
    expect(reach(site({ connection: 'claude.ai Atlassian', connectionAny: ['claude.ai Atlassian', 'claude.ai Notion'] }), c)).toBe('ok');
  });
  it('groups by area, unknown areas last', () => {
    const areas = [{ key: 'fin', label: 'Finance', owner: null, reviewEvery: 90, description: null }];
    const g = byArea([site({ key: 'a', area: 'fin' }), site({ key: 'b' }), site({ key: 'c', area: 'nope' })], areas);
    expect(g.map((x) => [x.area?.key || null, x.sites.map((s) => s.key)])).toEqual([['fin', ['a']], [null, ['b', 'c']]]);
  });
});

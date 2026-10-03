/**
 * A small markdown renderer for our own docs (skills, memory, guides, Linear
 * descriptions): headings, fences, lists, tables, quotes, inline code/bold/links.
 * Everything is escaped first, so the output is safe to bind with [innerHTML]
 * through the trusted-html pipe. Pure functions; no DOM except markDom().
 */
import { esc } from './util';

/**
 * Where a document's relative URLs point. Without one (the default), images aren't
 * shown and relative links are inert. Explore passes one so `![](img.png)` loads
 * the file and `[x](other.md)` opens it. Return null to leave a URL inert.
 */
export interface MdUrls {
  image(src: string): string | null;
  link(href: string): string | null;
}

export function inlineMd(s: string, urls?: MdUrls): string {
  // Links may be written [text](url) or, as Linear does, [text](<url>). Relative links
  // (to another file in the same repo) keep their text and show the path on hover.
  const re = /!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)|`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(<?(https?:[^)\s>]+)>?\)|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s:]+)\)/g;
  let out = '', last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[2] != null && !urls) { re.lastIndex = m.index + 1; continue; } // no image support: read on as text
    out += esc(s.slice(last, m.index));
    if (m[2] != null) {
      const src = /^https?:/.test(m[2]) ? m[2] : urls!.image(m[2]);
      out += src ? '<img src="' + esc(src) + '" alt="' + esc(m[1]) + '" loading="lazy">' : esc(m[0]);
    }
    else if (m[3] != null) out += '<code>' + esc(m[3]) + '</code>';
    else if (m[4] != null) out += '<b>' + esc(m[4]) + '</b>';
    else if (m[5] != null) out += '<a href="' + esc(m[6]) + '" target="_blank" rel="noopener">' + esc(m[5]) + '</a>';
    else if (m[8] != null) {
      const href = urls?.link(m[9]);
      out += href ? '<a href="' + esc(href) + '" data-rel="' + esc(m[9]) + '">' + esc(m[8]) + '</a>'
        : '<span class="rl" title="' + esc(m[9]) + '">' + esc(m[8]) + '</span>';
    }
    else out += '<span class="wl">' + esc(m[7]) + '</span>';
    last = re.lastIndex;
  }
  return out + esc(s.slice(last));
}

export function mdSlug(s: string): string {
  return String(s).toLowerCase().replace(/[`*_[\]()]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

export function renderMd(md: string | null | undefined, urls?: MdUrls): string {
  const lines = String(md || '').replace(/\r/g, '').replace(/^---\n[\s\S]*?\n---\n?/, '').split('\n');
  let html = '', i = 0;
  const isBlockStart = (l: string) => /^(#{1,6}\s|```|~~~|\s*[-*+]\s|\s*\d+[.)]\s|>|\|)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) {
      const lvl = Math.min(6, h[1].length + 1);
      html += `<h${lvl} data-sec="${esc(mdSlug(h[2]))}">${inlineMd(h[2], urls)}</h${lvl}>`;
      i++; continue;
    }
    if (/^\s*(```|~~~)/.test(l)) {
      const fence: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j])) fence.push(lines[j++]);
      html += '<pre><code>' + esc(fence.join('\n')) + '</code></pre>';
      i = j + 1; continue;
    }
    if (/^\|/.test(l)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      html += '<table>' + rows.filter((r) => !/^\|[\s:|-]+\|?\s*$/.test(r)).map((r, ri) => {
        const cells = r.replace(/^\||\|\s*$/g, '').split('|');
        const tag = ri ? 'td' : 'th';
        return '<tr>' + cells.map((c) => `<${tag}>${inlineMd(c.trim(), urls)}</${tag}>`).join('') + '</tr>';
      }).join('') + '</table>';
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items: string[] = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (item) items.push(item[2]); else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const t = ordered ? 'ol' : 'ul';
      html += `<${t}>` + items.map((x) => '<li>' + inlineMd(x, urls) + '</li>').join('') + `</${t}>`;
      continue;
    }
    if (/^>/.test(l)) {
      const q: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      html += '<blockquote>' + inlineMd(q.join(' '), urls) + '</blockquote>';
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    html += '<p>' + inlineMd(para.join(' '), urls) + '</p>';
  }
  return html;
}

function termRe(terms: string[], flags: string): RegExp {
  return new RegExp('\\b(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[a-z0-9]*', flags);
}

/** Escape text and wrap query-term matches (word starts) in <mark>. */
export function markTerms(text: string | null | undefined, terms?: string[] | null): string {
  const t = String(text || '');
  if (!terms || !terms.length) return esc(t);
  const re = termRe(terms, 'gi');
  let out = '', last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    out += esc(t.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = re.lastIndex;
    if (m[0] === '') re.lastIndex++;
  }
  return out + esc(t.slice(last));
}

/** Highlight terms inside already-rendered DOM (text nodes only). */
export function markDom(root: HTMLElement, terms?: string[] | null): void {
  if (!terms || !terms.length) return;
  const re = termRe(terms, 'i');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const tn = n as Text;
    if (re.test(tn.nodeValue || '') && !(tn.parentElement && tn.parentElement.closest('mark'))) nodes.push(tn);
  }
  nodes.slice(0, 400).forEach((node) => {
    const span = document.createElement('span');
    span.innerHTML = markTerms(node.nodeValue, terms);
    node.parentNode?.replaceChild(span, node);
  });
}

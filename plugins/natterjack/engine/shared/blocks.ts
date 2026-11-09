// The blocks Claude ends a dashboard turn with (<<QUESTION>>, <<WATCH>>, <<ROUTINE>>): where one
// is, and the text without it. The server (Node type stripping, .ts extensions) and the web build
// both compile this file, so it has no imports. A marker inside code is just text (Claude
// explaining how runs work).

export type BlockTag = 'QUESTION' | 'WATCH' | 'ROUTINE';

/**
 * Where a markdown text has code: fenced blocks (``` or ~~~, closed by a fence of the same
 * character at least as long; unclosed runs to the end) and inline spans (a run of N backticks
 * up to the next run of exactly N). Half-open [start, end) offsets.
 */
export function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const inline = (from: number, to: number) => {
    const s = text.slice(from, to);
    const runs = /`+/g;
    for (let m: RegExpExecArray | null; (m = runs.exec(s)); ) {
      const n = m[0].length;
      const next = /`+/g;
      next.lastIndex = m.index + n;
      let c: RegExpExecArray | null;
      while ((c = next.exec(s)) && c[0].length !== n) {}
      if (c) { out.push([from + m.index, from + c.index + n]); runs.lastIndex = c.index + n; }
    }
  };
  const fenceRe = /^[ \t]{0,3}(`{3,}|~{3,})/;
  let pos = 0, prose = 0;
  let open: { ch: string; len: number; start: number } | null = null;
  for (const line of text.split("\n")) {
    const lineEnd = pos + line.length;
    const f = fenceRe.exec(line);
    if (open) {
      if (f && f[1][0] === open.ch && f[1].length >= open.len && !line.slice(f[0].length).trim()) { out.push([open.start, lineEnd]); open = null; prose = lineEnd + 1; }
    } else if (f && !(f[1][0] === "`" && line.slice(f[0].length).includes("`"))) {
      inline(prose, pos);
      open = { ch: f[1][0], len: f[1].length, start: pos };
    }
    pos = lineEnd + 1;
  }
  if (open) out.push([open.start, text.length]);
  else inline(prose, text.length);
  return out;
}

/**
 * A <<QUESTION>>, <<WATCH>> or <<ROUTINE>> block: the first marker that isn't inside code (codeRanges). A
 * marker in code (Claude explaining how runs work) is just text: matching it would turn the
 * rest of the answer into a question and cut the answer off there.
 */
export function findBlock(text: string, tag: BlockTag): { start: number; end: number; body: string } | null {
  text = text || "";
  const open = new RegExp(`<<${tag}>>`, "g");
  let code: [number, number][] | null = null;
  for (let m: RegExpExecArray | null; (m = open.exec(text)); ) {
    const start = m.index;
    code ??= codeRanges(text);
    if (code.some(([a, b]) => start >= a && start < b)) continue;
    const from = m.index + m[0].length;
    const close = text.indexOf(`<</${tag}>>`, from);
    const end = close < 0 ? text.length : close + `<</${tag}>>`.length;
    return { start, end, body: text.slice(from, close < 0 ? text.length : close) };
  }
  return null;
}

/** The text without its block (if any). */
export function stripBlock(text: string, tag: BlockTag): string {
  const b = findBlock(text, tag);
  return b ? `${text.slice(0, b.start).trimEnd()}\n${text.slice(b.end).trimStart()}`.trim() : text;
}

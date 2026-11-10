import fs from "node:fs";
import path from "node:path";

const MD_EXT = /\.(md|markdown)$/i;

/**
 * A markdown file a run named (a plan, a HANDOFF.md, a PRD), for the run page's viewer: { path, text }.
 * `raw` may start with ~ (the home folder), be absolute, or be relative to one of `bases` (the
 * worktree the run worked in first, then the folder it started in; the first that has the file
 * wins). Only .md and .markdown files are read, by the name asked for and by the file it resolves
 * to, and only from ~/.claude/plans or one of `roots` (this workspace and its worktrees, the run's
 * outputs folder). Symlinks are resolved before the check, so a link can't lead out or to a
 * non-markdown file. At most `maxBytes` are read.
 */
export function readRunMarkdown(raw: string, opts: { home: string; bases: string[]; roots: string[]; maxBytes?: number }): { path: string; text: string } {
  const bad = (status: number, message: string) => Object.assign(new Error(message), { status });
  const given = String(raw || "").trim();
  if (!given || given.length > 1000 || given.includes("\0")) throw bad(400, "Bad path");
  if (!MD_EXT.test(given)) throw bad(400, "Only markdown files (.md) open here.");
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
  const expanded = given.replace(/^~(?=$|[\\/])/, opts.home);
  const candidates = path.isAbsolute(expanded) ? [expanded] : opts.bases.map((b) => path.resolve(b, expanded));
  const p = candidates.map(real).find((x): x is string => !!x);
  if (!p) throw bad(404, `The file isn't there: ${given}`);
  if (!MD_EXT.test(p)) throw bad(400, "Only markdown files (.md) open here.");
  const under = (root: string | null, x: string) => { if (!root) return false; const r = path.relative(root, x); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r); };
  const roots = [path.join(opts.home, ".claude", "plans"), ...opts.roots].map(real);
  if (!roots.some((r) => under(r, p))) throw bad(403, "That file is outside this workspace and ~/.claude/plans.");
  const st = fs.statSync(p);
  if (!st.isFile()) throw bad(404, `Not a file: ${given}`);
  const max = opts.maxBytes ?? 300_000;
  const buf = Buffer.alloc(Math.min(st.size, max));
  const fd = fs.openSync(p, "r");
  let n = 0;
  try { while (n < buf.length) { const got = fs.readSync(fd, buf, n, buf.length - n, n); if (!got) break; n += got; } } finally { fs.closeSync(fd); }
  const text = buf.subarray(0, n).toString("utf-8");
  return { path: p, text: st.size > max ? text + "\n\n…(cut here)" : text };
}

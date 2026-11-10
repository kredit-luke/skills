import fs from "node:fs";
import path from "node:path";

/**
 * A markdown file a run named (a plan, a HANDOFF.md, a PRD), for the run page's viewer: { path, text }.
 * `raw` may start with ~ (the home folder) or be relative to the run's folder (`base`). Only .md and
 * .markdown files are read, and only from ~/.claude/plans or one of `roots` (this workspace and its
 * worktrees, the run's outputs folder). Symlinks are resolved before the check, so a link can't lead out.
 */
export function readRunMarkdown(raw: string, opts: { home: string; base: string; roots: string[]; maxBytes?: number }): { path: string; text: string } {
  const bad = (status: number, message: string) => Object.assign(new Error(message), { status });
  const given = String(raw || "").trim();
  if (!given || given.length > 1000 || given.includes("\0")) throw bad(400, "Bad path");
  if (!/\.(md|markdown)$/i.test(given)) throw bad(400, "Only markdown files (.md) open here.");
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
  const expanded = given.replace(/^~(?=$|[\\/])/, opts.home);
  const p = real(path.resolve(opts.base, expanded));
  if (!p) throw bad(404, `The file isn't there: ${given}`);
  const under = (root: string | null, x: string) => { if (!root) return false; const r = path.relative(root, x); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r); };
  const roots = [path.join(opts.home, ".claude", "plans"), ...opts.roots].map(real);
  if (!roots.some((r) => under(r, p))) throw bad(403, "That file is outside this workspace and ~/.claude/plans.");
  const st = fs.statSync(p);
  if (!st.isFile()) throw bad(404, `Not a file: ${given}`);
  const max = opts.maxBytes ?? 300_000;
  const text = fs.readFileSync(p, "utf-8");
  return { path: p, text: st.size > max ? text.slice(0, max) + "\n\n…(cut here)" : text };
}

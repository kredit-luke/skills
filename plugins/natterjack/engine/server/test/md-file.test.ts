// The run page's markdown viewer reads only .md files from ~/.claude/plans, this workspace's
// folders and the run's outputs; ~ and paths relative to the run's folders resolve first.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRunMarkdown } from "../src/md-file.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "md-file-"));

test("readRunMarkdown reads a markdown file in ~/.claude/plans or a workspace, nothing else", () => {
  const home = tmp(), ws = tmp(), elsewhere = tmp();
  const plans = path.join(home, ".claude", "plans");
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, "ENG-1-retries.md"), "# Plan");
  fs.mkdirSync(path.join(ws, "docs"));
  fs.writeFileSync(path.join(ws, "docs", "HANDOFF.md"), "handoff");
  fs.writeFileSync(path.join(ws, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(elsewhere, "notes.md"), "not ours");
  fs.writeFileSync(path.join(home, "notes.md"), "home");
  const opts = { home, bases: [ws], roots: [ws] };

  assert.deepEqual(readRunMarkdown("~/.claude/plans/ENG-1-retries.md", opts), { path: fs.realpathSync(path.join(plans, "ENG-1-retries.md")), text: "# Plan" });
  assert.equal(readRunMarkdown("docs/HANDOFF.md", opts).text, "handoff");
  assert.equal(readRunMarkdown(path.join(ws, "docs", "HANDOFF.md"), opts).text, "handoff");
  assert.equal(readRunMarkdown(" docs/HANDOFF.md ", opts).text, "handoff");

  const status = (raw: string, code: number) => assert.throws(() => readRunMarkdown(raw, opts), (e: any) => e.status === code, raw);
  status(".env", 400);
  status("", 400);
  status("~/notes.md", 403);
  status(path.join(elsewhere, "notes.md"), 403);
  status("../" + path.basename(elsewhere) + "/notes.md", 403);
  status("~/.claude/plans/../../notes.md", 403);
  status("docs/missing.md", 404);
  fs.mkdirSync(path.join(ws, "dir.md"));
  status("dir.md", 404);

  // A symlink is followed to where it points: out of the roots, or to a file that isn't markdown, is refused.
  try { fs.symlinkSync(path.join(elsewhere, "notes.md"), path.join(ws, "sneaky.md")); } catch { return; }
  status("sneaky.md", 403);
  fs.symlinkSync(path.join(ws, ".env"), path.join(ws, "env.md"));
  status("env.md", 400);
});

test("readRunMarkdown resolves a relative path in the run's worktree first, then where it started", () => {
  const home = tmp(), main = tmp(), wt = tmp();
  fs.writeFileSync(path.join(main, "HANDOFF.md"), "main's");
  fs.writeFileSync(path.join(wt, "HANDOFF.md"), "the worktree's");
  fs.writeFileSync(path.join(main, "ONLY-MAIN.md"), "only in main");
  const opts = { home, bases: [wt, main], roots: [main, wt] };
  assert.equal(readRunMarkdown("HANDOFF.md", opts).text, "the worktree's");
  assert.equal(readRunMarkdown("ONLY-MAIN.md", opts).text, "only in main");
});

test("readRunMarkdown reads no more than maxBytes", () => {
  const home = tmp(), ws = tmp();
  fs.writeFileSync(path.join(ws, "BIG.md"), "x".repeat(50));
  fs.writeFileSync(path.join(ws, "SMALL.md"), "small");
  const opts = { home, bases: [ws], roots: [ws], maxBytes: 10 };
  assert.match(readRunMarkdown("BIG.md", opts).text, /^x{10}\n\n…\(cut here\)$/);
  assert.equal(readRunMarkdown("SMALL.md", opts).text, "small");
});

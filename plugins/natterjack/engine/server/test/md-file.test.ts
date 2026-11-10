// The run page's markdown viewer reads only .md files from ~/.claude/plans, this workspace's
// folders and the run's outputs; ~ and paths relative to the run's folder resolve first.
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
  const opts = { home, base: ws, roots: [ws] };

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

  // A symlink inside a root that points out is followed to where it points, and refused.
  try { fs.symlinkSync(path.join(elsewhere, "notes.md"), path.join(ws, "sneaky.md")); } catch { return; }
  status("sneaky.md", 403);
});

test("readRunMarkdown cuts a long file", () => {
  const home = tmp(), ws = tmp();
  fs.writeFileSync(path.join(ws, "BIG.md"), "x".repeat(50));
  assert.match(readRunMarkdown("BIG.md", { home, base: ws, roots: [ws], maxBytes: 10 }).text, /^x{10}\n\n…\(cut here\)$/);
});

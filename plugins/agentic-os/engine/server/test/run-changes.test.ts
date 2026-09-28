import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RunChanges, editedPaths, listRepos } from "../src/run-changes.ts";

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
function repo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@example.com");
  g(dir, "config", "user.name", "t");
  g(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  g(dir, "add", ".");
  g(dir, "commit", "-q", "-m", "init");
}
const meta = (id: string, cwd: string, turns = 1): any => ({ id, cwd, turns });

test("changes are measured from the run's first snapshot, ignoring edits that were already there", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const runsDir = path.join(ws, "_runs");
  fs.mkdirSync(runsDir);
  const api = path.join(ws, "API");
  repo(api);
  // Pre-existing uncommitted work and an untracked file: not the run's doing.
  fs.writeFileSync(path.join(api, "b.txt"), "b\nmine, before the run\n");
  fs.writeFileSync(path.join(api, "notes.txt"), "old untracked\n");

  const rc = new RunChanges(runsDir);
  assert.deepEqual(listRepos(ws), [api]);
  await rc.snapshot(meta("r1", ws));

  // The run: edits a.txt, adds new.txt, commits.
  fs.writeFileSync(path.join(api, "a.txt"), "one\nTWO\nthree\n");
  fs.writeFileSync(path.join(api, "new.txt"), "x\ny\n");
  g(api, "add", "a.txt");
  g(api, "commit", "-q", "-m", "run edit");

  const events = [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(api, "a.txt") } }] } }];
  const r = await rc.changes(meta("r1", ws), events as any, true);
  assert.equal(r.hasBaseline, true);
  assert.equal(r.scopes.length, 1);
  const s = r.scopes[0];
  assert.equal(s.repo, "API");
  assert.equal(s.baseKind, "run-start");
  assert.deepEqual(s.files.map((f) => `${f.status} ${f.file}`), ["M a.txt", "?? new.txt"]);
  assert.equal(s.files[0].adds, 2);
  assert.equal(s.commits.length, 1);
  assert.match(s.commits[0].message, /run edit/);

  const diff = await rc.fileDiff(meta("r1", ws), events as any, api, "a.txt");
  assert.match(diff, /\+TWO/);
  await assert.rejects(rc.fileDiff(meta("r1", ws), events as any, api, "b.txt"), /Not one of this run/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a repo the run edited without a snapshot is compared with where its branch left main", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const runsDir = path.join(ws, "_runs");
  fs.mkdirSync(runsDir);
  const wt = path.join(ws, "worktrees", "ENG-1", "API"); // created during the run: never snapshotted
  repo(wt);
  g(wt, "checkout", "-q", "-b", "feature/ENG-1");
  fs.writeFileSync(path.join(wt, "a.txt"), "changed on the branch\n");
  g(wt, "commit", "-q", "-am", "branch work");

  const rc = new RunChanges(runsDir);
  await rc.snapshot(meta("r2", ws)); // workspace root has no direct repos; worktrees/ is skipped
  const events = [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: path.join(wt, "a.txt") } }] } }];
  const r = await rc.changes(meta("r2", ws), events as any, true);
  assert.equal(r.scopes.length, 1);
  assert.equal(r.scopes[0].baseKind, "branch");
  assert.equal(r.scopes[0].branch, "feature/ENG-1");
  assert.equal(r.scopes[0].repo, "worktrees/ENG-1/API");
  assert.deepEqual(r.scopes[0].files.map((f) => f.file), ["a.txt"]);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("editedPaths picks absolute paths from edit tools in any thread", () => {
  const ev = [
    { type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/w/API/n.ipynb" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/w/API/x.cs" } }, { type: "tool_use", name: "Edit", input: { file_path: "relative.cs" } }] } },
  ];
  assert.deepEqual(editedPaths(ev as any), ["/w/API/n.ipynb"]);
});

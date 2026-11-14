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

test("a run that worked in a worktree lists only that worktree's repos", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const runsDir = path.join(ws, "_runs");
  fs.mkdirSync(runsDir);
  const mainApi = path.join(ws, "API");
  const tools = path.join(ws, "tools");
  repo(mainApi);
  repo(tools);
  const wtDir = path.join(ws, "worktrees", "ENG-1");
  const wt = path.join(wtDir, "API");
  const wtWeb = path.join(wtDir, "web"); // cloned later and committed to by a subagent: no edit event for it
  repo(wt);
  g(wt, "checkout", "-q", "-b", "feature/ENG-1");
  repo(wtWeb);
  g(wtWeb, "checkout", "-q", "-b", "feature/ENG-1");
  fs.writeFileSync(path.join(wtWeb, "b.txt"), "subagent\n");
  g(wtWeb, "commit", "-q", "-am", "web work");

  const rc = new RunChanges(runsDir);
  await rc.snapshot(meta("r3", ws));
  // Main's repos change during the run: another session's commit, and one stray edit by the run.
  fs.writeFileSync(path.join(tools, "a.txt"), "someone else\n");
  g(tools, "commit", "-q", "-am", "unrelated");
  fs.writeFileSync(path.join(mainApi, "a.txt"), "stray\n");
  fs.writeFileSync(path.join(wt, "a.txt"), "the run's work\n");
  const events = [{ type: "assistant", message: { content: [
    { type: "tool_use", name: "Edit", input: { file_path: path.join(mainApi, "a.txt") } },
    { type: "tool_use", name: "Edit", input: { file_path: path.join(wt, "a.txt") } },
  ] } }];

  const all = await rc.changes(meta("r3", ws), events as any, true);
  assert.deepEqual(all.scopes.map((s) => s.repo).sort(), ["API", "tools", "worktrees/ENG-1/API"]);

  const worktree = { path: wtDir, repos: [wt, wtWeb] };
  const r = await rc.changes(meta("r3", ws), events as any, true, worktree);
  assert.deepEqual(r.scopes.map((s) => s.repo), ["API", "web"]);
  assert.equal(r.scopes[0].path, wt);
  assert.deepEqual(r.scopes[1].commits.map((c) => c.message), ["web work"]);
  await assert.rejects(rc.fileDiff(meta("r3", ws), events as any, mainApi, "a.txt", worktree), /Not one of this run/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("editedPaths picks absolute paths from edit tools in any thread", () => {
  const ev = [
    { type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/w/API/n.ipynb" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/w/API/x.cs" } }, { type: "tool_use", name: "Edit", input: { file_path: "relative.cs" } }] } },
  ];
  assert.deepEqual(editedPaths(ev as any), ["/w/API/n.ipynb"]);
});

test("statuses and line counts come from one diff: renames, deletions, binaries, a branch read from a worktree's HEAD", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const runsDir = path.join(ws, "_runs");
  fs.mkdirSync(runsDir);
  const api = path.join(ws, "API");
  repo(api);
  fs.writeFileSync(path.join(api, "old name.txt"), "same\ncontent\nkept\n");
  fs.writeFileSync(path.join(api, "gone.txt"), "x\n");
  fs.writeFileSync(path.join(api, "pic.bin"), Buffer.from([0, 1, 2, 0]));
  g(api, "add", ".");
  g(api, "commit", "-q", "-m", "more");
  // A linked worktree: its .git is a file naming the git dir.
  const wt = path.join(ws, "worktrees", "ENG-2", "API");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  g(api, "worktree", "add", "-q", "-b", "feature/ENG-2", wt);

  const rc = new RunChanges(runsDir);
  g(wt, "mv", "old name.txt", "new name.txt");
  g(wt, "rm", "-q", "gone.txt");
  fs.writeFileSync(path.join(wt, "pic.bin"), Buffer.from([0, 9, 9, 0, 0]));
  fs.writeFileSync(path.join(wt, "a.txt"), "one\ntwo\nthree\n");
  const events = [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(wt, "a.txt") } }] } }];
  const worktree = { path: path.dirname(wt), repos: [wt] };
  const r = await rc.changes(meta("r5", ws), events as any, true, worktree);
  assert.equal(r.scopes.length, 1);
  assert.equal(r.scopes[0].branch, "feature/ENG-2");
  assert.deepEqual(r.scopes[0].files.map((f) => `${f.status} ${f.file} +${f.adds} -${f.dels}`), [
    "M a.txt +1 -0", "D gone.txt +0 -1", "R new name.txt +0 -0", "M pic.bin +null -null",
  ]);

  g(wt, "checkout", "-q", "--detach");
  assert.equal((await rc.changes(meta("r5", ws), events as any, true, worktree)).scopes[0].branch, "HEAD");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("a result is served again while fresh (longer once the run is over), and requests that overlap share one computation", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const runsDir = path.join(ws, "_runs");
  fs.mkdirSync(runsDir);
  const api = path.join(ws, "API");
  repo(api);
  const rc = new RunChanges(runsDir);
  const m = { ...meta("r6", ws), status: "succeeded" };
  await rc.snapshot(m);
  assert.equal(rc.cached(m), null, "nothing worked out yet");

  fs.writeFileSync(path.join(api, "a.txt"), "edited\n");
  const [a, b] = await Promise.all([rc.changes(m, []), rc.changes(m, [])]);
  assert.equal(a, b, "one computation for both");
  assert.deepEqual(a.scopes[0].files.map((f) => f.file), ["a.txt"]);

  // Still fresh: the same answer, with no events needed, even though the repo moved on.
  fs.writeFileSync(path.join(api, "b.txt"), "also edited\n");
  assert.deepEqual(rc.cached(m)?.scopes[0].files.map((f) => f.file), ["a.txt"]);
  assert.equal(rc.cached(m)?.hasBaseline, true);
  assert.deepEqual((await rc.changes(m, [])).scopes[0].files.map((f) => f.file), ["a.txt"]);
  // Refresh asks anew, and a new turn's snapshot drops what was cached.
  assert.deepEqual((await rc.changes(m, [], true)).scopes[0].files.map((f) => f.file), ["a.txt", "b.txt"]);
  await rc.snapshot({ ...m, turns: 2 });
  assert.equal(rc.cached(m), null);
  fs.rmSync(ws, { recursive: true, force: true });
});

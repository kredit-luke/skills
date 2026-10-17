// repo-pull.ts against real git: origins are local bare repos, the workspace a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pullRepos } from "../src/repo-pull.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-pull-")));
const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** A checked-out file's text; git on Windows may check files out with CRLF. */
const read = (...p: string[]) => fs.readFileSync(path.join(...p), "utf-8").replace(/\r\n/g, "\n");

/** A bare origin with a main branch, and a work clone to push more commits from. */
function origin(name: string) {
  const bare = path.join(TMP, "origins", `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "--quiet", "--bare", "-b", "main");
  const work = path.join(TMP, "work", name);
  fs.mkdirSync(work, { recursive: true });
  git(work, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), `${name} 1\n`);
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "first");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "--quiet", "origin", "main");
  const push = (text: string) => { fs.writeFileSync(path.join(work, "README.md"), text); git(work, "commit", "--quiet", "-am", text.trim()); git(work, "push", "--quiet", "origin", "main"); };
  return { bare, push };
}

test("pullRepos: clones missing repos and snapshot copies, fast-forwards clean clones, leaves local work alone", async () => {
  const ws = path.join(TMP, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const names = ["missing", "snapshot", "behind", "dirty", "branch", "notgit", "broken"];
  const o = Object.fromEntries(names.filter((n) => n !== "broken").map((n) => [n, origin(n)]));
  fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({
    repos: [
      ...names.filter((n) => n !== "broken").map((n) => ({ name: n, relativePath: `apps/${n}`, remote: o[n].bare })),
      { name: "broken", relativePath: "apps/broken", remote: path.join(TMP, "origins", "nope.git") },
      { name: "local-only", relativePath: "apps/local" },
    ],
  }));

  // A snapshot copy (stamp, no .git), and one for the repo whose clone will fail.
  for (const n of ["snapshot", "broken"]) {
    fs.mkdirSync(path.join(ws, "apps", n), { recursive: true });
    fs.writeFileSync(path.join(ws, "apps", n, ".snapshot.json"), JSON.stringify({ name: n, sha: "a".repeat(40) }));
    fs.writeFileSync(path.join(ws, "apps", n, "README.md"), "old copy\n");
  }
  // Clones: one behind origin, one with uncommitted work, one on another branch.
  for (const n of ["behind", "dirty", "branch"]) git(TMP, "clone", "--quiet", o[n].bare, path.join(ws, "apps", n));
  for (const n of ["behind", "dirty", "branch"]) o[n].push(`${n} 2\n`);
  fs.writeFileSync(path.join(ws, "apps", "dirty", "README.md"), "my edit\n");
  git(path.join(ws, "apps", "branch"), "checkout", "--quiet", "-b", "feature/x");
  // Files that are neither a clone nor a snapshot copy.
  fs.mkdirSync(path.join(ws, "apps", "notgit"), { recursive: true });
  fs.writeFileSync(path.join(ws, "apps", "notgit", "mine.txt"), "hands off\n");

  const lines: string[] = [];
  const results = await pullRepos(ws, (t) => lines.push(t));
  const by = Object.fromEntries(results.map((r) => [r.name, r]));

  assert.equal(by.missing.action, "cloned");
  assert.match(by.missing.detail, /^cloned at [0-9a-f]{7,}/, "names the commit it cloned");
  assert.ok(fs.existsSync(path.join(ws, "apps", "missing", ".git")));

  assert.equal(by.snapshot.action, "cloned");
  assert.match(by.snapshot.detail, /in place of the snapshot copy/);
  assert.equal(read(ws, "apps", "snapshot", "README.md"), "snapshot 1\n");
  assert.ok(!fs.existsSync(path.join(ws, "apps", "snapshot", ".snapshot.json")), "now a clone, which the snapshot install leaves alone");

  assert.equal(by.behind.action, "updated");
  assert.equal(read(ws, "apps", "behind", "README.md"), "behind 2\n");

  assert.equal(by.dirty.action, "skipped");
  assert.match(by.dirty.detail, /uncommitted/);
  assert.equal(read(ws, "apps", "dirty", "README.md"), "my edit\n", "their work is untouched");

  assert.equal(by.branch.action, "skipped");
  assert.match(by.branch.detail, /on branch feature\/x, not main/);

  assert.equal(by.notgit.action, "skipped");
  assert.equal(read(ws, "apps", "notgit", "mine.txt"), "hands off\n");

  assert.equal(by.broken.action, "failed");
  assert.match(by.broken.detail, /keeping the snapshot copy/);
  assert.equal(read(ws, "apps", "broken", "README.md"), "old copy\n", "a failed clone keeps the copy");
  assert.ok(!fs.existsSync(path.join(ws, "apps", "broken.natterjack-clone")), "and leaves no half-made clone");

  assert.ok(!("local-only" in by), "a repo without a remote is left out");
  assert.equal(lines.length, results.length, "one line per repo");

  // Run again: everything clean is already current.
  const again = Object.fromEntries((await pullRepos(ws)).map((r) => [r.name, r.action]));
  assert.equal(again.missing, "current");
  assert.equal(again.behind, "current");
  assert.equal(again.snapshot, "current");
});

test("fingerprint: the same folder gives the same answer; an edit, a new file or a clone appearing changes it", async () => {
  const { fingerprint } = await import("../src/repo-pull.ts");
  const dir = path.join(TMP, "fp");
  assert.equal(fingerprint(dir), null, "not there yet");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "one\n");
  const first = fingerprint(dir);
  assert.equal(fingerprint(dir), first);
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "one, edited by a run\n");
  const edited = fingerprint(dir);
  assert.notEqual(edited, first);
  fs.writeFileSync(path.join(dir, "src", "b.ts"), "new\n");
  assert.notEqual(fingerprint(dir), edited);
  const withB = fingerprint(dir);
  fs.mkdirSync(path.join(dir, ".git"));
  assert.notEqual(fingerprint(dir), withB, "Clone missing made it a clone meanwhile");
});

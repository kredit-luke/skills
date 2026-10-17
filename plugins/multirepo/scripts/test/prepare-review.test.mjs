// prepare-review.mjs on throwaway repos: discovery, base detection, ids, exclude.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildDiffCommands, candidateRepos, deriveReviewId, prepareReview } from "../prepare-review.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();

/** A repo with one commit on `base`, optionally a branch with one commit ahead. */
function makeRepo(dir, { base = "main", branch = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", base);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  if (branch) {
    git(dir, "switch", "-q", "-c", branch);
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    git(dir, "commit", "-q", "-am", "change");
  }
  return dir;
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("single repo: a branch ahead of main is reviewed, id from the branch, state excluded from git", () => {
  const root = makeRepo(tmp("mr-single-"), { branch: "feature/ENG-42-thing" });
  const m = prepareReview({ root });
  assert.equal(m.reviewId, "ENG-42");
  assert.equal(m.repos.length, 1);
  assert.equal(m.repos[0].commitsAhead, 1);
  assert.equal(m.repos[0].base, "main");
  assert.deepEqual(m.repos[0].diffCommands, ["git diff main...HEAD"]);
  assert.ok(fs.existsSync(path.join(m.inbox, "manifest.json")));
  assert.ok(fs.existsSync(m.outbox));
  assert.match(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf-8"), /^\.copilot\/$/m);
  // The state folder itself doesn't show up as a change.
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("clean repo on its base branch: nothing to review", () => {
  const root = makeRepo(tmp("mr-clean-"));
  const m = prepareReview({ root });
  assert.equal(m.reviewId, null);
  assert.deepEqual(m.repos, []);
  assert.equal(fs.existsSync(path.join(root, ".copilot")), false);
});

test("repos.json workspace: only changed repos, defaultBranch honored, dirty tree counted", () => {
  const root = tmp("mr-ws-");
  makeRepo(path.join(root, "api"), { base: "develop", branch: "fix/OPS-7" });
  makeRepo(path.join(root, "web"));
  makeRepo(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "a.txt"), "dirty\n");
  fs.writeFileSync(
    path.join(root, "repos.json"),
    JSON.stringify({ repos: [{ name: "api", relativePath: "api", defaultBranch: "develop" }, { name: "web" }, "docs"] })
  );

  const names = candidateRepos(root).map((c) => c.name);
  assert.deepEqual(names, ["api", "web", "docs"]);

  const m = prepareReview({ root });
  assert.equal(m.reviewId, "OPS-7");
  assert.deepEqual(m.repos.map((r) => r.name), ["api", "docs"]);
  const api = m.repos.find((r) => r.name === "api");
  assert.equal(api.base, "develop");
  const docs = m.repos.find((r) => r.name === "docs");
  assert.equal(docs.dirty, true);
  assert.deepEqual(docs.diffCommands, ["git diff HEAD"]);
  assert.deepEqual(docs.newFiles, []);
});

test("untracked files are listed in newFiles (no diff command shows them)", () => {
  const root = makeRepo(tmp("mr-new-"), { branch: "feature/ENG-5" });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "fresh.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.log\n");
  fs.writeFileSync(path.join(root, "ignored.log"), "x\n");
  const [repo] = prepareReview({ root }).repos;
  assert.deepEqual(repo.newFiles.sort(), [".gitignore", "src/fresh.ts"]);
  // An untracked-only change still counts as work to review.
  assert.equal(repo.dirty, true);
});

test(".worktree.json wins over repos.json", () => {
  const root = tmp("mr-wt-");
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ repos: ["a", "b"] }));
  fs.writeFileSync(path.join(root, ".worktree.json"), JSON.stringify({ repos: ["b"] }));
  assert.deepEqual(candidateRepos(root).map((c) => c.name), ["b"]);
});

test("review id: workspace.json ticketPattern, folder name, then a timestamp", () => {
  const root = tmp("mr-id-");
  fs.mkdirSync(path.join(root, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "dashboard", "workspace.json"),
    JSON.stringify({ issues: { ticketPattern: "^[a-z]+/[a-z]+#\\d+$" } })
  );
  assert.equal(deriveReviewId(root, [{ branch: "feature/acme/api#12" }]), "ACME/API#12");

  const named = path.join(tmp("mr-id2-"), "ENG-9");
  fs.mkdirSync(named);
  assert.equal(deriveReviewId(named, [{ branch: "feature/no-ticket" }]), "ENG-9");

  const plain = tmp("mrplain_");
  assert.equal(deriveReviewId(plain, [{ branch: "x" }], new Date("2026-01-02T03:04:05Z")), "adhoc-2026-01-02T03-04-05");
});

test(".worktree.json repos inherit defaultBranch from repos.json (here or the source workspace)", () => {
  const src = tmp("mr-src-");
  fs.writeFileSync(path.join(src, "repos.json"), JSON.stringify({ repos: [{ name: "api", relativePath: "svc/api", defaultBranch: "develop" }] }));
  const root = tmp("mr-wtb-");
  fs.writeFileSync(path.join(root, ".worktree.json"), JSON.stringify({ repos: ["svc/api"], sourceWorkspace: src }));
  const [c] = candidateRepos(root);
  assert.equal(c.defaultBranch, "develop");

  makeRepo(path.join(root, "svc", "api"), { base: "develop", branch: "feature/ENG-8" });
  const m = prepareReview({ root });
  assert.equal(m.repos[0].base, "develop");
});

test("a workspace root that is a repo is reviewed too, without its nested repos as changes", () => {
  const root = makeRepo(tmp("mr-rootrepo-"));
  makeRepo(path.join(root, "api"), { branch: "feature/ENG-9" });
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ repos: [{ name: "api" }] }));
  const rootPath = root.replace(/\\/g, "/");

  // The untracked repos.json is a root change; the nested repo isn't.
  let m = prepareReview({ root });
  const rootEntry = m.repos.find((r) => r.path === rootPath);
  assert.deepEqual(rootEntry.newFiles, ["repos.json"]);
  assert.ok(m.repos.some((r) => r.name === "api"));

  // Root-only changes are found (they used to produce "no changes to review").
  git(root, "add", "repos.json");
  git(root, "commit", "-q", "-m", "add repos.json");
  git(path.join(root, "api"), "switch", "-q", "main");
  fs.writeFileSync(path.join(root, "a.txt"), "edited\n");
  m = prepareReview({ root, id: "root-only" });
  assert.deepEqual(m.repos.map((r) => r.path), [rootPath]);
  assert.equal(m.repos[0].changedFiles, 1);
});

test("an unresolvable base is an error, not an empty review", () => {
  const root = makeRepo(tmp("mr-nobase-"), { branch: "feature/ENG-10" });
  assert.throws(() => prepareReview({ root, base: "does-not-exist" }), /can't resolve the base branch "does-not-exist"/);
});

test("newFiles are real paths, even with spaces or non-ASCII characters", () => {
  const root = makeRepo(tmp("mr-names-"), { branch: "feature/ENG-11" });
  fs.writeFileSync(path.join(root, "résumé.ts"), "x\n");
  fs.writeFileSync(path.join(root, " lead space.ts"), "x\n");
  const [repo] = prepareReview({ root }).repos;
  assert.deepEqual(repo.newFiles.sort(), [" lead space.ts", "résumé.ts"].sort());
});

test("in a linked git worktree, .copilot/ is excluded via the shared info/exclude", () => {
  const main = makeRepo(tmp("mr-linked-"));
  const linked = path.join(tmp("mr-linked-wt-"), "wt");
  git(main, "worktree", "add", "-q", "-b", "feature/ENG-12", linked);
  fs.writeFileSync(path.join(linked, "b.txt"), "new\n");
  const m = prepareReview({ root: linked });
  assert.equal(m.repos.length, 1); // reviewed, so the exclude check below means something
  assert.equal(git(linked, "status", "--porcelain").includes(".copilot"), false);
});

test("a root reached through a symlink or junction is still recognised as the repo", () => {
  // git reports the resolved path; macOS temp folders (/var → /private/var) and
  // Windows short names (RUNNER~1) differ from it the same way.
  const real = makeRepo(tmp("mr-real-"), { branch: "feature/ENG-13" });
  const link = path.join(tmp("mr-link-"), "via-link");
  fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  const m = prepareReview({ root: link });
  assert.equal(m.reviewId, "ENG-13");
  assert.equal(m.repos.length, 1);
});

test("diff commands: committed range, working tree, or both", () => {
  assert.deepEqual(buildDiffCommands("main", 2, true), ["git diff main...HEAD", "git diff HEAD"]);
  assert.deepEqual(buildDiffCommands("origin/main", 0, true), ["git diff HEAD"]);
  assert.deepEqual(buildDiffCommands(null, 0, true), ["git diff HEAD"]);
});

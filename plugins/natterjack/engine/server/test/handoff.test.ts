import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  CONFIRM_TTL_MS, FETCH_TTL_MS, HandoffTokens, buildBundle, importBundle,
  mapCwd, projectFolder, publicRemote, remoteKey, writeInside,
} from "../src/handoff.ts";
import { localDashboardOrigin } from "../../shared/send-to-hosted.ts";
import { RunManager } from "../src/runs.ts";
import type { RunMeta } from "../../shared/api.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-handoff-"));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** A checked-out file's text with `\n` line ends (git may write `\r\n` on Windows: core.autocrlf). */
const read = (f: string) => fs.readFileSync(f, "utf-8").replace(/\r\n/g, "\n");
const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

const RUN_ID = "20261021120000-abc123";
const SESSION = "3bd41355-10c7-4578-b446-2ba8a197c675";

function runMeta(cwd: string, extra: Partial<RunMeta> = {}): RunMeta {
  return {
    id: RUN_ID, sessionId: SESSION, presetId: null, label: "Fix the thing", prompt: "Fix the thing", cwd, workspace: "main",
    model: null, effort: null, permissionMode: "auto", planMode: false, budgetUsd: null, trigger: "manual", agent: "claude",
    status: "succeeded", startedAt: "2026-10-21T12:00:00.000Z", endedAt: "2026-10-21T12:05:00.000Z", turns: 2, turnStartedAt: "2026-10-21T12:04:00.000Z",
    costUsd: 0, numTurns: 0, durationMs: 0, toolCalls: 0, lastActivity: null, resultText: null, error: null, verdict: null, flagged: false,
    question: null, warning: null, queued: [], queueBlocked: null, watch: null, ...extra,
  } as RunMeta;
}

/** A remote with one commit on main, a computer with a worktree that has work on top, and a hosted workspace with a plain clone. */
function setup() {
  const base = tmp();
  const remote = path.join(base, "remote.git");
  git(base, "init", "-q", "--bare", remote);
  const seed = path.join(base, "seed");
  git(base, "clone", "-q", remote, seed);
  write(path.join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "one");
  git(seed, "push", "-q", "origin", "HEAD:main");

  // The person's computer: workspace L, worktree WT-1 with repo "api".
  const L = path.join(base, "local");
  const wt = path.join(L, "worktrees", "WT-1");
  const repo = path.join(wt, "api");
  fs.mkdirSync(wt, { recursive: true });
  git(wt, "clone", "-q", remote, repo);
  git(repo, "checkout", "-q", "-b", "feature/x");
  write(path.join(repo, "b.txt"), "two\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "two (not pushed)");
  write(path.join(repo, "a.txt"), "one, edited\n"); // uncommitted
  write(path.join(repo, "new.txt"), "untracked\n");
  write(path.join(wt, "CLAUDE.md"), "worktree notes\n");
  write(path.join(wt, ".claude", "ledger", "secret"), "per-person state\n");

  const ledger = path.join(L, ".claude", "ledger");
  const meta = runMeta(L, { attachments: [{ id: "a1", name: "shot.png", file: "a1-shot.png", size: 3, kind: "image", path: path.join(ledger, "attachments", RUN_ID, "a1-shot.png") }] });
  write(path.join(ledger, "runs", `${RUN_ID}.json`), JSON.stringify(meta));
  write(path.join(ledger, "runs", `${RUN_ID}.events.jsonl`), '{"type":"human","text":"hi"}\n');
  write(path.join(ledger, "attachments", RUN_ID, "a1-shot.png"), "png");
  const claudeL = path.join(base, "claude-local");
  const transcript = path.join(claudeL, "projects", projectFolder(L), `${SESSION}.jsonl`);
  write(transcript, '{"type":"user","cwd":"C:\\\\old"}\n');
  write(path.join(path.dirname(transcript), SESSION, "subagents", "agent-1.jsonl"), "{}\n");

  // The hosted dashboard: workspace P with a clone of the same repo at "api".
  const P = path.join(base, "pod");
  fs.mkdirSync(P, { recursive: true });
  git(P, "clone", "-q", remote, path.join(P, "api"));
  const ctx = {
    workspaceRoot: P,
    worktreeRoot: path.join(P, "worktrees"),
    runsDir: path.join(P, ".claude", "ledger", "runs"),
    attachmentsRoot: path.join(P, ".claude", "ledger", "attachments"),
    claudeDir: path.join(base, "claude-pod"),
    mainRepos: [path.join(P, "api")],
  };
  fs.mkdirSync(ctx.runsDir, { recursive: true });
  return { base, remote, L, wt, repo, ledger, meta, transcript, P, ctx };
}

async function bundleOf(s: ReturnType<typeof setup>) {
  return buildBundle({
    meta: s.meta,
    metaFile: path.join(s.ledger, "runs", `${RUN_ID}.json`),
    eventsFile: path.join(s.ledger, "runs", `${RUN_ID}.events.jsonl`),
    transcript: s.transcript,
    attachmentsDir: path.join(s.ledger, "attachments", RUN_ID),
    workspaceRoot: s.L,
    worktree: { path: s.wt, repos: [s.repo] },
    engineVersion: "0.0.0-test",
  });
}

test("a run with unpushed work in a worktree arrives whole on the hosted dashboard", async () => {
  const s = setup();
  const { bundle, manifest, warnings } = await bundleOf(s);
  assert.deepEqual(warnings, []);
  assert.equal(manifest.worktree!.name, "WT-1");
  const r = manifest.worktree!.repos[0];
  assert.equal(r.path, "api");
  assert.equal(r.branch, "feature/x");
  assert.ok(r.commits && r.patch);
  assert.deepEqual(r.untracked, ["new.txt"]);
  assert.deepEqual(manifest.worktree!.extras, ["CLAUDE.md"]); // .claude/ledger stays behind

  const { meta } = await importBundle(bundle, s.ctx);
  const dest = path.join(s.P, "worktrees", "WT-1", "api");
  assert.equal(git(dest, "rev-parse", "HEAD"), r.head);
  assert.equal(git(dest, "branch", "--show-current"), "feature/x");
  assert.equal(read(path.join(dest, "a.txt")), "one, edited\n");
  assert.equal(read(path.join(dest, "new.txt")), "untracked\n");
  assert.equal(read(path.join(s.P, "worktrees", "WT-1", "CLAUDE.md")), "worktree notes\n");
  assert.ok(!fs.existsSync(path.join(s.P, "worktrees", "WT-1", ".claude", "ledger")));

  // The transcript is where `claude --resume` looks from the run's new folder.
  const proj = path.join(s.ctx.claudeDir, "projects", projectFolder(s.P));
  assert.ok(fs.existsSync(path.join(proj, `${SESSION}.jsonl`)));
  assert.ok(fs.existsSync(path.join(proj, SESSION, "subagents", "agent-1.jsonl")));

  assert.equal(meta.cwd, s.P);
  assert.equal(meta.status, "succeeded");
  assert.match(meta.extraPrompt || "", /moved here from another computer/);
  assert.equal(meta.attachments![0].path, path.join(s.ctx.attachmentsRoot, RUN_ID, "a1-shot.png"));
  assert.ok(fs.existsSync(meta.attachments![0].path));
  assert.ok(fs.existsSync(path.join(s.ctx.runsDir, `${RUN_ID}.events.jsonl`)));

  await assert.rejects(importBundle(bundle, s.ctx), /already on the hosted dashboard/);
});

test("a failed import leaves nothing behind", async () => {
  const s = setup();
  const { bundle } = await bundleOf(s);
  // The repo isn't cloned on the hosted dashboard: the import stops after the worktree folder was made.
  const ctx = { ...s.ctx, mainRepos: [] as string[] };
  await assert.rejects(importBundle(bundle, ctx), /isn't cloned on the hosted dashboard/);
  assert.ok(!fs.existsSync(path.join(s.P, "worktrees", "WT-1")));
  assert.ok(!fs.existsSync(path.join(s.ctx.runsDir, `${RUN_ID}.json`)));
  assert.ok(!fs.existsSync(path.join(s.ctx.claudeDir, "projects")) || fs.readdirSync(path.join(s.ctx.claudeDir, "projects", projectFolder(s.P))).length === 0);
  // And once the repo is there, the same bundle goes in.
  await importBundle(bundle, s.ctx);
  assert.ok(fs.existsSync(path.join(s.P, "worktrees", "WT-1", "api", "b.txt")));
});

test("a commit that's on the remote needs no git bundle; a deleted branch's commits do", async () => {
  const s = setup();
  git(s.repo, "add", ".");
  git(s.repo, "commit", "-q", "-m", "everything");
  git(s.repo, "push", "-q", "-u", "origin", "feature/x");
  let { manifest } = await bundleOf(s);
  assert.equal(manifest.worktree!.repos[0].commits, false);
  assert.equal(manifest.worktree!.repos[0].upstream, "origin/feature/x");
  // Merged and deleted on the server: the local origin/feature/x is stale until pruned.
  git(s.base, "--git-dir", s.remote, "branch", "-D", "feature/x");
  ({ manifest } = await bundleOf(s));
  assert.equal(manifest.worktree!.repos[0].commits, true);
});

test("a branch on the hosted clone with commits of its own is left alone: the worktree is detached", async () => {
  const s = setup();
  // The hosted clone already has feature/x with a commit of its own.
  const hostedRepo = path.join(s.P, "api");
  git(hostedRepo, "checkout", "-q", "-b", "feature/x");
  write(path.join(hostedRepo, "mine.txt"), "hosted only\n");
  git(hostedRepo, "add", ".");
  git(hostedRepo, "commit", "-q", "-m", "hosted");
  git(hostedRepo, "checkout", "-q", "main");
  const { bundle, manifest } = await bundleOf(s);
  const { warnings } = await importBundle(bundle, s.ctx);
  assert.match(warnings.join(" "), /already exists on the hosted dashboard with other commits/);
  assert.equal(git(hostedRepo, "rev-parse", "feature/x") !== manifest.worktree!.repos[0].head, true); // kept
  assert.equal(git(path.join(s.P, "worktrees", "WT-1", "api"), "branch", "--show-current"), ""); // detached
});

test("a failed import puts a branch it made on the hosted clone back as it was", async () => {
  const s = setup();
  const { bundle } = await bundleOf(s);
  // The transcript's folder can't be made (a file is in the way): the import fails after the worktree was added.
  const projects = path.join(s.ctx.claudeDir, "projects");
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, projectFolder(s.P)), "in the way");
  await assert.rejects(importBundle(bundle, s.ctx), /goes through a link or a file/);
  const hosted = path.join(s.P, "api");
  assert.equal(git(hosted, "branch", "--list", "feature/x"), "", "the branch it created is gone");
  assert.ok(!fs.existsSync(path.join(s.P, "worktrees", "WT-1")));

  // And one that existed (behind the run's commit, so fast-forwarded) goes back to its old tip and tracking.
  const base = git(hosted, "rev-parse", "HEAD");
  git(hosted, "branch", "feature/x", base);
  git(hosted, "config", "branch.feature/x.remote", "origin");
  git(hosted, "config", "branch.feature/x.merge", "refs/heads/old-name");
  await assert.rejects(importBundle(bundle, s.ctx), /goes through a link or a file/);
  assert.equal(git(hosted, "rev-parse", "feature/x"), base);
  assert.equal(git(hosted, "config", "--get", "branch.feature/x.merge"), "refs/heads/old-name");
});

test("a repo with no commits shifts nothing: the next repo's changes still arrive", async () => {
  const s = setup();
  const empty = path.join(s.wt, "aaa-empty");
  git(s.wt, "init", "-q", empty);
  const built = await buildBundle({
    meta: s.meta, metaFile: path.join(s.ledger, "runs", `${RUN_ID}.json`), eventsFile: path.join(s.ledger, "runs", `${RUN_ID}.events.jsonl`),
    transcript: s.transcript, attachmentsDir: null, workspaceRoot: s.L, worktree: { path: s.wt, repos: [empty, s.repo] }, engineVersion: "t",
  });
  assert.match(built.warnings.join(" "), /aaa-empty has no commits yet/);
  assert.deepEqual(built.manifest.worktree!.repos.map((r) => r.path), ["api"]);
  await importBundle(built.bundle, s.ctx);
  const dest = path.join(s.P, "worktrees", "WT-1", "api");
  assert.equal(read(path.join(dest, "a.txt")), "one, edited\n");
  assert.equal(read(path.join(dest, "new.txt")), "untracked\n");
});

test("commits only on another remote travel in the bundle (the hosted dashboard fetches origin)", async () => {
  const s = setup();
  const upstream = path.join(s.base, "upstream.git");
  git(s.base, "init", "-q", "--bare", upstream);
  git(s.repo, "remote", "add", "upstream", upstream);
  git(s.repo, "push", "-q", "upstream", "feature/x");
  git(s.repo, "fetch", "-q", "upstream");
  const { bundle, manifest } = await bundleOf(s);
  assert.equal(manifest.worktree!.repos[0].commits, true);
  await importBundle(bundle, s.ctx);
  assert.equal(git(path.join(s.P, "worktrees", "WT-1", "api"), "rev-parse", "HEAD"), manifest.worktree!.repos[0].head);
});

test("an untracked link is left behind, not packed as what it points to", async (t) => {
  const s = setup();
  const secret = path.join(s.base, "secret.txt");
  fs.writeFileSync(secret, "do not send");
  try { fs.symlinkSync(secret, path.join(s.repo, "link.txt"), "file"); } catch { t.skip("file symlinks need rights here"); return; }
  const { manifest } = await bundleOf(s);
  assert.deepEqual(manifest.worktree!.repos[0].untracked, ["new.txt"]);
});

test("the imported run belongs to its recreated worktree, whatever paths its events hold", async () => {
  const s = setup();
  const { bundle } = await bundleOf(s);
  const { meta } = await importBundle(bundle, s.ctx);
  assert.equal(meta.workspace, "wt-1");
});

test("a bundle with an unsafe path or a bad id is refused before anything is written", async () => {
  const s = setup();
  const make = (manifest: any, files: Record<string, string>) => zlib.gzipSync(Buffer.from(JSON.stringify({ manifest, files })));
  const m = { format: 1, run: { id: RUN_ID, sessionId: SESSION, label: "x" }, source: { workspaceRoot: "/a", cwd: "/a", platform: "linux" }, transcript: false, worktree: null };
  await assert.rejects(importBundle(make(m, { "../evil": "" }), s.ctx), /unsafe path/);
  await assert.rejects(importBundle(make({ ...m, run: { ...m.run, id: "../x" } }, {}), s.ctx), /id isn't valid/);
  await assert.rejects(importBundle(make({ ...m, format: 99 }, {}), s.ctx), /different version/);
  await assert.rejects(importBundle(Buffer.from("not gzip"), s.ctx), /isn't a run from Send to hosted/);
  await assert.rejects(importBundle(make({ ...m, source: { workspaceRoot: "/a", cwd: "/b", platform: "linux" } }, {}), s.ctx), /outside its workspace/);
  assert.deepEqual(fs.readdirSync(s.ctx.runsDir), []);
});

test("the uncommitted changes apply whatever the person's git config does to diffs", async () => {
  const s = setup();
  git(s.repo, "config", "diff.noprefix", "true");
  git(s.repo, "config", "color.ui", "always");
  const { bundle } = await bundleOf(s);
  await importBundle(bundle, s.ctx);
  assert.equal(read(path.join(s.P, "worktrees", "WT-1", "api", "a.txt")), "one, edited\n");
});

test("writeInside never writes through or over a link", (t) => {
  const root = tmp();
  const outside = tmp();
  // A junction on Windows: it needs no rights there, and Node sees it as a link like a symlink.
  fs.symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeInside(root, "link/x.txt", Buffer.from("x")), /goes through a link/);
  assert.throws(() => writeInside(root, "link/deeper/x.txt", Buffer.from("x")), /goes through a link/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.throws(() => writeInside(root, "../x.txt", Buffer.from("x")), /unsafe path/);
  writeInside(root, "a/b/c.txt", Buffer.from("ok"));
  assert.equal(fs.readFileSync(path.join(root, "a", "b", "c.txt"), "utf-8"), "ok");
  // A file link in a file's place (symlinks need rights on Windows: only where they can be made).
  try { fs.symlinkSync(path.join(outside, "f.txt"), path.join(root, "f.txt"), "file"); } catch { t.diagnostic("file symlinks unavailable here"); return; }
  assert.throws(() => writeInside(root, "f.txt", Buffer.from("x")), /is a link/);
});

test("helpers: folder mapping, Claude's project folder, remotes, the hosted page's allowed source", () => {
  assert.equal(mapCwd({ workspaceRoot: "C:\\agentic-workspace", cwd: "C:\\agentic-workspace\\worktrees\\KREDIT-1", platform: "win32" }, "/data/workspace"), path.join("/data/workspace", "worktrees", "KREDIT-1"));
  assert.equal(mapCwd({ workspaceRoot: "C:\\ws", cwd: "C:\\ws", platform: "win32" }, "/data/workspace"), path.join("/data/workspace"));
  assert.equal(mapCwd({ workspaceRoot: "C:\\ws", cwd: "C:\\other", platform: "win32" }, "/data/workspace"), null);
  // A run in a worktree kept outside the workspace (worktrees.dir "../wt") lands in the recreated worktree.
  assert.equal(mapCwd({ workspaceRoot: "C:\\ws", cwd: "C:\\wt\\KREDIT-1\\api", platform: "win32" }, "/data/workspace", { from: "C:\\wt\\KREDIT-1", to: "/data/workspace/worktrees/KREDIT-1" }), path.join("/data/workspace/worktrees/KREDIT-1", "api"));
  // A run at the workspace root that worked in a worktree stays at the root.
  assert.equal(mapCwd({ workspaceRoot: "C:\\ws", cwd: "C:\\ws", platform: "win32" }, "/data/workspace", { from: "C:\\ws\\worktrees\\K", to: "/data/workspace/worktrees/K" }), path.join("/data/workspace"));
  assert.equal(projectFolder("C:\\agentic-workspace"), "C--agentic-workspace");
  assert.equal(projectFolder("/data/workspace"), "-data-workspace");
  assert.equal(projectFolder("/data/workspace/worktrees/KREDIT-8677"), "-data-workspace-worktrees-KREDIT-8677");
  assert.equal(publicRemote("https://x-access-token:ghs_abc@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(remoteKey("https://github.com/O/r.git"), "github.com/o/r");
  assert.equal(remoteKey("git@github.com:o/r.git"), "github.com/o/r");
  assert.equal(remoteKey("ssh://git@github.com/o/r"), "github.com/o/r");
  assert.equal(localDashboardOrigin("http://localhost:3333"), "http://localhost:3333");
  assert.equal(localDashboardOrigin("http://127.0.0.1:3333"), "http://127.0.0.1:3333");
  assert.equal(localDashboardOrigin("https://evil.example.com"), null);
  assert.equal(localDashboardOrigin("http://localhost.evil.com:3333"), null);
  assert.equal(localDashboardOrigin("http://localhost:3333/api/x"), null);
});

test("tokens: the bundle goes out once, confirms once, and an unfetched or unconfirmed send expires", () => {
  let now = 1_000_000;
  const t = new HandoffTokens(() => now);
  const a = t.create("run-a", Buffer.from("x"), "send-1");
  assert.equal(t.confirm(a), null); // not before the fetch
  assert.deepEqual(t.take(a)?.runId, "run-a");
  assert.equal(t.take(a), null); // single use
  assert.deepEqual(t.confirm(a), { runId: "run-a", attempt: "send-1" }, "the confirm names its send");
  assert.equal(t.confirm(a), null);
  assert.equal(t.take("f".repeat(48)), null);

  const b = t.create("run-b", Buffer.from("x"), "send-2");
  now += FETCH_TTL_MS + 1;
  assert.equal(t.take(b), null);
  assert.deepEqual(t.expired(), [{ runId: "run-b", attempt: "send-2" }]);

  const c = t.create("run-c", Buffer.from("x"), "send-3");
  t.take(c);
  now += CONFIRM_TTL_MS + 1;
  assert.deepEqual(t.expired(), [{ runId: "run-c", attempt: "send-3" }]);
  assert.equal(t.isPending("run-c"), false);
});

test("a run being sent takes no replies; finishing marks it moved, cancelling unlocks it", () => {
  const ledger = tmp();
  fs.mkdirSync(path.join(ledger, "runs"), { recursive: true });
  fs.writeFileSync(path.join(ledger, "runs", `${RUN_ID}.json`), JSON.stringify(runMeta("/ws", { watch: { prs: [], everyMinutes: 5, prompt: "x", startedAt: "2026-10-21T12:00:00.000Z", endedAt: null } as any })));
  const runs = new RunManager(ledger);
  runs.beginSend(RUN_ID);
  assert.throws(() => runs.beginSend(RUN_ID), /already being sent/); // a second send would swap the token mid-import
  assert.throws(() => runs.reply(RUN_ID, "hi"), /being sent to the hosted dashboard/);
  assert.throws(() => runs.enqueue(RUN_ID, "hi"), /being sent to the hosted dashboard/);
  assert.equal(runs.cancelSend(RUN_ID), true);
  assert.equal(runs.get(RUN_ID)!.handoffPendingAt, null);
  // Cancelled before the hosted page confirmed: the confirmation is refused, so the page can warn.
  assert.throws(() => runs.finishSend(RUN_ID, null), /cancelled on your computer/);

  // Continued in a terminal while the send was pending: same.
  runs.beginSend(RUN_ID);
  runs.handOff(RUN_ID);
  assert.throws(() => runs.finishSend(RUN_ID, null), /continued in a terminal/);
  fs.writeFileSync(path.join(ledger, "runs", `${RUN_ID}.json`), JSON.stringify(runMeta("/ws", { watch: { prs: [], everyMinutes: 5, prompt: "x", startedAt: "2026-10-21T12:00:00.000Z", endedAt: null } as any })));

  // An earlier send finishing late acts on nothing: neither its failure nor its confirm touches a newer send.
  const newer = runs.beginSend(RUN_ID).handoffPendingAt!;
  assert.equal(runs.cancelSend(RUN_ID, "2000-01-01T00:00:00.000Z"), false);
  assert.equal(runs.get(RUN_ID)!.handoffPendingAt, newer);
  assert.throws(() => runs.finishSend(RUN_ID, null, "2000-01-01T00:00:00.000Z"), /cancelled on your computer/);
  assert.equal(runs.get(RUN_ID)!.status, "succeeded");

  const done = runs.finishSend(RUN_ID, "https://hosted.example.com/runs/" + RUN_ID, newer);
  assert.equal(done.status, "handedOff");
  assert.equal(done.handedOffTo, "hosted");
  assert.ok(done.watch!.endedAt);
  assert.throws(() => runs.reply(RUN_ID, "hi"), /moved to the hosted dashboard/);
  assert.throws(() => runs.beginSend(RUN_ID), /moved to the hosted dashboard/);

  // A restart drops a send in flight (its token was in memory).
  fs.writeFileSync(path.join(ledger, "runs", `${RUN_ID}.json`), JSON.stringify(runMeta("/ws", { handoffPendingAt: "2026-10-21T12:00:00.000Z" })));
  assert.equal(new RunManager(ledger).get(RUN_ID)!.handoffPendingAt, null);
});

test("only Claude runs that aren't mid-turn can be sent", () => {
  const ledger = tmp();
  fs.mkdirSync(path.join(ledger, "runs"), { recursive: true });
  fs.writeFileSync(path.join(ledger, "runs", `${RUN_ID}.json`), JSON.stringify(runMeta("/ws", { agent: "codex" })));
  const runs = new RunManager(ledger);
  assert.throws(() => runs.beginSend(RUN_ID), /Only Claude runs/);
});

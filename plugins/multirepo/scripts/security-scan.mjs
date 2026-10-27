#!/usr/bin/env node
/**
 * security-scan.mjs: the factory's security stage, the deterministic half. Runs the team's
 * scanners (.claude/dashboard/factory.json security.scanners) in each repo they apply to, and
 * secret scanning (gitleaks) over the files the branch changed. The agent security review is
 * the other half; the implement skill runs it as a subagent.
 *
 * A scanner runs in a repo when its `when` file is at the repo's root (null: every repo). Its
 * command is the team's, from their committed policy, run through the shell in the repo. Exit 0
 * passes; any other exit is a finding at the scanner's `failOn` severity. A command that isn't
 * installed is skipped and said so; one that times out or can't run fails closed (a finding),
 * so a broken scan never passes the gate. A secret is critical. A repo fails the stage when a
 * finding is at the policy's `security.failOn` or worse.
 *
 * Usage:
 *   node security-scan.mjs --root <WORKROOT> [--repos a,b] [--ticket <id>] [--json]
 *
 *   --ticket  record each repo's result as its security stage on the Factory board.
 * Exits 1 when a repo fails the stage, 0 otherwise.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultBranch, git, gitRun, isMain, listRepos, parseArgs } from "./lib.mjs";
import { normalizePolicy, readPolicy, sourceWorkspace, update } from "./factory.mjs";

const SEVERITIES = ["critical", "high", "medium", "low"];
const OUTPUT_TAIL = 1500;
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
/** gitleaks's exit code for leaks found (its own errors exit 1). */
const LEAKS_EXIT = 3;

const worse = (a, b) => SEVERITIES.indexOf(a) <= SEVERITIES.indexOf(b);
const tail = (s) => { const t = String(s || "").trim(); return t.length > OUTPUT_TAIL ? "…" + t.slice(-OUTPUT_TAIL) : t; };

/** Whether a failed run means the command isn't installed (not a finding): only the shell's own signs. */
function notInstalled(r) {
  if (r.error && r.error.code === "ENOENT") return true;
  if (r.status === 127 || r.status === 9009) return true;
  // cmd.exe: exit 1 and only its own message.
  return r.status === 1 && !String(r.stdout || "").trim() && /is not recognized as an internal or external command/i.test(String(r.stderr || ""));
}

/** Runs one scanner in a repo: { name, command, status: passed|found|error|skipped, severity, detail }. */
export function runScanner(s, repoPath, run = spawnSync) {
  const r = run(s.command, { cwd: repoPath, shell: true, encoding: "utf-8", timeout: SCAN_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const base = { name: s.name, command: s.command };
  if (notInstalled(r)) return { ...base, status: "skipped", severity: null, detail: `Not installed here (${s.command.split(/\s+/)[0]}).` };
  // A scan that couldn't finish isn't a pass: it counts as a finding at its severity.
  if (r.error) return { ...base, status: "error", severity: s.failOn, detail: r.error.code === "ETIMEDOUT" ? "Timed out after 5 minutes." : `Couldn't run: ${r.error.message}` };
  if (r.status === 0) return { ...base, status: "passed", severity: null, detail: "" };
  return { ...base, status: "found", severity: s.failOn, detail: tail(r.stdout || r.stderr) };
}

/** Files the branch changed in a repo (committed since the default branch, plus uncommitted and untracked), unquoted. */
export function changedFiles(repoPath, base) {
  const out = new Set();
  // NUL-separated and untrimmed: every name exactly as it is (spaces at the ends, tabs, quotes, non-ASCII).
  const names = (args) => { const r = gitRun(repoPath, [...args, "-z"], { trim: false }); return r.ok ? r.out.split("\0").filter(Boolean) : []; };
  const mergeBase = git(repoPath, ["merge-base", "HEAD", `origin/${base}`]) || git(repoPath, ["merge-base", "HEAD", base]);
  if (mergeBase) names(["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "HEAD"]).forEach((f) => out.add(f));
  names(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]).forEach((f) => out.add(f));
  names(["ls-files", "--others", "--exclude-standard"]).forEach((f) => out.add(f));
  return [...out].filter((f) => fs.existsSync(path.join(repoPath, f)));
}

/**
 * gitleaks over the changed files, in one run: they're copied (paths kept) to a temp folder that
 * `gitleaks dir` scans. Needs gitleaks 8.19+ (`dir`); older ones are reported, not trusted.
 * { status: passed|found|error|skipped, detail }.
 */
export function scanSecrets(repoPath, files, run = spawnSync) {
  // Skipped only when gitleaks really isn't there, or is too old; any other failure is an error (fails closed).
  const opts = { encoding: "utf-8", windowsHide: true, timeout: 60_000 };
  const probe = run("gitleaks", ["version"], opts);
  if (probe.error && probe.error.code === "ENOENT") return { status: "skipped", detail: "gitleaks isn't installed, so secrets weren't scanned." };
  if (probe.error || probe.status !== 0) return { status: "error", detail: `gitleaks didn't run: ${probe.error ? probe.error.message : tail(probe.stderr || probe.stdout)}` };
  const hasDir = run("gitleaks", ["dir", "--help"], opts);
  if (!hasDir.error && hasDir.status !== 0 && /unknown command|unknown flag|no such command/i.test(String(hasDir.stderr || "") + String(hasDir.stdout || ""))) {
    return { status: "skipped", detail: `gitleaks ${String(probe.stdout || "").trim()} is older than 8.19 (no "dir"), so secrets weren't scanned.` };
  }
  if (hasDir.error || hasDir.status !== 0) return { status: "error", detail: `gitleaks didn't run: ${hasDir.error ? hasDir.error.message : tail(hasDir.stderr || hasDir.stdout)}` };
  if (!files.length) return { status: "passed", detail: "No changed files." };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-"));
  try {
    for (const f of files) {
      const to = path.join(tmp, "files", f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(repoPath, f), to);
    }
    const report = path.join(tmp, "report.json");
    const r = run("gitleaks", ["dir", path.join(tmp, "files"), "--no-banner", "--redact", "--exit-code", String(LEAKS_EXIT), "--report-format", "json", "--report-path", report],
      { encoding: "utf-8", windowsHide: true, timeout: SCAN_TIMEOUT_MS });
    if (r.status === 0) return { status: "passed", detail: `${files.length} changed files clean.` };
    if (r.status === LEAKS_EXIT) {
      let hits = [];
      try { hits = JSON.parse(fs.readFileSync(report, "utf-8")).map((x) => path.relative(path.join(tmp, "files"), x.File || x.file || "").replace(/\\/g, "/")); } catch {}
      return { status: "found", detail: `Possible secrets in ${[...new Set(hits.filter(Boolean))].join(", ") || "the changed files"}.` };
    }
    return { status: "error", detail: `gitleaks failed: ${tail(r.stderr || r.stdout || (r.error && r.error.message))}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The security stage for each repo under root. */
export function securityScan({ root, repos = null, policy = null, run = spawnSync } = {}) {
  const sec = normalizePolicy(policy).security;
  const targets = listRepos(root).filter((r) => r.exists && (!repos || repos.includes(r.name)));
  const results = targets.map((r) => {
    const ran = sec.scanners
      .filter((s) => !s.when || fs.existsSync(path.join(r.path, s.when)))
      .map((s) => runScanner(s, r.path, run));
    const secret = sec.secretScan ? scanSecrets(r.path, changedFiles(r.path, defaultBranch(r.path, r.defaultBranch)), run) : { status: "skipped", detail: "Secret scanning is off." };
    const findings = [
      ...ran.filter((x) => x.status === "found" || x.status === "error").map((x) => ({ severity: x.severity, error: x.status === "error", what: x.status === "error" ? `${x.name} (couldn't finish)` : x.name })),
      ...(secret.status === "found" ? [{ severity: "critical", error: false, what: "secrets" }] : []),
      ...(secret.status === "error" ? [{ severity: "critical", error: true, what: "secret scan (couldn't finish)" }] : []),
    ];
    // A scan that didn't finish fails whatever the threshold; findings fail at it or worse.
    const blocking = findings.filter((f) => f.error || worse(f.severity, sec.failOn));
    const status = blocking.length ? "failed" : "done";
    const parts = [ran.length ? ran.map((x) => `${x.name} ${x.status}`).join(", ") : "no scanner applies", `secrets ${secret.status}`];
    const note = `${blocking.length ? `Fails at ${sec.failOn}: ${blocking.map((f) => `${f.what} (${f.severity})`).join(", ")}. ` : ""}${parts.join("; ")}.`;
    return { repo: r.name, path: r.path, status, note, scanners: ran, secrets: secret };
  });
  return { failOn: sec.failOn, repos: results, failed: results.filter((r) => r.status === "failed").map((r) => r.repo) };
}

async function main(argv) {
  const args = parseArgs(argv, { booleans: ["json"] });
  const root = typeof args.root === "string" ? path.resolve(args.root) : process.cwd();
  const ws = sourceWorkspace(root);
  const repos = typeof args.repos === "string" ? args.repos.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const result = securityScan({ root, repos, policy: readPolicy(ws) });
  if (typeof args.ticket === "string") {
    for (const r of result.repos) update("stage", { ticket: args.ticket, stage: "security", status: r.status, repo: r.repo, agent: "security-scan", note: r.note }, { start: root });
  }
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    const lines = [`Security stage (fails at ${result.failOn}):`];
    for (const r of result.repos) {
      lines.push(`  ${r.repo}: ${r.status === "failed" ? "FAILED" : "passed"}: ${r.note}`);
      for (const s of r.scanners.filter((x) => x.status === "found" || x.status === "error")) lines.push(`    ${s.name}: ${s.detail.split("\n").slice(-6).join("\n      ")}`);
    }
    if (!result.repos.length) lines.push("  No repos to scan.");
    process.stdout.write(lines.join("\n") + "\n");
  }
  if (result.failed.length) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = e.usage ? 2 : 1;
  });
}

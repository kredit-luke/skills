#!/usr/bin/env node
/**
 * approver.mjs: the factory's Approver, the deterministic half. The approve skill adds the
 * agent's judgement; this applies the team's risk rules, checks the conditions for approving
 * without a person, records the assessment on the Factory board, and (only when the policy
 * enforces it) approves and merges.
 *
 * Risk rules (factory.json approver), any of which means "not low risk":
 *   - a changed path matches highRiskPaths (globs: ** any folders, * within a folder, ?, {a,b})   high
 *   - the ticket has one of highRiskLabels                                                          high
 *   - a repo's latest security stage failed                                                         high
 *   - what changed in a repo can't be told (no merge base with its default branch)                  high
 *   - more than maxFiles files, maxLines changed lines, or maxRepos repos                           medium
 *   - a new dependency (package.json, requirements*.txt, go.mod, *.csproj)                           medium
 * With no rule tripped, the risk is the agent's judgement (--risk), or medium without one. The
 * merge gate's rules read each PR as it is on the code host (its files at its head commit: what
 * gets approved); the pre-PR gate's read every repo of the WORKROOT; earlier gates only the labels
 * (the ticket's, as implement recorded them, plus --labels).
 *
 *
 * Approving without a person needs all of: low risk; for the merge gate, each open PR's required
 * checks green (all checks, when the policy names none), the policy's review bots reviewed with
 * nothing blocking, no unresolved threads (when the policy says so), not a draft, and its author
 * isn't the Approver's identity; the pipeline's own review passed (when the policy counts it).
 * Then a sample (samplingPct, decided by the ticket, gate and commit, so asking again gets the same
 * answer) still goes to a person. Budgets are the dashboard's to enforce (it won't start a run past them).
 * It approves each PR at the commit it assessed (and merges with --match-head-commit), refusing one
 * that moved since; whatever it did is recorded, even when a later step fails.
 *
 * It acts only when the policy enforces it (approver.enabled and approver.enforce, and the gate
 * set to the Approver), and only as the policy's identity: the gh account must be it. Otherwise
 * it's advisory: the assessment is recorded and a person decides.
 *
 * Usage:
 *   node approver.mjs rules  --root <WORKROOT> [--repos a,b] [--labels a,b] [--ticket <id>]
 *       { level, rules: [{ id, level, detail }], stats }: level null when no rule trips (could be low)
 *   node approver.mjs assess --ticket <id> --gate spec|plan|prePr|merge --root <WORKROOT> [--labels a,b]
 *                            [--risk low|medium|high --rationale "..." --concern "..." (repeat it, or ;-separate)]
 *                            [--judged <sha>[,<sha>]]  the merge gate: each PR's head commit the judgement read
 *                            [--run interactive|autonomous] [--can-ask yes|no]
 *       records the assessment and returns it with { action: pass|ask|stop|handoff, reason }
 * Exits 2 on a usage error, 1 on any other failure.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultBranch, git, gitRun, isMain, listRepos, parseArgs, readJson } from "./lib.mjs";
import { GATES, manifestPath, normalizePolicy, readPolicy, sourceWorkspace, update } from "./factory.mjs";

const LEVELS = ["low", "medium", "high"];
const GATE_NAMES = { spec: "spec", plan: "plan", prePr: "pre-PR", merge: "merge" };
const worst = (...ls) => ls.filter(Boolean).sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a))[0] || null;
const usage = (msg) => Object.assign(new Error(msg), { usage: true });

// ------------------------------------------------------------------ the rules

/** A glob as a regex over a repo-relative path with forward slashes. */
export function globRegex(glob) {
  let re = "";
  const g = String(glob).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) { re += "\\{"; continue; }
      re += "(?:" + g.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * The repo's changes since it left its default branch, uncommitted and untracked included:
 * { mergeBase, files: [{ path, lines }], failed }. `failed`: git couldn't list them (they're unknown).
 */
export function repoChanges(repoPath, base) {
  const mergeBase = git(repoPath, ["merge-base", "HEAD", `origin/${base}`]) || git(repoPath, ["merge-base", "HEAD", base]);
  const out = [];
  let failed = false;
  if (mergeBase) {
    // -z: "added\tdeleted\tpath\0", or for a rename "added\tdeleted\t\0old\0new\0"; binary files count "-".
    const r = gitRun(repoPath, ["diff", "--numstat", "-z", "-M", mergeBase], { trim: false });
    if (!r.ok) failed = true;
    const parts = r.ok ? r.out.split("\0") : [];
    for (let i = 0; i < parts.length; i++) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
      if (!m) continue;
      let p = m[3];
      if (!p) { p = parts[i + 2] || parts[i + 1] || ""; i += 2; }
      out.push({ path: p, lines: (Number(m[1]) || 0) + (Number(m[2]) || 0) });
    }
  }
  const untracked = gitRun(repoPath, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false });
  if (!untracked.ok) failed = true;
  for (const p of untracked.ok ? untracked.out.split("\0").filter(Boolean) : []) {
    let lines = 0;
    try { const t = fs.readFileSync(path.join(repoPath, p), "utf-8"); lines = t ? t.split("\n").length - (t.endsWith("\n") ? 1 : 0) : 0; } catch {}
    out.push({ path: p, lines });
  }
  return { mergeBase: mergeBase || null, files: out, failed };
}

/** Dependency names a manifest file declares (package.json, requirements*.txt, go.mod, *.csproj), or null for other files. */
export function dependencies(file, text) {
  const name = path.basename(file).toLowerCase();
  const s = String(text || "");
  if (name === "package.json") {
    try {
      const j = JSON.parse(s);
      return new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(j[k] || {})));
    } catch { return new Set(); }
  }
  if (/^requirements.*\.txt$/.test(name)) {
    return new Set(s.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter((l) => l && !l.startsWith("-"))
      .map((l) => l.split(/[\s<>=!~;[]/)[0].toLowerCase()).filter(Boolean));
  }
  if (name === "go.mod") {
    const deps = new Set();
    let block = false;
    for (const raw of s.split(/\r?\n/)) {
      const l = raw.replace(/\/\/.*/, "").trim();
      if (/^require\s*\($/.test(l)) { block = true; continue; }
      if (block && l === ")") { block = false; continue; }
      const m = block ? /^(\S+)\s+\S+/.exec(l) : /^require\s+(\S+)\s+\S+/.exec(l);
      if (m) deps.add(m[1]);
    }
    return deps;
  }
  if (name.endsWith(".csproj")) {
    return new Set([...s.matchAll(/<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/gi)].map((m) => m[1].toLowerCase()));
  }
  return null;
}

/** Dependencies the change adds in a repo: [{ file, name }]. */
function newDependencies(repoPath, mergeBase, files) {
  const added = [];
  for (const f of files) {
    if (dependencies(f.path, "") === null) continue;
    let now = "";
    try { now = fs.readFileSync(path.join(repoPath, f.path), "utf-8"); } catch { continue; }
    const before = mergeBase ? gitRun(repoPath, ["show", `${mergeBase}:${f.path}`], { trim: false }) : { ok: false, out: "" };
    const was = dependencies(f.path, before.ok ? before.out : "");
    for (const d of dependencies(f.path, now)) if (!was.has(d)) added.push({ file: f.path, name: d });
  }
  return added;
}

/**
 * The rules over what changed: `repos` is [{ name, files: [{ path, lines }], newDeps: [{ file, name }] }].
 * Returns { level, rules, stats }: level is the worst tripped rule's, or null when none trips.
 */
export function evaluateRules(approver, { repos = [], labels = [], securityFailed = [] } = {}) {
  const rules = [];
  const paths = approver.highRiskPaths.map((g) => ({ g, re: globRegex(g) }));
  for (const r of repos) {
    for (const f of r.files) {
      const hit = paths.find((p) => p.re.test(f.path.replace(/\\/g, "/")));
      if (hit) rules.push({ id: "path", level: "high", detail: `${repos.length > 1 ? `${r.name}/` : ""}${f.path} matches ${hit.g}` });
    }
  }
  const wanted = new Set(approver.highRiskLabels.map((l) => l.toLowerCase()));
  for (const l of labels) if (wanted.has(String(l).toLowerCase())) rules.push({ id: "label", level: "high", detail: `The ticket is labelled ${l}` });
  for (const repo of securityFailed) rules.push({ id: "security", level: "high", detail: `The security stage failed for ${repo}` });
  for (const r of repos) if (r.unknown) rules.push({ id: "unknown", level: "high", detail: `Couldn't tell what changed in ${r.name} (${typeof r.unknown === "string" ? r.unknown : "no merge base with its default branch"})` });
  const files = repos.reduce((n, r) => n + r.files.length, 0);
  const lines = repos.reduce((n, r) => n + r.files.reduce((m, f) => m + f.lines, 0), 0);
  const touched = repos.filter((r) => r.files.length).length;
  if (files > approver.maxFiles) rules.push({ id: "files", level: "medium", detail: `${files} files changed (more than ${approver.maxFiles})` });
  if (lines > approver.maxLines) rules.push({ id: "lines", level: "medium", detail: `${lines} lines changed (more than ${approver.maxLines})` });
  if (touched > approver.maxRepos) rules.push({ id: "repos", level: "medium", detail: `${touched} repos changed (more than ${approver.maxRepos})` });
  for (const r of repos) for (const d of r.newDeps || []) rules.push({ id: "dependency", level: "medium", detail: `New dependency ${d.name} (${repos.length > 1 ? `${r.name}/` : ""}${d.file})` });
  return { level: worst(...rules.map((r) => r.level)), rules: rules.slice(0, 50), stats: { files, lines, repos: touched } };
}

/** The newest row per repo of one stage. */
function latestRows(m, stage) {
  const by = new Map();
  for (const r of (m && m.stages) || []) if (r.id === stage) by.set(r.repo ?? "", r);
  return [...by.values()];
}

// ------------------------------------------------------------------ the conditions

/** Whether a check counts as green: success, or neutral/skipped. */
const green = (c) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(c.conclusion || c.state || "").toUpperCase());
const pending = (c) => !c.conclusion && !["SUCCESS", "FAILURE", "ERROR"].includes(String(c.state || "").toUpperCase());

/** A check's name in the rollup. */
const checkName = (c) => c.name || c.context || "check";
/** When a check's run started (the newest run decides, finished or not). */
const checkTime = (c) => String(c.startedAt || c.completedAt || "");

/** Whether a review login is the policy's bot: exactly it, its GitHub App ("<bot>[bot]"), or its review app ("<bot>-pull-request-reviewer"). */
export function isBot(login, bot) {
  const l = String(login || "").toLowerCase().replace(/\[bot\]$/, "");
  const b = String(bot || "").toLowerCase().replace(/\[bot\]$/, "");
  return !!b && (l === b || l === `${b}-pull-request-reviewer`);
}

/**
 * Why a PR can't be approved without a person, by the policy (empty when it can). `pr` is gh pr
 * view's { url, state, author, isDraft, statusCheckRollup, reviews } plus { unresolved }: open threads.
 */
export function prBlockers(policy, pr, identity) {
  const out = [];
  const name = pr.url.replace(/^https?:\/\/[^/]+\//, "");
  if (pr.state && pr.state !== "OPEN") out.push(`${name} is ${String(pr.state).toLowerCase()}`);
  if (pr.isDraft) out.push(`${name} is a draft`);
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  // A check that ran more than once: its newest run decides.
  const latest = new Map();
  for (const c of [...checks].sort((a, b) => checkTime(a).localeCompare(checkTime(b)))) latest.set(checkName(c).toLowerCase(), c);
  if (policy.requiredChecks.length) {
    for (const want of policy.requiredChecks) {
      const c = latest.get(want.toLowerCase());
      if (!c) out.push(`${name}: required check ${want} hasn't run`);
      else if (!green(c)) out.push(`${name}: required check ${want} is ${pending(c) ? "still running" : "not green"}`);
    }
  } else {
    const bad = [...latest.values()].filter((c) => !green(c));
    if (bad.length) out.push(`${name}: ${bad.length} check${bad.length === 1 ? "" : "s"} not green (${bad.slice(0, 3).map(checkName).join(", ")})`);
  }
  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  for (const bot of policy.reviewers.bots) {
    const theirs = reviews.filter((r) => isBot(r.author?.login, bot));
    // A comment later doesn't withdraw a request for changes: its newest approve/request/dismiss decides.
    const standing = theirs.filter((r) => ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)).at(-1);
    if (!theirs.length) out.push(`${name}: ${bot} hasn't reviewed`);
    else if (standing && standing.state === "CHANGES_REQUESTED") out.push(`${name}: ${bot} requested changes`);
  }
  if (policy.reviewers.noUnresolved && pr.unresolved > 0) out.push(`${name}: ${pr.unresolved} unresolved review thread${pr.unresolved === 1 ? "" : "s"}`);
  const author = pr.author?.login || "";
  if (identity && author.toLowerCase() === identity.toLowerCase()) out.push(`${name} is by ${author}, the Approver's own identity: it can't approve its own PR`);
  return out;
}

/**
 * Whether this one goes to a person anyway (the policy's sampling): decided by the ticket, gate
 * and commit, so assessing the same thing again gets the same answer.
 */
export function sampledFor(pct, key) {
  if (!(pct > 0)) return false;
  const n = crypto.createHash("sha256").update(String(key)).digest().readUInt32BE(0);
  return (n % 10000) / 100 < pct;
}

/**
 * The assessment at a gate (pure): the risk (the rules' level, else the agent's judgement, else
 * medium), why it can't go without a person (blockers), whether a sample sends it to one anyway,
 * whether the policy lets the Approver act, and what the pipeline does next.
 * `prs` are the merge gate's PRs (see prBlockers); `ghUser` is the account this runs as;
 * `sampleKey` decides the sample (the ticket, gate and commit).
 */
export function assess(rawPolicy, manifest, gate, { rules, risk = null, rationale = null, concerns = [], prs = [], judgedShas = [], ghUser = null, sampleKey = "", run = "interactive", canAsk = run === "interactive" } = {}) {
  if (!GATES.includes(gate)) throw usage(`--gate must be one of ${GATES.join(", ")}`);
  const policy = normalizePolicy(rawPolicy);
  const ap = policy.approver;
  const judged = LEVELS.includes(risk) ? risk : null;
  const level = worst(rules.level, judged || (rules.level ? null : "medium"));
  const blockers = [];
  if (level !== "low") blockers.push(rules.level ? `The risk rules say ${rules.level}: ${rules.rules.slice(0, 3).map((r) => r.detail).join("; ")}` : judged ? `The Approver rated it ${level} risk` : "No judgement was given, so it counts as medium risk");
  if ((gate === "merge" || gate === "prePr") && policy.reviewers.pipeline) {
    // Every repo the change built (else every repo the ticket names) needs a passed review.
    const reviews = new Map(latestRows(manifest, "review").map((r) => [r.repo || "", r.status]));
    const built = latestRows(manifest, "build").filter((r) => r.status === "done").map((r) => r.repo || "");
    const named = (manifest && manifest.repos) || [];
    const changed = built.length ? built : named.length ? named : [...reviews.keys()];
    const unreviewed = changed.filter((repo) => reviews.get(repo) !== "done").map((repo) => repo || "review");
    if (!changed.length) blockers.push("The pipeline's review hasn't run");
    else if (unreviewed.length) blockers.push(`The pipeline's review hasn't passed for ${unreviewed.join(", ")}`);
  }
  if (gate === "merge") {
    if (!prs.length) blockers.push("There's no open PR to approve");
    for (const pr of prs) blockers.push(...prBlockers(policy, pr, ap.identity));
    // The judgement must be of each PR as it is now: a judged risk of other code proves nothing.
    if (judgedShas.length || LEVELS.includes(risk)) {
      for (const pr of prs) {
        if (!judgedShas.some((s) => s && String(pr.headRefOid || "").toLowerCase().startsWith(String(s).toLowerCase()))) blockers.push(`The judgement wasn't of ${pr.url.replace(/^https?:\/\/[^/]+\//, "")} at ${String(pr.headRefOid || "?").slice(0, 7)} (pass --judged with the commits read)`);
      }
    }
  }
  const enforced = policy.enabled && ap.enabled && ap.enforce && policy.gates[gate] === "approver";
  if (enforced && !ap.identity) blockers.push("The policy names no identity for the Approver to act as");
  else if (enforced && (!ghUser || ghUser.toLowerCase() !== ap.identity.toLowerCase())) blockers.push(`This runs as ${ghUser || "an unknown gh account"}, but the Approver acts only as ${ap.identity}`);
  const wouldApprove = !blockers.length;
  const sampled = wouldApprove && sampledFor(ap.samplingPct, sampleKey);
  const name = GATE_NAMES[gate];
  let action, reason;
  if (enforced && wouldApprove && !sampled) {
    action = "pass";
    reason = `The Approver approves the ${name} gate: low risk, every condition met.`;
  } else {
    const why = sampled ? `Sampled for a person (${ap.samplingPct}% of auto-approvable work)` : blockers[0] || "A person decides";
    action = gate === "merge" ? "handoff" : canAsk ? "ask" : "stop";
    reason = enforced ? `The Approver sends the ${name} gate to a person: ${why}.` : `Advisory: the Approver ${wouldApprove ? "would have approved it" : `wouldn't approve it (${why})`}; a person decides the ${name} gate.`;
  }
  return {
    gate, level, rulesLevel: rules.level, judged, rules: rules.rules, stats: rules.stats || null,
    rationale: typeof rationale === "string" && rationale.trim() ? rationale.trim().slice(0, 2000) : null,
    concerns: concerns.map((c) => String(c).trim()).filter(Boolean).slice(0, 10),
    wouldApprove, blockers: blockers.slice(0, 20), sampled, enforced, action, reason,
    by: ghUser, mergeAction: gate === "merge" ? ap.mergeAction : null,
  };
}

// ------------------------------------------------------------------ the CLI

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf-8", input, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

/** The changes under a WORKROOT, per repo, with their new dependencies. */
function workrootChanges(root, only) {
  return listRepos(root).filter((r) => r.exists && (!only || only.includes(r.name))).map((r) => {
    const { mergeBase, files, failed } = repoChanges(r.path, defaultBranch(r.path, r.defaultBranch));
    return { name: r.name, files, unknown: !mergeBase ? true : failed ? "git couldn't list them" : false, newDeps: newDependencies(r.path, mergeBase, files) };
  });
}

/** A file's text at a commit of a GitHub repo, "" when it isn't there; throws when it can't be read. */
function fileAt(repo, file, ref) {
  try { return gh(["api", `repos/${repo}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw+json"]); }
  catch (e) {
    if (/HTTP 404|Not Found/i.test(String(e.stderr || e.message))) return "";
    throw e;
  }
}

/** A PR's unresolved review threads, every page of them. */
function unresolvedThreads(owner, name, number) {
  const q = "query($o:String!,$n:String!,$p:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}";
  let unresolved = 0;
  let after = null;
  for (let page = 0; page < 50; page++) {
    const r = JSON.parse(gh(["api", "graphql", "-f", `query=${q}`, "-F", `o=${owner}`, "-F", `n=${name}`, "-F", `p=${number}`, ...(after ? ["-f", `after=${after}`] : [])]));
    const t = r.data?.repository?.pullRequest?.reviewThreads;
    unresolved += (t?.nodes || []).filter((x) => !x.isResolved).length;
    if (!t?.pageInfo?.hasNextPage) return unresolved;
    after = t.pageInfo.endCursor;
  }
  throw new Error("Too many review threads to read");
}

/** A PR's state for the conditions and its changes for the rules, read with gh at its current head. */
function prState(url) {
  const pr = JSON.parse(gh(["pr", "view", url, "--json", "url,number,state,author,isDraft,headRefOid,baseRefOid,statusCheckRollup,reviews,files"]));
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  const unresolved = m ? unresolvedThreads(m[1], m[2], m[3]) : 0;
  const repo = m ? `${m[1]}/${m[2]}` : null;
  const files = (pr.files || []).map((f) => ({ path: f.path, lines: (f.additions || 0) + (f.deletions || 0) }));
  const newDeps = [];
  let unknown = repo ? false : "not a GitHub PR";
  for (const f of files) {
    if (!repo || dependencies(f.path, "") === null) continue;
    // A dependency file that can't be read leaves what it adds unknown (never "nothing new").
    try {
      const was = dependencies(f.path, fileAt(repo, f.path, pr.baseRefOid));
      for (const d of dependencies(f.path, fileAt(repo, f.path, pr.headRefOid))) if (!was.has(d)) newDeps.push({ file: f.path, name: d });
    } catch (e) { unknown = `couldn't read ${f.path}: ${String(e.stderr || e.message).trim().split("\n")[0]}`; }
  }
  return { ...pr, repo, unresolved, changes: { name: repo || url, files, newDeps, unknown } };
}

/** Repeated flags (`--concern a --concern b`), each value kept. */
function all(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === `--${flag}`) out.push(argv[i + 1]);
  return out;
}

/**
 * Approves each PR at the commit that was assessed and does the policy's merge action, refusing
 * a PR whose head has moved since. Returns what was done; on a failure, what was done before it
 * and the error (the caller records both).
 */
function actOnPrs(prs, a, method) {
  const done = [];
  try {
    for (const pr of prs) {
      const now = JSON.parse(gh(["pr", "view", pr.url, "--json", "headRefOid,state"]));
      if (now.state !== "OPEN" || now.headRefOid !== pr.headRefOid) throw new Error(`${pr.url} changed since it was assessed (now ${String(now.state).toLowerCase()} at ${String(now.headRefOid).slice(0, 7)})`);
      gh(["api", `repos/${pr.repo}/pulls/${pr.number}/reviews`, "--method", "POST", "--input", "-"],
        JSON.stringify({ commit_id: pr.headRefOid, event: "APPROVE", body: `Approved by the Natterjack Approver: ${a.level} risk. ${a.rationale || ""}`.trim() }));
      done.push(`approved ${pr.url}`);
      if (a.mergeAction === "auto-merge") { gh(["pr", "merge", pr.url, "--auto", `--${method}`, "--match-head-commit", pr.headRefOid]); done.push(`auto-merge on for ${pr.url}`); }
      if (a.mergeAction === "merge") { gh(["pr", "merge", pr.url, `--${method}`, "--match-head-commit", pr.headRefOid]); done.push(`merged ${pr.url}`); }
    }
    return { done, error: null };
  } catch (e) {
    return { done, error: (e.stderr && String(e.stderr).trim().split("\n")[0]) || e.message };
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  const root = typeof args.root === "string" ? path.resolve(args.root) : process.cwd();
  const ws = sourceWorkspace(root);
  const rawPolicy = readPolicy(ws);
  const policy = normalizePolicy(rawPolicy);
  const ticket = typeof args.ticket === "string" && args.ticket.trim() ? args.ticket.trim() : null;
  const file = ticket ? manifestPath(ws, ticket) : null;
  const manifest = file ? readJson(file) : null;
  // The ticket's labels: what implement recorded, plus any given here (never fewer).
  const labels = [...new Set([...((manifest && manifest.labels) || []), ...(typeof args.labels === "string" ? args.labels.split(",").map((s) => s.trim()).filter(Boolean) : [])])];
  const only = typeof args.repos === "string" ? args.repos.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const securityFailed = latestRows(manifest, "security").filter((r) => r.status === "failed").map((r) => r.repo || "a repo");

  if (command === "rules") {
    const r = evaluateRules(policy.approver, { repos: workrootChanges(root, only), labels, securityFailed });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return;
  }
  if (command === "assess") {
    if (!ticket) throw usage("--ticket is required");
    const gate = args.gate;
    if (!GATES.includes(gate)) throw usage(`--gate must be one of ${GATES.join(", ")}`);
    // The merge gate judges the PRs as they are on the code host (what gets approved); the pre-PR
    // gate the WORKROOT, every repo of it; before building there's no diff, only the labels.
    const prs = gate === "merge" ? ((manifest && manifest.prs) || []).filter((p) => p.state !== "merged" && p.state !== "closed").map((p) => prState(p.url)).filter((p) => p.state === "OPEN") : [];
    const repos = gate === "merge" ? prs.map((p) => p.changes) : gate === "prePr" ? workrootChanges(root, null) : [];
    const rules = evaluateRules(policy.approver, { repos, labels, securityFailed: gate === "merge" || gate === "prePr" ? securityFailed : [] });
    let ghUser = null;
    try { ghUser = gh(["api", "user", "--jq", ".login"]).trim() || null; } catch {}
    const concerns = all(argv, "concern").flatMap((c) => c.split(";"));
    const canAsk = args["can-ask"] === undefined ? undefined : args["can-ask"] !== "no";
    const sha = prs.map((p) => p.headRefOid).filter(Boolean).join(",") || null;
    const judgedShas = all(argv, "judged").flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
    const a = assess(rawPolicy, manifest, gate, {
      rules, risk: args.risk, rationale: args.rationale, concerns, prs, judgedShas, ghUser, sampleKey: `${ticket}|${gate}|${sha || (manifest && manifest.roundStartedAt) || ""}`,
      run: args.run === "autonomous" ? "autonomous" : "interactive", ...(canAsk === undefined ? {} : { canAsk }),
    });
    let acted = null;
    if (a.action === "pass" && gate === "merge") {
      acted = actOnPrs(prs, a, policy.approver.mergeMethod);
      if (acted.error) {
        // Part of it may have happened: say what, and leave the rest to a person.
        a.action = "handoff";
        a.reason = `The Approver approved, then stopped: ${acted.error}.${acted.done.length ? ` Done: ${acted.done.join("; ")}.` : ""} A person takes it from here.`;
      }
    }
    if (a.action === "pass") {
      update("gate", { ticket, gate, decision: "approved", by: "approver", mode: "approver", risk: a.level, rationale: [a.rationale || a.reason, acted?.done.length ? `(${acted.done.join("; ")})` : ""].filter(Boolean).join(" "), sha }, { start: root });
    } else {
      // A person decides from here (advisory, or sent on by the Approver): the board says it waits on them.
      update("gate", { ticket, gate, decision: "pending", by: null, mode: "human", risk: a.level, rationale: a.reason, sha }, { start: root });
    }
    update("assess", { ticket, assessment: { ...a, sha } }, { start: root });
    process.stdout.write(JSON.stringify(a, null, 2) + "\n");
    if (acted?.error) process.exitCode = 1;
    return;
  }
  throw usage("usage: approver.mjs rules|assess --root <WORKROOT> [--ticket <id> --gate <gate>] (see the header)");
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`Error: ${(e.stderr && String(e.stderr).trim()) || e.message}\n`);
    process.exitCode = e.usage ? 2 : 1;
  });
}

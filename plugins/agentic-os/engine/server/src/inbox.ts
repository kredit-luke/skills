/**
 * "Needs you" inbox — things waiting on a human, pulled from the code host and
 * from the run ledger. Code host = workspace.json codeHost: kind "github" uses
 * the gh CLI (already authenticated); ciRepos ("owner/name") get a CI dot for
 * ciBranch. Other kinds (or "none") show only the ledger items.
 *
 * GitHub results are cached for INBOX_TTL_MS; gh is slow and rate-limited.
 */

import { execFile } from "node:child_process";
import { workspaceConfig } from "./config.ts";

const INBOX_TTL_MS = 2 * 60 * 1000;
const MAX_PR_DETAIL_LOOKUPS = 15;

function gh(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split("\n")[0]));
      try { resolve(JSON.parse(stdout || "null")); } catch (e) { reject(e); }
    });
  });
}

function rollupState(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return "none";
  let pending = false;
  for (const c of checks) {
    const conclusion = (c.conclusion || c.state || "").toUpperCase();
    const status = (c.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion)) return "failing";
    if (status && status !== "COMPLETED") pending = true;
    if (conclusion === "PENDING" || conclusion === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "passing";
}

class Inbox {
  runs: any;
  cache: any;
  inflight: any;

  constructor(runs) {
    this.runs = runs;
    this.cache = null;
    this.inflight = null;
  }

  async _github(ciRepos, ciBranch) {
    const items = [];
    const errors = [];

    const [mine, reviews] = await Promise.all([
      gh(["search", "prs", "--author=@me", "--state=open", "--limit", "30", "--json", "number,title,repository,url,updatedAt,isDraft"]).catch((e) => { errors.push(`my PRs: ${e.message}`); return []; }),
      gh(["search", "prs", "--review-requested=@me", "--state=open", "--limit", "30", "--json", "number,title,repository,url,updatedAt,author"]).catch((e) => { errors.push(`review requests: ${e.message}`); return []; }),
    ]);

    for (const pr of reviews || []) {
      items.push({
        kind: "review-requested",
        severity: "action",
        title: pr.title,
        detail: `${pr.repository.nameWithOwner}#${pr.number} by ${pr.author ? pr.author.login : "?"}`,
        url: pr.url,
        at: pr.updatedAt,
      });
    }

    const details = await Promise.all(
      (mine || []).slice(0, MAX_PR_DETAIL_LOOKUPS).map((pr) =>
        gh(["pr", "view", String(pr.number), "--repo", pr.repository.nameWithOwner, "--json", "reviewDecision,mergeable,statusCheckRollup"])
          .then((d) => ({ pr, d }))
          .catch(() => ({ pr, d: null }))
      )
    );
    for (const { pr, d } of details) {
      const checks = d ? rollupState(d.statusCheckRollup) : "unknown";
      const decision = d ? d.reviewDecision : "";
      let kind = "my-pr";
      let severity = "info";
      let state = pr.isDraft ? "draft" : "waiting on review";
      if (checks === "failing") { kind = "pr-failing"; severity = "alert"; state = "checks failing"; }
      else if (decision === "CHANGES_REQUESTED") { severity = "action"; state = "changes requested"; }
      else if (d && d.mergeable === "CONFLICTING") { severity = "action"; state = "merge conflict"; }
      else if (decision === "APPROVED" && checks !== "pending") { kind = "pr-ready"; severity = "action"; state = "approved, ready to merge"; }
      else if (checks === "pending") { state = "checks running"; }
      items.push({
        kind,
        severity,
        title: pr.title,
        detail: `${pr.repository.nameWithOwner}#${pr.number} · ${state}`,
        url: pr.url,
        at: pr.updatedAt,
      });
    }

    const ci = await Promise.all(
      ciRepos.map((repo) =>
        gh(["run", "list", "--repo", repo, "--branch", ciBranch, "--limit", "1", "--json", "conclusion,status,workflowName,url,displayTitle,updatedAt"])
          .then((runs) => ({ repo, run: runs && runs[0] }))
          .catch((e) => { errors.push(`${repo} CI: ${e.message}`); return { repo, run: null }; })
      )
    );
    const ciHealth = ci.map(({ repo, run }) => ({
      repo,
      state: !run ? "unknown" : run.status !== "completed" ? "running" : run.conclusion === "success" ? "passing" : "failing",
      url: run ? run.url : `https://github.com/${repo}/actions`,
      title: run ? run.displayTitle : null,
      at: run ? run.updatedAt : null,
    }));
    for (const h of ciHealth) {
      if (h.state === "failing") {
        items.push({ kind: "main-ci-failing", severity: "alert", title: `main is red: ${h.repo.split("/")[1]}`, detail: h.title || "", url: h.url, at: h.at });
      }
    }

    return { items, ciHealth, errors };
  }

  _ledgerItems() {
    const cutoff = Date.now() - 72 * 3600 * 1000;
    const items = [];
    for (const r of this.runs.list()) {
      const at = r.endedAt || r.startedAt;
      // A question waits for you however old it is.
      if (r.status === "waiting") {
        const q = (r.question && r.question[0]) || null;
        items.push({ kind: "run-waiting", severity: "action", title: `Claude is asking: ${r.label}`, detail: q ? q.question.slice(0, 160) : "Needs your answer", runId: r.id, at });
        continue;
      }
      if (Date.parse(r.startedAt) < cutoff || r.verdict) continue;
      if (["failed", "interrupted"].includes(r.status)) {
        items.push({ kind: "run-failed", severity: "alert", title: `Run ${r.status}: ${r.label}`, detail: (r.error || "").split("\n")[0].slice(0, 160), runId: r.id, at });
      } else if (r.warning && r.status === "succeeded") {
        items.push({ kind: "run-warning", severity: "action", title: `Background work stopped: ${r.label}`, detail: r.warning.slice(0, 160), runId: r.id, at });
      }
    }
    return items;
  }

  async get(force = false) {
    const host = workspaceConfig().codeHost;
    const fresh = this.cache && this.cache.host === host.kind && Date.now() - this.cache.fetchedAt < INBOX_TTL_MS;
    if (!fresh || force) {
      if (!this.inflight) {
        const load = host.kind === "github"
          ? this._github(host.ciRepos, host.ciBranch)
          : Promise.resolve({ items: [], ciHealth: [], errors: host.kind === "none" ? [] : [`Code host "${host.kind}" isn't supported by the inbox yet (github is).`] });
        this.inflight = load
          .then((g) => { this.cache = { ...g, host: host.kind, fetchedAt: Date.now() }; })
          .catch((e) => { this.cache = { items: [], ciHealth: [], errors: [e.message], host: host.kind, fetchedAt: Date.now() }; })
          .finally(() => { this.inflight = null; });
      }
      // Serve stale data immediately when we have it; block only on the first load.
      if (!this.cache || force) await this.inflight;
    }
    const rank = { alert: 0, action: 1, info: 2 };
    const items = [...this._ledgerItems(), ...this.cache.items].sort(
      (a, b) => rank[a.severity] - rank[b.severity] || (b.at || "").localeCompare(a.at || "")
    );
    return { items, ciHealth: this.cache.ciHealth, errors: this.cache.errors, fetchedAt: this.cache.fetchedAt };
  }
}

export { Inbox };

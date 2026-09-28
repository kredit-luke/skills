/**
 * The GitHub Issues adapter (IssueTracker), through the gh CLI: the viewer's own
 * `gh auth login`, so there is no key to paste. workspace.json:
 *
 *   "issues": { "kind": "github", "repos": ["acme/api", "acme/web"],
 *               "states": { "In progress": ["in progress"], "In review": ["review"] } }
 *
 * `repos` (or a single `repo`) are the repositories to show; each is a "team" on
 * the board. GitHub issues are only open/closed, so the board's columns come from
 * labels: `states` maps a column name to the labels that put an issue in it;
 * open issues with none of them are "Open". deck.json issues.states picks which
 * columns show (empty = all). Ids are "<repo>#<number>" (e.g. "api#42").
 */

import { execFile } from "node:child_process";
import type { IssuesConfig } from "../config.ts";
import type { ConnectHelp, IssueFilter, IssueTracker, TrackerStatus } from "./index.ts";

const CACHE_TTL_MS = 60 * 1000;
const LIMIT = 200;

/** A personal search (GitHub qualifiers) as gh arguments; throws on one gh would misread. */
export function searchArgs(query: string | undefined): string[] {
  const q = String(query || "").trim();
  if (!q) return [];
  if (/[\r\n]/.test(q)) throw new Error("Keep your filter on one line.");
  if (q.length > 256) throw new Error("Your filter is longer than GitHub search allows (256 characters).");
  return ["--search", q];
}

const LABEL_COLOR = (hex: string) => (/^[0-9a-f]{6}$/i.test(hex || "") ? `#${hex}` : "#8b949e");

function gh(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split("\n")[0]));
      try { resolve(JSON.parse(stdout || "null")); } catch (e) { reject(e); }
    });
  });
}

export function repoList(cfg: any): string[] {
  const list = Array.isArray(cfg.repos) ? cfg.repos : cfg.repo ? [cfg.repo] : [];
  return list.filter((r: unknown) => typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r as string));
}

/** The board column for an issue: the first `states` entry whose labels it has, else Open/Closed. */
export function stateOf(labels: string[], closed: boolean, states: Record<string, string[]>): string {
  if (closed) return "Closed";
  const lower = labels.map((l) => l.toLowerCase());
  for (const [state, want] of Object.entries(states || {})) {
    if ((want || []).some((w) => lower.includes(String(w).toLowerCase()))) return state;
  }
  return "Open";
}

class GitHubTracker implements IssueTracker {
  kind = "github";
  cfg: IssuesConfig & Record<string, any>;
  cache: any = null;
  inflight: Promise<void> | null = null;
  inflightKey = "";
  cacheKey = "";
  viewer: string | null = null;
  authed: boolean | null = null;

  constructor(cfg: IssuesConfig) { this.cfg = cfg as any; }

  get repos() { return repoList(this.cfg); }
  get states(): Record<string, string[]> { return this.cfg.states && typeof this.cfg.states === "object" ? this.cfg.states : {}; }

  status(): TrackerStatus {
    return { connected: this.authed !== false && this.repos.length > 0, source: "cli", viewer: this.viewer };
  }

  connectHelp(): ConnectHelp {
    if (!this.repos.length) {
      return {
        title: "Pick the repositories",
        steps: ["List them in `.claude/dashboard/workspace.json` under `issues.repos`, e.g. `[\"acme/api\", \"acme/web\"]`, then reload."],
        placeholder: "", needsKey: false,
      };
    }
    return {
      title: "Sign in to GitHub",
      steps: [
        "The Issues page reads GitHub through the GitHub CLI with your own login.",
        "In a terminal, run `gh auth login` (GitHub.com → HTTPS → browser), then reload this page.",
      ],
      placeholder: "", needsKey: false,
    };
  }

  async connect(): Promise<TrackerStatus> {
    throw new Error("GitHub uses the gh CLI's login: run `gh auth login` in a terminal, then reload.");
  }

  disconnect(): TrackerStatus { return this.status(); }

  issueUrl(id: string) {
    const m = /^([\w.-]+)#(\d+)$/.exec(id);
    const repo = m ? this.repos.find((r) => r.split("/")[1] === m[1]) : null;
    return repo && m ? `https://github.com/${repo}/issues/${m[2]}` : null;
  }

  queryHelp() {
    return { label: "Search", placeholder: "assignee:@me label:bug", help: "GitHub issue search qualifiers, for you only (passed to gh issue list --search)." };
  }

  async issues(filter: IssueFilter, force = false) {
    if (!this.repos.length) return { connected: false, issues: [] };
    searchArgs(filter.query); // a bad personal filter is the caller's error, not a GitHub outage
    // Cached per filter: a changed personal query is a different board.
    const key = JSON.stringify([filter.teams || [], filter.states || [], filter.query || ""]);
    if (this.inflight && this.inflightKey !== key) await this.inflight;
    const fresh = this.cache && this.cacheKey === key && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
    if (fresh && !force) return this.cache;
    if (!this.inflight) {
      this.inflightKey = key;
      this.inflight = (async () => {
        try {
          if (!this.viewer) this.viewer = await gh(["api", "user", "--jq", "{login: .login}"]).then((u) => u.login);
          this.authed = true;
        } catch (e) {
          this.authed = false;
          this.cache = { connected: false, issues: [], fetchedAt: Date.now(), error: e.message };
          return;
        }
        const repos = filter.teams && filter.teams.length ? this.repos.filter((r) => filter.teams.includes(r.split("/")[1])) : this.repos;
        const errors: string[] = [];
        const lists = await Promise.all(repos.map((repo) =>
          gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(LIMIT), ...searchArgs(filter.query),
            "--json", "number,title,url,labels,assignees,updatedAt,milestone"])
            .then((rows) => rows.map((n) => this.toIssue(repo, n)))
            .catch((e) => { errors.push(`${repo}: ${e.message}`); return []; })));
        const all = lists.flat().filter((i) => !filter.states || !filter.states.length || filter.states.includes(i.state));
        all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.cache = { connected: true, fetchedAt: Date.now(), error: errors.length ? errors.join("; ") : null, issues: all };
        this.cacheKey = key;
      })().finally(() => { this.inflight = null; });
    }
    await this.inflight;
    return this.cache;
  }

  toIssue(repo: string, n: any) {
    const labels = (n.labels || []).map((l) => ({ name: l.name, color: LABEL_COLOR(l.color) }));
    const short = repo.split("/")[1];
    return {
      id: `${short}#${n.number}`,
      title: n.title,
      url: n.url,
      priority: 0,
      priorityLabel: "",
      updatedAt: n.updatedAt,
      state: stateOf(labels.map((l) => l.name), false, this.states),
      team: short,
      teamKey: short,
      assignee: (n.assignees && n.assignees[0] && n.assignees[0].login) || null,
      project: n.milestone ? n.milestone.title : null,
      labels,
    };
  }

  async issue(id: string) {
    const m = /^([\w.-]+)#(\d+)$/.exec(id);
    const repo = m ? this.repos.find((r) => r.split("/")[1] === m[1]) : null;
    if (!m || !repo) throw new Error(`${id} isn't an issue in the configured repos (${this.repos.join(", ") || "none"}).`);
    const n = await gh(["issue", "view", m[2], "--repo", repo, "--json", "number,title,url,body,labels,assignees,milestone,state,updatedAt"]);
    const labels = (n.labels || []).map((l) => ({ name: l.name, color: LABEL_COLOR(l.color) }));
    return {
      id, title: n.title, url: n.url, team: m[1],
      state: stateOf(labels.map((l) => l.name), n.state === "CLOSED", this.states),
      priorityLabel: "",
      assignee: (n.assignees && n.assignees[0] && n.assignees[0].login) || null,
      project: n.milestone ? n.milestone.title : null,
      cycle: null,
      labels,
      description: n.body || "",
      branchName: null,
      updatedAt: n.updatedAt,
    };
  }
}

export { GitHubTracker };

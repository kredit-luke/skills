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
import type { ConnectHelp, IssueFilter, IssueTracker, LinkedIssues, TrackerStatus } from "./index.ts";
import { LINKED_LIMIT, byMarker } from "./markers.ts";
import { ACTIVITY_LIMIT, type AssignedIssue, type IssueChange, type TrackerActivity, changesOf, isBlocked, isSince, noteChange, searchTime } from "./activity.ts";

const CACHE_TTL_MS = 60 * 1000;
const LIMIT = 200;
/** Pages of 100 read from a repo's issue events or comments, at most, to reach the Standup window's start. */
const ACTIVITY_PAGES = 5;

/**
 * GitHub search allows 256 characters of search terms (qualifiers like repo: don't count)
 * and five AND/OR/NOT operators, so markers go in groups that fit both. A quote or backslash
 * in a marker is dropped (markers are ids; this keeps one from ending its phrase early).
 */
export function markerQueries(markers: string[]): string[] {
  const out: string[] = [];
  let group: string[] = [];
  const text = (g: string[]) => g.map((m) => `"${m}"`).join(" OR ");
  for (const raw of markers) {
    const m = String(raw).replace(/["\\]/g, "");
    if (!m) continue;
    if (`"${m}"`.length > 256) continue;
    if (group.length && (group.length >= 6 || text([...group, m]).length > 256)) { out.push(text(group)); group = []; }
    group.push(m);
  }
  if (group.length) out.push(text(group));
  return out;
}

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

/**
 * The configured repo a board team (deck.json issues.teams / implementTeams) names, in any case:
 * its owner/name, or its short name when only one configured repo has it. Undefined otherwise.
 */
export function repoForTeam(repos: string[], team: string): string | undefined {
  const t = String(team || "").trim().toLowerCase();
  const full = repos.find((r) => r.toLowerCase() === t);
  if (full) return full;
  const short = repos.filter((r) => r.split("/")[1].toLowerCase() === t);
  return short.length === 1 ? short[0] : undefined;
}

/** A repo's team on the board: its short name, or owner/name when another configured repo shares it. */
export function teamOfRepo(repos: string[], repo: string): string {
  const short = repo.split("/")[1];
  return repos.filter((r) => r.split("/")[1].toLowerCase() === short.toLowerCase()).length > 1 ? repo : short;
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

  /** Runs gh, parsing its JSON (a field so tests can stub it). */
  gh: (args: string[]) => Promise<any> = gh;

  constructor(cfg: IssuesConfig) { this.cfg = cfg as any; }

  get repos() { return repoList(this.cfg); }
  /** The team issues of the repo a configured team names carry (teamOfRepo); null when it names none, or several. */
  teamName(team: string) { const repos = this.repos; const r = repoForTeam(repos, team); return r ? teamOfRepo(repos, r) : null; }

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
    const key = JSON.stringify([filter.teams || [], filter.states || [], filter.query || "", filter.assigned || "", filter.labels || []]);
    // Another filter's fetch may start while waiting for one: wait until none is in flight but ours.
    while (this.inflight && this.inflightKey !== key) await this.inflight;
    const fresh = this.cache && this.cacheKey === key && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
    if (fresh && !force) return this.cache;
    if (!this.inflight) {
      this.inflightKey = key;
      this.inflight = (async () => {
        try {
          if (!this.viewer) this.viewer = await this.gh(["api", "user", "--jq", "{login: .login}"]).then((u) => u.login);
          this.authed = true;
        } catch (e) {
          this.authed = false;
          this.cache = { connected: false, issues: [], fetchedAt: Date.now(), error: e.message };
          return;
        }
        const configured = this.repos;
        const picked = filter.teams && filter.teams.length ? new Set(filter.teams.map((t) => repoForTeam(configured, t))) : null;
        const repos = picked ? configured.filter((r) => picked.has(r)) : configured;
        const errors: string[] = [];
        const lists = await Promise.all(repos.map((repo) =>
          this.gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(LIMIT), ...searchArgs(filter.query),
            ...(filter.assigned === "me" ? ["--assignee", "@me"] : []),
            // Any of the labels: one label is a filter; several, a search (a comma means "or" there).
            ...(filter.labels && filter.labels.length === 1 && !filter.query ? ["--label", filter.labels[0]] : []),
            ...(filter.labels && filter.labels.length > 1 && !filter.query ? ["--search", `label:${filter.labels.map((l) => JSON.stringify(l)).join(",")}`] : []),
            "--json", "number,title,url,labels,assignees,updatedAt,milestone"])
            // gh has no "mine or nobody's": the open ones, then by login (exact on GitHub).
            .then((rows) => rows.filter((n) => filter.assigned !== "me-or-none" || !(n.assignees || []).length || (n.assignees || []).some((a) => String(a.login).toLowerCase() === String(this.viewer).toLowerCase())))
            .then((rows) => { const team = teamOfRepo(configured, repo); return rows.map((n) => this.toIssue(repo, n, team)); })
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

  /** Issues (open or closed, in the configured repos) whose body has one of the markers exactly. Rejects when gh fails. */
  async linkedIssues(markers: string[]): Promise<LinkedIssues> {
    const repos = this.repos;
    if (!repos.length || !markers.length || this.authed === false) return new Map();
    const repoArgs = repos.flatMap((r) => ["--repo", r]);
    const lists = await Promise.all(markerQueries(markers).map((q) =>
      this.gh(["search", "issues", q, "--match", "body", ...repoArgs, "--limit", String(LINKED_LIMIT), "--json", "number,title,url,body,state,repository"])));
    const truncated = lists.some((l) => Array.isArray(l) && l.length >= LINKED_LIMIT);
    const found = lists.flat().filter(Boolean).map((n: any) => {
      const repo = String(n.repository?.nameWithOwner || n.repository?.name || "");
      const short = repo.split("/").pop() || repo;
      return { issue: { key: `${short}#${n.number}`, url: String(n.url || ""), title: String(n.title || ""), state: n.state === "closed" || n.state === "CLOSED" ? "Closed" : "Open" }, text: String(n.body || "") };
    });
    return byMarker(markers, found, truncated);
  }

  /**
   * What the viewer did since `since` in the configured repos: issues they opened (search), closed,
   * reopened or moved to a board column (a `states` label; each repo's issue events), and commented
   * on (each repo's comments since then); and the open issues assigned to them.
   */
  async activity(since: string): Promise<TrackerActivity> {
    const repos = this.repos;
    if (!repos.length) throw new Error("No repositories are configured (workspace.json issues.repos).");
    if (!this.viewer) this.viewer = await this.gh(["api", "user", "--jq", "{login: .login}"]).then((u) => u.login);
    const login = this.viewer;
    const repoArgs = repos.flatMap((r) => ["--repo", r]);
    const at = searchTime(since);
    const fields = "number,title,url,repository,labels,state,createdAt,updatedAt";
    // Each part on its own: one unreadable repo or a rate-limited search leaves the rest.
    const errors: string[] = [];
    const part = (what: string, p: Promise<any>) => p.catch((e) => { errors.push(`${what}: ${e.message}`); return []; });
    const search = (what: string, args: string[]) => part(what, this.gh(["search", "issues", ...repoArgs, ...args, "--limit", String(ACTIVITY_LIMIT), "--json", fields]));
    const [opened, commented, assigned, perRepo] = await Promise.all([
      search("issues you opened", ["--author=@me", "--created", `>=${at}`]),
      // Only for the titles: the comments below say which issues, and when.
      search("issues you commented on", ["--commenter=@me", "--updated", `>=${at}`]),
      search("issues assigned to you", ["--assignee=@me", "--state=open"]),
      Promise.all(repos.map(async (repo) => {
        const [events, comments] = await Promise.all([
          part(`${repo} issue events`, this.pagesSince(`repos/${repo}/issues/events`, since)),
          part(`${repo} comments`, this.pagesSince(`repos/${repo}/issues/comments?since=${encodeURIComponent(at)}&sort=created&direction=desc`, since)),
        ]);
        return { repo, events, comments };
      })),
    ]);
    if (errors.length && errors.length === 3 + repos.length * 2) throw new Error(errors[0]);
    const changes = new Map<string, IssueChange>();
    const short = (n: any) => String(n.repository?.nameWithOwner || n.repository?.name || "").split("/").pop() || "";
    const labelNames = (n: any) => (n.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)).filter(Boolean);
    const baseOf = (repo: string, n: any) => ({
      id: `${repo}#${n.number}`, title: n.title || "", url: n.url || n.html_url || "",
      state: stateOf(labelNames(n), String(n.state).toLowerCase() === "closed", this.states),
    });
    for (const n of opened || []) noteChange(changes, baseOf(short(n), n), "opened", n.createdAt);
    // A column is a label (issues.states), so adding one moves the issue there.
    const column = (label: string) => Object.keys(this.states).find((s) => (this.states[s] || []).some((w) => String(w).toLowerCase() === label.toLowerCase()));
    for (const { repo, events, comments } of perRepo) {
      const name = repo.split("/")[1];
      for (const e of events || []) {
        if (!e.actor || e.actor.login !== login || !e.issue || e.issue.pull_request || !isSince(e.created_at, since)) continue;
        const base = baseOf(name, e.issue);
        if (e.event === "closed" || e.event === "reopened") noteChange(changes, base, e.event, e.created_at);
        else if (e.event === "labeled" && e.label && column(e.label.name)) noteChange(changes, base, `moved to ${column(e.label.name)}`, e.created_at);
      }
      for (const c of comments || []) {
        if (!c.user || c.user.login !== login || !isSince(c.created_at, since)) continue;
        // Comments on pull requests come here too; their links say /pull/.
        const m = /\/issues\/(\d+)$/.exec(String(c.issue_url || ""));
        if (!m || /\/pull\//.test(String(c.html_url || ""))) continue;
        const id = `${name}#${m[1]}`;
        const found = (commented || []).find((n: any) => short(n) === name && String(n.number) === m[1]);
        noteChange(changes, found ? baseOf(name, found) : { id, title: "", url: String(c.html_url || "").replace(/#.*$/, ""), state: "" }, "commented", c.created_at);
      }
    }
    const open: AssignedIssue[] = (assigned || []).map((n: any) => {
      const labels = labelNames(n);
      const state = stateOf(labels, false, this.states);
      return { id: `${short(n)}#${n.number}`, title: n.title || "", url: n.url || "", state, priority: 0, priorityLabel: "", blocked: isBlocked(state, labels), updatedAt: n.updatedAt || "" };
    });
    open.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { changed: changesOf(changes), assigned: open, ...(errors.length ? { errors } : {}) };
  }

  /** A newest-first list endpoint, page by page until it goes past `since` (or ACTIVITY_PAGES pages). */
  async pagesSince(endpoint: string, since: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= ACTIVITY_PAGES; page++) {
      const rows = await this.gh(["api", `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`]);
      if (!Array.isArray(rows)) break;
      out.push(...rows);
      if (rows.length < 100 || !isSince(rows[rows.length - 1].created_at, since)) break;
    }
    return out;
  }

  toIssue(repo: string, n: any, team = teamOfRepo(this.repos, repo)) {
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
      team,
      teamKey: team,
      assignee: (n.assignees && n.assignees[0] && n.assignees[0].login) || null,
      project: n.milestone ? n.milestone.title : null,
      labels,
    };
  }

  /**
   * Assigns the issue to the gh account unless someone else has it, and reads it back
   * (IssueTracker.claim). GitHub allows several assignees, so two claims at the same moment both
   * land: the one first by name keeps it, the other takes itself off.
   */
  async claim(id: string): Promise<{ ok: boolean; why?: string }> {
    const m = /^([\w.-]+)#(\d+)$/.exec(id);
    const repo = m ? this.repos.find((r) => r.split("/")[1] === m[1]) : null;
    if (!m || !repo) return { ok: false, why: `${id} isn't an issue in the configured repos.` };
    if (!this.viewer) this.viewer = await gh(["api", "user", "--jq", "{login: .login}"]).then((u) => u.login);
    const me = String(this.viewer);
    const same = (a: string) => a.toLowerCase() === me.toLowerCase();
    const read = async (): Promise<string[]> => ((await gh(["api", `repos/${repo}/issues/${m[2]}`, "--jq", "{a: [.assignees[].login]}"]))?.a || []);
    const before = await read();
    const others = before.filter((l) => !same(l));
    if (others.length) return { ok: false, why: `assigned to ${others.join(", ")}` };
    if (!before.length) await gh(["api", `repos/${repo}/issues/${m[2]}/assignees`, "--method", "POST", "-f", `assignees[]=${me}`]);
    const after = await read();
    if (!after.some(same)) return { ok: false, why: "the claim didn't stick" };
    const first = [...after].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))[0];
    if (same(first)) return { ok: true };
    await gh(["api", `repos/${repo}/issues/${m[2]}/assignees`, "--method", "DELETE", "-f", `assignees[]=${me}`]).catch(() => {});
    return { ok: false, why: `claimed by ${first} at the same time` };
  }

  async issue(id: string) {
    const m = /^([\w.-]+)#(\d+)$/.exec(id);
    const repo = m ? this.repos.find((r) => r.split("/")[1] === m[1]) : null;
    if (!m || !repo) throw new Error(`${id} isn't an issue in the configured repos (${this.repos.join(", ") || "none"}).`);
    const n = await gh(["issue", "view", m[2], "--repo", repo, "--json", "number,title,url,body,labels,assignees,milestone,state,updatedAt"]);
    const labels = (n.labels || []).map((l) => ({ name: l.name, color: LABEL_COLOR(l.color) }));
    return {
      id, title: n.title, url: n.url, team: teamOfRepo(this.repos, repo),
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

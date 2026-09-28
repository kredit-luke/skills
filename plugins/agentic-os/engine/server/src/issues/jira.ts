/**
 * The Jira Cloud adapter (IssueTracker): Jira's REST API v3 with the viewer's own
 * API token (their permissions, no Claude usage spent on refreshes). workspace.json:
 *
 *   "issues": { "kind": "jira", "site": "acme.atlassian.net", "projects": ["ENG", "OPS"],
 *               "implementStates": ["To Do"] }
 *
 * deck.json issues.teams filters by project name (empty = every project in
 * `projects`, or every project the token can see) and issues.states by status name.
 *
 * Key lookup: JIRA_API_TOKEN (+ JIRA_EMAIL) env vars, else <ledger>/jira-api-token
 * (gitignored) as "email:token", which the Connect card writes. Never sent to the browser.
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import type { IssuesConfig } from "../config.ts";
import type { ConnectHelp, IssueFilter, IssueTracker, TrackerStatus } from "./index.ts";

const CACHE_TTL_MS = 60 * 1000;
const LIMIT = 200;
const FIELDS = ["summary", "status", "priority", "assignee", "labels", "updated", "project", "issuetype", "sprint", "fixVersions"];
// Jira status categories carry a color name, not a hex.
const CATEGORY_COLOR: Record<string, string> = { "blue-gray": "#8993a4", yellow: "#f5a623", green: "#36b37e", "medium-gray": "#8993a4" };
const PRIORITY_RANK: Record<string, number> = { highest: 1, high: 2, medium: 3, low: 4, lowest: 4 };

export function jql(filter: IssueFilter, projects: string[]): string {
  const q = (s: string) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
  const parts: string[] = [];
  if (projects.length) parts.push(`project in (${projects.map(q).join(", ")})`);
  if (filter.states && filter.states.length) parts.push(`status in (${filter.states.map(q).join(", ")})`);
  else parts.push("statusCategory != Done");
  return `${parts.join(" AND ")} ORDER BY updated DESC`;
}

/** Atlassian Document Format → markdown, for the description panel (common nodes only). */
export function adfToMarkdown(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const kids = (n: any, sep = "") => (n.content || []).map((c) => adfToMarkdown(c)).join(sep);
  switch (node.type) {
    case "doc": return (node.content || []).map((c) => adfToMarkdown(c)).join("\n\n").trim();
    case "paragraph": return kids(node);
    case "heading": return `${"#".repeat(Math.min(6, (node.attrs && node.attrs.level) || 2))} ${kids(node)}`;
    case "text": {
      let t = node.text || "";
      for (const m of node.marks || []) {
        if (m.type === "strong") t = `**${t}**`;
        else if (m.type === "em") t = `*${t}*`;
        else if (m.type === "code") t = `\`${t}\``;
        else if (m.type === "link" && m.attrs && m.attrs.href) t = `[${t}](${m.attrs.href})`;
      }
      return t;
    }
    case "hardBreak": return "\n";
    case "bulletList": return (node.content || []).map((li) => `- ${adfToMarkdown(li)}`).join("\n");
    case "orderedList": return (node.content || []).map((li, i) => `${i + 1}. ${adfToMarkdown(li)}`).join("\n");
    case "listItem": return (node.content || []).map((c) => adfToMarkdown(c)).join("\n  ");
    case "codeBlock": return "```\n" + kids(node) + "\n```";
    case "blockquote": return kids(node, "\n").split("\n").map((l) => `> ${l}`).join("\n");
    case "rule": return "---";
    case "mention": return (node.attrs && node.attrs.text) || "@someone";
    case "inlineCard": return (node.attrs && node.attrs.url) || "";
    default: return kids(node);
  }
}

class JiraTracker implements IssueTracker {
  kind = "jira";
  cfg: IssuesConfig & Record<string, any>;
  keyFile: string;
  cache: any = null;
  inflight: Promise<void> | null = null;
  viewer: string | null = null;

  constructor(ledgerDir: string, cfg: IssuesConfig) {
    this.cfg = cfg as any;
    this.keyFile = path.join(ledgerDir, "jira-api-token");
  }

  get site(): string | null {
    const s = String(this.cfg.site || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return /^[\w.-]+$/.test(s) ? s : null;
  }
  get projects(): string[] { return Array.isArray(this.cfg.projects) ? this.cfg.projects.filter((p) => typeof p === "string") : []; }

  /** "email:token", from the env or the ledger file. */
  _cred(): string | null {
    if (process.env.JIRA_API_TOKEN && process.env.JIRA_EMAIL) return `${process.env.JIRA_EMAIL.trim()}:${process.env.JIRA_API_TOKEN.trim()}`;
    try { return fs.readFileSync(this.keyFile, "utf-8").trim() || null; } catch { return null; }
  }

  _get(cred: string, pathAndQuery: string, body?: object): Promise<any> {
    const site = this.site;
    if (!site) return Promise.reject(new Error("Set issues.site in workspace.json (e.g. acme.atlassian.net)."));
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request(`https://${site}${pathAndQuery}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(cred).toString("base64")}`,
          Accept: "application/json",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: 20000,
      }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error("Jira rejected the email/API token."));
          let json;
          try { json = out ? JSON.parse(out) : {}; } catch { return reject(new Error(`Jira returned HTTP ${res.statusCode}`)); }
          if (res.statusCode && res.statusCode >= 400) return reject(new Error((json.errorMessages && json.errorMessages[0]) || `Jira returned HTTP ${res.statusCode}`));
          resolve(json);
        });
      });
      req.on("timeout", () => req.destroy(new Error("Jira request timed out")));
      req.on("error", reject);
      req.end(data || undefined);
    });
  }

  status(): TrackerStatus {
    const fromEnv = !!(process.env.JIRA_API_TOKEN && process.env.JIRA_EMAIL);
    return { connected: !!this._cred() && !!this.site, source: fromEnv ? "env" : this._cred() ? "file" : null, viewer: this.viewer };
  }

  connectHelp(): ConnectHelp {
    if (!this.site) {
      return { title: "Set your Jira site", steps: ["Add `\"site\": \"<you>.atlassian.net\"` under `issues` in `.claude/dashboard/workspace.json`, then reload."], placeholder: "", needsKey: false };
    }
    return {
      title: "Connect Jira",
      steps: [
        "Create an API token at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).",
        "Paste it below as `your-email:token` (the email you sign in to Jira with).",
        "It stays on this machine (in `.claude/ledger/`, never committed) and uses your own Jira permissions.",
      ],
      placeholder: "you@company.com:ATATT…",
      needsKey: true,
    };
  }

  async connect(key: string): Promise<TrackerStatus> {
    const cred = String(key || "").trim();
    if (!/^[^:\s]+@[^:\s]+:\S{10,}$/.test(cred)) throw new Error("Paste it as your-email:api-token.");
    const me = await this._get(cred, "/rest/api/3/myself");
    fs.writeFileSync(this.keyFile, cred, { mode: 0o600 });
    this.viewer = me.displayName || me.emailAddress || null;
    this.cache = null;
    return this.status();
  }

  disconnect(): TrackerStatus {
    try { fs.unlinkSync(this.keyFile); } catch {}
    this.viewer = null;
    this.cache = null;
    return this.status();
  }

  issueUrl(id: string) { return this.site ? `https://${this.site}/browse/${id}` : null; }

  async issues(filter: IssueFilter, force = false) {
    const cred = this._cred();
    if (!cred || !this.site) return { connected: false, issues: [] };
    const fresh = this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
    if (fresh && !force) return this.cache;
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          if (!this.viewer) this.viewer = (await this._get(cred, "/rest/api/3/myself")).displayName || null;
          // teams (project names) narrow the configured projects; project keys and names both work in JQL.
          const projects = filter.teams && filter.teams.length ? filter.teams : this.projects;
          const res = await this._get(cred, "/rest/api/3/search/jql", { jql: jql({ ...filter, teams: [] }, projects), fields: FIELDS, maxResults: LIMIT });
          this.cache = { connected: true, fetchedAt: Date.now(), error: null, issues: (res.issues || []).map((n) => this.toIssue(n)) };
        } catch (e) {
          // Keep showing the last good list, flagged with the error.
          this.cache = { ...(this.cache || { issues: [] }), connected: true, fetchedAt: Date.now(), error: e.message };
        }
      })().finally(() => { this.inflight = null; });
    }
    await this.inflight;
    return this.cache;
  }

  toIssue(n: any) {
    const f = n.fields || {};
    const pri = f.priority ? String(f.priority.name || "") : "";
    return {
      id: n.key,
      title: f.summary || "",
      url: this.issueUrl(n.key),
      priority: PRIORITY_RANK[pri.toLowerCase()] || 0,
      priorityLabel: pri,
      updatedAt: f.updated ? new Date(f.updated).toISOString() : new Date(0).toISOString(),
      state: f.status ? f.status.name : "",
      stateColor: f.status && f.status.statusCategory ? CATEGORY_COLOR[f.status.statusCategory.colorName] : undefined,
      team: f.project ? f.project.name : "",
      teamKey: f.project ? f.project.key : "",
      assignee: f.assignee ? f.assignee.displayName : null,
      project: f.fixVersions && f.fixVersions[0] ? f.fixVersions[0].name : null,
      labels: (f.labels || []).map((l) => ({ name: l, color: "#8993a4" })),
    };
  }

  async issue(id: string) {
    const cred = this._cred();
    if (!cred) throw new Error("Jira isn't connected.");
    const n = await this._get(cred, `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${[...FIELDS, "description"].join(",")}`);
    const base = this.toIssue(n);
    const f = n.fields || {};
    const sprint = Array.isArray(f.sprint) ? f.sprint[f.sprint.length - 1] : f.sprint;
    return {
      id: base.id, title: base.title, url: base.url, team: base.team, state: base.state,
      priorityLabel: base.priorityLabel, assignee: base.assignee, project: base.project,
      cycle: sprint && sprint.name ? sprint.name : null,
      labels: base.labels,
      description: adfToMarkdown(f.description),
      branchName: null,
      updatedAt: base.updatedAt,
    };
  }
}

export { JiraTracker };

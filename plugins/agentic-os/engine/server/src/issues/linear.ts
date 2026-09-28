/**
 * The Linear adapter (IssueTracker): issues read straight from Linear's
 * GraphQL API with the viewer's own personal API key (their permissions, no
 * Claude usage spent on refreshes).
 *
 * Key lookup: LINEAR_API_KEY env var, else <ledger>/linear-api-key (gitignored),
 * which the Connect Linear card writes. The key is never sent to the browser.
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import type { IssuesConfig } from "../config.ts";
import type { ConnectHelp, IssueTracker, TrackerStatus } from "./index.ts";

const ENDPOINT = "https://api.linear.app/graphql";
const CACHE_TTL_MS = 60 * 1000;
const ISSUE_LIMIT = 250;

const ISSUES_QUERY = `
query DashboardIssues($filter: IssueFilter, $first: Int!) {
  viewer { name displayName }
  issues(first: $first, orderBy: updatedAt, filter: $filter) {
    nodes {
      identifier
      title
      url
      priority
      priorityLabel
      updatedAt
      state { name type color }
      team { key name }
      assignee { displayName name }
      project { name }
      labels { nodes { name color } }
    }
  }
}`;

function gql(key: string, query: string, variables: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      ENDPOINT,
      {
        method: "POST",
        // Personal API keys go in Authorization as-is (no "Bearer").
        headers: { "Content-Type": "application/json", Authorization: key, "Content-Length": Buffer.byteLength(body) },
        timeout: 20000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json;
          try { json = JSON.parse(data); } catch { return reject(new Error(`Linear returned HTTP ${res.statusCode}`)); }
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error("Linear rejected the API key."));
          if (json.errors && json.errors.length) return reject(new Error(json.errors[0].message));
          resolve(json.data);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Linear request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

class LinearTracker implements IssueTracker {
  kind = "linear";
  org: string | null;
  urlTemplate: string | null;
  keyFile: any;
  cache: any;
  inflight: any;
  viewer: any;

  constructor(ledgerDir, cfg: IssuesConfig) {
    this.org = cfg.org || null;
    this.urlTemplate = cfg.urlTemplate || null;
    this.keyFile = path.join(ledgerDir, "linear-api-key");
    this.cache = null;
    this.inflight = null;
  }

  _key() {
    if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY.trim();
    try { return fs.readFileSync(this.keyFile, "utf-8").trim() || null; } catch { return null; }
  }

  status(): TrackerStatus {
    return {
      connected: !!this._key(),
      source: process.env.LINEAR_API_KEY ? "env" : this._key() ? "file" : null,
      viewer: this.viewer || null,
    };
  }

  connectHelp(): ConnectHelp {
    const settings = this.org ? `https://linear.app/${this.org}/settings/account/security` : "https://linear.app/settings/account/security";
    return {
      title: "Connect Linear",
      steps: [
        `In Linear, open [Settings → Security & access](${settings}).`,
        "Under **Personal API keys**, create a key (read access is enough) and copy it.",
        "Paste it below. It stays on this machine (in `.claude/ledger/`, never committed) and uses your own Linear permissions.",
      ],
      placeholder: "lin_api_…",
      needsKey: true,
    };
  }

  issueUrl(id: string) {
    if (this.urlTemplate) return this.urlTemplate.replace(/{id}/g, id);
    return this.org ? `https://linear.app/${this.org}/issue/${id}` : null;
  }

  /** Validate a pasted key against Linear before saving it. */
  async connect(key): Promise<TrackerStatus> {
    key = String(key || "").trim();
    if (!/^lin_api_[A-Za-z0-9]+$/.test(key)) throw new Error("That doesn't look like a Linear personal API key (they start with lin_api_).");
    const data = await gql(key, "query { viewer { name email } }", {});
    fs.writeFileSync(this.keyFile, key, { mode: 0o600 });
    this.viewer = data.viewer.name;
    this.cache = null;
    return this.status();
  }

  disconnect(): TrackerStatus {
    try { fs.unlinkSync(this.keyFile); } catch {}
    this.viewer = null;
    this.cache = null;
    return this.status();
  }

  async issues({ teams, states }, force = false) {
    const key = this._key();
    if (!key) return { connected: false, issues: [] };
    const fresh = this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
    if (fresh && !force) return this.cache;
    if (!this.inflight) {
      // An empty teams/states list means "all" rather than "none".
      const filter: any = {};
      if (teams && teams.length) filter.team = { name: { in: teams } };
      if (states && states.length) filter.state = { name: { in: states } };
      this.inflight = gql(key, ISSUES_QUERY, { filter, first: ISSUE_LIMIT })
        .then((data) => {
          this.viewer = data.viewer ? data.viewer.displayName || data.viewer.name : null;
          this.cache = {
            connected: true,
            fetchedAt: Date.now(),
            error: null,
            issues: data.issues.nodes.map((n) => ({
              id: n.identifier,
              title: n.title,
              url: n.url,
              priority: n.priority,
              priorityLabel: n.priorityLabel,
              updatedAt: n.updatedAt,
              state: n.state.name,
              stateColor: n.state.color,
              team: n.team.name,
              teamKey: n.team.key,
              assignee: n.assignee ? n.assignee.displayName || n.assignee.name : null,
              project: n.project ? n.project.name : null,
              labels: n.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
            })),
          };
        })
        .catch((e) => {
          // Keep showing the last good list, flagged with the error.
          this.cache = { ...(this.cache || { issues: [] }), connected: true, fetchedAt: Date.now(), error: e.message };
        })
        .finally(() => { this.inflight = null; });
    }
    await this.inflight;
    return this.cache;
  }

  /** One issue with its description (markdown), for the detail panel and Explain. */
  async issue(identifier: string) {
    const key = this._key();
    if (!key) throw new Error("Linear isn't connected.");
    const data = await gql(key, ISSUE_QUERY, { id: identifier });
    const n = data.issue;
    if (!n) throw new Error(`${identifier} not found.`);
    return {
      id: n.identifier,
      title: n.title,
      url: n.url,
      team: n.team.name,
      state: n.state.name,
      priorityLabel: n.priorityLabel,
      assignee: n.assignee ? n.assignee.displayName || n.assignee.name : null,
      project: n.project ? n.project.name : null,
      cycle: n.cycle ? n.cycle.name || `Cycle ${n.cycle.number}` : null,
      labels: n.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
      description: n.description || "",
      branchName: n.branchName || null,
      updatedAt: n.updatedAt,
    };
  }
}

const ISSUE_QUERY = `
query DashboardIssue($id: String!) {
  issue(id: $id) {
    identifier title url description branchName priorityLabel updatedAt
    state { name }
    team { name }
    assignee { displayName name }
    project { name }
    cycle { name number }
    labels { nodes { name color } }
  }
}`;

export { LinearTracker };

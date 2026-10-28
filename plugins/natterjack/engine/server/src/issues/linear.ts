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
import type { ConnectHelp, IssueTracker, LinkedIssue, LinkedIssues, TrackerStatus } from "./index.ts";
import { LINKED_LIMIT, byMarker, chunks, isIssueKey } from "./markers.ts";
import { ACTIVITY_LIMIT, type AssignedIssue, type IssueChange, type TrackerActivity, byPriority, changesOf, isBlocked, isSince, noteChange } from "./activity.ts";

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

const LINKED_QUERY = `
query DashboardLinkedIssues($filter: IssueFilter, $first: Int!) {
  issues(first: $first, filter: $filter) {
    nodes { identifier title url description state { name } }
  }
}`;

/** The filter for issues whose description contains any of `markers` (Linear checks; the exact match is ours). */
export function linkedFilter(markers: string[]) {
  return { or: markers.map((m) => ({ description: { contains: m } })) };
}

const ACTIVITY_QUERY = `
query StandupActivity($changed: IssueFilter, $assigned: IssueFilter, $comments: CommentFilter, $first: Int!) {
  changed: issues(first: $first, orderBy: updatedAt, filter: $changed) {
    nodes {
      identifier title url createdAt
      state { name }
      creator { isMe }
      history(first: 50) { nodes { createdAt actor { isMe } fromState { name } toState { name } } }
      comments(first: 20, filter: $comments) { nodes { createdAt } }
    }
  }
  assigned: issues(first: $first, orderBy: updatedAt, filter: $assigned) {
    nodes { identifier title url priority priorityLabel updatedAt state { name } labels { nodes { name } } }
  }
}`;

/**
 * The Standup query's filters: issues assigned to, created by, subscribed to or commented on by
 * the viewer (moving an issue subscribes you) and updated since `since`; their own comments since then; and their open issues that are started or up next
 * (Linear's "started" and "unstarted" state types, so not the backlog or triage).
 */
export function activityFilters(since: string) {
  const me = { isMe: { eq: true } };
  return {
    changed: { updatedAt: { gte: since }, or: [{ assignee: me }, { creator: me }, { subscribers: { some: me } }, { comments: { some: { user: me } } }] },
    comments: { createdAt: { gte: since }, user: me },
    assigned: { assignee: me, state: { type: { in: ["started", "unstarted"] } } },
  };
}

class LinearTracker implements IssueTracker {
  kind = "linear";
  /** Sends a GraphQL query with the key (a field so tests can stub it). */
  gql: (key: string, query: string, variables: object) => Promise<any> = gql;
  org: string | null;
  urlTemplate: string | null;
  keyFile: any;
  cache: any;
  inflight: any;
  viewer: any;
  inflightKey = "";
  cacheKey = "";

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

  /** Linear's API has no text query language: no personal board query. */
  queryHelp() { return null; }

  issueUrl(id: string) { return isIssueKey(id) ? this.link(id) : null; }

  issueUrlTemplate() { return this.link("{id}"); }

  /** The issue link for `id`, unchecked: issueUrl checks it's a key; the template passes the placeholder. */
  private link(id: string) {
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

  async issues({ teams, states, assigned, labels, open }: { teams: string[]; states: string[]; assigned?: "me" | "me-or-none"; labels?: string[]; open?: boolean }, force = false) {
    const key = this._key();
    if (!key) return { connected: false, issues: [] };
    // Cached per filter: the Factory's intake asks for other states than the Issues page.
    const filterKey = JSON.stringify([teams || [], states || [], assigned || "", labels || [], !!open]);
    // Another filter's fetch may start while waiting for one: wait until none is in flight but ours.
    while (this.inflight && this.inflightKey !== filterKey) await this.inflight;
    const fresh = this.cache && this.cacheKey === filterKey && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
    if (fresh && !force) return this.cache;
    if (!this.inflight) {
      this.inflightKey = filterKey;
      // An empty teams/states list means "all" rather than "none".
      const filter: any = {};
      if (teams && teams.length) filter.team = { name: { in: teams } };
      if (states && states.length) filter.state = { name: { in: states } };
      if (assigned === "me") filter.assignee = { isMe: { eq: true } };
      if (assigned === "me-or-none") filter.or = [{ assignee: { isMe: { eq: true } } }, { assignee: { null: true } }];
      if (labels && labels.length) filter.labels = { some: { name: { in: labels } } };
      // Linear's own idea of finished: whatever the team calls those states.
      if (open) filter.state = { ...(filter.state || {}), type: { nin: ["completed", "canceled"] } };
      this.inflight = gql(key, ISSUES_QUERY, { filter, first: ISSUE_LIMIT })
        .then((data) => {
          this.viewer = data.viewer ? data.viewer.displayName || data.viewer.name : null;
          this.cacheKey = filterKey;
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
              stateType: n.state.type,
              team: n.team.name,
              teamKey: n.team.key,
              assignee: n.assignee ? n.assignee.displayName || n.assignee.name : null,
              project: n.project ? n.project.name : null,
              labels: n.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
            })),
          };
        })
        .catch((e) => {
          // Keep showing the last good list (for this filter), flagged with the error.
          if (this.cacheKey !== filterKey) { this.cache = null; this.cacheKey = filterKey; }
          this.cache = { ...(this.cache || { issues: [] }), connected: true, fetchedAt: Date.now(), error: e.message };
        })
        .finally(() => { this.inflight = null; });
    }
    await this.inflight;
    return this.cache;
  }

  /** Assigns the issue to the key's owner unless someone else has it, and reads it back (IssueTracker.claim). */
  async claim(identifier: string): Promise<{ ok: boolean; why?: string }> {
    const key = this._key();
    if (!key) return { ok: false, why: "Linear isn't connected." };
    const read = () => this.gql(key, "query($id: String!) { viewer { id displayName } issue(id: $id) { id assignee { id displayName } } }", { id: identifier });
    const before = await read();
    const me = before && before.viewer;
    const issue = before && before.issue;
    if (!me || !issue) return { ok: false, why: `${identifier} wasn't found.` };
    if (issue.assignee && issue.assignee.id !== me.id) return { ok: false, why: `assigned to ${issue.assignee.displayName}` };
    if (!issue.assignee) await this.gql(key, "mutation($id: String!, $a: String!) { issueUpdate(id: $id, input: { assigneeId: $a }) { success } }", { id: issue.id, a: me.id });
    const after = (await read())?.issue?.assignee;
    return after && after.id === me.id ? { ok: true } : { ok: false, why: `claimed by ${after ? after.displayName : "someone else"} first` };
  }

  /** Issues (any state) whose description has one of the markers exactly. Rejects when Linear fails. */
  async linkedIssues(markers: string[]): Promise<LinkedIssues> {
    const key = this._key();
    if (!key || !markers.length) return new Map();
    const found: { issue: LinkedIssue; text: string }[] = [];
    let truncated = false;
    for (const group of chunks(markers, 25)) {
      const data = await this.gql(key, LINKED_QUERY, { filter: linkedFilter(group), first: LINKED_LIMIT });
      const nodes = (data && data.issues && data.issues.nodes) || [];
      if (nodes.length >= LINKED_LIMIT) truncated = true;
      for (const n of nodes) {
        found.push({ issue: { key: n.identifier, url: n.url || this.issueUrl(n.identifier) || "", title: n.title || "", state: n.state ? n.state.name : "" }, text: n.description || "" });
      }
    }
    return byMarker(markers, found, truncated);
  }

  /** What the viewer changed since `since` (state moves, comments, issues they created) and their open assigned issues. */
  async activity(since: string): Promise<TrackerActivity> {
    const key = this._key();
    if (!key) throw new Error("Linear isn't connected.");
    const data = await this.gql(key, ACTIVITY_QUERY, { ...activityFilters(since), first: ACTIVITY_LIMIT });
    const changes = new Map<string, IssueChange>();
    for (const n of (data && data.changed && data.changed.nodes) || []) {
      const base = { id: n.identifier, title: n.title || "", url: n.url || this.issueUrl(n.identifier) || "", state: n.state ? n.state.name : "" };
      if (n.creator && n.creator.isMe && isSince(n.createdAt, since)) noteChange(changes, base, "created", n.createdAt);
      for (const h of (n.history && n.history.nodes) || []) {
        if (!h.actor || !h.actor.isMe || !isSince(h.createdAt, since) || !h.toState) continue;
        noteChange(changes, base, h.fromState ? `moved ${h.fromState.name} → ${h.toState.name}` : `moved to ${h.toState.name}`, h.createdAt);
      }
      for (const c of (n.comments && n.comments.nodes) || []) noteChange(changes, base, "commented", c.createdAt);
    }
    const assigned: AssignedIssue[] = ((data && data.assigned && data.assigned.nodes) || []).map((n) => {
      const labels = ((n.labels && n.labels.nodes) || []).map((l) => l.name);
      const state = n.state ? n.state.name : "";
      return { id: n.identifier, title: n.title || "", url: n.url || this.issueUrl(n.identifier) || "", state, priority: n.priority || 0, priorityLabel: n.priority ? n.priorityLabel || "" : "", blocked: isBlocked(state, labels), updatedAt: n.updatedAt || "" };
    });
    return { changed: changesOf(changes), assigned: assigned.sort(byPriority) };
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

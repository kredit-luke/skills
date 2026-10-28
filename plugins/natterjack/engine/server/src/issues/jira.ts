/**
 * The Jira Cloud adapter (IssueTracker): Jira's REST API v3 as the viewer (their
 * permissions, no Claude usage spent on refreshes): their Connect to Atlassian sign-in
 * (atlassian-auth.ts) when they have one, else their own API token. workspace.json:
 *
 *   "issues": { "kind": "jira", "site": "acme.atlassian.net", "projects": ["ENG", "OPS"],
 *               "implementStates": ["To Do"] }
 *
 * deck.json issues.teams filters by project name (empty = every project in
 * `projects`, or every project the token can see) and issues.states by status name.
 *
 * Key lookup: JIRA_API_TOKEN (+ JIRA_EMAIL) env vars, else <ledger>/jira-api-token
 * (gitignored) as "email:token", which the Connect card writes. Never sent to the browser.
 * A sign-in for this site comes before any of them.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { atlassianCall, removeKeyFile, type AtlassianCred } from "../atlassian.ts";
import type { AtlassianAuth } from "../atlassian-auth.ts";
import { readConfigFile, type IssuesConfig } from "../config.ts";

const REFUSED = "Jira rejected the email/API token. A scoped token needs at least the read:jira-work and read:jira-user scopes.";
const SIGNIN_REFUSED = "Jira turned your Atlassian sign-in down. The team's Atlassian app needs the read:jira-work and read:jira-user scopes; if it has them, disconnect Atlassian and connect again.";
import type { ConnectHelp, IssueFilter, IssueTracker, LinkedIssue, LinkedIssues, TrackerStatus } from "./index.ts";
import { LINKED_LIMIT, byMarker, chunks, isIssueKey } from "./markers.ts";
import { ACTIVITY_LIMIT, type AssignedIssue, type IssueChange, type TrackerActivity, byPriority, changesOf, isBlocked, isSince, minutesAgo, noteChange } from "./activity.ts";

const CACHE_TTL_MS = 60 * 1000;
const LIMIT = 200;
/** Issues whose long changelog is read again for its newest page (one request each). */
const MAX_CHANGELOG_LOOKUPS = 10;
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
  if (filter.labels && filter.labels.length) parts.push(`labels in (${filter.labels.map(q).join(", ")})`);
  if (filter.open && filter.states && filter.states.length) parts.push("statusCategory != Done");
  if (filter.assigned === "me") parts.push("assignee = currentUser()");
  if (filter.assigned === "me-or-none") parts.push("(assignee = currentUser() OR assignee is EMPTY)");
  const extra = cleanQuery(filter.query);
  if (extra) parts.push(`(${extra})`);
  return `${parts.join(" AND ")} ORDER BY updated DESC`;
}

/** Markers searched for in one JQL query, at most. */
const MARKERS_PER_QUERY = 25;

/** JQL for issues whose text has any of `markers` as a phrase, in the configured projects (open or done). */
export function linkedJql(markers: string[], projects: string[]): string {
  const q = (s: string) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
  // text ~ "\"a-b\"": a phrase, so the marker's hyphenated parts match in order.
  const terms = markers.map((m) => `text ~ ${q(`"${m}"`)}`).join(" OR ");
  return `${projects.length ? `project in (${projects.map(q).join(", ")}) AND ` : ""}(${terms}) ORDER BY updated DESC`;
}

/**
 * The Standup page's JQL, in the configured projects: issues the viewer changed in the last
 * `minutes` (updatedBy counts edits, transitions and comments) or created then; and their open
 * issues, highest priority first. Relative dates, so the site's time zone doesn't matter.
 */
export function activityJql(minutes: number, projects: string[]): { changed: string; assigned: string } {
  const q = (s: string) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
  const scope = projects.length ? `project in (${projects.map(q).join(", ")}) AND ` : "";
  const ago = `"-${Math.max(1, Math.floor(minutes))}m"`;
  return {
    changed: `${scope}(issue in updatedBy(currentUser(), ${ago}) OR (reporter = currentUser() AND created >= ${ago})) ORDER BY updated DESC`,
    assigned: `${scope}assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC`,
  };
}

/** Atlassian Document Format as plain text (every text node, blocks on their own lines). */
export function adfText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return String(node.text || "");
  if (node.type === "hardBreak") return "\n";
  if (node.type === "inlineCard") return String(node.attrs?.url || "");
  const inner = (node.content || []).map(adfText).join(node.type === "doc" || /List$|listItem|blockquote|tableRow|table$/.test(node.type || "") ? "\n" : "");
  return /^(paragraph|heading|codeBlock)$/.test(node.type || "") ? inner + "\n" : inner;
}

/** A personal JQL clause, trimmed; throws on one that would break the board query. */
export function cleanQuery(query: string | undefined): string {
  const s = String(query || "").trim();
  if (!s) return "";
  if (/\border\s+by\b/i.test(s)) throw new Error("Leave ORDER BY out of your filter: the board is always newest-updated first.");
  if (/[\r\n]/.test(s)) throw new Error("Keep your filter on one line.");
  // Unbalanced parentheses would escape the "(...)" it's wrapped in.
  let depth = 0;
  for (const ch of s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")) {
    if (ch === "(") depth++;
    if (ch === ")" && --depth < 0) break;
  }
  if (depth !== 0) throw new Error("Your filter's parentheses don't balance.");
  return s;
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
  inflightKey = "";
  cacheKey = "";
  viewer: string | null = null;

  /** The "Flagged" custom field's id (customfield_10021 on most sites; looked up by name), or null when the site has none. */
  flagField: string | null | undefined = undefined;

  confluenceKeyFile: string;
  /** docs.json sources (a field so tests can supply their own). */
  docsSources = (): unknown => readConfigFile("docs.json").data?.sources;
  /** The workspace's Connect to Atlassian, when the dashboard has one. */
  atlassian: () => AtlassianAuth | null;

  constructor(ledgerDir: string, cfg: IssuesConfig, atlassian: () => AtlassianAuth | null = () => null) {
    this.cfg = cfg as any;
    this.atlassian = atlassian;
    this.keyFile = path.join(ledgerDir, "jira-api-token");
    this.confluenceKeyFile = path.join(ledgerDir, "confluence-api-token");
  }

  get site(): string | null {
    const s = String(this.cfg.site || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return /^[\w.-]+$/.test(s) ? s : null;
  }
  get projects(): string[] { return Array.isArray(this.cfg.projects) ? this.cfg.projects.filter((p) => typeof p === "string") : []; }

  /** A docs.json Confluence source is on this same site: its key is an Atlassian token that works here too. */
  get sameSiteConfluence(): boolean {
    const sources = this.docsSources();
    if (!this.site || !Array.isArray(sources)) return false;
    return sources.some((s: any) => {
      if (!s || s.kind !== "external" || s.provider !== "confluence") return false;
      try { return new URL(String(s.url)).hostname === this.site; } catch { return false; }
    });
  }

  /**
   * "email:token" and where it came from: the env or the ledger file, else the same site's Confluence
   * key (docs-providers/confluence.ts does the reverse). A Confluence env key is still "env".
   */
  _credWithSource(): { cred: string; source: "env" | "file" } | null {
    const env = (e: string, t: string) => (process.env[t] && process.env[e] ? `${process.env[e]!.trim()}:${process.env[t]!.trim()}` : null);
    const file = (f: string) => { try { return fs.readFileSync(f, "utf-8").trim() || null; } catch { return null; } };
    let k = env("JIRA_EMAIL", "JIRA_API_TOKEN");
    if (k) return { cred: k, source: "env" };
    if ((k = file(this.keyFile))) return { cred: k, source: "file" };
    if (this.sameSiteConfluence) {
      if ((k = env("CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN"))) return { cred: k, source: "env" };
      if ((k = file(this.confluenceKeyFile))) return { cred: k, source: "file" };
    }
    return null;
  }

  _cred(): string | null { return this._credWithSource()?.cred ?? null; }

  /** The person's Connect to Atlassian sign-in, when it's for this site. */
  _signIn(): AtlassianAuth | null {
    const a = this.atlassian();
    return a && this.site && a.cfg.site === this.site && a.connected() ? a : null;
  }

  /** What requests use: the sign-in first, else the API token; null when there's neither. */
  _auth(): AtlassianCred | null {
    const a = this._signIn();
    const auth: AtlassianCred | null = a ? { kind: "signin", auth: a } : (() => { const cred = this._cred(); return cred ? { kind: "token" as const, cred } : null; })();
    this._syncCred(auth);
    return auth;
  }

  /** Which credential was last used ("signin", or the token's hash): the viewer and the board belong to it. */
  private credKey = "";

  /**
   * A different credential (a sign-in made, dropped or expired, or a new key): the viewer and
   * the cached board were read as someone who may not be this person, so they go. A request
   * still in flight with the old one doesn't write them back (see issues()).
   */
  _syncCred(auth: AtlassianCred | null) {
    const key = !auth ? "" : auth.kind === "signin" ? `signin:${auth.auth.current()?.accessToken ? auth.auth.cfg.site : ""}` : `token:${crypto.createHash("sha256").update(auth.cred).digest("hex")}`;
    if (key === this.credKey) return;
    this.credKey = key;
    this.viewer = null;
    this.cache = null;
  }

  _get(cred: string | AtlassianCred, pathAndQuery: string, body?: object, method?: "PUT"): Promise<any> {
    const site = this.site;
    if (!site) return Promise.reject(new Error("Set issues.site in workspace.json (e.g. acme.atlassian.net)."));
    const auth: AtlassianCred = typeof cred === "string" ? { kind: "token", cred } : cred;
    const refused = auth.kind === "signin" ? SIGNIN_REFUSED : REFUSED;
    const send = (url: string, authorization: string) => new Promise<any>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request(url, {
        method: method || (body ? "POST" : "GET"),
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: 20000,
      }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) return reject(Object.assign(new Error(refused), { status: res.statusCode }));
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
    return atlassianCall("jira", site, auth, pathAndQuery, send);
  }

  /**
   * The id of the field Jira's "Add flag" sets, read once from the site's field list. A failed
   * lookup isn't kept, so the next refresh tries again; meanwhile no card shows as flagged.
   */
  async _flagField(cred: AtlassianCred): Promise<string | null> {
    if (this.flagField !== undefined) return this.flagField;
    try {
      const fields = await this._get(cred, "/rest/api/3/field");
      const f = Array.isArray(fields) ? fields.find((x) => x && x.custom && String(x.name).toLowerCase() === "flagged") : null;
      return (this.flagField = f ? String(f.id) : null);
    } catch { return null; }
  }

  status(): TrackerStatus {
    const auth = this._auth();
    if (auth?.kind === "signin") return { connected: true, source: "signin", viewer: this.viewer || auth.auth.current()?.viewer || null };
    const c = this._credWithSource();
    return { connected: !!c && !!this.site, source: c ? c.source : null, viewer: this.viewer };
  }

  connectHelp(): ConnectHelp {
    if (!this.site) {
      return { title: "Set your Jira site", steps: ["Add `\"site\": \"<you>.atlassian.net\"` under `issues` in `.claude/dashboard/workspace.json`, then reload."], placeholder: "", needsKey: false };
    }
    return {
      title: "Connect Jira",
      steps: [
        "Create an API token at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).",
        "Enter it below with the email you sign in to Jira with. Use a classic token (Create API token, no scopes): one covers both Issues and Confluence docs. A scoped token works too but only for Jira, and needs at least the `read:jira-work` and `read:jira-user` scopes.",
        "It stays on this machine (in `.claude/ledger/`, never committed) and uses your own Jira permissions.",
      ],
      placeholder: "you@company.com:ATATT…",
      needsKey: true,
      keyFields: "email-token",
      signIn: "atlassian",
    };
  }

  async connect(key: string): Promise<TrackerStatus> {
    const cred = String(key || "").trim();
    if (!/^[^:\s]+@[^:\s]+:\S{10,}$/.test(cred)) throw new Error("Enter the email you sign in with and an API token.");
    const me = await this._get(cred, "/rest/api/3/myself");
    fs.writeFileSync(this.keyFile, cred, { mode: 0o600 });
    this.viewer = me.displayName || me.emailAddress || null;
    this.cache = null;
    return this.status();
  }

  disconnect(): TrackerStatus {
    removeKeyFile(this.keyFile);
    this.viewer = null;
    this.cache = null;
    return this.status();
  }

  issueUrl(id: string) { return isIssueKey(id) ? this.link(id) : null; }

  issueUrlTemplate() { return this.link("{id}"); }

  /** The browse link for `id`, unchecked: issueUrl checks it's a key; the template passes the placeholder. */
  private link(id: string) { return this.site ? `https://${this.site}/browse/${id}` : null; }

  queryHelp() {
    return { label: "JQL", placeholder: "assignee = currentUser() AND sprint in openSprints()", help: "Added to the board's query with AND, for you only. Leave out ORDER BY." };
  }

  async issues(filter: IssueFilter, force = false) {
    const cred = this._auth();
    if (!cred || !this.site) return { connected: false, issues: [] };
    cleanQuery(filter.query); // a bad personal filter is the caller's error, not a Jira outage
    // Cached per filter: a changed personal query is a different board.
    const key = JSON.stringify([filter.teams || [], filter.states || [], filter.query || "", filter.assigned || "", filter.labels || [], !!filter.open]);
    // Another filter's fetch may start while waiting for one: wait until none is in flight but ours.
    while (this.inflight && this.inflightKey !== key) await this.inflight;
    const fresh = this.cache && this.cacheKey === key && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
    if (fresh && !force) return this.cache;
    if (!this.inflight) {
      this.inflightKey = key;
      const asKey = this.credKey;
      this.inflight = (async () => {
        try {
          if (!this.viewer) {
            const me = (await this._get(cred, "/rest/api/3/myself")).displayName || null;
            if (this.credKey === asKey) this.viewer = me;
          }
          // teams (project names) narrow the configured projects; project keys and names both work in JQL.
          const projects = filter.teams && filter.teams.length ? filter.teams : this.projects;
          const flag = await this._flagField(cred);
          const res = await this._get(cred, "/rest/api/3/search/jql", { jql: jql({ ...filter, teams: [] }, projects), fields: flag ? [...FIELDS, flag] : FIELDS, maxResults: LIMIT });
          // Read as someone else (the credential changed meanwhile): don't put it back.
          if (this.credKey !== asKey) return;
          this.cache = { connected: true, fetchedAt: Date.now(), error: null, issues: (res.issues || []).map((n) => this.toIssue(n)) };
        } catch (e) {
          if (this.credKey !== asKey) return;
          // Same board: keep showing the last good list, flagged with the error. A new filter that fails shows nothing.
          const keep = this.cacheKey === key && this.cache ? this.cache : { issues: [] };
          this.cache = { ...keep, connected: true, fetchedAt: Date.now(), error: e.message };
        }
        this.cacheKey = key;
      })().finally(() => { this.inflight = null; });
    }
    const waitedAs = this.credKey;
    await this.inflight;
    // That request was made with a credential that's since changed: fetch again with the current one.
    if (!this.cache || this.credKey !== waitedAs) return this._auth() ? this.issues(filter, true) : { connected: false, issues: [] };
    return this.cache;
  }

  /** Issues (any status, in the configured projects) whose description has one of the markers exactly. Rejects when Jira fails. */
  /** Assigns the issue to the signed-in person unless someone else has it, and reads it back (IssueTracker.claim). */
  async claim(id: string): Promise<{ ok: boolean; why?: string }> {
    const cred = this._auth();
    if (!cred || !this.site) return { ok: false, why: "Jira isn't connected." };
    const me = await this._get(cred, "/rest/api/3/myself");
    const read = async () => (await this._get(cred, `/rest/api/3/issue/${encodeURIComponent(id)}?fields=assignee`))?.fields?.assignee || null;
    const before = await read();
    if (before && before.accountId !== me.accountId) return { ok: false, why: `assigned to ${before.displayName}` };
    if (!before) await this._get(cred, `/rest/api/3/issue/${encodeURIComponent(id)}/assignee`, { accountId: me.accountId }, "PUT");
    const after = await read();
    return after && after.accountId === me.accountId ? { ok: true } : { ok: false, why: `claimed by ${after ? after.displayName : "someone else"} first` };
  }

  async linkedIssues(markers: string[]): Promise<LinkedIssues> {
    const cred = this._auth();
    if (!cred || !this.site || !markers.length) return new Map();
    const found: { issue: LinkedIssue; text: string }[] = [];
    let truncated = false;
    for (const group of chunks(markers, MARKERS_PER_QUERY)) {
      const res = await this._get(cred, "/rest/api/3/search/jql", { jql: linkedJql(group, this.projects), fields: ["summary", "status", "description"], maxResults: LINKED_LIMIT });
      if ((res.issues || []).length >= LINKED_LIMIT || res.nextPageToken) truncated = true;
      for (const n of res.issues || []) {
        const f = n.fields || {};
        found.push({ issue: { key: n.key, url: this.issueUrl(n.key) || "", title: f.summary || "", state: f.status ? f.status.name : "" }, text: adfText(f.description) });
      }
    }
    return byMarker(markers, found, truncated);
  }

  /** What the viewer changed since `since` (from each issue's changelog and comments) and their open assigned issues. */
  async activity(since: string): Promise<TrackerActivity> {
    const cred = this._auth();
    if (!cred || !this.site) throw new Error("Jira isn't connected.");
    const me = await this._get(cred, "/rest/api/3/myself");
    const accountId = me && me.accountId;
    const q = activityJql(minutesAgo(since), this.projects);
    const [changed, assigned] = await Promise.all([
      this._get(cred, "/rest/api/3/search/jql", { jql: q.changed, fields: ["summary", "status", "created", "reporter", "comment"], expand: "changelog", maxResults: ACTIVITY_LIMIT }),
      this._get(cred, "/rest/api/3/search/jql", { jql: q.assigned, fields: FIELDS, maxResults: ACTIVITY_LIMIT }),
    ]);
    // Search embeds at most a page of each issue's changelog, oldest first: a long one's newest page is read on its own.
    const cut = (changed.issues || []).filter((n) => n.changelog && n.changelog.total > (n.changelog.histories || []).length).slice(0, MAX_CHANGELOG_LOOKUPS);
    await Promise.all(cut.map(async (n) => {
      const start = Math.max(0, n.changelog.total - 100);
      const page = await this._get(cred, `/rest/api/3/issue/${encodeURIComponent(n.key)}/changelog?startAt=${start}&maxResults=100`).catch(() => null);
      if (page && Array.isArray(page.values)) n.changelog.histories = page.values;
    }));
    const mine = (u: any) => !!u && !!accountId && u.accountId === accountId;
    const changes = new Map<string, IssueChange>();
    for (const n of changed.issues || []) {
      const f = n.fields || {};
      const base = { id: n.key, title: f.summary || "", url: this.issueUrl(n.key) || "", state: f.status ? f.status.name : "" };
      if (mine(f.reporter) && isSince(f.created, since)) noteChange(changes, base, "created", f.created);
      for (const h of (n.changelog && n.changelog.histories) || []) {
        if (!mine(h.author) || !isSince(h.created, since)) continue;
        for (const it of h.items || []) {
          if (it.field === "status") noteChange(changes, base, `moved ${it.fromString || "?"} → ${it.toString || "?"}`, h.created);
          else if (it.field === "assignee" && it.to === accountId) noteChange(changes, base, "took it", h.created);
        }
      }
      for (const c of (f.comment && f.comment.comments) || []) {
        if (mine(c.author) && isSince(c.created, since)) noteChange(changes, base, "commented", c.created);
      }
    }
    const open: AssignedIssue[] = (assigned.issues || []).map((n) => {
      const i = this.toIssue(n);
      return { id: i.id, title: i.title, url: i.url || "", state: i.state, priority: i.priority, priorityLabel: i.priorityLabel, blocked: isBlocked(i.state, i.labels.map((l) => l.name)), updatedAt: i.updatedAt };
    });
    return { changed: changesOf(changes), assigned: open.sort(byPriority) };
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
      // Flagged is a checkbox field: set means one option ("Impediment") is ticked.
      flagged: !!this.flagField && Array.isArray(f[this.flagField]) && f[this.flagField].length > 0,
    };
  }

  async issue(id: string) {
    const cred = this._auth();
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

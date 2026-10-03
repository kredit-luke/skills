/**
 * Issue trackers. The Issues page, Explain/Implement, search and the run
 * ticket strip all go through one IssueTracker, chosen by workspace.json
 * `issues.kind`. Adding a tracker = one file here implementing IssueTracker,
 * registered in ADAPTERS. The dashboard reads the tracker's API directly with the
 * viewer's own key (no Claude usage spent on refreshes); Claude runs that need
 * the tracker (Implement, a morning brief) use its MCP connector instead.
 *
 * Normalized shapes (shared/api.ts): Issue for lists, IssueDetail for one issue.
 * `team` is whatever the tracker groups by (Linear team, Jira project, GitHub
 * repo); `state` is the workflow column the board shows.
 */

import { workspaceConfig, type IssuesConfig } from "../config.ts";
import { GitHubTracker } from "./github.ts";
import { JiraTracker } from "./jira.ts";
import { LinearTracker } from "./linear.ts";

export interface TrackerStatus { connected: boolean; source: "env" | "file" | "cli" | null; viewer: string | null }

/** How the Issues page asks for a key when the tracker isn't connected (null: no key needed). */
export interface ConnectHelp {
  title: string;
  /** Markdown, one list item each. */
  steps: string[];
  placeholder: string;
  /** false: nothing to paste (e.g. the gh CLI's own login); the card shows only the steps. */
  needsKey: boolean;
  /** 'email-token': the key is an email and an API token, asked for in two fields and sent as "email:token". */
  keyFields?: "email-token";
}

/** query: this person's own extra filter in the tracker's language (Jira JQL, GitHub search), if it has one. */
export interface IssueFilter { teams: string[]; states: string[]; query?: string }

/** How the Issues page asks for a personal board query; null = the tracker has no query language. */
export interface QueryHelp { label: string; placeholder: string; help: string }

export interface IssueTracker {
  kind: string;
  /** The last successful issues() result (search indexes it). */
  cache: { issues: any[] } | null;
  status(): TrackerStatus;
  connectHelp(): ConnectHelp | null;
  connect(key: string): Promise<TrackerStatus>;
  disconnect(): TrackerStatus;
  issues(filter: IssueFilter, force?: boolean): Promise<{ connected: boolean; issues: any[]; fetchedAt?: number; error?: string | null }>;
  issue(id: string): Promise<any>;
  /** A browser URL for an issue id (when the API didn't give one). */
  issueUrl(id: string): string | null;
  queryHelp(): QueryHelp | null;
}

/** No tracker configured: the Issues page explains how to set one up. */
class NoTracker implements IssueTracker {
  kind = "none";
  cache = null;
  status(): TrackerStatus { return { connected: false, source: null, viewer: null }; }
  connectHelp() { return null; }
  async connect(): Promise<TrackerStatus> { throw new Error("No issue tracker is configured (workspace.json issues.kind)."); }
  disconnect() { return this.status(); }
  async issues() { return { connected: false, issues: [] }; }
  async issue(id: string): Promise<any> { throw new Error(`No issue tracker is configured, so ${id} can't be looked up.`); }
  issueUrl() { return null; }
  queryHelp() { return null; }
}

type Factory = (cfg: IssuesConfig, ledgerDir: string) => IssueTracker;
const ADAPTERS: Record<string, Factory> = {
  linear: (cfg, ledgerDir) => new LinearTracker(ledgerDir, cfg),
  jira: (cfg, ledgerDir) => new JiraTracker(ledgerDir, cfg),
  github: (cfg) => new GitHubTracker(cfg),
};

export function supportedTrackers() { return Object.keys(ADAPTERS); }

/**
 * The configured tracker. Re-reads workspace.json each call and keeps one
 * instance per kind+settings, so switching trackers applies without a restart.
 */
export class Trackers {
  ledgerDir: string;
  current: { sig: string; tracker: IssueTracker } | null = null;

  constructor(ledgerDir: string) { this.ledgerDir = ledgerDir; }

  get(): IssueTracker {
    const cfg = workspaceConfig().issues;
    const sig = JSON.stringify(cfg);
    if (this.current && this.current.sig === sig) return this.current.tracker;
    const make = ADAPTERS[cfg.kind];
    const tracker = make ? make(cfg, this.ledgerDir) : new NoTracker();
    this.current = { sig, tracker };
    return tracker;
  }

  config(): IssuesConfig & { configured: boolean; supported: boolean } {
    const cfg = workspaceConfig().issues;
    return { ...cfg, configured: cfg.kind !== "none", supported: !!ADAPTERS[cfg.kind] };
  }
}

/**
 * The dashboard's HTTP contract, shared by the server (server/) and the
 * Angular app (web/). Type-only: both sides import it with `import type`,
 * so it never exists at runtime.
 *
 * Conventions
 *  - Everything is JSON under /api. Errors are `{ error: string }` with a 4xx/5xx.
 *  - GETs are open to the page; every POST needs the `X-Dash-Token` header, whose
 *    value comes from GET /api/boot (same-origin only; the server rejects any
 *    Host that isn't localhost/127.0.0.1 on its port).
 *  - Timestamps are ISO strings unless the field name ends in `At` and is typed number (epoch ms).
 */

// ---------------------------------------------------------------- boot

/** GET /api/boot */
export interface Boot {
  token: string;
  platform: 'win32' | 'darwin' | 'linux' | string;
  workspaceRoot: string;
  /** The engine's folder in the workspace, relative to it with forward slashes (engine.json `dir`; "dashboard" in older workspaces). */
  engineDir: string;
  version: string;
  /** When this server process started (a restart changes it). */
  startedAt: string;
  port: number;
  /** Who this workspace is: from .claude/dashboard/workspace.json and brand/. */
  workspace: {
    name: string;
    title: string;
    /** /ds/<file> URLs (the team's brand folder), or null for the built-in mark. */
    logo: string | null;
    logoAlt: string;
    favicon: string | null;
    /** Optional wording overrides by key (page subtitles, search examples, ...). */
    copy: Record<string, any>;
  };
  issues: IssuesBoot;
  /**
   * This person's role and its profile; the role's pages are hidden (reload after changing it).
   * `ask`: the team has roles and this person hasn't picked one (the first-start question).
   */
  profile: { current: 'developer' | 'reader'; role: string; roleLabel: string; ask: boolean; hiddenPages: string[] };
  /**
   * Hosted mode (server/src/hosted.ts): this dashboard runs in a container behind the company's
   * login proxy, so nothing opens on "this computer" (terminals, apps, local previews).
   * `user` is the signed-in email the proxy passed on. null when it runs on the person's own machine.
   */
  hosted: { user: string | null } | null;
}

/** The configured issue tracker, as the UI needs it everywhere (badges, links, ticket ids). */
export interface IssuesBoot {
  /** Adapter: 'linear' | 'jira' | 'github' | 'none' */
  kind: string;
  /** "Linear", "Jira", ... */
  label: string;
  configured: boolean;
  /** Anchored regex source for a ticket id. */
  ticketPattern: string;
  /** Issue URL with an {id} placeholder, or null when the tracker can't build one. */
  urlTemplate: string | null;
}

// ---------------------------------------------------------------- runs

export type RunStatus =
  | 'running'      // a turn is in progress (a claude process is alive)
  | 'waiting'      // Claude asked a question (<<QUESTION>> block); reply to continue
  | 'succeeded'    // last turn ended normally; you can still reply
  | 'failed'       // last turn failed; you can still reply
  | 'cancelled'    // stopped by you; you can still reply
  | 'interrupted'  // the dashboard restarted mid-turn; you can still reply
  | 'handedOff';   // continued in a terminal; the dashboard no longer drives it

export type PermissionMode = 'auto' | 'acceptEdits' | 'dontAsk' | 'plan';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'none';

/** The agent CLIs a run can use (server/src/agents/). */
export type AgentId = 'claude' | 'copilot' | 'codex';
export interface AgentModelInfo { id: string; label: string; efforts: string[] | null }
/** GET /api/agents[?force=1] → { agents: AgentInfo[] }: each CLI, whether it can run here, and its models. */
export interface AgentInfo {
  id: AgentId; label: string; installed: boolean; signedIn: boolean; version: string | null;
  /** Why it can't run (not installed / not signed in), or null. */
  problem: string | null;
  models: AgentModelInfo[]; efforts: string[]; defaultModel: string | null; defaultEffort: string | null;
  capabilities: { planMode: boolean; costUsd: boolean; backgroundTasks: boolean; transcripts: boolean };
}

export interface QuestionOption { label: string; description?: string }
export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export interface RunMeta {
  id: string;
  sessionId: string;
  presetId: string | null;
  label: string;
  /** The first prompt. Later turns' prompts are `human` events in the transcript. */
  prompt: string;
  cwd: string;
  workspace: string;
  model: string | null;
  effort: Effort | null;
  /** Mode used for turns while plan mode is off. */
  permissionMode: PermissionMode;
  /** When true, each turn runs with --permission-mode plan (read-only). Switchable between turns. */
  planMode: boolean;
  budgetUsd: number | null;
  trigger: string;             // "manual" | "routine:<id>" | "issues" | "ask" | ...
  /** docs.json sources the run was told to use ("Use <source>"). */
  docSources?: string[];
  /** Appended to the system prompt every turn (the docs sources' notes). */
  extraPrompt?: string | null;
  /** Folders outside the workspace the run may read (a knowledge store's local copy). */
  addDirs?: string[];
  /** The agent CLI that runs it ('claude' when missing: runs from before agents). */
  agent?: AgentId;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;      // end of the latest turn
  /** Number of turns started (1 = only the first prompt). */
  turns: number;
  turnStartedAt: string | null;
  costUsd: number;             // API-equivalent, summed over turns; not money on a subscription
  numTurns: number;            // model round-trips reported by the CLI, summed
  durationMs: number | null;   // summed over turns
  toolCalls: number;
  lastActivity: string | null;
  resultText: string | null;   // final main-session text of the latest turn, question block removed
  error: string | null;
  verdict: 'good' | 'needed-fix' | null;
  /** You marked it "needs me": kept in Focus until you clear it or set a verdict. */
  flagged: boolean;
  /** Set while status === 'waiting'. */
  question: Question[] | null;
  /** Background work that was cut off when the turn ended (§8). Cleared on the next turn. */
  warning: string | null;
  effectivePermissionMode?: string | null;
  resolvedModel?: string | null;
  continuedAt?: string | null; // first activity seen in a terminal after the headless part
  handedOffAt?: string | null;
  /** Files sent with the first prompt. A reply's files are on its `human` event. */
  attachments?: Attachment[];
  /** When the run's files were deleted (keepAttachmentsDays after it was done). */
  attachmentsRemovedAt?: string | null;
  /** Pull requests the dashboard watches for this run (a <<WATCH>> block); null when there never was one. */
  watch?: RunWatch | null;
  /**
   * Messages typed while Claude was working. When a turn ends as succeeded or failed they
   * go together as the next turn (also when it ends with a question, if queueAutoSend is
   * on); otherwise, and after a cancel or restart, they stay here until sent (Send now)
   * or removed.
   */
  queued?: QueuedMessage[];
  /** Why the queue didn't go out on its own (a run limit, Claude signed out); null once it's sent. It's retried every 30 s. */
  queueBlocked?: string | null;
  /** Auto-send: the queue also goes out when Claude ends a turn with a question, as the answer (for when you've walked away). */
  queueAutoSend?: boolean;
}

/** A message queued on a run (RunMeta.queued). Editable and removable until it's sent. */
export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
}

/** One watched pull request and what the last check saw. */
export interface WatchedPr {
  repo: string;                // owner/name
  number: number;
  /** null until the first check (that check only records, it never wakes). */
  seen: PrSnapshot | null;
}

/** What a check reads from GitHub. Activity is only what other people did. */
export interface PrSnapshot {
  state: string;               // OPEN | MERGED | CLOSED
  reviewDecision: string;      // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
  mergeStateStatus: string;    // CLEAN | BEHIND | DIRTY | BLOCKED | UNSTABLE | UNKNOWN | ...
  checks: 'passing' | 'failing' | 'pending' | 'none';
  /** Newest review by someone else: submittedAt, or '' for none. */
  lastReviewAt: string;
  lastReviewBy: string;
  lastReviewState: string;
  /** Highest inline review comment id by someone else, 0 for none. */
  lastCommentId: number;
  /** Newest top-level comment by someone else: createdAt, or ''. */
  lastIssueCommentAt: string;
}

/**
 * A run's PR watch. Claude starts one by ending a turn with a <<WATCH>> block; the
 * server checks the PRs every `everyMinutes` while the run is idle and done
 * (status 'succeeded'), and replies to the run when something changed.
 * Active while `endedAt` is null.
 */
export interface RunWatch {
  kind: 'github-pr';
  prs: WatchedPr[];
  everyMinutes: number;
  /** Sent after the list of changes when the watch wakes the run. */
  prompt: string;
  startedAt: string;
  expiresAt: string;
  nextCheckAt: string;
  lastCheckAt: string | null;
  lastChangeAt: string | null;
  /** The changes the last wake-up reported, one line. */
  lastChange: string | null;
  wakes: number;
  /** The last check's failure (gh missing, not signed in, ...); cleared by a good check. */
  error: string | null;
  endedAt: string | null;
  endReason: string | null;
}

/**
 * A file sent with a prompt or reply. Served at GET /api/runs/:id/files/:file.
 * `path` is where Claude read it from.
 */
export interface Attachment { id: string; name: string; file: string; size: number; kind: 'image' | 'pdf' | 'text' | 'file'; path: string }
/**
 * POST /api/attachments?name=<file name>  body: the raw file bytes (up to 20 MB) → 201 StagedAttachment.
 * Held until a launch or reply names its id in `attachments`; dropped after a day otherwise.
 */
export interface StagedAttachment { id: string; name: string; size: number; kind: Attachment['kind'] }

export interface PresetStats { runs: number; succeeded: number; rated: number; good: number; costUsd: number; durationMs: number; lastRunAt: string | null }

/** GET /api/runs?limit=N */
export interface RunsResponse { runs: RunMeta[]; stats: Record<string, PresetStats> }

/**
 * GET /api/runs/:id → { run, events }
 * `events` are the raw stream-json objects the CLI printed (see RunEvent), plus the
 * dashboard's own `human` (a reply you sent) and `turn` markers, in order.
 */
export interface RunDetail { run: RunMeta; events: RunEvent[] }

/**
 * GET /api/runs/:id/stream  (Server-Sent Events, stays open until the client closes it)
 *   event: event   data: RunEvent       — replays every saved event first, then live ones
 *   event: meta    data: RunMeta        — whenever status/counters change
 *   : ping                              — keepalive comment every 25s
 * Dedupe by `uuid` when present (the replay and a reconnect can overlap).
 */

/**
 * Loosely typed: these are the CLI's stream-json lines. Fields the UI relies on:
 *  - type 'system', subtype 'init': model, permissionMode, cwd, session_id
 *  - type 'assistant' | 'user': message.content blocks; parent_tool_use_id is null for the
 *    main session, else the tool_use id of the Agent call whose subagent produced it
 *  - type 'system', subtype 'task_started' | 'task_progress' | 'task_updated' | 'task_notification':
 *    subagent (task_type 'local_agent') and background bash (task_type 'local_bash') lifecycle;
 *    task_updated carries only task_id (+ patch.status)
 *  - type 'result': result (text), subtype, is_error, duration_ms, num_turns, total_cost_usd.
 *    A turn can emit more than one result (a background agent finishing re-invokes the model);
 *    the last one wins.
 *  - type 'rate_limit_event': rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization
 * Dashboard-added:
 *  - { type: 'human', text, uuid, timestamp, turn }  — a reply sent from the dashboard (turn >= 2)
 *    or typed in a terminal after hand-off (from /continuation; no turn)
 *  - { type: 'turn', turn, uuid, timestamp, planMode }  — marks the start of turn N (N >= 2)
 * The server strips <<QUESTION>>…<</QUESTION>> and <<WATCH>>…<</WATCH>> blocks from main-session text before saving.
 */
export type RunEvent = { type: string; uuid?: string; [k: string]: any };

/** POST /api/runs  body: LaunchRequest → 201 { run } */
export interface LaunchRequest {
  presetId?: string;
  args?: Record<string, string>;
  /** Preset option checkboxes by name; missing ones use the option's default. */
  options?: Record<string, boolean>;
  prompt?: string;             // required without a preset
  workspace?: string;          // slug, default preset's or "main"
  /** The agent CLI to run it with; omitted = the deck's default agent (Claude unless set). */
  agent?: AgentId;
  model?: string;              // alias or full id; omitted/"" = CLI default
  effort?: Effort | '';
  permissionMode?: PermissionMode;
  planMode?: boolean;          // start read-only (Ask/Explain); can be switched off later
  budgetUsd?: number;          // runaway cap, 0 < x <= 100; ignored unless limits.runBudget is on
  trigger?: string;            // "ask" | "explain" | ... (default "manual"); informational only
  /** docs.json external sources (with a provider) this run should use: Claude is told to search them via their MCP connector. */
  docSources?: string[];
  /** With one docSource: the page the question is about. */
  docPage?: string;
  attachments?: string[];      // ids from POST /api/attachments
}

/** POST /api/runs/:id/reply  { text, attachments? } → { run }   409 while a turn is running or after hand-off */
/** model: the rest of the run on another model (Claude runs; e.g. a local model's run on to "opus"); effort with it. */
export interface ReplyRequest { text: string; attachments?: string[]; model?: string; effort?: string }
/** POST /api/runs/:id/rename  { label } → { run }   (any time, even mid-turn) */
export interface RenameRequest { label: string }
/** POST /api/runs/:id/plan-mode  { on } → { run }   409 while a turn is running or after hand-off */
export interface PlanModeRequest { on: boolean }
/** POST /api/runs/:id/cancel → { ok: true }   works on running (kills) and waiting (clears the question) */
/** POST /api/runs/:id/verdict  { verdict: 'good' | 'needed-fix' | null } → { run }   (a verdict clears `flagged`) */
/** POST /api/runs/:id/flag  { flagged: boolean } → { run }   (any time, even mid-turn) */
/** POST /api/runs/:id/watch-stop → { run }   ends the run's PR watch (409 when there's none running) */
/**
 * POST /api/runs/:id/terminal → TerminalResponse
 * Kills a running turn first, marks the run handedOff and opens `claude --resume <sessionId>`
 * in a terminal in the run's folder.
 */
export interface TerminalResponse { opened: boolean; command: string; run: RunMeta }
/**
 * GET /api/runs/:id/changes[?force=1] → RunChanges: what the run changed, per repo.
 * baseKind 'run-start' = compared with a snapshot taken when the run's first turn started
 * (so edits already there don't show); 'branch' = no snapshot (a worktree the run created,
 * or an older run), compared with where the branch left main.
 * GET /api/runs/:id/diff?repo=<scope.path>&file=<file> → { diff } (unified diff text)
 */
export interface RunChangedFile { file: string; status: string; adds: number | null; dels: number | null }
export interface RunChangeScope {
  repo: string; path: string; branch: string;
  baseKind: 'run-start' | 'branch'; baseLabel: string;
  commits: { hash: string; message: string }[];
  files: RunChangedFile[];
}
export interface RunChanges { scopes: RunChangeScope[]; hasBaseline: boolean; computedAt: string }
/** GET /api/runs/:id/continuation → { events, lastActivityAt }  (what happened in the terminal after hand-off / after the headless turns) */
export interface Continuation { events: RunEvent[]; lastActivityAt: string | null }

// ---------------------------------------------------------------- deck / presets / skills

export interface PresetArg { name: string; label?: string; placeholder?: string }
/** A checkbox in the launch dialog; when ticked, `append` is added to the prompt (e.g. " --auto"). */
export interface PresetOption { name: string; label: string; hint?: string; append: string; default?: boolean }
export interface Preset {
  id: string; label: string; description?: string; icon?: string; prompt: string;
  args?: PresetArg[]; options?: PresetOption[]; model?: string; effort?: Effort; permissionMode?: PermissionMode;
  budgetUsd?: number; workspace?: string;
}
export interface Routine { id: string; preset: string; at: string; days?: string[] | string; enabled: boolean; workspace?: string; args?: Record<string, string> }
export interface RoutineView extends Routine { nextAt: string | null; last: { firedAt: string; ok: boolean; runId?: string; error?: string } | null }
export interface SkillInfo { name: string; description: string; argumentHint: string }
/**
 * runBudget: pass each preset's budgetUsd as a per-run cap (--max-budget-usd); off by default,
 * since on a subscription the cap only stops working runs. keepAttachmentsDays: delete a done
 * run's attached files this long after its last turn (0 = never).
 */
export interface Limits { maxConcurrentRuns: number; pauseAtSessionPct: number; pauseAtWeeklyPct: number; runBudget: boolean; keepAttachmentsDays: number; dailyBudgetUsd: number | null }
/** The settings the Settings page can change. */
export type SettingKey = 'maxConcurrentRuns' | 'pauseAtSessionPct' | 'pauseAtWeeklyPct' | 'runBudget' | 'keepAttachmentsDays' | 'model' | 'effort';
/**
 * GET /api/settings → Settings. `team` is deck.json (what everyone gets), `mine` your overrides
 * (.claude/ledger/settings.json, only the keys you changed), `effective` the two combined.
 * POST /api/settings  { limits?: {key: value | null}, defaults?: {model|effort: value | null} } → Settings
 * (null goes back to the team default).
 */
export interface Settings {
  team: { limits: Limits; defaults: { model: string; effort: Effort } };
  mine: { limits: Partial<Limits>; defaults: Partial<{ model: string; effort: Effort }> };
  effective: { limits: Limits; defaults: { model: string; effort: Effort } };
  options: { models: string[]; efforts: Effort[] };
  attachments: { bytes: number; runs: number };
}
export interface IssuesConfig { teams: string[]; states: string[]; implementPreset: string; implementTeams: string[] }

/** GET /api/deck */
export interface DeckResponse {
  limits: Limits;
  /** Model/effort every run starts with unless the dialog (or a preset) sets its own. */
  defaults: { model: string; effort: Effort };
  presets: Preset[];
  routines: Routine[];
  issues: IssuesConfig;
  error?: string;
  stats: Record<string, PresetStats>;
  skills: SkillInfo[];
  workspaces: { slug: string; name: string; ticketId?: string | null }[];
  options: { models: string[]; efforts: Effort[]; permissionModes: PermissionMode[] };
}

/** GET /api/commands → { commands }  (every slash command the CLI knows; for autocomplete) */
export interface CommandInfo { name: string; description: string; argumentHint: string; aliases: string[]; source: 'skill' | 'plugin' | 'built-in' | 'mcp' }

// ---------------------------------------------------------------- overview / usage / inbox

export interface UsageMeter { kind: 'session' | 'week' | string; label: string; pct: number; resets: string | null }
export interface UsageReport { plan?: string; meters: UsageMeter[]; insights: { title: string; items: string[] }[]; fetchedAt?: string; error?: string }

export interface SessionInfo { sessionId: string; name?: string; kind: string; status: string; cwd: string; startedAt: string; runId: string | null }

/** GET /api/overview */
export interface Overview {
  stats: { runsToday: number; running: number; waiting: number; maxConcurrentRuns: number; pauseAtSessionPct: number; pauseAtWeeklyPct: number; weekRuns: number; weekSucceeded: number };
  usage: UsageReport | null;
  sessions: SessionInfo[];
  routines: RoutineView[];
  desktopTasks: { name: string; description: string }[];
  timestamp: string;
}

/** GET /api/usage[?force=1] → UsageReport */

export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }
/**
 * GET /api/usage/history?days=30[&force=1]
 * tokens: from this machine's Claude Code transcripts (all sessions, not just dashboard runs),
 *   local dates, oldest first; family is opus | sonnet | haiku | fable | other (for colours).
 * limits: /usage readings over time (recorded when a meter moves, at most every 30 min otherwise).
 * runs: dashboard runs per day.
 */
export interface UsageHistoryResponse {
  tokens: {
    generatedAt: string; scannedAt: string | null; firstScanMs: number | null; files: number;
    days: { date: string; byModel: Record<string, TokenCounts>; sessions: number }[];
    models: (TokenCounts & { model: string; family: string })[];
    projects: (TokenCounts & { project: string; models: Record<string, number> })[];
    hours: number[];
    totals: TokenCounts;
  };
  limits: { at: string; meters: { kind: string; label: string; pct: number }[] }[];
  runs: { date: string; byStatus: Record<string, number>; byTrigger: Record<string, number>; turns: number }[];
}

/** kind: 'review-requested' | 'my-pr' | 'pr-failing' | 'pr-ready' | 'main-ci-failing' | 'run-failed' | 'run-waiting' | 'run-warning' */
export interface InboxItem { kind: string; severity: 'alert' | 'action' | 'info'; title: string; detail: string; url?: string; runId?: string; at?: string }
/** GET /api/inbox[?force=1] */
export interface Inbox { items: InboxItem[]; ciHealth: { repo: string; state: string; url: string; title?: string }[]; errors?: string[] }

// ---------------------------------------------------------------- apps / workspaces

export interface AppStatus {
  key: string; name: string; type: string; group: string;
  port: number | null; url: string | null; running: boolean; repo: string;
  available: boolean; busy: string | null; blockedBy: string[];
  /** In a worktree, a "fallback": "main" app that isn't running here: its dependents use main's instance on this port. */
  fallback?: { port: number; running: boolean } | null;
}
export interface WorkspaceStatus {
  name: string; slug: string; path: string; apps: AppStatus[];
  screenshots: { name: string; mtime: number; size: number }[];
  /** The worktree's ticket (.worktree.json ticketId). */
  _ticketId: string | null;
}
/** GET /api/status */
export interface StatusResponse { workspaces: WorkspaceStatus[]; timestamp: string }

export interface JobStep { label: string; status: 'running' | 'done' | 'failed'; error?: string }
export interface Job { id: string; label: string; apps: string[]; workspace: string; workspaceName: string; status: 'running' | 'succeeded' | 'failed' | 'interrupted'; startedAt: string; endedAt: string | null; steps: JobStep[]; notes: string[]; error: string | null }
export interface Stack { label: string; description: string; hint?: string; apps: string[]; mainOnly?: boolean }
/** GET /api/apps/jobs  (apps and stacks from .claude/dashboard/apps.json) */
export interface JobsResponse {
  jobs: Job[]; stacks: Record<string, Stack>;
  /** App groups in display order. */
  groups: { id: string; label: string }[];
  /** What a workspace's Start stack button starts. */
  defaultStack: string | null;
  hasSetup: boolean;
  configured: boolean;
  error: string | null;
}
/** GET /api/apps/log?job=ID  or  ?workspace=slug&app=key → { files } */
export interface LogFiles { files: { file: string; text: string }[] }
/**
 * POST /api/apps/action → 202 { job }
 * { action: 'start'|'stop'|'restart'|'stop-all'|'setup', workspace: slug, app?: key, stack?: id }
 */
export interface AppActionRequest { action: 'start' | 'stop' | 'restart' | 'stop-all' | 'setup'; workspace: string; app?: string; stack?: string }

/** GET /api/git?workspace=slug */
export interface GitInfo {
  repos: Record<string, { branch: string; ahead: number; behind: number; mainRef: string | null; changedFiles: { file: string; status: string; source?: string }[]; recentCommits: { hash: string; message: string }[] }>;
  ticketId?: string | null;
  _paths?: Record<string, string>;
}
/** GET /api/diff?workspace=slug&repo=dir&file=path → { diff } */

/** Screenshots: GET /screenshots/<slug>/<file> (image) */

// ---------------------------------------------------------------- docs sites

/**
 * A knowledge source from .claude/dashboard/docs.json. 'site' and 'notes' live in the workspace
 * (repo = their folder); 'store' is business notes in the team's bucket (a local copy, edited
 * from the page); 'external' is elsewhere (Confluence, Notion, ...): url opens it.
 */
export interface DocSite {
  key: string; name: string; repo: string | null; kind: 'site' | 'notes' | 'external' | 'store'; type: string;
  live: string | null; url: string | null; provider: string | null; description: string | null;
  available: boolean; previewUrl: string | null; docs: number;
  /** "Use <source>" can be ticked for a run: an external source with an adapter, or a store with a copy. */
  searchable?: boolean;
  /** docs.json area key, and the MCP server Claude reaches it through (as the Connections page names it). */
  area?: string | null;
  connection?: string | null;
  /** Every connector name that reaches it (any one is enough); `connection` is the first. */
  connectionAny?: string[];
  /** The Knowledge setup wrote it (a catalog tool id, or "other"). */
  tool?: string | null;
  /** Notes past their area's review interval. */
  stale?: number;
  store?: KnowledgeStoreStatus | null;
}
/** docs.json `areas`: parts of the business, each with an owner and how often its notes are reviewed (days). */
export interface KnowledgeArea { key: string; label: string; owner: string | null; reviewEvery: number | null; description: string | null }
/** GET /api/docs → { sites, areas } ;  POST /api/docs/preview { site } → { url } */
export interface DocsResponse { sites: DocSite[]; areas: KnowledgeArea[] }

/** A store's connection and sync. POST /api/knowledge/{connect {source,key}, disconnect, sync, claude-access {source,on}} → this. */
export interface KnowledgeStoreStatus {
  source: string; label: string; connected: boolean; problem: string | null;
  /** Where the key comes from: 'env' (the deployment's) can't be disconnected here. */
  keySource: 'env' | 'file' | null;
  help: { title: string; steps: string[]; placeholder: string; needsKey: boolean } | null;
  syncedAt: string | null; syncing: boolean; error: string | null; files: number;
  /** The local copy (under the ledger). */
  dir: string;
  /** This person's Claude sessions in the workspace can read the copy (additionalDirectories). */
  claudeAccess: boolean;
}
/** A tool teams keep knowledge in, and how Claude reaches it. GET /api/knowledge/setup → KnowledgeSetup. */
export interface KnowledgeTool {
  id: string; label: string; description: string; urlLabel: string; urlPlaceholder: string; urlRequired: boolean; urlPattern: string | null;
  connections: string[]; provider: string | null; connectHelp: string;
}
export interface KnowledgeChosenTool { tool: string; key: string; name: string; url: string | null; area: string | null; connection: string[] }
/**
 * POST /api/knowledge/setup { tools: [{ tool, url?, name?, area?, connection? }] } → KnowledgeSetup (rewrites the tools in docs.json + connections.json).
 * POST /api/knowledge/store-source { name, area?, store: { type, bucket | account+container, region?, prefix?, endpoint? } } → KnowledgeSetup.
 * Both refused when hosted (the config is the workspace repo's).
 */
export interface KnowledgeSetup { catalog: KnowledgeTool[]; chosen: KnowledgeChosenTool[]; stores: string[]; canEdit: boolean }

/** A note of a Markdown source (repo folder or store), with its links and freshness. */
export interface KnowledgeNote {
  rel: string; title: string; owner: string | null; reviewed: string | null; tags: string[]; updatedAt: string | null;
  links: string[]; unresolved: string[]; backlinks: string[]; summary: string;
  since: string | null; dueAt: string | null; stale: boolean;
}
/** GET /api/knowledge/notes?source= */
export interface KnowledgeNotesResponse { source: string; notes: KnowledgeNote[]; tags: Record<string, number>; store: KnowledgeStoreStatus | null }
/**
 * GET /api/knowledge/note?source=&rel= → this. Stores only: POST /api/knowledge/save { source, rel, text, etag (null: new) } → { rel, etag },
 * /delete { source, rel, etag }, /rename { source, from, to, etag } → { rel, etag }. Any notes source: /reviewed { source, rel }.
 * A save that would overwrite someone else's newer change answers 409.
 */
export interface KnowledgeNoteText { rel: string; text: string; etag: string | null; editable: boolean; file: string }

/**
 * External docs with a provider adapter (Confluence, …), read with each person's own key.
 *   GET  /api/docs/external?site=<key>                      → ExternalDocsStatus
 *   GET  /api/docs/external/search?site=&q=&spaces=a,b      → { hits: ExternalDocHit[] }
 *   GET  /api/docs/external/page?site=&id=                  → ExternalDocPage
 *   GET  /api/docs/external/search-all?q=                   → { groups: { site, name, hits }[] }   (connected sources only)
 *   POST /api/docs/external/connect { site, key }           → ExternalDocsStatus
 *   POST /api/docs/external/disconnect { site }             → ExternalDocsStatus
 */
export interface ExternalDocsStatus {
  site: string; name: string; provider: string; label: string; url: string | null;
  connected: boolean; source: 'env' | 'file' | 'tracker' | null; viewer: string | null;
  /** The key in use is a saved file Disconnect can delete. */
  removable?: boolean;
  help: { title: string; steps: string[]; placeholder: string; needsKey: boolean; keyFields?: 'email-token' } | null;
  spaces: { key: string; name: string; url: string }[];
  error: string | null;
}
export interface ExternalDocHit {
  id: string; title: string; url: string; space: string; spaceName: string;
  excerpt: { text: string; hl: boolean }[]; updatedAt?: string | null;
}
export interface ExternalDocPage {
  id: string; title: string; url: string; space: string; spaceName: string; html: string;
  updatedAt?: string | null; updatedBy?: string | null; labels: string[]; ancestors: { id: string; title: string }[];
}

/** One page of a docs site. Read it with GET /api/search/doc?id= (content is markdown). */
export interface DocPage { id: string; title: string; rel: string; pagePath: string; format: 'md' | 'html'; live: string | null; sections: string[] }
/** GET /api/docs/pages?site=key */
export interface DocPagesResponse { site: DocSite; pages: DocPage[] }

// ---------------------------------------------------------------- company pages

/** `repo`: the site's source folder in the workspace (only when cloned); the tile offers Make edits. */
/**
 * `repo` is the tile's cloned workspace folder (null when it isn't cloned). `readme` is that
 * repo's root README file name if it has one (the Info button); `editable` adds Make edits.
 */
export interface LinkTile {
  title: string; description: string; icon: string; url: string | null; links: { label: string; url: string }[];
  repo: string | null; editable: boolean; readme: string | null;
  /** team: .claude/dashboard/links.json (committed); personal: .claude/ledger/links.local.json (this machine). */
  scope: LinkScope;
  /** Where it's stored, for edit/delete. */
  ref: LinkRef;
  /** As written in the file (repo even when it isn't cloned here). */
  raw: { repo: string | null; edit: boolean };
}
export type LinkScope = 'team' | 'personal';
export interface LinkRef { scope: LinkScope; category: string; index: number }
/** GET /api/links  (team + personal merged; urls are http(s) or dashboard paths like /docs/roadmap) */
export interface LinksResponse { categories: { title: string; description: string; tiles: LinkTile[] }[]; error?: string; files: Record<LinkScope, string> }
/** What the Links edit form saves. */
export interface LinkTileInput { title: string; description?: string; icon?: string; url?: string; links?: { label: string; url: string }[]; repo?: string; edit?: boolean }
/**
 * POST /api/links/save { scope, category, categoryDescription?, tile, original?: { ref, title } } → LinksResponse
 *   (original = the tile being edited; it may move to another category or scope)
 * POST /api/links/delete { ref, title } → LinksResponse
 */
export interface LinkSaveRequest { scope: LinkScope; category: string; categoryDescription?: string; tile: LinkTileInput; original?: { ref: LinkRef; title: string } }
/** GET /api/readme?repo=<folder>  (404 when the repo isn't cloned or has no README) */
export interface RepoReadme { repo: string; file: string; path: string; markdown: string; updatedAt: string }

export interface FactGroup { title: string; section: string; rows: { label: string; value: string; note?: string }[] }
/**
 * GET /api/infrastructure: the doc infrastructure.json names, live. `groups` are quick
 * facts extracted from it by infrastructure.json groups (hosts, IPs, ids, ...); `section` is the
 * slug of the doc heading they come from (same slug renderMd gives headings).
 */
export interface InfrastructureResponse {
  available: boolean;
  /** infrastructure.json (or the older reference.json) names a doc. */
  configured: boolean;
  error: string | null;
  title: string | null;
  rel: string | null; file: string | null; markdown: string; updatedAt: string | null; lastUpdated: string | null; groups: FactGroup[];
}

// ---------------------------------------------------------------- search

export type SearchSource = 'skill' | 'memory' | 'guide' | 'doc' | 'issue' | 'agent' | 'run';
export interface SearchResult {
  id: string; source: SearchSource; sourceLabel: string;
  title: string; subtitle: string; section: string; anchor: string;
  rel: string; url: string | null; format: 'md' | 'html' | 'none';
  updatedAt: string | null; ref: string | null; snippet: string; score: number;
  extra: Record<string, any>; // skill, argumentHint | memoryFile, type, issues | site, siteName, kind, pagePath, live | ticket, team, state, labels | runId, status | repo
}
/** GET /api/search?q=&source=&site=&limit= */
export interface SearchResponse { query: string; terms: string[]; results: SearchResult[]; counts: Partial<Record<SearchSource, number>>; total: number; builtAt: number; took: number }
/** GET /api/search/doc?id= */
export interface SearchDoc { id: string; source: SearchSource; sourceLabel: string; title: string; subtitle?: string; rel: string; file?: string; format: string; content: string; extra?: Record<string, any>; updatedAt?: string }
/** GET /api/search/stats */
export interface SearchStats { docs: number; chunks: number; bySource: Partial<Record<SearchSource, number>>; builtAt: number; buildMs: number; sources: Record<SearchSource, { label: string; order: number }> }

// ---------------------------------------------------------------- memory

export interface MemoryItem { file: string; name: string; description: string; type: string; body: string; updatedAt: string; bytes: number; indexed: boolean; issues: string[] }
/** GET /api/memory ;  POST /api/memory/delete { file } → { ok, file } */
export interface MemoryList { dir: string; exists: boolean; memories: MemoryItem[]; orphanIndexLines: string[] }

// ---------------------------------------------------------------- connections (MCP servers)

/** Where an MCP server is configured: a claude.ai connector, a plugin, ~/.claude.json (user: every folder; local: this workspace only) or the workspace's .mcp.json (project). */
export type McpScope = 'claude.ai' | 'plugin' | 'user' | 'local' | 'project' | 'unknown';
/** From `claude mcp list`: null = not checked yet. */
export type McpState = 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'pending' | 'not-configured' | 'unknown';
/** A server definition as `claude mcp add-json` takes it. Secrets live in headers/env values. */
export interface McpServerConfig { type: 'http' | 'sse' | 'stdio'; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }
export interface ConnectionRequired {
  why: string;
  /** How to add it (connections.json), with `${VAR}` placeholders asked for in the Add dialog. */
  add: McpServerConfig | null;
  /** The ${VAR} names in `add`. */
  vars: string[];
  /** Other names that meet it (the same tool reached another way); the first connected one carries the requirement. */
  alternatives: string[];
}
export interface Connection {
  name: string;
  scope: McpScope;
  transport: string | null;
  /** URL or command line, with secret-looking arguments masked. */
  target: string | null;
  /** Names only: values are never sent to the browser. */
  envKeys: string[];
  headerKeys: string[];
  state: McpState | null;
  /** The CLI's status text, e.g. "Failed to connect — …". */
  status: string | null;
  /** Project (.mcp.json) servers: approved for this person, rejected, or not decided yet. */
  approval: 'approved' | 'rejected' | 'pending' | null;
  /** Its tool prefix (mcp__<id>) is in permissions.allow, so dashboard runs can use it without asking. */
  allowed: boolean;
  /** The allow rule for its tools, e.g. "mcp__claude_ai_Linear". */
  rule: string;
  /** Listed in connections.json `required`. */
  required: ConnectionRequired | null;
  /** In connections.json but not configured anywhere for this person. */
  missing: boolean;
  /** What the page can do: login, logout, remove, approve, allow. */
  actions: Array<'login' | 'logout' | 'remove' | 'approve' | 'allow'>;
  /** A sentence on what to do when there's no button for it. */
  hint: string | null;
}
/**
 * GET /api/connections[?wait=1][&force=1]: config right away; `wait` waits for the health check (`claude mcp list`, slow).
 * POST /api/connections/{logout,remove,approve,allow,add} { name, ... } → ConnectionsResponse.
 * POST /api/connections/login { name, action: 'start' } → McpLoginStart; { action: 'status' | 'finish', url? } → McpLoginStatus; { action: 'cancel' }.
 */
export interface ConnectionsResponse {
  connections: Connection[];
  /** Health check: when the last one finished (null = never), and whether one is running. */
  checkedAt: number | null;
  checking: boolean;
  /** `claude mcp list` failed. */
  checkError: string | null;
  /** connections.json is broken. */
  configError: string | null;
  configured: boolean;
  /** How many need attention (required and missing, or required/allowed and not connected). */
  problems: number;
}
/** Signing in from the page: open `url`; `callback` (loopback) is where the browser ends up, pasted back when hosted. Null: it finishes on claude.ai. */
export interface McpLoginStart {
  url: string; callback: string | null;
  /** Windows: no pseudo-terminal, so sign-in opened a terminal window instead (opened: false = run `command` yourself). */
  terminal?: { opened: boolean; command: string };
}
export interface McpLoginStatus { pending: boolean; done: boolean; ok: boolean; message: string }
/** POST /api/connections/add */
export interface ConnectionAddRequest { name: string; scope: 'local' | 'user'; config: McpServerConfig; allow?: boolean }

// ---------------------------------------------------------------- issues (tracker adapters)

export interface IssueLabel { name: string; color: string }
export interface Issue {
  id: string; title: string; url: string; team: string; state: string; stateColor?: string;
  priority: number; priorityLabel: string; assignee: string | null; project: string | null;
  labels: IssueLabel[]; updatedAt: string; branchName?: string | null;
  canImplement: boolean; hasWorktree: boolean;
  lastRun: { id: string; status: RunStatus; startedAt: string } | null;
}
/** How to connect the tracker when it needs a personal key (steps are markdown). */
export interface ConnectHelp { title: string; steps: string[]; placeholder: string; needsKey: boolean; method?: 'key' | 'oauth'; keyFields?: 'email-token' }
/** GET /api/issues[?force=1]  (/api/linear/issues still works) */
export interface IssuesResponse {
  connected: boolean; issues: Issue[]; states: string[]; teams: string[]; viewer: string | null; fetchedAt?: number; error?: string;
  /** Where the tracker's key comes from: 'env' can't be disconnected from the dashboard. */
  keySource?: 'env' | 'file' | 'cli' | null;
  tracker: { kind: string; label: string; configured: boolean; supported: boolean };
  /** Set when not connected and the tracker takes a key. */
  connect: ConnectHelp | null;
  /**
   * Your own board filter in the tracker's query language (Jira JQL, GitHub search), and how to
   * write it; null when the tracker has none (Linear). Saved with POST /api/settings { issues: { query } }.
   */
  query?: { value: string; label: string; placeholder: string; help: string } | null;
}
/** GET /api/issues/issue?id=ENG-123 → IssueDetail (description is markdown) */
export interface IssueDetail { id: string; title: string; url: string; team: string; state: string; priorityLabel: string; assignee: string | null; project: string | null; cycle: string | null; labels: IssueLabel[]; description: string; branchName: string | null; updatedAt: string }
/**
 * POST /api/issues/connect { key } → { connected, viewer }
 * POST /api/issues/disconnect → { connected: false }
 * POST /api/issues/implement { ticket, mode?: 'terminal', auto?: boolean } → { run } | { opened, command }
 *   (headless by default: its questions come back as a waiting run unless auto is true)
 * POST /api/issues/explain { ticket } → 201 { run }  (plan-mode run with the issue embedded)
 * (The /api/linear/* names of these still work.)
 */

// ---------------------------------------------------------------- machine

export interface MachineCheck {
  /** id: machine.json's id, else its `use` ("claude"); kind: what's checked ("claude-code"), whatever the id. */
  id: string; kind: string; group: string; label: string; status: 'ok' | 'warn' | 'missing' | 'info';
  version?: string; required?: string; detail?: string; fix?: string; apps: string[];
  install?: { label: string; cmd: string; cwd?: string } | null; action?: 'setup';
}
/** GET /api/machine[?force=1] ;  POST /api/machine/install { id } → { opened, command } */
export interface MachineGpu { name: string; vramGb: number | null; unified?: boolean; vendor?: 'nvidia' | 'apple'; driver?: string }
export interface MachineDisk { path: string; freeGb: number; totalGb: number }
export interface MachineReport {
  host: string; os: string; osVersion: string; arch: string; cpus: number; memoryGb: number;
  /** Older servers don't send these. */
  freeMemoryGb?: number; gpus?: MachineGpu[]; disk?: MachineDisk | null;
  checks: MachineCheck[]; problems: number; warnings: number; checkedAt: number;
  blocked: Record<string, string[]>;
  /** machine.json exists (otherwise there are no checks to show). */
  configured: boolean;
  error: string | null;
}

// ---------------------------------------------------------------- models

export type ModelFit = 'gpu' | 'partial' | 'cpu' | 'too-big' | 'no-disk';
export interface ModelPull { tag: string; status: string; completed: number; total: number; error: string | null; startedAt: number; done: boolean }
export interface RecommendedModel {
  tag: string; label: string; params: string; diskGb: number; context: number; tools: boolean; goodFor: string; notes?: string;
  installed: boolean; fit: ModelFit; fitLabel: string;
}
export interface InstalledModel {
  name: string; label: string; sizeGb: number; params: string | null; quantization: string | null;
  /** null: not known yet (Ollama hasn't said). */
  tools: boolean | null; capabilities: string[]; contextMax: number | null;
  /** The window runs give it (the configured one, or its own maximum if smaller). */
  context: number;
  /** Has its twin with that window, so runs can use it. */
  ready: boolean;
  /** Why runs can't use it (no tool calling, too small a window, not prepared), or null. */
  problem: string | null;
  /** "Prepare for runs" would fix it. */
  preparable: boolean;
  routeId: string; recommended: boolean; fit: ModelFit; fitLabel: string;
}
export interface ModelEndpoint {
  id: string; label: string; baseUrl: string;
  /** Where its token comes from: its env var, the one saved on the Models page, models.json itself, or none. */
  tokenSource: 'env' | 'saved' | 'config' | null; tokenVar: string | null; needsToken: boolean;
  /** No `models` in models.json: the list is whatever the endpoint's /v1/models said. */
  discovered: boolean;
  models: { id: string; label: string; tools: boolean | null; context: number | null; routeId: string }[];
  test: { ok: boolean; ms: number | null; error: string | null; models: string[]; at: number } | null;
}
/**
 * GET /api/models[?force=1] (and the live `models` topic) → ModelsView
 * POST /api/models/pull { name } → 202 { pull } ;  /cancel { name } ;  /delete { name } ;  /prepare { name }
 * POST /api/models/test { id } → ModelEndpoint['test'] ;  /token { id, token } (empty clears it)
 * POST /api/models/install-ollama { update?: boolean } → { opened, command } ;  /start → { running }
 * Run models: "local/<ollama tag>" and "team/<endpoint>/<model>" (Claude Code pointed at that server).
 */
export interface ModelsView {
  hosted: boolean;
  hardware: { memoryGb: number; freeMemoryGb: number; gpus: MachineGpu[]; disk: MachineDisk | null };
  /** The GPU can't be used (e.g. an NVIDIA driver older than Ollama needs), and what to do; null when fine. */
  gpuWarning: string | null;
  modelsDir: MachineDisk | null;
  contextLength: number;
  /** messagesApi: it serves Anthropic's Messages API, which Claude Code needs (older versions don't). */
  /** where: on this OS, in WSL (Windows), somewhere else that answers (a container, another machine), or not found. */
  ollama: { where: 'here' | 'wsl' | 'elsewhere' | null; installed: boolean; running: boolean; messagesApi: boolean; version: string | null; base: string };
  usedGb: number;
  recommended: RecommendedModel[];
  installed: InstalledModel[];
  pulls: ModelPull[];
  /**
   * Smart routing (POST /api/models/routing { explorer: id | null }): Claude's runs' Explore
   * subagent (code searching and reading) runs on this model, through a router on 127.0.0.1.
   */
  routing: { explorer: string | null; active: boolean; choices: { id: string; label: string }[]; stats: { local: number; claude: number; queued: number } | null };
  endpoints: ModelEndpoint[];
  configured: boolean;
  error: string | null;
}

// ---------------------------------------------------------------- repos

/** One repos.json repo (normalized: relativePath / remote, whatever names the file used) and what's on disk. */
export interface RepoInfo {
  name: string; relativePath: string; remote: string | null; layer: string | null;
  defaultBranch: string | null; dependencies: string[];
  /** In published snapshots (repos.json "snapshot": false leaves it out). */
  snapshot: boolean;
  /**
   * cloned: has .git · snapshot: a downloaded read-only copy (.snapshot.json, no .git) ·
   * missing: absent or an empty folder (Clone / Download can fill it) · not-git: has files but neither (left alone).
   */
  state: 'cloned' | 'snapshot' | 'missing' | 'not-git';
  /** For clones: the checked-out branch and how many files have uncommitted changes. */
  branch: string | null; changes: number | null;
}
/**
 * GET /api/repos ;  POST /api/repos/clone { names?: string[] } → 202 { job } (an apps job:
 * GET /api/apps/jobs and /api/apps/log show it). Clones only missing repos with a remote.
 */
export interface ReposResponse {
  /** repos.json exists at the workspace root. */
  configured: boolean;
  repos: RepoInfo[];
  /** repos.json snapshot.source (read-only copies can be downloaded; see GET /api/snapshot), or null. */
  snapshotSource: string | null;
  error: string | null;
}

export interface SnapshotVersion { sha: string; builtAt: string }
export interface SnapshotRepo {
  name: string; relativePath: string; layer: string | null;
  /** In snapshots at all (repos.json "snapshot": false = no). */
  included: boolean;
  state: RepoInfo['state'];
  /** The downloaded copy's stamp (state 'snapshot'), and what's published. */
  local: SnapshotVersion | null;
  latest: (SnapshotVersion & { size: number }) | null;
  /** Download would fetch it: missing or older, and not a clone or someone else's folder. */
  needsDownload: boolean;
}
/**
 * GET /api/snapshot[?force=1] ;  POST /api/snapshot/connect { key } | /disconnect → ConnectionStatus ;
 * POST /api/snapshot/download { names?: string[] } → 202 { job }. The source is repos.json `snapshot`.
 */
export interface SnapshotStatus {
  configured: boolean;
  /** repos.json snapshot.source, and its adapter's label ("Confluence", "Web server"); label null = no adapter. */
  sourceKind: string | null;
  label: string | null;
  connection: { connected: boolean; source: 'env' | 'file' | 'tracker' | null; viewer: string | null } | null;
  /** How to connect, when not connected. */
  connect: ConnectHelp | null;
  /** When the published snapshot was built (null until the manifest is read). */
  builtAt: string | null;
  /**
   * The workspace files themselves (workspace.zip): what's published, the stamp at the
   * workspace root, and the Windows setup script published with it (it also updates).
   */
  workspace: { latest: SnapshotVersion & { size: number }; local: SnapshotVersion | null; installer: string | null } | null;
  repos: SnapshotRepo[];
  /** This source takes uploads and you're connected: the Repos page offers Publish now (developers only). */
  canPublish: boolean;
  error: string | null;
}

/** One repo as a publish would upload it: its origin default branch's latest commit. */
export interface PublishTarget { name: string; relativePath: string; branch: string; sha: string; subject: string; committedAt: string }
/**
 * POST /api/snapshot/plan → PublishPlanResponse (fetches each repo's default branch first) ;
 * POST /api/snapshot/publish { planId } → 202 { job }: uploads exactly that plan. Developer profile only.
 */
export interface PublishPlanResponse {
  planId: string;
  label: string;
  repos: PublishTarget[];
  workspace: PublishTarget | null;
  /** Included in repos.json but not publishable from this machine; the last published copy of each is kept. */
  skipped: { name: string; reason: string }[];
}

/** A workspace.json role; its hidden pages and skills include its profile's (profiles.reader). */
export interface RoleInfo {
  id: string;
  label: string;
  description: string;
  profile: 'developer' | 'reader';
  /** The output style Claude answers this role in; null = Claude's default. */
  outputStyle: string | null;
  hiddenPages: string[];
  hiddenSkills: string[];
}

/** GET /api/profile ;  POST /api/profile { role } → ProfileInfo. Per person (ledger). */
export interface ProfileInfo {
  profile: 'developer' | 'reader';
  /** The role in effect (the one picked, else the first on the profile). */
  role: string;
  /** False until someone chose (or a first snapshot download set the reader profile). */
  chosen: boolean;
  /** They picked one of the team's roles. */
  roleChosen: boolean;
  /** workspace.json has roles (else there are just Developer and Reader). */
  configured: boolean;
  /** False when their own outputStyle in .claude/settings.local.json is kept instead of the role's. */
  styleApplied: boolean;
  roles: RoleInfo[];
}

// ---------------------------------------------------------------- explore

/** A file's line-ending style as found on disk. */
export type ExploreEol = 'lf' | 'crlf' | 'mixed' | 'none';
export interface ExploreEntry { name: string; kind: 'dir' | 'file'; size: number; mtimeMs: number; link?: boolean; heavy?: boolean }
/** GET /api/explore/list?path=<workspace-relative dir> (dirs first) */
export interface ExploreListResponse { path: string; entries: ExploreEntry[] }
/**
 * GET /api/explore/file?path= . content is LF-normalised (null for binary / too large);
 * eol is what's on disk, saveEol what a save writes back (the dominant style).
 * GET /api/explore/raw/<path> serves the bytes (sandboxed) for previews and images.
 */
export interface ExploreFile {
  path: string; abs: string; size: number; mtimeMs: number;
  content: string | null; eol: ExploreEol; saveEol: 'lf' | 'crlf'; bom: boolean;
  binary: boolean; tooLarge: boolean; readOnlyReason: string | null;
}
/** POST /api/explore/save → ExploreSaveResponse; 409 if the file changed since baseMtimeMs (unless force). */
export interface ExploreSaveRequest { path: string; content: string; eol: 'lf' | 'crlf'; bom: boolean; baseMtimeMs: number; force?: boolean }
export interface ExploreSaveResponse { path: string; mtimeMs: number; size: number; eol: 'lf' | 'crlf'; bom: boolean }

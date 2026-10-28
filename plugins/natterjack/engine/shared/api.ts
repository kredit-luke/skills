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
  /** The team's meeting tool (.claude/dashboard/meetings.json); null = no meetings.json, so no Meetings page. */
  meetings: MeetingsBoot | null;
  /**
   * This person's role and its profile; the role's pages are hidden (reload after changing it).
   * `ask`: the team has roles and this person hasn't picked one (the first-start question).
   * `roleLocked`: the role was assigned to them (DASHBOARD_ROLE), so they're never asked.
   */
  profile: { current: 'developer' | 'reader'; role: string; roleLabel: string; ask: boolean; roleLocked: boolean; hiddenPages: string[] };
  /**
   * Hosted mode (server/src/hosted.ts): this dashboard runs in a container behind the company's
   * login proxy, so nothing opens on "this computer" (terminals, apps, local previews).
   * `user` is the signed-in email the proxy passed on. null when it runs on the person's own machine.
   */
  hosted: { user: string | null } | null;
  /**
   * A local dashboard's hosted counterpart (hosting.json `url`, or DASHBOARD_HOSTED_URL): where
   * Send to hosted moves a run. null when hosted, or when none is set.
   */
  hostedUrl?: string | null;
}

/**
 * GET /api/update: is a newer Natterjack release out (asknatterjack.com/version.json)?
 * `enabled` false: the check is off (workspace.json dashboard.updateCheck, NATTERJACK_UPDATE_CHECK,
 * or a hosted dashboard). `latest` null: not checked yet, or offline.
 */
export interface UpdateInfo {
  enabled: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  /** Release notes, when version.json links them. */
  notes: string | null;
  checkedAt: string | null;
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

/** The configured meeting tool, as the nav and the Meetings page need it. */
export interface MeetingsBoot {
  /** Adapter: 'roam' (see server/src/meetings/index.ts). */
  source: string;
  /** "Roam", ... */
  label: string;
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
  /** A meetings run's meeting id: when a turn ends, the tickets it wrote to meeting-tickets.json are recorded against it. */
  meetingId?: string;
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
  /** Where a handedOff run went: a terminal (also when missing: runs from before Send to hosted) or the hosted dashboard. */
  handedOffTo?: 'terminal' | 'hosted' | null;
  /** The run's page on the hosted dashboard, once it moved there. */
  hostedRunUrl?: string | null;
  /** Send to hosted is under way (the hosted tab is importing it): replies wait until it finishes or is cancelled. */
  handoffPendingAt?: string | null;
  /** On the hosted dashboard: the run came from someone's computer (its folder there). */
  movedFrom?: { at: string; cwd: string } | null;
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
  /** On the hosted dashboard: a run mirrored from a linked computer (Remote control), which runs it. */
  remote?: RemoteRunInfo;
}

/**
 * A mirrored run's link (RunMeta.remote). The hosted dashboard only shows the run; replies
 * and other commands wait in `pending` until the computer acks them.
 */
export interface RemoteRunInfo {
  /** The link token's id: the computer. */
  linkId: string;
  /** The link's label ("Work laptop"). */
  label: string;
  /**
   * The computer synced in the last minute (ONLINE_MS in shared/remote.ts). Only on a single run
   * (GET /api/runs/:id, its stream's `meta`, the live `run` event). Not in the runs list
   * (RunsResponse.remote): there a run's online state is its link's, in RunsResponse.remoteLinks
   * and the live `remote-links` topic, so a heartbeat doesn't change the list.
   */
  online?: boolean;
  /** As `online`: only on a single run; in the runs list, read the link's (RemoteLinkLive). */
  lastSeenAt?: string | null;
  /** Remote control is on there; false after it was turned off (commands are refused with 409). */
  enabled: boolean;
  /** Commands not acked yet; `delivered` once they went down the open link. */
  pending: { id: string; kind: RemoteCommandKind; text?: string; at: string; delivered: boolean }[];
  /**
   * The last command the computer refused or failed to run (e.g. "Claude is still working"), or
   * one the pod failed itself. Always a command: a failed sync is an HTTP status to the computer
   * and shows on its own Remote control state, not on a run.
   */
  lastError?: { kind: RemoteCommandKind; message: string; at: string } | null;
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
/**
 * A file the run made for the person, in its outputs folder (DASHBOARD_OUTPUTS). `name` is
 * its path inside that folder, with `/`; served at GET /api/runs/:id/outputs/:name.
 */
export interface RunOutput { name: string; size: number; modifiedAt: string }

export interface PresetStats { runs: number; succeeded: number; rated: number; good: number; costUsd: number; durationMs: number; lastRunAt: string | null }

/** GET /api/runs?limit=N (and the live `runs` topic, with N = 200 and no `remoteLinks`) */
export interface RunsResponse {
  runs: RunMeta[];
  stats: Record<string, PresetStats>;
  /**
   * Hosted dashboards: runs mirrored from a linked computer (RunMeta.remote), apart from
   * `runs` because the router's idle check reads only `runs` (they run on the computer).
   * A run here with the same id as one in `runs` is left out: the pod's own run wins. At most
   * N, latest activity first. Their `remote` has no `online` or `lastSeenAt`: read the run's
   * link (`remote.linkId`) in `remoteLinks` / the `remote-links` topic.
   */
  remote?: RunMeta[];
  /**
   * Hosted dashboards, GET /api/runs only: every linked computer that has connected, with its
   * live state. After the first load the live `remote-links` topic carries the same list.
   */
  remoteLinks?: RemoteLinkLive[];
}

/**
 * A linked computer's live state (hosted): RunsResponse.remoteLinks, and the live `remote-links`
 * topic (data: RemoteLinkLive[], sent when it changes: on a sync, an open or a revoke, and as a
 * link goes offline). A mirrored run is online when its link (`remote.linkId`) is.
 */
export interface RemoteLinkLive {
  linkId: string;
  /** The link's label ("Work laptop"). */
  label: string;
  /** Remote control is on there; false after it was turned off (commands are refused with 409). */
  enabled: boolean;
  /** Synced or opened in the last minute (ONLINE_MS in shared/remote.ts); false once a newer link from the same computer took over. */
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * GET /api/runs/:id → { run, events, outputs }
 * `events` are the raw stream-json objects the CLI printed (see RunEvent), plus the
 * dashboard's own `human` (a reply you sent) and `turn` markers, in order. `outputs`:
 * the files in its outputs folder right now, newest first (at most 200).
 */
export interface RunDetail { run: RunMeta; events: RunEvent[]; outputs?: RunOutput[] }

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
 *  - { type: 'omitted', reason: 'too-large' | 'invalid', bytes, uuid?, timestamp? }  — a mirrored run's (RunMeta.remote)
 *    event too big, or not well-formed enough, to send over the link, in its place so indexes stay in step
 *    (shared/remote.ts OmittedEvent)
 * The server strips <<QUESTION>>…<</QUESTION>> and <<WATCH>>…<</WATCH>> blocks from main-session text before saving.
 */
export type RunEvent = { type: string; uuid?: string; [k: string]: any };

/**
 * What a Remote control command does on the computer (shared/remote.ts RemoteCommand), through the
 * same RunManager rules as the run page there: reply (an answer to a question is a reply too),
 * queue and the queue's own actions, cancel, plan mode.
 */
export type RemoteCommandKind = 'reply' | 'queue' | 'queue-edit' | 'queue-remove' | 'queue-send' | 'queue-auto' | 'cancel' | 'plan-mode';

/** POST /api/runs  body: LaunchRequest → 201 { run } */
export interface LaunchRequest {
  presetId?: string;
  args?: Record<string, string>;
  /** Preset option checkboxes by name; missing ones use the option's default. */
  options?: Record<string, boolean>;
  prompt?: string;             // required without a preset
  /** The run's name in the list; omitted = the prompt's first line (a preset's label with one). */
  label?: string;
  workspace?: string;          // slug, default preset's or "main"
  /** The agent CLI to run it with; omitted = the deck's default agent (Claude unless set). */
  agent?: AgentId;
  model?: string;              // alias or full id; omitted/"" = CLI default
  effort?: Effort | '';
  permissionMode?: PermissionMode;
  planMode?: boolean;          // start read-only (Ask/Explain); can be switched off later
  budgetUsd?: number;          // runaway cap, 0 < x <= 100; ignored unless limits.runBudget is on
  trigger?: string;            // "ask" | "explain" | ... (default "manual"); informational only
  /** A meeting's Ask run: the meeting it's about (kept only with trigger "meetings"), so the tickets it reports are recorded against it. */
  meetingId?: string;
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
 * A mirrored run (RunMeta.remote) on the hosted dashboard: reply, queue, queue-*, cancel and
 * plan-mode → 202 { run } once the command is held for the computer (run.remote.pending), with
 * the same body as on the computer (body → RemoteCommand.payload, shared/remote.ts).
 *   409 when Remote control is off there.
 *   409 when the computer is offline, except `queue`, and `queue-edit` / `queue-remove` on a queue
 *       still pending on the pod and not yet delivered (`delivered === false`; applied there in place).
 *   409 "Already sent to your computer" for `queue-edit` / `queue-remove` on a pending queue that was
 *       delivered but not acked yet, online or offline.
 *   429 "Too many messages waiting for your computer" once the link has PENDING_MAX pending.
 *   400 for a reply or queue with attachments.
 * Every other run POST (rename, verdict, terminal, …) → 409 "Open it on your computer."
 */
/**
 * POST /api/runs/:id/terminal → TerminalResponse
 * Kills a running turn first, marks the run handedOff and opens `claude --resume <sessionId>`
 * in a terminal in the run's folder.
 */
export interface TerminalResponse { opened: boolean; command: string; run: RunMeta }
/**
 * POST /api/runs/:id/send-to-hosted → SendToHostedResponse (local dashboards with Boot.hostedUrl)
 * Packs the run (transcript, ledger files, its worktree's unpushed work) and holds it for the
 * hosted dashboard, which `url` opens: that page fetches it once with the token in the URL
 * (GET /api/handoff/bundle?t=, allowed from the hosted origin only), imports it, and confirms
 * (POST /api/handoff/confirm?t= { url }), which marks the run handedOff to 'hosted'. Until then
 * the run is locked (handoffPendingAt); POST /api/runs/:id/send-cancel unlocks it, as does a
 * send that isn't fetched within 5 minutes or confirmed within 30.
 */
export interface SendToHostedResponse { url: string; warnings: string[]; bytes: number; run: RunMeta }
/**
 * Remote control: a person's own computer linked to their hosted dashboard (server/src/link-tokens.ts).
 * GET /api/remote-links (hosted) → { links: RemoteLink[] }
 * POST /api/remote-links { action: "create", label } → 201 { token, link, links }: the token is shown this once
 *                        { action: "revoke", id } → { links }: also closes its open link and drops its mirrored runs
 * The link itself (link token as Bearer; protocol in shared/remote.ts):
 * GET /api/remote/link[?machine=<id>] → Server-Sent Events: hello, then command / watch / unwatch (409 while another computer's link is online)
 * POST /api/remote/sync SyncRequest → SyncResponse (413 "A sync can be up to 2 MB.")
 * POST /api/remote/ack AckRequest → { ok: true }
 */
export interface RemoteLink {
  id: string; label: string; createdAt: string; lastUsedAt: string | null;
  /** Synced in the last minute. */
  online?: boolean;
  lastSeenAt?: string | null;
  /** Remote control is on there (false once turned off; true before the first sync). */
  enabled?: boolean;
}
export interface LinkCheckStep { name: string; ok: boolean; message: string }
/**
 * GET /api/hosted-link (local) → HostedLinkStatus: this computer's link to its hosted dashboard (server/src/hosted-link.ts).
 * POST /api/hosted-link { action: "certificate", pfx (base64), passphrase } | { action: "token", token }
 *                       | { action: "check" } | { action: "forget" } → HostedLinkStatus
 *                       | { action: "remote-control", on } → HostedLinkStatus: mirror this computer's runs (off by default; forget turns it off)
 */
export interface HostedLinkStatus {
  /** The hosted dashboard's address (hosting.json `url`), or null. */
  url: string | null;
  certificate: { present: boolean; fromEnv: boolean };
  token: { present: boolean; fromEnv: boolean; email: string | null };
  lastCheck: { at: string; ok: boolean; steps: LinkCheckStep[] } | null;
  /**
   * Remote control: `on` is the switch; `state` is the link right now ('refused': the hosted
   * dashboard turned the token down, so it stopped trying). `message` says why for refused/error.
   */
  remoteControl: {
    on: boolean;
    state: 'off' | 'connecting' | 'connected' | 'refused' | 'error';
    message: string | null;
    lastSyncAt: string | null;
  };
  /** POST only: something worth saying about what was just done (a certificate converted from the legacy format). */
  notice?: string | null;
}
/**
 * POST /api/runs/import (hosted dashboards) body: the bundle's raw bytes → 202 ImportRunJob.
 * Recreates the run, its transcript and its worktree here, in the background (it fetches each
 * repo, which can outlast a proxy's response timeout): poll GET /api/runs/import/:id until
 * `state` isn't 'running'. The same bundle posted again gets the same job, unless that failed.
 */
export interface ImportRunJob {
  id: string;
  state: 'running' | 'done' | 'failed';
  run: RunMeta | null;
  warnings: string[];
  /** Why it failed (e.g. the run or its worktree is already here). */
  error: string | null;
}
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
/** A workspace skill, or (with `plugin`) one from an enabled Claude Code plugin, named `<plugin>:<skill>`. */
export interface SkillInfo { name: string; description: string; argumentHint: string; plugin?: string }
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

/** GET /api/commands → { commands }  (every slash command the CLI knows; for autocomplete). `organization`: a claude.ai organization skill. */
export interface CommandInfo { name: string; description: string; argumentHint: string; aliases: string[]; source: 'skill' | 'organization' | 'plugin' | 'built-in' | 'mcp' }

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
export interface InboxItem { kind: string; severity: 'alert' | 'action' | 'info'; title: string; detail: string; url?: string; runId?: string; at?: string; route?: string; query?: Record<string, string> }
/** GET /api/inbox[?force=1] */
export interface Inbox { items: InboxItem[]; ciHealth: { repo: string; state: string; url: string; title?: string }[]; errors?: string[] }

// ---------------------------------------------------------------- reviews

/** An open pull request on the Reviews page. requested: a review is requested from you (or a team of yours); mine: you opened it. */
export interface ReviewPr {
  repo: string; number: number; title: string; url: string;
  author: string | null; authorIsBot: boolean; isDraft: boolean;
  createdAt: string; updatedAt: string; labels: string[]; comments: number;
  requested: boolean; mine: boolean;
  /** Who approved it, by each reviewer's latest review (a dismissed or superseded approval doesn't count). */
  approvedBy: string[];
  /** The last summary made for it (maybe for an older commit); null = none yet. */
  summary: ReviewSummary | null;
}

/** A PR's short summary, made for one head commit. */
export interface ReviewSummary { text: string; sha: string; at: string }

/** GET /api/reviews[?force=1]. orgs: the owners searched; truncated: the search hit its cap. */
export interface ReviewList {
  host: string; viewer: string | null; orgs: string[]; prs: ReviewPr[];
  truncated: boolean; fetchedAt: number; errors: string[];
}

/** GET /api/reviews/pr?repo=&number= */
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface ReviewPrDetail {
  repo: string; number: number; title: string; url: string; body: string;
  author: string | null; isDraft: boolean; createdAt: string; updatedAt: string; labels: string[];
  base: string; head: string; sha: string;
  /** OPEN, MERGED or CLOSED. */
  state: string;
  additions: number; deletions: number; changedFiles: number;
  files: { path: string; additions: number; deletions: number }[];
  checks: 'none' | 'failing' | 'pending' | 'passing';
  failingChecks: string[];
  /** GitHub's reviewDecision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''. */
  decision: string;
  /** The latest review from each reviewer, with how many line comments they left on the PR. */
  reviews: { author: string; state: string; at: string; comments: number }[];
  mergeable: string;
  /** GitHub's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT, HAS_HOOKS or UNKNOWN. */
  mergeState: string;
  /** The merge methods the repository allows, its default first. */
  mergeMethods: MergeMethod[];
  /** The repository deletes a PR's branch when it merges. */
  deletesBranch: boolean;
  /** The summary for this head commit, if one has been made. */
  summary: ReviewSummary | null;
}

/** What a hunk is for, in a guided review: core carries the behaviour; the rest is collapsed by default. */
export type HunkTag = 'core' | 'supporting' | 'test' | 'generated' | 'formatting';

/** One line of a hunk: t is '+', '-' or ' '; old/new are its line numbers on each side. */
export interface DiffLine { t: '+' | '-' | ' '; text: string; old: number | null; new: number | null }
/** id: "h1", "h2"... across the whole PR, in diff order (what a guide points at). */
export interface DiffHunk { id: string; header: string; oldStart: number; newStart: number; lines: DiffLine[] }
export interface DiffFile {
  path: string; oldPath: string | null; status: 'added' | 'deleted' | 'renamed' | 'modified';
  binary: boolean; additions: number; deletions: number; hunks: DiffHunk[];
}
/** GET /api/reviews/diff?repo=&number= (truncated: the diff was too big to show all of). */
export interface ReviewDiff { sha: string; files: DiffFile[]; truncated: boolean }

/** A point a guide makes, with the hunks it's about. */
export interface GuidePoint { title: string; text: string; hunks: string[] }

/**
 * GET /api/reviews/guide?repo=&number= (null: none for this commit yet), POST /api/reviews/guide
 * { repo, number, force? }: chapters in reading order, for one head commit.
 */
export interface ReviewGuide {
  sha: string; at: string;
  /** The tracker ticket the PR names (title or branch), when one was found. */
  ticket: { id: string; title: string; url: string } | null;
  /** What the PR is for: the ticket's ask and the approach taken. */
  intent: string;
  core: GuidePoint[];
  consequences: GuidePoint[];
  supporting: GuidePoint[];
  risk: GuidePoint[];
  /** 3-5 specific things for the reviewer to check. */
  questions: string[];
  /** Hunk id → what it's for. Hunks left out count as supporting. */
  tags: Record<string, HunkTag>;
  /** About how long a careful review takes. */
  minutes: number;
  /** Posted on the PR as a comment (multirepo's review-guide skill), rather than written here. */
  posted?: { by: string; url: string } | null;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export interface SecurityFinding { severity: Severity; title: string; text: string; hunks: string[] }
/** GET/POST /api/reviews/security: an agent's security review of the diff, for one head commit. */
export interface SecurityReview { sha: string; at: string; summary: string; findings: SecurityFinding[] }

/** "Ask agent for review": what a coding agent (Claude Code, Copilot, Codex) found in a PR. */
export type AgentFindingCategory = 'bug' | 'performance' | 'security' | 'nitpick';
export interface AgentFinding {
  id: string;
  category: AgentFindingCategory;
  severity: 'high' | 'medium' | 'low';
  title: string;
  text: string;
  /** Where it is: a file in the PR, and a line of the new file. */
  file: string | null;
  line: number | null;
  /** The line is in the diff, so it can be a line comment on GitHub (otherwise it goes in the review's text). */
  onDiff: boolean;
}
export interface AgentReview { sha: string; at: string; agent: AgentId; agentLabel: string; summary: string; findings: AgentFinding[] }

/** A review the dashboard posts to the PR as the person: a comment, an approval or a request for changes. */
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export interface ReviewSubmit {
  repo: string; number: number; event: ReviewEvent; body: string;
  /** The head commit the person reviewed: a PR that has moved on since is refused. */
  sha: string;
  comments: { path: string; line: number; body: string }[];
}
export interface ReviewSubmitted { url: string | null; state: string; comments: number; movedToBody: number }

// ---------------------------------------------------------------- standup ("My updates")

/** One line on the Standup page. url: where it lives (tracker, code host); runId / meetingId: a run or meeting on this dashboard. */
export interface StandupItem { title: string; detail: string; url?: string | null; runId?: string | null; meetingId?: string | null; at?: string | null }
export type StandupSourceId = 'tracker' | 'code' | 'runs' | 'meetings';
/**
 * What one source says. done: since `since`; next: assigned to you, waiting on you or still going;
 * blockers: what's stuck. error: it couldn't be read, or isn't connected (the other sources still show).
 */
export interface StandupSource { id: StandupSourceId; label: string; done: StandupItem[]; next: StandupItem[]; blockers: StandupItem[]; error: string | null }
/**
 * GET /api/standup?since=<ISO time>[&force=1]: the sources this workspace has, in order; one it
 * doesn't have (no tracker, no code host, no meetings.json) is left out. since: the browser's
 * start of the window (its last workday, in its own time zone), as the server read it.
 */
export interface StandupResponse { since: string; sources: StandupSource[]; fetchedAt: number }
/**
 * A standup draft (Yesterday / Today / Blockers), written by a small model from the page's items and
 * kept per day (the browser's date) and window. Nothing is posted anywhere: it's for copying.
 * GET /api/standup/draft?since=&day= → StandupDraft | null (the saved one)
 * POST /api/standup/draft { since, day, force? } → StandupDraft (the saved one, or a new one)
 */
export interface StandupDraft { text: string; day: string; since: string; at: string }

// ------------------------------------------------------------------ the software factory

/** The factory's pipeline stages, in their default order. */
export type FactoryStageId = 'align' | 'plan' | 'build' | 'review' | 'security' | 'qa' | 'guide' | 'pr' | 'approve' | 'merge';
/** The gates between stages: before building (the spec), after planning, before the PR, before merging. */
export type FactoryGateId = 'spec' | 'plan' | 'prePr' | 'merge';
/** Who decides a gate: a person, the Approver agent, its checks alone, or nobody (no gate). */
export type FactoryGateMode = 'human' | 'approver' | 'auto' | 'off';
export type FactoryPreset = 'supervised' | 'risk-tiered' | 'lights-out' | 'custom';

export interface FactoryStageConfig {
  id: FactoryStageId;
  on: boolean;
  /** The agent that runs it (null: the item's agent). */
  agent: AgentId | null;
  model: string | null;
  effort: string | null;
}

/** A security scanner the security stage runs in each repo, e.g. `npm audit --audit-level=high`. */
export interface FactoryScanner {
  name: string;
  command: string;
  /** Runs only in repos that have this file at their root (e.g. package-lock.json); null: every repo. */
  when: string | null;
  failOn: Severity;
}

/** .claude/dashboard/factory.json with every default filled in (Settings → Factory). */
export interface FactoryConfig {
  enabled: boolean;
  preset: FactoryPreset;
  /** How items run: gates ask a person (interactive) or decide and record (autonomous, `--auto`). */
  mode: 'interactive' | 'autonomous';
  /** Which tickets the factory takes: tracker states and/or labels (empty: only ones sent by hand). */
  /**
   * Which tracker tickets the factory pulls in (by state and/or label; neither: only by hand), and
   * whether the dashboard pulls them in on its own every `everyMinutes`, up to the WIP limit. Each
   * person's dashboard takes the ones assigned to them on the tracker; `unassigned`: unassigned ones
   * too, each claimed (assigned to them) before it starts, so two dashboards never take the same one.
   */
  intake: { states: string[]; labels: string[]; auto: boolean; everyMinutes: number; unassigned: boolean };
  limits: {
    /** Items in flight at once. */
    wip: number;
    itemBudgetUsd: number | null;
    dayBudgetUsd: number | null;
    /** Agent wall-clock per item, in hours. */
    itemHours: number | null;
  };
  stages: FactoryStageConfig[];
  security: {
    /** An agent reads the diff for security problems. */
    agentReview: boolean;
    /** Secret scanning on the diff (gitleaks) when it's installed. */
    secretScan: boolean;
    scanners: FactoryScanner[];
    /** Findings at or above this fail the stage. */
    failOn: Severity;
  };
  gates: Record<FactoryGateId, FactoryGateMode>;
  /** Commands or CI check names that must be green before a gate can pass. */
  requiredChecks: string[];
  reviewers: {
    /** Review bots or check names that count as a review (e.g. "copilot-pull-request-reviewer"). */
    bots: string[];
    /** The pipeline's own reviewer agent counts. */
    pipeline: boolean;
    /** A bot review counts only with no unresolved threads. */
    noUnresolved: boolean;
  };
  /** Spec readiness: how ready a ticket is for an agent to start, scored when a session reads it. */
  spec: {
    /** Scores at or above this are Ready. */
    readyAt: number;
    /** Scores at or above this (and below readyAt) are Needs work; below, Not ready. */
    needsWorkAt: number;
    /** Autonomous runs below this stop and say on the ticket what's missing (null: advice only). */
    minScore: number | null;
    /** Weight per check (0 turns one off); checks not listed keep their default. */
    weights: Partial<Record<SpecCheckId, number>>;
  };
  /**
   * When a ticket needs someone (a gate waiting on a person, a stage that failed twice, a budget
   * reached, a ticket stopped, PRs merged): on the dashboard's Inbox (Home → Needs you), and posted
   * as JSON to each webhook for the events it names (Slack-compatible: it has `text`).
   */
  notifications: { inbox: boolean; webhooks: FactoryWebhook[] };
  /** The Approver agent: rates each change's risk; acts on it only when `enforce` is on. */
  approver: {
    enabled: boolean;
    /** Let it decide its gates (approve, and merge as `mergeAction` says). Off: advisory, a person decides. */
    enforce: boolean;
    /** The code-host account it acts as (never a PR's author); it refuses to act as anyone else. */
    identity: string | null;
    /** Paths that are always high risk (globs). */
    highRiskPaths: string[];
    /** Ticket labels that are always high risk. */
    highRiskLabels: string[];
    maxFiles: number;
    maxLines: number;
    maxRepos: number;
    mergeAction: 'none' | 'auto-merge' | 'merge';
    mergeMethod: MergeMethod;
    /** Share of auto-approvable items sent to a person anyway (0-100). */
    samplingPct: number;
  };
}

/** One rule of the Approver's that tripped (any means "not low risk"). */
export interface FactoryRiskRule { id: 'path' | 'label' | 'security' | 'unknown' | 'files' | 'lines' | 'repos' | 'dependency'; level: 'medium' | 'high'; detail: string }

/** The Approver's assessment at a gate (multirepo's approver.mjs assess), appended to the manifest. */
export interface FactoryAssessment {
  gate: FactoryGateId;
  level: 'low' | 'medium' | 'high';
  /** The rules' level (null: none tripped) and the agent's own judgement (null: none given). */
  rulesLevel: 'medium' | 'high' | null;
  judged: 'low' | 'medium' | 'high' | null;
  rules: FactoryRiskRule[];
  rationale: string | null;
  concerns: string[];
  /** Every condition for approving without a person was met. */
  wouldApprove: boolean;
  /** Why it couldn't approve without a person. */
  blockers: string[];
  /** Sent to a person anyway (the policy's sampling). */
  sampled: boolean;
  /** The policy let it decide (else advisory). */
  enforced: boolean;
  action: 'pass' | 'ask' | 'stop' | 'handoff';
  reason: string;
  by: string | null;
  sha: string | null;
  at: string;
}

/**
 * A person's verdict on an assessment: right, should have asked (it let through something a person
 * should see), or could have approved (it sent something safe to a person).
 * POST /api/factory/rate { ticket, assessmentAt, rating, note? }.
 */
export type FactoryRatingValue = 'right' | 'should-have-asked' | 'could-have-approved';
export interface FactoryRating { assessmentAt: string; gate: FactoryGateId; level: 'low' | 'medium' | 'high'; wouldApprove: boolean; rating: FactoryRatingValue; by: string; note: string | null; at: string }

export type FactoryNoticeEvent = 'gate-waiting' | 'stage-failed' | 'budget' | 'stopped' | 'merged';

/**
 * A webhook: its address, or (better: a webhook address is a secret, and factory.json is committed)
 * `env`, the environment variable on each dashboard's machine that holds it. Read-only viewers see
 * only the address's host. `events`: which notices it gets (none: muted).
 */
export interface FactoryWebhook { url: string | null; env: string | null; events: FactoryNoticeEvent[] }

/** Something about a ticket worth telling someone (FactoryConfig.notifications). `key` is unique per occurrence. */
export interface FactoryNotice { key: string; event: FactoryNoticeEvent; ticket: string; title: string | null; url: string | null; text: string; severity: 'alert' | 'action' | 'info'; at: string }

/** One row of the gate audit log (GET /api/factory/audit?format=csv|json[&ticket=]). */
export interface FactoryAuditRow {
  ticket: string; at: string; kind: 'gate' | 'assessment' | 'rating'; gate: FactoryGateId;
  /** gate: pending/approved/rejected; assessment: its action; rating: its verdict. */
  decision: string; by: string | null; mode: FactoryGateMode | null; risk: string | null;
  rationale: string | null; sha: string | null; override: boolean;
}

/** A PR's factory ticket and its other PRs (GET /api/reviews/related): one change across several repos. */
export interface ReviewRelated { ticket: string; title: string | null; prs: { repo: string | null; number: number | null; url: string; state: string | null; current: boolean }[] }

export interface FactoryConfigState {
  config: FactoryConfig;
  /** factory.json exists (else these are the defaults and the factory is off). */
  exists: boolean;
  /** factory.json is there but isn't valid JSON. */
  error: string | null;
  /** The person may change it (full access). */
  canEdit: boolean;
  /** The file's mtime (epoch ms), sent back on save so a stale edit is refused. */
  mtimeMs: number | null;
  /** What each preset sets (the rest of the config is kept). */
  presets: Record<Exclude<FactoryPreset, 'custom'>, FactoryPresetPatch>;
  suggestedScanners: FactoryScanner[];
  stageLabels: Record<FactoryStageId, string>;
  gateLabels: Record<FactoryGateId, string>;
  /** The spec checks, with what each looks for and its default weight. */
  specChecks: { id: SpecCheckId; label: string; help: string; weight: number }[];
}

export interface FactoryPresetPatch {
  label: string;
  description: string;
  mode: FactoryConfig['mode'] | null;
  gates: Record<FactoryGateId, FactoryGateMode>;
  approver: Pick<FactoryConfig['approver'], 'enabled' | 'mergeAction' | 'samplingPct'>;
  /** The Approver stage is on. */
  approve: boolean;
}

export type SpecCheckId = 'problem' | 'outcome' | 'criteria' | 'scope' | 'constraints' | 'affected' | 'questions' | 'verify';
export type SpecLevel = 'ready' | 'needs-work' | 'not-ready';

/** A ticket's spec readiness, as spec-check.mjs scored it (with the agent's corrections). */
export interface FactorySpec {
  score: number;
  level: SpecLevel;
  readyAt: number;
  needsWorkAt: number;
  minScore: number | null;
  checks: { id: SpecCheckId; label: string; weight: number; score: number; finding: string; override?: { from: number; reason: string } }[];
  at: string;
}

/** What a pipeline step reports in a work item's manifest. */
export type FactoryStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * One work item's progress, written by the pipeline (e.g. /multirepo:implement through its
 * factory.mjs script) to <workspace>/.claude/ledger/factory/<ticket>.json. Any pipeline that
 * writes this gets the Factory board. Version 1.
 */
export interface FactoryManifest {
  version: 1;
  ticket: string;
  title: string | null;
  url: string | null;
  mode: 'interactive' | 'autonomous';
  /** The policy it ran under: factory.json's preset and when it was last changed. */
  policy: { preset: FactoryPreset | null; updatedAt: string | null } | null;
  /** Where the work lives (the worktree, or the workspace itself). */
  workroot: string | null;
  branch: string | null;
  repos: string[];
  plan: string | null;
  startedAt: string;
  updatedAt: string;
  /** When the ticket's current round started (picking a finished one up again starts a new round). */
  roundStartedAt: string | null;
  /** Spec readiness, scored when the pipeline read the ticket. */
  spec: FactorySpec | null;
  stages: { id: FactoryStageId; repo: string | null; agent: string | null; status: FactoryStepStatus; startedAt: string | null; endedAt: string | null; note: string | null; failures?: number }[];
  gates: { id: FactoryGateId; mode: FactoryGateMode | null; decision: 'pending' | 'approved' | 'rejected'; by: string | null; risk: 'low' | 'medium' | 'high' | null; rationale: string | null; sha: string | null; at: string; override?: boolean }[];
  prs: { repo: string | null; url: string; number: number | null; state: 'open' | 'merged' | 'closed' | null }[];
  /** The Approver's assessments, oldest first (part of the audit log). */
  assessments: FactoryAssessment[];
  /** People's ratings of the Approver's assessments, oldest first. */
  ratings: FactoryRating[];
  /** When it finished (done, rejected or overridden): the metrics' end time. */
  finishedAt: string | null;
  /** What was learned once its PRs merged (multirepo's retro skill), if it's been done. */
  retro: FactoryRetro | null;
  /** The pipeline finished (or was abandoned) for this item. */
  done: boolean;
  error: string | null;
}

/** A merged ticket's retro: what review caught, which assumptions were wrong, how the Approver's call held up, and tweaks to propose. */
export interface FactoryRetro { caught: string[]; wrong: string[]; approver: string | null; proposals: string[]; at: string }

/** The line's throughput (Factory page): the last 30 days unless said otherwise. */
export interface FactoryMetrics {
  /** Items finished (done, not stopped short) in the last 7 days. */
  done7d: number;
  /** Median hours from start to finished. */
  leadTimeHours: number | null;
  /** Share of repos whose review passed without failing first. */
  firstPassReview: { rate: number; n: number } | null;
  /** Share of the Approver's assessments that approved without a person. */
  autoApproved: { rate: number; n: number } | null;
  /** Agent cost per item whose PRs all merged. */
  costPerMergedUsd: number | null;
  merged: number;
}

/** GET /api/factory/intake: what the factory would pull in now. POST takes them (up to `free`). */
export interface FactoryIntake {
  /** Intake has states or labels to go by. */
  configured: boolean;
  /** Free WIP slots. */
  free: number;
  /** unassigned: it's claimed (assigned to this person) before it starts. */
  candidates: { ticket: string; title: string; url: string | null; state: string | null; unassigned: boolean }[];
  note: string | null;
  error: string | null;
}

/** A column on the Factory board: a stage, a gate, or the ends. */
export interface FactoryColumn { id: string; label: string; kind: 'queued' | 'stage' | 'gate' | 'done' }

export interface FactoryItem {
  ticket: string;
  title: string | null;
  url: string | null;
  /** The column it's in. */
  column: string;
  /** What it needs: nothing (moving), a person, or a fix. */
  state: 'moving' | 'waiting' | 'failing' | 'idle' | 'done';
  /** Why it's waiting or failing, in a few words. */
  reason: string | null;
  branch: string | null;
  workroot: string | null;
  /** Per repo, the furthest step: repo-a ✓ · repo-b ● · repo-c ○. */
  repos: { repo: string; status: FactoryStepStatus; stage: FactoryStageId | null }[];
  agent: string | null;
  model: string | null;
  startedAt: string;
  updatedAt: string;
  costUsd: number;
  budgetUsd: number | null;
  prs: FactoryManifest['prs'];
  /** The newest risk rating (the Approver's, else a gate decision's), if any. */
  risk: { level: 'low' | 'medium' | 'high'; rationale: string | null } | null;
  /** The Approver's newest assessment this round, if any, with the newest rating of it. */
  approver: FactoryAssessment | null;
  approverRating: FactoryRating | null;
  /** An automatic approval this round (by its checks or the Approver) a person may override, if any. */
  overridable: { gate: FactoryGateId; by: string; at: string } | null;
  /** Runs for this ticket, newest first. */
  runIds: string[];
  /** A run of this ticket waiting on an answer (an implement run first), or null. */
  askingRunId: string | null;
  /** An implement run of this ticket is going (running or asking): its gates are decided there. */
  implementLive: boolean;
  /** Every step of the pipeline for this item, in order (the Tickets view's track and details). */
  steps: FactoryItemStep[];
  /** The gate it's waiting at for a decision (approve or reject on the Factory page), or null. */
  waitingGate: { id: FactoryGateId; label: string; mode: FactoryGateMode | null; since: string; reason: string | null } | null;
  mode: FactoryManifest['mode'];
  spec: FactorySpec | null;
  plan: string | null;
  /** Why the pipeline stopped short, when it did. */
  error: string | null;
  /** Every PR it opened has merged. */
  merged: boolean;
  retro: FactoryRetro | null;
}

/** Where one item is on one step: done, under way, failed, waiting on a decision, skipped or not reached. */
export type FactoryStepState = 'done' | 'running' | 'failed' | 'waiting' | 'skipped' | 'pending';

export interface FactoryItemStep {
  /** The board column's id: a stage id, or gate:<id>. */
  id: string;
  kind: 'stage' | 'gate';
  label: string;
  state: FactoryStepState;
  /** The item's current step. */
  current: boolean;
  startedAt: string | null;
  endedAt: string | null;
  /** A stage's rows, one per repo (or one with repo null). */
  repos: { repo: string | null; status: FactoryStepStatus; agent: string | null; note: string | null; startedAt: string | null; endedAt: string | null }[];
  /** A gate's decisions, oldest first. */
  decisions: { decision: 'pending' | 'approved' | 'rejected'; mode: FactoryGateMode | null; by: string | null; risk: 'low' | 'medium' | 'high' | null; rationale: string | null; at: string }[];
}

/** POST /api/factory/gate: a person's decision at a gate an item is waiting at. */
export interface FactoryGateDecision {
  ticket: string;
  gate: FactoryGateId;
  decision: 'approved' | 'rejected';
  note?: string;
  /** On approval, start the next implement run for the ticket (default true). */
  resume?: boolean;
}
export interface FactoryGateResult {
  /** Who it was recorded as. */
  by: string;
  /** The run started to carry on, or null (not asked, rejected, or refused: see launchError). */
  run: RunMeta | null;
  launchError: string | null;
}

export interface FactoryBoard {
  /** factory.json exists and says enabled. */
  enabled: boolean;
  configured: boolean;
  preset: FactoryPreset | null;
  columns: FactoryColumn[];
  items: FactoryItem[];
  /** Items in flight vs the WIP limit. */
  wip: { inFlight: number; limit: number };
  /** Manifests that couldn't be read. */
  errors: string[];
  /** The person may decide gates here (full access). */
  canDecide: boolean;
  /**
   * How the Approver's calls have held up (its newest assessment per ticket and round): judged by a
   * person (rated, or an automatic approval overridden), and of those, too lenient or too strict.
   */
  approverStats: { assessed: number; judged: number; tooLenient: number; tooStrict: number };
  metrics: FactoryMetrics;
}

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
  /** Where the connection comes from: an env key, the pasted key, the tracker's key for the same site, or Connect to Atlassian. */
  connected: boolean; source: 'env' | 'file' | 'tracker' | 'signin' | null; viewer: string | null;
  /** The key in use is a saved file (or a sign-in) Disconnect can remove. */
  removable?: boolean;
  /** signIn 'atlassian': the card also offers Connect to Atlassian (GET /api/atlassian/status says whether it's set up). */
  help: { title: string; steps: string[]; placeholder: string; needsKey: boolean; keyFields?: 'email-token'; signIn?: 'atlassian' } | null;
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
/** GET /api/memory ;  POST /api/memory/delete { file } → { ok, file } ;  POST /api/memory/prune-index → { ok, removed } */
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
  /** Flagged in the tracker (Jira's Add flag, usually an impediment); the card is shown in yellow. */
  flagged?: boolean;
  /** The epic the issue belongs to (Jira), or null. */
  epic?: { id: string; title: string; url: string | null } | null;
}
/**
 * How to connect the tracker when it needs a personal key (steps are markdown). signIn 'atlassian':
 * Connect to Atlassian is offered too (GET /api/atlassian/status says whether it's set up).
 */
export interface ConnectHelp { title: string; steps: string[]; placeholder: string; needsKey: boolean; method?: 'key' | 'oauth'; keyFields?: 'email-token'; signIn?: 'atlassian' }
/** GET /api/issues[?force=1]  (/api/linear/issues still works) */
export interface IssuesResponse {
  connected: boolean; issues: Issue[]; states: string[]; teams: string[]; viewer: string | null; fetchedAt?: number; error?: string;
  /** Where the tracker's key comes from ('signin': Connect to Atlassian): 'env' can't be disconnected from the dashboard. */
  keySource?: 'env' | 'file' | 'cli' | 'signin' | null;
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

// ---------------------------------------------------------------- atlassian

/**
 * GET /api/atlassian/status: Connect to Atlassian (OAuth 2.0 3LO), which reads Jira and
 * Confluence as the person. Pasted API tokens are separate and still work.
 */
export interface AtlassianStatus {
  /** The workspace reads Atlassian: a Jira tracker or a Confluence docs source. */
  used: boolean;
  /** The site it reads (acme.atlassian.net). */
  site: string | null;
  /** Sign-in is offered: workspace.json atlassian.clientId is set and this dashboard has the client secret. */
  signIn: boolean;
  /** Why sign-in isn't offered when it's configured (a bad setting, no client secret), or null. */
  signInProblem: string | null;
  /** Signed in (for this site). */
  connected: boolean;
  viewer: string | null;
  /** The issue tracker is Jira: whether it's connected at all (sign-in or an API token); null for another tracker. */
  jira: boolean | null;
}
/**
 * POST /api/atlassian/sign-in { action: 'start' } → AtlassianSignInStart; { action: 'status' | 'finish', url? }
 * → AtlassianSignInStatus; { action: 'cancel' }. POST /api/atlassian/disconnect → { envKeys, note? }:
 * forgets the sign-in and the saved API tokens (envKeys: env vars that still supply one).
 * Hosted, the browser comes back to GET /api/oauth/atlassian/callback on the dashboard itself.
 */
export type AtlassianSignInStart = MeetingSignInStart;
export type AtlassianSignInStatus = McpLoginStatus;

// ---------------------------------------------------------------- meetings

/** GET /api/meetings/status: whether the meeting tool can be read yet. */
export interface MeetingsStatus {
  source: string;
  label: string;
  /** meetings.json is there. */
  configured: boolean;
  /** The engine has an adapter for `source`. */
  supported: boolean;
  connected: boolean;
  /** Who the stored token reads as, when connected. */
  viewer: string | null;
  /** How the person connected: browser sign-in or a pasted personal access token. */
  via: 'oauth' | 'token' | null;
  /** Sign-in is offered (meetings.json has a valid OAuth clientId and redirectUri); pasting a token always is. */
  signIn: boolean;
  /** What's wrong with meetings.json's sign-in settings (clientId, redirectUri), or null. Pasting a token still works. */
  signInProblem: string | null;
  message: string;
}
/** GET /api/meetings/list?cursor= : one page, newest first. cursor is the previous page's nextCursor. */
export interface MeetingListRequest { cursor?: string }
export interface MeetingPage { meetings: Meeting[]; nextCursor: string | null }
/**
 * A meeting as lists show it. summary (markdown) and actionItems are null when the tool
 * didn't send them; host is null when the tool couldn't say who hosted.
 */
export interface Meeting {
  id: string; title: string;
  startedAt: string; endedAt: string | null;
  participantCount: number;
  host: { name: string; type: 'member' | 'guest' } | null;
  summary: string | null;
  actionItems: ActionItem[] | null;
  /** Tickets made from this meeting, one per key: 'run' = an Ask run here reported it, 'tracker' = the tracker has it (its title and link win). */
  tickets: MeetingTicket[];
}
/** A ticket made from a meeting: found by its back-reference marker in the tracker, or reported by an Ask run. */
export interface MeetingTicket { key: string; url: string; title: string; source: 'run' | 'tracker' }
/** suggestedOwner is the tool's guess at who should do it: shown, never used to assign. */
export interface ActionItem { text: string; description: string | null; complete: boolean; suggestedOwner: string | null }
/** GET /api/meetings/meeting?id= : one meeting with who was there. participantsOmitted: there were more than listed. */
export interface MeetingDetail extends Meeting {
  participants: { id: string; name: string; type: 'member' | 'guest' }[];
  participantsOmitted: boolean;
}
/** How to make a personal access token for the tool: each step is markdown, placeholder is the token field's hint. */
export interface MeetingConnectHelp { title: string; steps: string[]; placeholder: string }
/**
 * POST /api/meetings/sign-in { action: 'start' } → the page to open. listening: this dashboard
 * catches the redirect to `callback` itself (locally on a loopback port, hosted at
 * GET /api/oauth/<tool>/callback); otherwise the person pastes that address back.
 */
export interface MeetingSignInStart { url: string; callback: string; listening: boolean }
/** POST /api/meetings/sign-in { action: 'status' | 'finish' | 'cancel' }. */
export type MeetingSignInStatus = McpLoginStatus;
/*
 * GET  /api/meetings/connect-help → MeetingConnectHelp
 * POST /api/meetings/connect { token } → MeetingsStatus  (a personal access token, checked with the tool first)
 * POST /api/meetings/disconnect → MeetingsStatus & { note? }  (note: what's left to do in the tool by hand)
 * POST /api/meetings/share-link { id } → { url: string | null }  (may create the link in the tool)
 * POST /api/meetings/ask { id, agent?, model?, effort? } → 201 { run }  (proposes tickets, creates none until you answer)
 * Errors ({ error, code } from the tool): 401 connect again, 403 the token lacks a scope, 404 no such
 * meeting, 400 the tool refused the request, 429 the tool is limiting requests, 502 the tool failed
 * or couldn't be reached. A 400 without a code is bad input caught here.
 */

// ---------------------------------------------------------------- machine

export interface MachineCheck {
  /** id: machine.json's id, else its `use` ("claude"); kind: what's checked ("claude-code"), whatever the id. */
  id: string; kind: string; group: string; label: string; status: 'ok' | 'warn' | 'missing' | 'info';
  version?: string; required?: string; detail?: string; fix?: string; apps: string[];
  install?: { label: string; cmd: string; cwd?: string } | null; action?: 'setup';
  /** Hosted: this check's sign-in happens in the page (github-login.ts); `account` is who's signed in. */
  signIn?: 'github'; account?: string;
  /** Local: the page offers a file picker for this check ("google-client": the People page's Google OAuth client). */
  upload?: 'google-client';
}
/** POST /api/machine/google-client { content } → the client it saved (people/google-login.ts). */
export interface GoogleClientSaved { ok: true; clientId: string; projectId: string | null }
/**
 * POST /api/github/login { action: "start" | "status" | "cancel" | "logout" }. start → the code to
 * enter at `url` (GitHub's device page); status → how it's going, polled until done or failed.
 */
export interface GithubLoginStatus {
  state: 'idle' | 'starting' | 'pending' | 'finishing' | 'done' | 'failed';
  code?: string; url?: string; login?: string | null; message?: string;
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
  /** Checks for running the apps left out here (a hosted dashboard, or read-only access). Older servers don't send it. */
  hidden?: MachineHidden | null;
}

export interface MachineHidden {
  reason: 'hosted' | 'read';
  count: number;
  /** Their groups, in machine.json order. */
  groups: string[];
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
  connection: { connected: boolean; source: 'env' | 'file' | 'tracker' | 'signin' | null; viewer: string | null } | null;
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
  /** Their role was assigned on the People page (DASHBOARD_ROLE): shown, but they can't change it. */
  roleLocked: boolean;
  /** workspace.json has roles (else there are just Developer and Reader). */
  configured: boolean;
  /** False when their own outputStyle in .claude/settings.local.json is kept instead of the role's. */
  styleApplied: boolean;
  roles: RoleInfo[];
  /**
   * What they can do with the code, separate from the role: full (everything) or read (ask and read;
   * no Implement, Publish or GitHub sign-in). `accessOwn` is their own setting (null = the role's
   * default, `roleAccess`); `accessLocked`: assigned on the People page (DASHBOARD_ACCESS).
   * POST /api/profile { access: "full" | "read" | "default" } changes it.
   */
  access: Access;
  accessOwn: Access | null;
  roleAccess: Access;
  accessLocked: boolean;
}
export type Access = 'full' | 'read';

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

// ---------------------------------------------------------------- people (local dashboard only)

export type PersonState = 'not-set-up' | 'running' | 'starting' | 'stopped' | 'left' | 'missing' | 'unmanaged' | 'unknown';
export interface PersonRow {
  email: string; name: string;
  /** In the directory and active; null when the directory couldn't be read or is "manual". */
  active: boolean | null;
  state: PersonState;
  /** Why the state is 'unknown': the platform's error, e.g. a lapsed az or kubectl sign-in (null otherwise). */
  stateError: string | null;
  slug: string | null; profile: string | null; needsUpdate: boolean;
  /** The workspace role assigned to them (DASHBOARD_ROLE); null: they pick their own. */
  role: string | null;
  /** Their access over their role's default (DASHBOARD_ACCESS); null: the role's. */
  access: Access | null;
  provisionedAt: string | null; provisionedBy: string | null;
}
/** One of the team's roles on the People page; `access` is the default it gives, `people` how many in the roster have it. */
export interface PeopleRole { id: string; label: string; description: string; access: Access; outputStyle: string | null; people: number }
/** people.json and its git state (GET /api/people .roster; POST /api/people/commit returns it). */
export interface PeopleRoster { file: string; uncommitted: boolean; changes: string[] }
/** GET /api/people: hosting.json's directory + the roster (.claude/dashboard/people.json) + the cluster. */
export interface PeopleResponse {
  configured: boolean;
  problems: string[];
  errors: { source: 'directory' | 'roster' | 'cluster' | 'template'; message: string; fix: string | null }[];
  directory: { label: string; type: string; count: number | null };
  /** people.json, and whether it has changes that aren't committed (one line per change). */
  roster: PeopleRoster | null;
  /** Where the dashboards run ("context x, namespace y", "resource group z"). */
  cluster: string | null;
  /** What a person keeps between restarts there: "volume" (Kubernetes), "file share" (App Service). */
  dataLabel: string | null;
  profiles: { id: string; name: string; areas: string[] }[];
  defaultProfile: string | null;
  /** workspace.json roles one can be assigned; empty when the team has none. */
  roles: PeopleRole[];
  /** Output styles a role can use: the team's (.claude/output-styles) and Claude Code's own. */
  styles: string[];
  /** workspace.json (the roles) and what isn't committed in it; POST /api/people/commit { file: "roles" } commits it. */
  rolesFile: PeopleRoster | null;
  rows: PersonRow[];
}
export type PeopleActionName = 'provision' | 'update' | 'profile' | 'role' | 'access' | 'start' | 'stop' | 'remove' | 'adopt' | 'forget';
/** POST /api/people/action */
/** `role`: a workspace role id, or "" for "they pick their own" (provision, role). `access`: "full", "read", or "" to follow the role (provision, access). */
export interface PeopleActionRequest { action: PeopleActionName; email: string; profile?: string; role?: string; access?: Access | ''; keepVolume?: boolean; dryRun?: boolean }
/** POST /api/people/roles: add a role (no id), change one, or remove one. */
export interface PeopleRolesRequest { action: 'save' | 'remove'; id?: string; role?: { label: string; description?: string; access?: Access; outputStyle?: string | null } }
export interface PeopleActionResponse { ok: true; dryRun: boolean; output: string; objects?: unknown[] }

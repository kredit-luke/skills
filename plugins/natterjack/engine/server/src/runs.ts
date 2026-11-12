/**
 * Run manager: headless `claude -p` conversations.
 *
 * A run is one conversation; each turn (the first prompt, or a reply) is a new
 * `claude -p` process on the same session (--session-id on turn 1, --resume
 * after). The process exits when Claude ends its turn. Everything a turn prints
 * (stream-json) is appended to the run's event log and fanned out over SSE.
 *
 * Headless gaps it papers over:
 *  - AskUserQuestion doesn't work under -p. The appended system prompt asks
 *    Claude to end its turn with a <<QUESTION>>{json}<</QUESTION>> block
 *    instead; the run then waits for your answer (status "waiting").
 *  - Background work dies with the process. The prompt forbids it, and each
 *    turn records what was backgrounded and flags anything that was cut off.
 *  - Plan mode is a per-run switch applied per turn, so a read-only question
 *    can turn into real work without starting over.
 *
 * Ledger layout (under <main workspace>/.claude/ledger/, gitignored):
 *   runs/<id>.json          RunMeta
 *   runs/<id>.events.jsonl  every event, one per line (CLI events + dashboard markers)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { Attachment, Effort, PermissionMode, QueuedMessage, Question, RoutineProposal, RunEvent, RunMeta, RunWatch, WatchedPr } from "../../shared/api.ts";
import { BETWEEN_TURNS } from "../../shared/send-to-hosted.ts";
import { lastActivity } from "../../shared/remote.ts";
import { implementTicket } from "../../shared/run-ticket.ts";
import { codeRanges, findBlock, stripBlock } from "../../shared/blocks.ts";
import { formatMinutes, parseDuration } from "../../shared/loops.ts";
import { checkRoutine } from "./routines.ts";
import { agentHeadlessRules, agentOf, keepRunningRule, loopRules, outputsRule, type ParseState, type TurnInput } from "./agents/index.ts";
import { LOCAL_MODEL_RULE, isRoutedId } from "./models/routes.ts";
import { expandSlash } from "./agents/skills.ts";
import { promptWithAttachments, type Attachments } from "./attachments.ts";
import { MAX_SESSION_BYTES, MOVED_FOLDER_NOTE, claudeDir, terminalOnlyRun, firstPromptIndex, lastAssistantText, readSessionEvents, runPermission, type SessionInfo } from "./sessions.ts";

const RESULT_TEXT_MAX = 4000;
const REPLY_MAX = 20000;
const LABEL_MAX = 120;
const QUEUE_MAX = 10;
/** An adopted run takes no reply until its terminal session has been quiet this long (RunManager.terminalBusy). */
export const TERMINAL_QUIET_MS = 2 * 60_000;
/** ...or while its terminal is running a tool, for at most this long after its last write (a terminal closed mid-tool doesn't hold it forever). */
const TOOL_PENDING_MS = 30 * 60_000;
/** A new run's title at most (a rename may go up to LABEL_MAX). */
const LAUNCH_LABEL_MAX = 60;

/**
 * A new run's title: the label it was launched with, else the prompt's first line; on one
 * line (it becomes an argument and a list entry) and at most LAUNCH_LABEL_MAX characters.
 */
export function runLabel(label: unknown, prompt: string): string {
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  const given = typeof label === "string" ? one(label) : "";
  return (given || one(String(prompt).split("\n")[0])).slice(0, LAUNCH_LABEL_MAX);
}
/** How often a queue a limit held back is tried again. */
const QUEUE_RETRY_MS = 30000;
/** Backstop for run files edited outside this server (a file added or removed is caught by name). */
const LIST_TTL_MS = 10000;
export { codeRanges, findBlock, stripBlock };
const WATCH_DEFAULT_MINUTES = 5;
const WATCH_MIN_MINUTES = 2;
const WATCH_MAX_MINUTES = 60;
const WATCH_DEFAULT_DAYS = 7;
const WATCH_MAX_DAYS = 14;
const WATCH_MAX_PRS = 10;
const WATCH_PROMPT_MAX = 8000;
/** An 'every' loop wakes 10 minutes to a day apart, for a day unless the block says otherwise (up to a week). */
const LOOP_MIN_MINUTES = 10;
const LOOP_MAX_MINUTES = 1440;
const LOOP_DEFAULT_DAYS = 1;
const LOOP_MAX_DAYS = 7;
const CHECK_COMMAND_MAX = 2000;
const CHECK_DEFAULT_PROMPT = "The check you set up changed. Look at what it says, act on it, and report in a few lines.";
const WATCH_DEFAULT_PROMPT = "Check each pull request: act on new review feedback, fix failing checks if the fix is yours to make, update a branch that is behind, and report each PR's status in a short table.";
const SCHEDULE_TOOLS = new Set(["CronCreate", "ScheduleWakeup", "Monitor"]);
/** A run in one of these can take a reply. */
export const REPLYABLE = new Set(BETWEEN_TURNS);
/** Finished for the purposes of stats and verdicts. */
const SETTLED = new Set(["waiting", "succeeded", "failed", "cancelled", "interrupted", "handedOff"]);

/** Claude's headless rules. `appsCli`: the command for bin/dashboard.mjs when the dashboard can start apps (keepRunningRule). */
export function headlessRules(appsCli: string | null = null): string {
  return `You are running headless inside the workspace dashboard (claude -p). The AskUserQuestion tool is not available and there is no terminal to type into.
Whenever you would call AskUserQuestion, or you otherwise need a decision from the user before you can continue (an approval gate, a choice between options, missing input), do NOT guess, do NOT skip the step, and do NOT treat silence as approval. Instead, end your turn with exactly one block in this format and then stop:
<<QUESTION>>
{"questions":[{"question":"<full question>","header":"<short label>","multiSelect":false,"options":[{"label":"<option>","description":"<what it means>"}]}]}
<</QUESTION>>
Put any explanation the user needs before the block. The user's answer arrives as your next message. Approval gates must always be surfaced this way, never bypassed. Skills that say to use AskUserQuestion mean this block here.

Background work does not survive here. This process exits the moment your turn ends, and everything it started in the background is killed with it; no task notification will re-invoke you after that.
So, overriding any skill or instruction that says otherwise (for example a code-review skill, or "run_in_background: true"):
- Never run anything in the background, and never plan to "wait for a notification". On Bash, leave run_in_background unset. On the Agent tool, always pass run_in_background: false explicitly: Agent runs in the background by default, so leaving it out backgrounds the subagent. Subagents are fine this way: the call blocks and returns the subagent's report. Continuing an agent with SendMessage resumes it in the background, so to follow up with a finished agent, start a new foreground Agent call and give it the context instead.
- Run long commands in the foreground and wait for them, with a Bash timeout of up to 600000 ms. If one needs longer than 10 minutes, tell the user it has to continue in a terminal.
- A process that must keep running after your turn (e.g. dev servers) cannot be started as a background task: it dies when this process exits. ${keepRunningRule(appsCli)}
- Never tell the user a background task is still running at the end of your turn; it will not be. Only a process you started detached (above) is still running, and only if you checked it came up.
${loopRules("CronCreate, ScheduleWakeup, Monitor or /loop")}

Don't end on a to-do list for the user. If you finish with follow-up steps you could do yourself (commit, open a PR, deploy, publish, update the ticket), end with the question block offering to do them, recommended option first, instead of listing them as "next steps". Otherwise the dashboard shows the run as Done while work is still waiting.

The same goes for handing work back: if your turn ends with the user doing something and reporting back (test a change, reload a page, add a secret, check an email, try again), end with the question block too, e.g. "How did it go?" with options like "It worked", "It failed (I'll paste the error)" and "Still testing". End without a block only when the work is actually finished.`;
}

export const PLAN_MODE_RULE = `Plan mode is on for this turn: you can read and search, but not edit files, run commands with side effects, or post anything externally. If the user asks for something that needs any of those, don't work around it (e.g. by writing into a plan file); tell them to click "Turn off plan mode" in the dashboard and reply again. Otherwise never mention plan mode.`;

export interface StartSpec {
  label?: string;
  presetId?: string | null;
  prompt: string;
  cwd: string;
  workspace?: string;
  model?: string | null;
  effort?: Effort | null;
  permissionMode?: PermissionMode;
  planMode?: boolean;
  budgetUsd?: number | null;
  trigger?: string;
  /** A meetings run's meeting id (checked by the caller). */
  meetingId?: string;
  /** Staged attachment ids (checked by the caller); moved into the run's folder. */
  attachments?: string[];
  /** Docs sources this run should use (docs.json keys), and the note that tells Claude how (appended every turn). */
  docSources?: string[];
  extraPrompt?: string | null;
  /** Folders outside the workspace it may read (--add-dir), e.g. a knowledge store's local copy. */
  addDirs?: string[];
  /** The agent CLI that runs it (agents/): "claude" (the default), "copilot", "codex". */
  agent?: string;
}

/**
 * Whether queued messages may go out now, and the reply options to send them with;
 * main.ts applies the same limits as a reply you send (concurrent runs, usage, budget).
 */
export type QueueGate = (meta: RunMeta) => { blocker: string | null; budgetUsd?: number | null };

export interface ReplyOptions {
  /** A new per-turn cap; null removes it, undefined keeps the run's. */
  budgetUsd?: number | null;
  /**
   * Another model from this turn on (checked by the caller; Claude runs only), and its effort.
   * The session carries on: e.g. a run that explored on a local model continues on Opus.
   */
  model?: string;
  effort?: Effort | null;
  attachments?: string[];
}

interface LiveTurn {
  child: ChildProcess;
  /** Why the process is being stopped, if we stopped it. */
  stopping: "cancel" | "handoff" | null;
  /** The turn's copy of the run, which it saves as it goes: changes made mid-turn go here too. */
  meta: RunMeta;
}

/** What a turn backgrounded, so the end of the turn can say what was cut off. */
interface TurnWatch {
  outputFiles: Set<string>;
  bgTasks: Map<string, string>; // task_id -> description, until it reports completed/failed
  asyncAgents: Map<string, string>; // tool_use_id -> description
  schedules: string[];
}

export class RunManager {
  runsDir: string;
  live = new Map<string, LiveTurn>();
  subscribers = new Map<string, Set<ServerResponse>>();
  onFinish: (meta: RunMeta) => void;
  onTurnStart: (meta: RunMeta) => void;
  /** A run's meta was written (any change the run list shows). */
  onChange: (meta: RunMeta) => void;
  /** An event was appended to a run's events file; `index` is its place there (the SSE id). */
  onEvent: (meta: RunMeta, ev: RunEvent, index: number) => void;
  queueGate: QueueGate;
  attachments: Attachments | null;
  /** The command for bin/dashboard.mjs when the dashboard can start this workspace's apps, else null (asked each turn). */
  appsCli: () => string | null;
  /** The main workspace: where plugins enabled for it are found when a run is in a worktree (null: the run's folder). */
  workspaceRoot: string | null;
  private _cont = new Map<string, any>();
  private _paths = new Map<string, string>();
  /** list() parses every run file; kept until a write, a file added or removed, or LIST_TTL_MS. */
  private _listCache: { runs: RunMeta[]; names: string; at: number } | null = null;
  /**
   * Events in each run's file once this process has appended to it: the index of its next event,
   * which is both its SSE id and onEvent's index. Counted from the file on the first append, then
   * kept for the life of the process.
   */
  private _counts = new Map<string, number>();

  constructor(ledgerDir: string, { onFinish, onTurnStart, onChange, onEvent, queueGate, attachments, appsCli, workspaceRoot }: { onFinish?: (meta: RunMeta) => void; onTurnStart?: (meta: RunMeta) => void; onChange?: (meta: RunMeta) => void; onEvent?: (meta: RunMeta, ev: RunEvent, index: number) => void; queueGate?: QueueGate; attachments?: Attachments; appsCli?: () => string | null; workspaceRoot?: string } = {}) {
    this.runsDir = path.join(ledgerDir, "runs");
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.onFinish = onFinish || (() => {});
    this.onTurnStart = onTurnStart || (() => {});
    this.onChange = onChange || (() => {});
    this.onEvent = onEvent || (() => {});
    this.queueGate = queueGate || (() => ({ blocker: null }));
    this.attachments = attachments || null;
    this.appsCli = appsCli || (() => null);
    this.workspaceRoot = workspaceRoot || null;
    this._markOrphansInterrupted();
    // A queue held back by a limit (concurrent runs, usage) goes out once the limit clears.
    setInterval(() => {
      for (const r of this.list()) if (r.queueBlocked && drainable(r) && !this.live.has(r.id)) this._drain(r.id);
    }, QUEUE_RETRY_MS).unref();
  }

  // ------------------------------------------------------------ storage

  private _metaPath(id: string) { return path.join(this.runsDir, `${id}.json`); }
  private _eventsPath(id: string) { return path.join(this.runsDir, `${id}.events.jsonl`); }

  private _write(meta: RunMeta) {
    fs.writeFileSync(this._metaPath(meta.id), JSON.stringify(meta, null, 2));
    this._listCache = null;
    try { this.onChange(meta); } catch {}
  }

  /** Persist and tell anyone watching. */
  private _save(meta: RunMeta) {
    this._write(meta);
    this._broadcast(meta.id, "meta", meta);
  }

  private _markOrphansInterrupted() {
    for (const meta of this.list()) {
      if (meta.status === "running") {
        meta.status = "interrupted";
        meta.endedAt = meta.endedAt || new Date().toISOString();
        meta.error = "The dashboard restarted mid-turn. Reply to carry on, or continue in a terminal.";
        this._write(meta);
      }
      // A send to the hosted dashboard doesn't survive a restart (its token was in memory).
      if (meta.handoffPendingAt) {
        meta.handoffPendingAt = null;
        this._write(meta);
      }
    }
  }

  get(id: string): RunMeta | null {
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    try {
      return normaliseMeta(JSON.parse(fs.readFileSync(this._metaPath(id), "utf-8")));
    } catch {
      return null;
    }
  }

  list(): RunMeta[] {
    let files: string[] = [];
    // Only <id>.json: runs/ also holds each run's <id>.baselines.json (run-changes.ts), which isn't a run.
    try { files = fs.readdirSync(this.runsDir).filter((f) => /^[a-z0-9-]+\.json$/i.test(f)); } catch { return []; }
    const names = files.join("/");
    const c = this._listCache;
    // Copies, so a caller that edits a run can't change the cache.
    if (c && c.names === names && Date.now() - c.at < LIST_TTL_MS) return c.runs.map((r) => ({ ...r }));
    const runs: RunMeta[] = [];
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.runsDir, f), "utf-8"));
        // The id must be the file's own name: a copy holding another run's id would list it twice.
        if (m && typeof m.id === "string" && `${m.id}.json` === f) runs.push(normaliseMeta(m));
      } catch {}
    }
    runs.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
    this._listCache = { runs, names, at: Date.now() };
    return runs.map((r) => ({ ...r }));
  }

  events(id: string): RunEvent[] {
    if (!this.get(id)) return [];
    return this._readEvents(id);
  }

  /** The events file as events() and subscribe() index it: blank and unreadable lines skipped. */
  private _readEvents(id: string): RunEvent[] {
    try {
      return fs.readFileSync(this._eventsPath(id), "utf-8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  runningCount() { return this.live.size; }

  spentSince(sinceMs: number) {
    return this.list().filter((r) => Date.parse(r.startedAt) >= sinceMs).reduce((sum, r) => sum + (r.costUsd || 0), 0);
  }

  // ------------------------------------------------------------ public actions

  start(spec: StartSpec): RunMeta {
    const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
    const meta: RunMeta = {
      id,
      sessionId: crypto.randomUUID(), // chosen up front, so "Continue in terminal" works from the first second
      presetId: spec.presetId || null,
      label: spec.label || spec.prompt.slice(0, 60),
      prompt: spec.prompt,
      cwd: spec.cwd,
      workspace: spec.workspace || "main",
      model: spec.model || null,
      effort: spec.effort || null,
      permissionMode: spec.permissionMode || "auto",
      planMode: !!spec.planMode,
      budgetUsd: spec.budgetUsd || null,
      trigger: spec.trigger || "manual",
      ...(spec.meetingId ? { meetingId: spec.meetingId } : {}),
      docSources: spec.docSources && spec.docSources.length ? spec.docSources : undefined,
      extraPrompt: spec.extraPrompt || null,
      addDirs: spec.addDirs && spec.addDirs.length ? spec.addDirs : undefined,
      agent: agentOf(spec.agent).id,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      turns: 0,
      turnStartedAt: null,
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
      toolCalls: 0,
      lastActivity: null,
      resultText: null,
      error: null,
      verdict: null,
      flagged: false,
      question: null,
      warning: null,
    };
    const files = this._claim(id, spec.attachments);
    if (files.length) meta.attachments = files;
    this._turn(meta, promptWithAttachments(spec.prompt, files));
    return meta;
  }

  // ------------------------------------------------------------ sessions from a terminal

  /**
   * Take over a Claude Code session started in a terminal (sessions.ts): a run on the same
   * session, so a reply resumes it. Its first prompt is the run's prompt and the rest are its
   * events; it ends where the session's last line is, so what's typed there later is added by
   * absorbTerminal. Throws 409 when the session is already a run here.
   */
  adopt(session: SessionInfo, workspace: string, trigger = "terminal", outside: string | null = null): RunMeta {
    if (this.list().some((r) => r.sessionId === session.sessionId)) throw httpError(409, "That session is already a run here.");
    return this._sessionRun(session, { workspace, trigger, cwd: session.cwd, adopted: true, outside });
  }

  /**
   * A copy of a session from another folder, moved into this workspace (sessions.ts forkSession
   * made it, under a new session id): an ordinary run in `cwd` from now on, told every turn that
   * paths earlier in it are the old folder's. The original stays as it was, in its terminal.
   */
  moveIn(copy: SessionInfo, opts: { workspace: string; cwd: string; fromCwd: string; fromSession: string }): RunMeta {
    const moved = this.list().find((r) => r.movedFrom?.session === opts.fromSession);
    if (moved) throw httpError(409, `That session was moved here already: "${moved.label}".`);
    return this._sessionRun(copy, { workspace: opts.workspace, trigger: "terminal:moved", cwd: opts.cwd, adopted: false, movedFrom: opts.fromCwd, fromSession: opts.fromSession });
  }

  private _sessionRun(session: SessionInfo, o: { workspace: string; trigger: string; cwd: string; adopted: boolean; outside?: string | null; movedFrom?: string; fromSession?: string }): RunMeta {
    const { workspace, trigger } = o;
    const readAt = fs.statSync(session.file).mtimeMs;
    const { events, lastAt, to, pending } = readSessionEvents(session.file, 0, 0, { commands: true, terminalOnly: true });
    const firstHuman = firstPromptIndex(events);
    const rest = firstHuman >= 0 ? events.filter((_, i) => i !== firstHuman) : events;
    const now = new Date().toISOString();
    const startedAt = session.startedAt || lastAt || now;
    const endedAt = lastAt || session.lastActivityAt;
    const id = `${startedAt.replace(/[-:T]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
    const meta: RunMeta = {
      id,
      sessionId: session.sessionId,
      presetId: null,
      label: runLabel(session.label, session.firstPrompt),
      prompt: firstHuman >= 0 ? String(events[firstHuman].text) : session.firstPrompt,
      cwd: o.cwd,
      workspace,
      model: null,
      effort: null,
      // As the session was: a reply from here (or the hosted dashboard) gets no more than it had there.
      ...runPermission(session.permissionMode),
      budgetUsd: null,
      trigger,
      agent: "claude",
      status: "succeeded",
      startedAt,
      endedAt,
      turns: 1,
      turnStartedAt: startedAt,
      costUsd: 0,
      numTurns: 0,
      durationMs: null,
      toolCalls: toolUses(rest),
      lastActivity: null,
      resultText: null,
      error: null,
      verdict: null,
      flagged: false,
      question: null,
      warning: null,
      adoptedFrom: o.adopted ? { at: now, file: session.file, entrypoint: session.entrypoint, offset: to, readAt, inTerminal: false, pendingTools: pending, ...(o.outside ? { outside: o.outside } : {}) } : null,
      terminalActivityAt: o.adopted ? endedAt : null,
      watch: null,
      queued: [],
      queueBlocked: null,
    };
    if (o.movedFrom) {
      meta.movedFrom = { at: now, cwd: o.movedFrom, ...(o.fromSession ? { session: o.fromSession } : {}) };
      meta.extraPrompt = `${MOVED_FOLDER_NOTE}, ${o.movedFrom}. Paths earlier in the conversation under that folder are the old location: you now work in ${o.cwd}, and changes made there (committed or not) aren't here unless they were pushed.`;
    }
    meta.resultText = lastAssistantText(rest, RESULT_TEXT_MAX);
    if (rest.length) fs.writeFileSync(this._eventsPath(id), rest.map((e) => JSON.stringify(e)).join("\n") + "\n");
    this._paths.set(session.sessionId, session.file);
    this._write(meta);
    return meta;
  }

  /**
   * An adopted run: add what was said in its terminal session as events (so the run page, Remote
   * control and Send to hosted all have it). Reads only what was written since the last read
   * (adoptedFrom.offset), and only the terminal's lines: the dashboard's own turns (`claude -p`)
   * are told apart by their entrypoint, so what was typed there during one of them isn't lost.
   * Returns the run when something was added, else null. Not while a dashboard turn is running.
   */
  absorbTerminal(id: string): RunMeta | null {
    const meta = this.get(id);
    const from = meta?.adoptedFrom;
    if (!meta || !from || this.live.has(id) || meta.status === "running" || meta.status === "handedOff" || meta.handoffPendingAt || !meta.endedAt) return null;
    const file = this._adoptedFile(meta);
    if (!file) return null;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
    if (mtime <= (from.readAt ?? 0)) return null;
    const wrote = new Date(mtime).toISOString();
    let read: ReturnType<typeof readSessionEvents>;
    try { read = readSessionEvents(file, Date.parse(meta.endedAt), from.offset ?? 0, { commands: true, terminalOnly: true, pending: from.pendingTools }); }
    catch (e: any) {
      if (e?.status !== 413) return null;
      // Too much written at once to take in (big tool output, images): skip past it and say so, rather than stall here.
      from.offset = e.size;
      from.readAt = mtime;
      from.pendingTools = [];
      this._append(meta, { type: "divider", text: "Too much was written to this session at once to show here: open it in a terminal to see it", uuid: crypto.randomUUID(), timestamp: wrote });
      this._save(meta);
      return meta;
    }
    from.offset = read.to;
    from.readAt = mtime;
    from.pendingTools = read.pending;
    // The file's write time, not the last line's: the terminal may have written lines that aren't events (titles).
    const activityBefore = meta.terminalActivityAt;
    // Also a line naming no entrypoint (an older Claude Code, a title) written after the last turn from here ended: only the terminal writes then.
    if (read.fromTerminal || mtime > Date.parse(meta.endedAt) + 5000) meta.terminalActivityAt = wrote;
    // A rewritten file is read from the start: what the run already has isn't added again.
    if (read.restarted) {
      const have = new Set(this._readEvents(id).map((e) => e.uuid).filter(Boolean));
      // The first prompt is the run's prompt, not an event.
      let promptSkipped = false;
      read.events = read.events.filter((e) => {
        if (e.uuid && have.has(e.uuid)) return false;
        if (!promptSkipped && e.type === "human" && e.text === meta.prompt) { promptSkipped = true; return false; }
        return true;
      });
    }
    if (!read.events.length) {
      // Only the cursor moved: written quietly (no onChange: nothing the list, the page or Remote control shows changed), unless the activity time did.
      if (meta.terminalActivityAt !== activityBefore) this._write(meta);
      else { fs.writeFileSync(this._metaPath(meta.id), JSON.stringify(meta, null, 2)); this._listCache = null; }
      return null;
    }
    // What was said there reads as its own part of the run, under one divider until a turn runs from here.
    if (!from.inTerminal) this._append(meta, { type: "divider", text: "In the terminal", uuid: crypto.randomUUID(), timestamp: read.events[0].timestamp });
    from.inTerminal = true;
    for (const ev of read.events) this._append(meta, ev);
    const last = read.events[read.events.length - 1].timestamp as string;
    if (last > meta.endedAt) meta.endedAt = last;
    // Carried on there: a question it asked here, or how its last turn here ended, no longer stands. Not
    // with messages queued: a question, cancel or restart holds them, and "succeeded" would send them.
    if ((meta.status === "waiting" || meta.status === "failed" || meta.status === "interrupted" || meta.status === "cancelled") && !(meta.queued || []).length) {
      meta.status = "succeeded";
      meta.question = null;
      meta.error = null;
    }
    meta.toolCalls = (meta.toolCalls || 0) + toolUses(read.events);
    meta.resultText = lastAssistantText(read.events, RESULT_TEXT_MAX) ?? meta.resultText;
    this._cont.delete(id);
    this._save(meta);
    return meta;
  }

  /**
   * Why an adopted run can't take a turn from here right now, or null: its terminal wrote the
   * session in the last TERMINAL_QUIET_MS, or is still running a tool (TOOL_PENDING_MS at most),
   * and a turn from here would fork the conversation.
   */
  terminalBusy(meta: RunMeta, now = Date.now()): string | null {
    const from = meta.adoptedFrom;
    if (!from) return null;
    const file = this._adoptedFile(meta);
    let mtime = 0;
    try { mtime = file ? fs.statSync(file).mtimeMs : 0; } catch {}
    const ended = meta.endedAt ? Date.parse(meta.endedAt) : 0;
    // Written since the last read, and not by the dashboard's own turn (which writes until it ends).
    const written = mtime > (from.readAt ?? 0) && mtime > ended + 5000 ? mtime : 0;
    const said = meta.terminalActivityAt ? Date.parse(meta.terminalActivityAt) : 0;
    const latest = Math.max(written, said);
    if ((from.pendingTools || []).length && said && now - said < TOOL_PENDING_MS) {
      return `This session's terminal is still running a tool (since ${Math.max(1, Math.round((now - said) / 60_000))} min ago). Wait for it to finish there, or exit it, then try again.`;
    }
    if (!latest || now - latest >= TERMINAL_QUIET_MS) return null;
    const ago = Math.max(1, Math.round((now - latest) / 1000));
    return `This session is still open in a terminal (active ${ago}s ago). Reply there, or exit it there and try again in ${Math.ceil((TERMINAL_QUIET_MS - (now - latest)) / 1000)}s.`;
  }

  /** Send a reply: a new turn on the same session. Throws with a user-facing message. */
  reply(id: string, text: string, opts: ReplyOptions = {}): RunMeta {
    // An adopted run: take in what its terminal said first, or this turn's endedAt would leave it behind for good.
    if (!this.live.has(id)) this.absorbTerminal(id);
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    text = String(text || "").trim();
    const ids = opts.attachments || [];
    if (!text && !ids.length) throw httpError(400, "Reply is empty.");
    if (text.length > REPLY_MAX) throw httpError(400, "Reply is too long.");
    if (this.live.has(id) || meta.status === "running") throw httpError(409, "Claude is still working on this run.");
    if (meta.status === "handedOff") throw httpError(409, handedOffMessage(meta));
    if (meta.handoffPendingAt) throw httpError(409, SENDING_MESSAGE);
    if (!REPLYABLE.has(meta.status)) throw httpError(409, `Can't reply to a ${meta.status} run.`);
    const busy = this.terminalBusy(meta);
    if (busy) throw httpError(409, busy);
    if (opts.budgetUsd !== undefined) meta.budgetUsd = opts.budgetUsd;
    if (opts.model !== undefined && opts.model !== meta.model) {
      meta.model = opts.model;
      meta.effort = opts.effort ?? null;
      meta.resolvedModel = null;
    }
    const files = this._claim(id, ids);
    this._turn(meta, text || "See the attached files.", files);
    return meta;
  }

  // ------------------------------------------------------------ queued messages

  /**
   * Queue a message to send when the current turn ends (like typing ahead in the
   * CLI). Works mid-turn: it goes on the live turn's copy, which the turn saves.
   * Queued on a run that has already finished, it goes out straight away.
   */
  enqueue(id: string, text: string, autoSend?: boolean): RunMeta {
    text = String(text || "").trim();
    if (!text) throw httpError(400, "The message is empty.");
    if (text.length > REPLY_MAX) throw httpError(400, "The message is too long.");
    const meta = this._queueOwner(id);
    if (meta.status === "handedOff") throw httpError(409, handedOffMessage(meta));
    if (meta.handoffPendingAt) throw httpError(409, SENDING_MESSAGE);
    const queued = meta.queued || (meta.queued = []);
    if (queued.length >= QUEUE_MAX) throw httpError(409, `Up to ${QUEUE_MAX} messages can wait in the queue.`);
    queued.push({ id: crypto.randomBytes(4).toString("hex"), text, at: new Date().toISOString() });
    if (autoSend !== undefined) meta.queueAutoSend = !!autoSend;
    meta.queueBlocked = null;
    this._save(meta);
    if (!this.live.has(id) && drainable(meta)) this._drain(id);
    return this.live.get(id)?.meta || this.get(id) || meta;
  }

  /** Change a queued message that hasn't gone out yet (empty text removes it). Works mid-turn. */
  editQueued(id: string, qid: string, text: string): RunMeta {
    text = String(text || "").trim();
    if (!text) return this.removeQueued(id, qid);
    if (text.length > REPLY_MAX) throw httpError(400, "The message is too long.");
    const meta = this._queueOwner(id);
    const item = (meta.queued || []).find((q) => q.id === qid);
    if (!item) throw httpError(409, "That message was already sent.");
    item.text = text;
    this._save(meta);
    return meta;
  }

  /** Turn auto-send on or off (send the queue as the answer when Claude asks a question). Works mid-turn. */
  setQueueAutoSend(id: string, on: boolean): RunMeta {
    const meta = this._queueOwner(id);
    meta.queueAutoSend = !!on;
    this._save(meta);
    if (!this.live.has(id) && drainable(meta)) this._drain(id);
    return this.live.get(id)?.meta || this.get(id) || meta;
  }

  /** Take a message out of the queue. Works mid-turn. */
  removeQueued(id: string, qid: string): RunMeta {
    const meta = this._queueOwner(id);
    const before = (meta.queued || []).length;
    meta.queued = (meta.queued || []).filter((q) => q.id !== qid);
    if (meta.queued.length === before) throw httpError(409, "That message was already sent.");
    if (!meta.queued.length) meta.queueBlocked = null;
    this._save(meta);
    return meta;
  }

  /**
   * Send the whole queue now, as one reply: for a run that's waiting on a question,
   * was cancelled or interrupted (those hold the queue), or whose queue was blocked.
   */
  sendQueued(id: string, opts: ReplyOptions = {}): RunMeta {
    // An adopted run: take in what its terminal said first (it may have answered the question already).
    if (!this.live.has(id)) this.absorbTerminal(id);
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    if (!meta.queued || !meta.queued.length) throw httpError(409, "Nothing is queued.");
    // Sent while a question is open (auto-send), say so: Claude shouldn't read it as the answer.
    const text = (meta.status === "waiting" ? QUEUED_OVER_QUESTION + "\n\n" : "") + queuedText(meta.queued);
    const sent = this.reply(id, text, opts); // throws, leaving the queue as it was, if the run can't take a reply
    // The agent couldn't be started (the run failed on the spot): nothing went out, so the
    // queue stays, held (not retried) until it's sent by hand. A blocker from before (a run or
    // usage limit) is cleared, or the 30-second retry would keep sending it.
    if (!this.live.has(id)) {
      if (sent.queueBlocked) { sent.queueBlocked = null; this._save(sent); }
      return sent;
    }
    sent.queued = [];
    sent.queueBlocked = null;
    this._save(sent);
    return sent;
  }

  private _queueOwner(id: string): RunMeta {
    const live = this.live.get(id);
    const meta = live ? live.meta : this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    return meta;
  }

  /** Send the queue as the next turn if the run is idle and the limits allow it; otherwise say why it's held. */
  private _drain(id: string) {
    if (this.live.has(id)) return;
    const meta = this.get(id);
    if (!meta || !drainable(meta)) return;
    const gate = this.queueGate(meta);
    try {
      if (gate.blocker) throw new Error(gate.blocker);
      this.sendQueued(id, gate.budgetUsd === undefined ? {} : { budgetUsd: gate.budgetUsd });
    } catch (e: any) {
      const latest = this.get(id);
      if (latest && !this.live.has(id)) { latest.queueBlocked = e.message; this._save(latest); }
    }
  }

  /** Change a run's title. Works mid-turn: the live turn's copy is updated too. */
  rename(id: string, label: string): RunMeta {
    label = String(label || "").replace(/\s+/g, " ").trim();
    if (!label) throw httpError(400, "The title is empty.");
    if (label.length > LABEL_MAX) throw httpError(400, `Keep the title under ${LABEL_MAX} characters.`);
    const live = this.live.get(id);
    const meta = live ? live.meta : this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    meta.label = label;
    this._save(meta);
    return meta;
  }

  /** Note that a run's attached files were deleted by the cleanup. */
  markAttachmentsRemoved(id: string): void {
    if (this.live.has(id)) return;
    const meta = this.get(id);
    if (!meta) return;
    meta.attachmentsRemovedAt = new Date().toISOString();
    this._write(meta);
  }

  private _claim(runId: string, ids: string[] | undefined): Attachment[] {
    if (!ids || !ids.length) return [];
    if (!this.attachments) throw httpError(400, "Attachments aren't available.");
    return this.attachments.claim(runId, ids);
  }

  setPlanMode(id: string, on: boolean): RunMeta {
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    if (this.live.has(id)) throw httpError(409, "Wait for this turn to finish, then change plan mode.");
    if (meta.status === "handedOff") throw httpError(409, meta.handedOffTo === "hosted" ? handedOffMessage(meta) : "This run continued in a terminal (use Shift+Tab there).");
    if (meta.handoffPendingAt) throw httpError(409, SENDING_MESSAGE);
    meta.planMode = !!on;
    this._save(meta);
    return meta;
  }

  /** Stop a running turn, or dismiss a waiting question. False if there's nothing to cancel. */
  cancel(id: string): boolean {
    const live = this.live.get(id);
    if (live) {
      live.stopping = "cancel";
      killTree(live.child);
      return true;
    }
    const meta = this.get(id);
    if (meta && meta.status === "waiting") {
      // No process is alive while a run waits; cancelling just drops the question.
      meta.status = "cancelled";
      meta.question = null;
      this._save(meta);
      return true;
    }
    return false;
  }

  /**
   * Hand the conversation to a terminal: stop any running turn first so two
   * processes never write to one session, then stop driving it from here.
   */
  handOff(id: string): RunMeta {
    if (!this.live.has(id)) this.absorbTerminal(id); // an adopted run: what its terminal said last comes along
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    // An adopted run whose own terminal is still going: a second one on the same session would fork it.
    const busy = this.live.has(id) ? null : this.terminalBusy(meta);
    if (busy) throw httpError(409, busy);
    const live = this.live.get(id);
    if (live) {
      live.stopping = "handoff";
      killTree(live.child);
    }
    meta.status = "handedOff";
    meta.handedOffTo = "terminal";
    meta.handoffPendingAt = null;
    meta.question = null;
    meta.queued = [];
    meta.queueBlocked = null;
    meta.handedOffAt = new Date().toISOString();
    endWatch(meta, "Continued in a terminal.");
    this._save(meta);
    return meta;
  }

  // ------------------------------------------------------------ send to hosted (handoff.ts)

  /**
   * Lock a run while it's sent to the hosted dashboard: replies, queued messages and plan
   * mode wait until the hosted tab confirms (finishSend) or the send is called off (cancelSend).
   * Only a Claude run that isn't mid-turn can go: its transcript is what moves.
   */
  beginSend(id: string): RunMeta {
    // An adopted run: what its terminal said last comes along (a no-op for any other run).
    if (!this.live.has(id)) this.absorbTerminal(id);
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    if (agentOf(meta.agent).id !== "claude") throw httpError(400, "Only Claude runs can move to the hosted dashboard.");
    if (this.live.has(id) || meta.status === "running") throw httpError(409, "Wait for this turn to finish (or stop it), then send the run.");
    if (meta.status === "handedOff") throw httpError(409, handedOffMessage(meta));
    if (meta.handoffPendingAt) throw httpError(409, "This run is already being sent. Finish in the tab that opened, or cancel the send first.");
    if (!REPLYABLE.has(meta.status)) throw httpError(409, `Can't send a ${meta.status} run.`);
    // A session opened from a folder outside the workspace: the hosted dashboard has only the workspace's repos.
    if (meta.adoptedFrom?.outside) throw httpError(409, `This run works in ${meta.adoptedFrom.outside}, outside the workspace, so the hosted dashboard can't carry it on. Move it into this workspace first (From terminal, Move here), then send that.`);
    // Not while an adopted run's terminal is still going.
    const busy = this.terminalBusy(meta);
    if (busy) throw httpError(409, busy);
    meta.handoffPendingAt = new Date().toISOString();
    this._save(meta);
    return meta;
  }

  /**
   * The hosted dashboard has the run: this copy stops driving it, like a terminal hand-off.
   * Only while the send is still pending: a run whose send was cancelled, or that was continued
   * in a terminal, since is refused (409), so the hosted page can warn that two copies are live.
   * `attempt` is the send's handoffPendingAt (beginSend): a confirm for an earlier send is refused too.
   */
  finishSend(id: string, hostedRunUrl: string | null, attempt?: string): RunMeta {
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    if (!meta.handoffPendingAt || (attempt !== undefined && meta.handoffPendingAt !== attempt)) {
      throw httpError(409, meta.status === "handedOff" && meta.handedOffTo !== "hosted"
        ? "The run was continued in a terminal on your computer meanwhile."
        : "The send was cancelled on your computer meanwhile, so the run is still open there.");
    }
    meta.status = "handedOff";
    meta.handedOffTo = "hosted";
    meta.hostedRunUrl = hostedRunUrl;
    meta.handoffPendingAt = null;
    meta.question = null;
    meta.queued = [];
    meta.queueBlocked = null;
    meta.handedOffAt = new Date().toISOString();
    endWatch(meta, "Moved to the hosted dashboard, which watches it from now on.");
    this._save(meta);
    return meta;
  }

  /**
   * Unlock a run whose send didn't finish. False when it wasn't being sent. With `attempt`
   * (a send's handoffPendingAt), only that send: an earlier one failing late leaves a newer one be.
   */
  cancelSend(id: string, attempt?: string): boolean {
    const meta = this.get(id);
    if (!meta || !meta.handoffPendingAt || (attempt !== undefined && meta.handoffPendingAt !== attempt)) return false;
    meta.handoffPendingAt = null;
    this._save(meta);
    return true;
  }

  /** Where Claude Code keeps a session's transcript, or null when it isn't on this computer. */
  transcriptPath(sessionId: string): string | null { return this._transcriptPath(sessionId); }
  metaFile(id: string): string { return this._metaPath(id); }
  eventsFile(id: string): string { return this._eventsPath(id); }

  /** End a run's PR watch. Works mid-turn, like rename. */
  stopWatch(id: string, reason = "Stopped from the dashboard."): RunMeta {
    const live = this.live.get(id);
    const meta = live ? live.meta : this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    if (!watchActive(meta)) throw httpError(409, "This run isn't watching anything.");
    endWatch(meta, reason);
    this._save(meta);
    return meta;
  }

  /**
   * Approve a check watch's command: until then the server never runs it (a command Claude
   * wrote, which a prompt injection could have planted). The first check runs right away.
   */
  approveWatch(id: string, seen: { startedAt?: unknown; command?: unknown }, now = new Date()): RunMeta {
    const live = this.live.get(id);
    const meta = live ? live.meta : this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    if (meta.remote) throw httpError(409, "Approve it on the computer that runs it.");
    if (!watchActive(meta) || meta.watch!.kind !== "check") throw httpError(409, "This run has no check to approve.");
    // Approve only the command you looked at: a turn may have replaced it since the page showed it.
    if (seen.startedAt !== meta.watch!.startedAt || seen.command !== meta.watch!.command) {
      throw httpError(409, "The check changed since you looked at it. Read the command again before approving.");
    }
    meta.watch!.approval = "approved";
    meta.watch!.nextCheckAt = now.toISOString();
    meta.watch!.error = null;
    this._save(meta);
    return meta;
  }

  /** The routine Claude proposed in this run was created as `routineId`. */
  markRoutineCreated(id: string, routineId: string): RunMeta {
    const live = this.live.get(id);
    const meta = live ? live.meta : this.get(id);
    if (!meta || !meta.routineProposal) throw httpError(404, "This run hasn't proposed a routine.");
    meta.routineProposal.routineId = routineId;
    this._save(meta);
    return meta;
  }

  /**
   * The watcher's write: change an idle run's watch and save. Null (and nothing
   * saved) when the run is mid-turn or its watch isn't the one `startedAt` names
   * any more (replaced or ended while a check was in flight).
   */
  updateWatch(id: string, startedAt: string, fn: (w: RunWatch, meta: RunMeta) => void): RunMeta | null {
    if (this.live.has(id)) return null;
    const meta = this.get(id);
    if (!meta || !watchActive(meta) || meta.watch!.startedAt !== startedAt) return null;
    fn(meta.watch!, meta);
    this._save(meta);
    return meta;
  }

  /** Rating a run also closes it: the "needs me" flag clears. */
  setVerdict(id: string, verdict: RunMeta["verdict"]): RunMeta | null {
    const meta = this.get(id);
    if (!meta || !SETTLED.has(meta.status)) return null;
    meta.verdict = verdict;
    if (verdict) meta.flagged = false;
    this._save(meta);
    return meta;
  }

  /** Flag a run as needing you (kept in Focus until cleared). Works mid-turn, like rename. */
  setFlag(id: string, flagged: boolean): RunMeta {
    const live = this.live.get(id);
    const meta = live ? live.meta : this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    meta.flagged = !!flagged;
    this._save(meta);
    return meta;
  }

  /**
   * SSE: replay the saved events, then stream live ones (and meta changes) until
   * the client disconnects. The stream stays open across turns. An event's SSE id
   * is its index in the run's events; `after` (a reconnect's Last-Event-ID) skips
   * the ones the client already has.
   */
  subscribe(id: string, res: ServerResponse, after = -1): boolean {
    const meta = this.get(id);
    if (!meta) return false;
    // Synchronous read + add: no event can be appended in between.
    const events = this.events(id);
    for (let i = Math.max(0, after + 1); i < events.length; i++) res.write(`id: ${i}\nevent: event\ndata: ${JSON.stringify(events[i])}\n\n`);
    res.write(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`);
    let set = this.subscribers.get(id);
    if (!set) this.subscribers.set(id, (set = new Set()));
    set.add(res);
    res.on("close", () => {
      set.delete(res);
      if (!set.size) this.subscribers.delete(id);
    });
    return true;
  }

  private _broadcast(id: string, event: string, data: unknown, eventId: number | null = null) {
    const set = this.subscribers.get(id);
    if (!set) return;
    const payload = `${eventId === null ? "" : `id: ${eventId}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(payload);
  }

  // ------------------------------------------------------------ one turn

  private _append(meta: RunMeta, ev: RunEvent) {
    // The new event's index (its SSE id): the file is counted on this process's first append, as events() reads it.
    let index = this._counts.get(meta.id);
    if (index === undefined) {
      index = this._readEvents(meta.id).length;
      // A last line cut short (a crash mid-write) ends here, so this event starts a line of its own
      // instead of joining it as one unreadable line, which would shift every later index.
      if (!this._endsWithNewline(meta.id)) fs.appendFileSync(this._eventsPath(meta.id), "\n");
    }
    fs.appendFileSync(this._eventsPath(meta.id), JSON.stringify(ev) + "\n");
    this._counts.set(meta.id, index + 1);
    try { this.onEvent(meta, ev, index); } catch {}
    // subscribe() replays the file as events() reads it, so this index follows on from its last id.
    this._broadcast(meta.id, "event", ev, index);
  }

  /** The events file is missing, empty, or its last byte is a newline. */
  private _endsWithNewline(id: string): boolean {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this._eventsPath(id), "r");
      const size = fs.fstatSync(fd).size;
      if (!size) return true;
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      return last[0] === 0x0a;
    } catch { return true; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }

  /** `files` are a reply's attachments (the first turn's are already in `prompt`). */
  private _appsCli(): string | null {
    try { return this.appsCli(); } catch { return null; }
  }

  private _turn(meta: RunMeta, prompt: string, files: Attachment[] = []) {
    const first = meta.turns === 0;
    meta.turns += 1;
    meta.status = "running";
    meta.turnStartedAt = new Date().toISOString();
    meta.question = null;
    meta.warning = null;
    meta.deniedTools = null;
    meta.error = null;
    meta.effectivePermissionMode = null; // this turn's init sets it again
    this._cont.delete(meta.id); // the terminal-continuation cutoff moves with each dashboard turn
    if (meta.adoptedFrom) meta.adoptedFrom.inTerminal = false; // what the terminal says after this gets a divider of its own
    // Before the save below: the Factory's gate guard reads saved runs.
    if (!first && IMPLEMENT_PROMPT.test(prompt.trim())) markImplementing(meta, prompt.trim());
    // Snapshot the workspace's repos (runs alongside the spawn: claude takes seconds to
    // start, long before its first edit).
    try { this.onTurnStart(meta); } catch {}
    this._save(meta);

    if (!first) {
      const at = meta.turnStartedAt;
      this._append(meta, { type: "turn", turn: meta.turns, planMode: meta.planMode, uuid: crypto.randomUUID(), timestamp: at });
      this._append(meta, { type: "human", text: prompt, turn: meta.turns, uuid: crypto.randomUUID(), timestamp: at, ...(files.length ? { attachments: files } : {}) });
    }

    // The run's agent (agents/) builds the command line and translates what it prints.
    const agent = agentOf(meta.agent);
    // The run's attachments and outputs folder live outside a worktree's folder; allow using
    // them (permission prompts are denied here, so without this a worktree run couldn't).
    let outputsDir: string | null = null;
    try { outputsDir = this.attachments ? this.attachments.ensureOutputs(meta.id) : null; } catch {}
    const filesDir = this.attachments ? this.attachments.runDir(meta.id) : null;
    const addDirs = [...(filesDir && fs.existsSync(filesDir) ? [filesDir] : []), ...(meta.addDirs || []).filter((d) => fs.existsSync(d))];
    const turn: TurnInput = {
      first, sessionId: meta.sessionId, label: meta.label,
      // Agents that don't load Claude Code's skills get the skill's instructions for `/name args`
      // (a workspace skill from the run's folder, `/plugin:name` from the main workspace's plugins).
      prompt: (agent.id === "claude" ? (s: string) => s : (s: string) => expandSlash(s, meta.cwd, this.workspaceRoot || meta.cwd))(first ? prompt : promptWithAttachments(prompt, files)),
      model: meta.model, effort: meta.effort, planMode: !!meta.planMode, permissionMode: meta.permissionMode,
      budgetUsd: agent.capabilities.costUsd ? meta.budgetUsd : null,
      rules: [(agent.id === "claude" ? headlessRules : agentHeadlessRules)(this._appsCli()), isRoutedId(meta.model) ? LOCAL_MODEL_RULE : null, outputsDir ? outputsRule(outputsDir) : null, meta.extraPrompt || null].filter(Boolean).join("\n\n"),
      planRule: meta.planMode ? PLAN_MODE_RULE : null,
      addDirs,
    };
    const args = agent.turnArgs(turn);

    let child: ChildProcess;
    try {
      child = agent.spawn(args, {
        cwd: meta.cwd,
        env: outputsDir ? { ...process.env, DASHBOARD_OUTPUTS: outputsDir } : process.env,
        stdio: ["ignore", "pipe", "pipe"], // prompt is an argument; an open stdin can make the CLI wait forever
        windowsHide: true,
      }, turn);
    } catch (e) {
      // Thrown, not emitted (e.g. ENAMETOOLONG: a command line over Windows' 32,767 characters):
      // the turn never started, so it ends here as failed rather than staying "running".
      meta.status = "failed";
      meta.error = `Could not start ${agent.label}: ${(e && (e as Error).message) || e}`;
      meta.endedAt = new Date().toISOString();
      this._save(meta);
      try { this.onFinish(meta); } catch {}
      return;
    }
    const parseState: ParseState = { sessionId: first ? null : meta.sessionId, model: meta.model };
    const live: LiveTurn = { child, stopping: null, meta };
    this.live.set(meta.id, live);

    const costBefore = meta.costUsd || 0;
    const roundTripsBefore = meta.numTurns || 0;
    const watch: TurnWatch = { outputFiles: new Set(), bgTasks: new Map(), asyncAgents: new Map(), schedules: [] };
    let rawFinalText = ""; // last main-session text or result, question block intact
    let lastResultFailed: boolean | null = null;
    let buf = "";
    let stderr = "";
    let dirty = false;
    const flush = setInterval(() => { if (dirty) { this._save(meta); dirty = false; } }, 1500);

    const handle = (ev: RunEvent) => {
      if (ev.type === "system" && (ev.subtype === "commands_changed" || ev.subtype === "thinking_tokens")) return; // bulky noise
      // An agent that names its own session (Codex) tells us on its first turn: resume that one.
      if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string" && ev.session_id && ev.session_id !== meta.sessionId && agent.id !== "claude") meta.sessionId = ev.session_id;
      const main = ev.parent_tool_use_id == null;

      // Question blocks: remember the raw main-session text, store it without the block.
      if (ev.type === "assistant" && main && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            rawFinalText = b.text;
            if (b.text.includes("<<QUESTION>>")) b.text = stripBlock(b.text, "QUESTION");
            if (b.text.includes("<<WATCH>>")) b.text = stripBlock(b.text, "WATCH");
          }
        }
      }
      if (ev.type === "result" && typeof ev.result === "string") {
        if (ev.result.trim()) rawFinalText = ev.result;
        ev.result = stripBlock(stripBlock(ev.result, "QUESTION"), "WATCH").trim();
      }

      watchBackground(watch, ev);
      this._append(meta, ev);
      const failed = applyEvent(meta, ev, main, costBefore, roundTripsBefore);
      if (failed !== undefined) lastResultFailed = failed;
      dirty = true;
    };

    child.stdout!.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let raw: any;
        try { raw = JSON.parse(line); } catch { continue; }
        for (const ev of agent.parse(raw, parseState)) handle(ev);
      }
    });
    child.stderr!.on("data", (d) => { stderr = (stderr + d).slice(-4000); });

    let finished = false;
    const finish = (code: number | null, spawnErr?: Error) => {
      if (finished) return; // "error" and "close" can both fire
      finished = true;
      clearInterval(flush);
      this.live.delete(meta.id);
      // Re-read: a hand-off or plan-mode change may have been saved meanwhile.
      const current = this.get(meta.id);
      if (current) { meta.handedOffAt = current.handedOffAt; meta.verdict = current.verdict; meta.watch = current.watch; meta.routineProposal = current.routineProposal; }

      meta.endedAt = new Date().toISOString();
      meta.durationMs = (meta.durationMs || 0) + (Date.parse(meta.endedAt) - Date.parse(meta.turnStartedAt!));
      if (live.stopping === "handoff") {
        meta.status = "handedOff";
      } else if (live.stopping === "cancel") {
        meta.status = "cancelled";
      } else if (spawnErr) {
        meta.status = "failed";
        meta.error = `Could not start ${agent.label}: ${spawnErr.message}`;
      } else {
        const question = rawFinalText.includes("<<QUESTION>>") ? parseQuestion(rawFinalText) : null;
        if (question) {
          meta.status = "waiting";
          meta.question = question;
          meta.error = null;
        } else if (lastResultFailed !== null) {
          meta.status = lastResultFailed ? "failed" : "succeeded";
        } else {
          // No result event arrived: the exit code is the verdict.
          meta.status = code === 0 ? "succeeded" : "failed";
          if (code !== 0 && !meta.error) meta.error = stderr.trim().split("\n").slice(-3).join("\n") || `${agent.label} exited with code ${code}`;
        }
      }
      if (meta.status === "handedOff") endWatch(meta, "Continued in a terminal.");
      else { applyWatchBlock(meta, rawFinalText); applyRoutineBlock(meta, rawFinalText); }
      this._save(meta);
      this.onFinish(meta);
      // An adopted run: read past this turn's own lines now (once, not on every poll), taking in
      // anything its terminal said meanwhile.
      if (meta.adoptedFrom && meta.status !== "handedOff") { try { this.absorbTerminal(meta.id); } catch {} }
      // Messages typed during the turn are the next turn (once finish's own work has settled).
      if (drainable(meta)) setImmediate(() => this._drain(meta.id));

      // Give killed background tasks a moment to write their [killed] marker, then report them.
      setTimeout(() => {
        const warning = backgroundWarning(watch);
        if (!warning) return;
        const latest = this.get(meta.id);
        if (!latest || latest.turns !== meta.turns || latest.status === "running") return; // a new turn already started
        latest.warning = warning;
        this._save(latest);
      }, 1500);
    };
    child.on("error", (err) => finish(null, err));
    // "close" (not "exit") so the final result on stdout is parsed first.
    child.on("close", (code) => finish(code));
  }

  // ------------------------------------------------------------ terminal continuation

  /**
   * What happened in a terminal after the headless turns ("Continue in terminal").
   * The session keeps appending to its transcript
   * (~/.claude/projects/<workspace>/<sessionId>.jsonl); anything newer than the
   * last dashboard turn is the continuation. Read incrementally.
   */
  continuation(id: string) {
    const meta = this.get(id);
    if (!meta || meta.status === "running" || !meta.endedAt) return null;
    // An adopted run takes what's said in its terminal in as events instead (the page polls this, so it
    // shows within seconds); once it's continued in a terminal from here, it's like any other run.
    if (meta.adoptedFrom && meta.status !== "handedOff") {
      const after = this.absorbTerminal(id) || meta;
      return { events: [], lastActivityAt: after.terminalActivityAt || null };
    }
    const file = this._transcriptPath(meta.sessionId);
    if (!file) return { events: [], lastActivityAt: null };

    const c = this._cont.get(id) || { offset: 0, events: [] as RunEvent[], cutoff: Date.parse(meta.endedAt) };
    try {
      let read: ReturnType<typeof readSessionEvents>;
      try { read = readSessionEvents(file, c.cutoff, c.offset); }
      catch (e: any) {
        if (e?.status !== 413) throw e;
        // A transcript too big to read whole the first time: its last part holds what came after the run.
        read = readSessionEvents(file, c.cutoff, Math.max(c.offset, e.size - MAX_SESSION_BYTES));
      }
      if (read.to < c.offset) c.events = []; // rewritten from the start
      c.offset = read.to;
      c.events.push(...read.events);
    } catch {
      return { events: c.events, lastActivityAt: null };
    }
    this._cont.set(id, c);
    const last = c.events.length ? c.events[c.events.length - 1].timestamp : null;
    if (c.events.length && !meta.continuedAt) {
      meta.continuedAt = c.events[0].timestamp;
      this._write(meta);
    }
    return { events: c.events, lastActivityAt: last };
  }

  /** An adopted run's session file: where it was found, else looked up as any run's. */
  private _adoptedFile(meta: RunMeta): string | null {
    const f = meta.adoptedFrom?.file;
    if (!f) return this._transcriptPath(meta.sessionId);
    // Not looked for elsewhere when it's gone (pruned): that would scan every project folder on each poll.
    return fs.existsSync(f) && path.basename(f) === `${meta.sessionId}.jsonl` ? f : null;
  }

  private _transcriptPath(sessionId: string): string | null {
    if (this._paths.has(sessionId)) return this._paths.get(sessionId)!;
    const root = path.join(claudeDir(), "projects");
    let found: string | null = null;
    try {
      for (const dir of fs.readdirSync(root)) {
        const candidate = path.join(root, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) { found = candidate; break; }
      }
    } catch {}
    if (found) this._paths.set(sessionId, found); // misses aren't cached: the file may appear later
    return found;
  }

  /** Per-preset stats: the seed of the trust ledger. */
  stats() {
    const byPreset: Record<string, any> = {};
    for (const r of this.list()) {
      if (!SETTLED.has(r.status)) continue;
      if (terminalOnlyRun(r)) continue; // a terminal session with no turn from here isn't the dashboard's record
      const key = r.presetId || "_adhoc";
      const s = (byPreset[key] = byPreset[key] || { runs: 0, succeeded: 0, rated: 0, good: 0, costUsd: 0, durationMs: 0, lastRunAt: null });
      s.runs++;
      s.durationMs += r.durationMs || 0;
      if (r.status === "succeeded") s.succeeded++;
      if (r.verdict) { s.rated++; if (r.verdict === "good") s.good++; }
      s.costUsd += r.costUsd || 0;
      if (!s.lastRunAt || r.startedAt > s.lastRunAt) s.lastRunAt = r.startedAt;
    }
    return byPreset;
  }
}

// ------------------------------------------------------------------ helpers (exported for tests)

/** Older runs predate multi-turn fields; fill them so the UI can rely on them. */
export function normaliseMeta(m: any): RunMeta {
  if (m.turns == null) m.turns = 1;
  if (m.planMode == null) m.planMode = m.permissionMode === "plan";
  if (m.question === undefined) m.question = null;
  if (m.warning === undefined) m.warning = null;
  if (m.flagged === undefined) m.flagged = false;
  if (m.turnStartedAt === undefined) m.turnStartedAt = m.startedAt;
  if (m.watch === undefined) m.watch = null;
  if (m.watch && !m.watch.kind) m.watch.kind = "github-pr";
  if (m.routineProposal === undefined) m.routineProposal = null;
  if (!Array.isArray(m.queued)) m.queued = [];
  if (m.queueBlocked === undefined) m.queueBlocked = null;
  return m;
}

// ------------------------------------------------------------------ queued messages

/**
 * Whether a run's queue goes out by itself: after a turn that simply ended, or with
 * auto-send on, also one that ended with a question. Otherwise a question waits for
 * your answer, and a cancel or restart means you stepped in: those hold the queue
 * until you send it.
 */
export function drainable(meta: Pick<RunMeta, "status" | "queued" | "queueAutoSend">): boolean {
  const ended = meta.status === "succeeded" || meta.status === "failed" || (meta.status === "waiting" && !!meta.queueAutoSend);
  return ended && !!meta.queued && meta.queued.length > 0;
}

/** Leads a queue auto-sent over an open question. */
export const QUEUED_OVER_QUESTION = "(Sent from my queue: I typed this before you asked your question, so it isn't my answer. Work on this first, then ask your question again when you're done.)";

/** Queued messages as one reply, in the order they were typed (the CLI sends a backlog the same way). */
export function queuedText(queued: QueuedMessage[]): string {
  return queued.map((q) => q.text).join("\n\n");
}

// ------------------------------------------------------------------ PR watch

export function watchActive(meta: Pick<RunMeta, "watch">): boolean {
  return !!meta.watch && !meta.watch.endedAt;
}

export function endWatch(meta: RunMeta, reason: string, now = new Date()) {
  if (!watchActive(meta)) return;
  meta.watch!.endedAt = now.toISOString();
  meta.watch!.endReason = reason;
}

export type WatchBlock =
  | { stop: true }
  | { noop: true }
  | { kind: "github-pr"; prs: { repo: string; number: number }[]; everyMinutes: number; days: number; prompt: string }
  | { kind: "every"; everyMinutes: number; days: number; prompt: string }
  | { kind: "check"; command: string; until: "change" | "success"; everyMinutes: number; days: number; prompt: string }
  | { error: string };

/** "owner/name#12", "https://github.com/owner/name/pull/12", or { repo, number } / { url }. */
function parseWatchedPr(v: any): { repo: string; number: number } | null {
  if (v && typeof v === "object") {
    if (v.url) return parseWatchedPr(String(v.url));
    const repo = String(v.repo || "").trim();
    const number = Number(v.number);
    return /^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isInteger(number) && number > 0 ? { repo, number } : null;
  }
  const s = String(v || "").trim();
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:#|\/pull\/)(\d+)\b/.exec(s);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** A block's JSON body (a code fence around it is fine), or { error }. */
function blockJson(body: string, what: string): { data: any } | { error: string } {
  const text = body.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let data: any = null;
  try { data = JSON.parse(text); } catch { return { error: `The ${what} block isn't valid JSON.` }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: `The ${what} block isn't a JSON object.` };
  return { data };
}

const clampInt = (n: any, lo: number, hi: number, dflt: number) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : dflt);

/**
 * Parse a <<WATCH>> block. Null when there's no marker; { error } when it can't be used.
 * The kind is `kind`, else what the block names: `prs` (or `pr`), `command`, `every`.
 */
export function parseWatch(text: string): WatchBlock | null {
  const m = findBlock(text || "", "WATCH");
  if (!m) return null;
  const json = blockJson(m.body, "watch");
  if ("error" in json) return json;
  const data = json.data;
  if (data.stop === true) return { stop: true };
  if (data.noop === true) return { noop: true };
  const kind = data.kind || (data.prs || data.pr ? "github-pr" : data.command ? "check" : data.every != null ? "every" : "github-pr");
  const prompt = String(data.prompt || "").trim().slice(0, WATCH_PROMPT_MAX);
  if (kind === "every") {
    const minutes = parseDuration(data.every ?? data.everyMinutes);
    if (minutes === null) return { error: `Can't read the interval ${JSON.stringify(data.every ?? data.everyMinutes ?? null)} (use "every": "30m" or "2h").` };
    if (minutes < LOOP_MIN_MINUTES || minutes > LOOP_MAX_MINUTES) return { error: `A loop wakes every ${LOOP_MIN_MINUTES} minutes to 24 hours (this one asked for every ${formatMinutes(minutes)}).` };
    if (!prompt) return { error: "The loop has no prompt: say what to do on each wake-up." };
    return { kind, everyMinutes: minutes, days: clampInt(data.days, 1, LOOP_MAX_DAYS, LOOP_DEFAULT_DAYS), prompt };
  }
  if (kind === "check") {
    const command = String(data.command || "").trim();
    if (!command) return { error: "The check has no command." };
    if (command.length > CHECK_COMMAND_MAX) return { error: `The check's command is longer than ${CHECK_COMMAND_MAX} characters.` };
    const until = data.until === "success" ? "success" : data.until == null || data.until === "change" ? "change" : null;
    if (!until) return { error: `Unknown "until" ${JSON.stringify(data.until)} (use "change" or "success").` };
    const every = data.every != null ? parseDuration(data.every) : null;
    return {
      kind, command, until,
      everyMinutes: clampInt(every ?? data.everyMinutes, WATCH_MIN_MINUTES, WATCH_MAX_MINUTES, WATCH_DEFAULT_MINUTES),
      days: clampInt(data.days, 1, LOOP_MAX_DAYS, LOOP_DEFAULT_DAYS),
      prompt: prompt || CHECK_DEFAULT_PROMPT,
    };
  }
  if (kind !== "github-pr") return { error: `Unknown watch kind "${kind}" (github-pr, every and check are supported).` };
  const raw = Array.isArray(data.prs) ? data.prs : data.pr ? [data.pr] : [];
  const prs: { repo: string; number: number }[] = [];
  for (const v of raw) {
    const pr = parseWatchedPr(v);
    if (!pr) return { error: `Can't read the pull request ${JSON.stringify(v)} (use "owner/name#123" or its URL).` };
    if (!prs.some((p) => p.repo.toLowerCase() === pr.repo.toLowerCase() && p.number === pr.number)) prs.push(pr);
  }
  if (!prs.length) return { error: "The watch block names no pull requests." };
  if (prs.length > WATCH_MAX_PRS) return { error: `Watch at most ${WATCH_MAX_PRS} pull requests at once.` };
  return {
    kind: "github-pr",
    prs,
    everyMinutes: clampInt(data.everyMinutes, WATCH_MIN_MINUTES, WATCH_MAX_MINUTES, WATCH_DEFAULT_MINUTES),
    days: clampInt(data.days, 1, WATCH_MAX_DAYS, WATCH_DEFAULT_DAYS),
    prompt: prompt || WATCH_DEFAULT_PROMPT,
  };
}

/**
 * Apply the turn's watch block, if any. A new block replaces the watch; PRs it
 * already watched keep what the last check saw, so replacing doesn't re-baseline them,
 * and a check with the same command keeps its approval and last result.
 * {"noop":true} leaves the watch as it is and counts a quiet wake-up; any other turn that
 * ends while a watch is on resets the count. No block leaves a running watch as it is.
 */
export function applyWatchBlock(meta: RunMeta, text: string, now = new Date()) {
  const block = parseWatch(text);
  const active = watchActive(meta);
  if (!block || "noop" in block) {
    if (active) meta.watch!.quiet = block ? (meta.watch!.quiet || 0) + 1 : 0;
    return;
  }
  if ("error" in block) {
    // A running watch carries on as it was; otherwise record a watch that never started, so the run says why.
    if (active) { meta.watch!.error = `A new watch block was ignored: ${block.error}`; return; }
    meta.watch = blankWatch("github-pr", now, WATCH_DEFAULT_MINUTES, "", now);
    meta.watch.endedAt = now.toISOString();
    meta.watch.endReason = `Couldn't start the watch: ${block.error}`;
    return;
  }
  if ("stop" in block) { endWatch(meta, "Claude ended the watch.", now); return; }
  const old = active ? meta.watch! : null;
  // An interval loop lives at least two intervals, so it always gets its first wake-up (a 24 h
  // loop for "1 day" would otherwise expire the moment it's due).
  const lifeMs = Math.max(block.days * 86400000, block.kind === "every" ? 2 * block.everyMinutes * 60000 : 0);
  const w = blankWatch(block.kind, now, block.everyMinutes, block.prompt, new Date(now.getTime() + lifeMs));
  w.wakes = old ? old.wakes : 0;
  if (block.kind === "github-pr") {
    const previous = old?.kind === "github-pr" ? old.prs : [];
    w.prs = block.prs.map((p) => {
      const was = previous.find((o) => o.repo.toLowerCase() === p.repo.toLowerCase() && o.number === p.number);
      return { repo: p.repo, number: p.number, seen: was ? was.seen : null };
    });
  } else if (block.kind === "every") {
    // The first wake-up is one interval from now: this turn was the first pass.
    w.nextCheckAt = new Date(now.getTime() + block.everyMinutes * 60000).toISOString();
  } else {
    const same = old?.kind === "check" && old.command === block.command;
    w.command = block.command;
    w.until = block.until;
    w.approval = same ? old!.approval : "pending";
    w.lastResult = same ? old!.lastResult ?? null : null;
  }
  meta.watch = w;
}

function blankWatch(kind: RunWatch["kind"], now: Date, everyMinutes: number, prompt: string, expires: Date): RunWatch {
  return {
    kind,
    prs: [],
    everyMinutes,
    prompt,
    startedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    nextCheckAt: now.toISOString(), // check right away: the first look records where things stand
    lastCheckAt: null,
    lastChangeAt: null,
    lastChange: null,
    wakes: 0,
    quiet: 0,
    error: null,
    endedAt: null,
    endReason: null,
  };
}

// ------------------------------------------------------------------ routine proposals

/**
 * Apply the turn's <<ROUTINE>> block, if any: Claude proposes a routine, which waits on the
 * run page until you create it (Claude never schedules one by itself). The run's workspace,
 * model and effort fill in what the block leaves out.
 */
export function applyRoutineBlock(meta: RunMeta, text: string, now = new Date()) {
  const m = findBlock(text || "", "ROUTINE");
  if (!m) return;
  const json = blockJson(m.body, "routine");
  const proposal: RoutineProposal = { routine: {}, proposedAt: now.toISOString(), error: null, routineId: null };
  if ("error" in json) proposal.error = json.error;
  else {
    const d = json.data;
    try {
      const { id: _id, enabled: _on, ...routine } = checkRoutine({
        ...d,
        id: "proposal",
        workspace: d.workspace || meta.workspace || undefined,
        model: d.model || meta.model || undefined,
        effort: d.effort || meta.effort || undefined,
      });
      proposal.routine = routine;
    } catch (e) {
      proposal.routine = { label: String(d.label || "").slice(0, 80), prompt: String(d.prompt || "").slice(0, 8000) };
      proposal.error = (e as Error).message;
    }
  }
  meta.routineProposal = proposal;
}

/** When a run last did something (shared/remote.ts, where the mirror and the web read it too). */
export { lastActivity };

/** `/implement X` or a plugin's `/multirepo:implement X` (not Explain: that only reads). */
export const IMPLEMENT_PROMPT = /^\/(?:[\w.-]+:)?implement\s+\S/;
/** The implement skill, called by the model with the Skill tool (`implement`, `multirepo:implement`). */
const IMPLEMENT_SKILL = /^\/?(?:[\w.-]+:)?implement$/;

/** A later turn implements a ticket: flag the run, and keep the ticket `prompt` (an `/implement X`) names, if any. */
function markImplementing(meta: RunMeta, prompt: string) {
  meta.implementing = true;
  const ticket = implementTicket(prompt);
  if (ticket) meta.implementingTicket = ticket;
}

/** Update counters from one event. For a result, returns whether it failed. */
const MAX_DENIED_TOOLS = 20;

/** The MCP tool names in a result's permission_denials ([{ tool_name, tool_use_id, tool_input }]). */
export function deniedMcpTools(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.map((d) => d?.tool_name).filter((n): n is string => typeof n === "string" && /^mcp__[A-Za-z0-9_-]+$/.test(n) && n.length <= 200);
  return [...new Set(out)];
}

export function applyEvent(meta: RunMeta, ev: RunEvent, main: boolean, costBefore: number, roundTripsBefore: number): boolean | undefined {
  if (ev.type === "system" && ev.subtype === "init" && main) {
    // The CLI can downgrade the requested mode (e.g. auto isn't available on every model).
    meta.effectivePermissionMode = ev.permissionMode || null;
    meta.resolvedModel = ev.model || meta.resolvedModel || null;
  }
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type === "tool_use") {
        meta.toolCalls++;
        meta.lastActivity = toolLabel(b.name, b.input);
        if (main && b.name === "Skill" && IMPLEMENT_SKILL.test(String(b.input?.skill || ""))) markImplementing(meta, `/implement ${String(b.input?.args || "").trim()}`);
      } else if (b.type === "text" && main && b.text && b.text.trim()) {
        meta.lastActivity = b.text.trim().split("\n")[0].slice(0, 140);
      }
    }
  }
  if (ev.type === "result") {
    // A turn can print several results (a background agent finishing re-invokes the
    // model); each carries running totals, so the last one wins. total_cost_usd covers
    // the whole session, earlier (resumed) turns included, so it is the run's total:
    // adding it to the previous turns' total counted them again.
    // A local or team model costs nothing here (Claude Code would price it as a Claude model).
    meta.costUsd = isRoutedId(meta.model) ? costBefore : Math.max(costBefore, ev.total_cost_usd || 0);
    meta.numTurns = roundTripsBefore + (ev.num_turns || 0);
    const text = typeof ev.result === "string" ? ev.result : "";
    meta.resultText = text.slice(0, RESULT_TEXT_MAX);
    // MCP tools refused for want of an allow rule: the run page offers to allow the server. Kept over
    // the turn's results (each lists its own), so a later one doesn't hide an earlier refusal.
    const denied = deniedMcpTools(ev.permission_denials);
    if (denied.length) meta.deniedTools = [...new Set([...(meta.deniedTools || []), ...denied])].slice(0, MAX_DENIED_TOOLS);
    // Status is settled when the process exits (more output can follow a result).
    const failed = !!(ev.is_error || (ev.subtype && ev.subtype !== "success"));
    meta.error = failed ? (ev.subtype && ev.subtype !== "success" ? ev.subtype : text.slice(0, 300) || "error") : null;
    return failed;
  }
  return undefined;
}

/** Short label for a tool call: what it does, not its raw input. */
export function toolLabel(name: string, input: any): string {
  input = input || {};
  const base = (p: string) => String(p || "").split(/[\\/]/).pop();
  let v: string;
  switch (name) {
    case "Bash": case "PowerShell": v = input.description || input.command; break;
    case "Read": case "Edit": case "Write": case "NotebookEdit": v = base(input.file_path || input.notebook_path); break;
    case "Grep": v = `"${input.pattern}"${input.path ? ` in ${base(input.path)}` : ""}`; break;
    case "Glob": v = input.pattern; break;
    case "Skill": v = `/${input.skill}${input.args ? " " + input.args : ""}`; break;
    case "Agent": case "Task": v = input.description; break;
    default: v = input.description || input.query || input.url || input.prompt || input.command || "";
  }
  return `${name}${v ? " · " + String(v).split("\n")[0].slice(0, 120) : ""}`;
}

/** Parse the <<QUESTION>> block. Never returns null for text that has the marker. */
export function parseQuestion(text: string): Question[] | null {
  const m = findBlock(text, "QUESTION");
  if (!m) return null;
  let body = m.body.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let data: any = null;
  try { data = JSON.parse(body); } catch {}
  const list = Array.isArray(data?.questions) ? data.questions : Array.isArray(data) ? data : data && typeof data === "object" ? [data] : null;
  const questions = (list || [])
    .filter((q: any) => q && (q.question || q.header))
    .map((q: any): Question => ({
      question: String(q.question || q.header),
      header: q.header ? String(q.header).slice(0, 40) : undefined,
      multiSelect: !!q.multiSelect,
      options: (Array.isArray(q.options) ? q.options : [])
        .map((o: any) => (typeof o === "string" ? { label: o } : { label: String(o?.label ?? ""), description: o?.description ? String(o.description) : undefined }))
        .filter((o: any) => o.label),
    }));
  if (questions.length) return questions;
  // Unparseable: still a question, answered in free text.
  const before = text.slice(0, m.start).trim().split("\n").pop() || "";
  return [{ question: body && !body.startsWith("{") ? body : before || "Claude needs your input to continue.", options: [] }];
}

function watchBackground(w: TurnWatch, ev: RunEvent) {
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type === "tool_use" && SCHEDULE_TOOLS.has(b.name)) w.schedules.push(b.name);
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && b.input?.run_in_background) {
        w.asyncAgents.set(b.id, b.input.description || "a background agent");
      }
    }
  }
  if (ev.type === "user" && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c.text || "").join("\n") : "";
      const out = /Output is being written to:\s*(\S+?\.output)\b/.exec(text);
      if (out) w.outputFiles.add(out[1]);
      if (/Async agent launched/i.test(text) && !w.asyncAgents.has(b.tool_use_id)) w.asyncAgents.set(b.tool_use_id, "a background agent");
    }
  }
  if (ev.type === "system" && ev.subtype === "task_started" && ev.is_backgrounded) {
    w.bgTasks.set(ev.task_id, ev.description || ev.task_type || "a background task");
  }
  const done = (s: any) => ["completed", "failed", "killed", "stopped", "cancelled"].includes(String(s || ""));
  if (ev.type === "system" && ev.subtype === "task_notification" && done(ev.status)) {
    w.bgTasks.delete(ev.task_id);
    if (ev.tool_use_id) w.asyncAgents.delete(ev.tool_use_id);
  }
  if (ev.type === "system" && ev.subtype === "task_updated" && done(ev.patch?.status)) w.bgTasks.delete(ev.task_id);
}

/** What was cut off when the turn's process exited, as one sentence, or null. */
export function backgroundWarning(w: TurnWatch): string | null {
  const stopped: string[] = [];
  for (const file of w.outputFiles) {
    let tail = "";
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, "r");
      const len = Math.min(st.size, 200);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, st.size - len);
      fs.closeSync(fd);
      tail = b.toString("utf-8");
    } catch { continue; }
    if (/\[killed\]\s*$/.test(tail)) stopped.push(`a background command (${path.basename(file)})`);
  }
  for (const d of w.bgTasks.values()) stopped.push(`"${d}"`);
  for (const d of w.asyncAgents.values()) stopped.push(`the agent "${d}"`);
  if (w.schedules.length) stopped.push(`a recurring schedule (${[...new Set(w.schedules)].join(", ")})`);
  if (!stopped.length) return null;
  return `Background work stopped when the turn ended: ${[...new Set(stopped)].join(", ")}. Reply to have Claude run it in the foreground, or continue in a terminal.`;
}

function killTree(child: ChildProcess) {
  const pid = child.pid;
  if (process.platform === "win32" && pid) {
    // Kill the whole tree; claude's Bash/PowerShell children otherwise linger.
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    child.kill("SIGTERM");
  }
}

export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

export const SENDING_MESSAGE = "This run is being sent to the hosted dashboard. Finish in the tab that opened, or cancel the send.";

/** How many tools the assistant called in these events. */
function toolUses(events: RunEvent[]): number {
  return events.filter((e) => e.type === "assistant").reduce((n, e) => n + (e.message?.content || []).filter((b: any) => b.type === "tool_use").length, 0);
}

/** Why a handed-off run takes no replies here. */
export function handedOffMessage(meta: Pick<RunMeta, "handedOffTo">): string {
  return meta.handedOffTo === "hosted" ? "This run moved to the hosted dashboard; reply there." : "This run continued in a terminal; reply there.";
}

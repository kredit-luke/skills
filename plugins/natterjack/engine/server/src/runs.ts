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
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { Attachment, Effort, PermissionMode, QueuedMessage, Question, RunEvent, RunMeta, RunWatch, WatchedPr } from "../../shared/api.ts";
import { AGENT_HEADLESS_RULES, agentOf, type ParseState, type TurnInput } from "./agents/index.ts";
import { LOCAL_MODEL_RULE, isRoutedId } from "./models/routes.ts";
import { expandSlash } from "./agents/skills.ts";
import { promptWithAttachments, type Attachments } from "./attachments.ts";

const RESULT_TEXT_MAX = 4000;
const REPLY_MAX = 20000;
const LABEL_MAX = 120;
const QUEUE_MAX = 10;
/** How often a queue a limit held back is tried again. */
const QUEUE_RETRY_MS = 30000;
/** Backstop for run files edited outside this server (a file added or removed is caught by name). */
const LIST_TTL_MS = 10000;
/**
 * Where a markdown text has code: fenced blocks (``` or ~~~, closed by a fence of the same
 * character at least as long; unclosed runs to the end) and inline spans (a run of N backticks
 * up to the next run of exactly N). Half-open [start, end) offsets.
 */
export function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const inline = (from: number, to: number) => {
    const s = text.slice(from, to);
    const runs = /`+/g;
    for (let m: RegExpExecArray | null; (m = runs.exec(s)); ) {
      const n = m[0].length;
      const next = /`+/g;
      next.lastIndex = m.index + n;
      let c: RegExpExecArray | null;
      while ((c = next.exec(s)) && c[0].length !== n) {}
      if (c) { out.push([from + m.index, from + c.index + n]); runs.lastIndex = c.index + n; }
    }
  };
  const fenceRe = /^[ \t]{0,3}(`{3,}|~{3,})/;
  let pos = 0, prose = 0;
  let open: { ch: string; len: number; start: number } | null = null;
  for (const line of text.split("\n")) {
    const lineEnd = pos + line.length;
    const f = fenceRe.exec(line);
    if (open) {
      if (f && f[1][0] === open.ch && f[1].length >= open.len && !line.slice(f[0].length).trim()) { out.push([open.start, lineEnd]); open = null; prose = lineEnd + 1; }
    } else if (f && !(f[1][0] === "`" && line.slice(f[0].length).includes("`"))) {
      inline(prose, pos);
      open = { ch: f[1][0], len: f[1].length, start: pos };
    }
    pos = lineEnd + 1;
  }
  if (open) out.push([open.start, text.length]);
  else inline(prose, text.length);
  return out;
}

/**
 * A <<QUESTION>> or <<WATCH>> block: the first marker that isn't inside code (codeRanges). A
 * marker in code (Claude explaining how runs work) is just text: matching it would turn the
 * rest of the answer into a question and cut the answer off there.
 */
export function findBlock(text: string, tag: "QUESTION" | "WATCH"): { start: number; end: number; body: string } | null {
  text = text || "";
  const open = new RegExp(`<<${tag}>>`, "g");
  let code: [number, number][] | null = null;
  for (let m: RegExpExecArray | null; (m = open.exec(text)); ) {
    const start = m.index;
    code ??= codeRanges(text);
    if (code.some(([a, b]) => start >= a && start < b)) continue;
    const from = m.index + m[0].length;
    const close = text.indexOf(`<</${tag}>>`, from);
    const end = close < 0 ? text.length : close + `<</${tag}>>`.length;
    return { start, end, body: text.slice(from, close < 0 ? text.length : close) };
  }
  return null;
}

/** The text without its block (if any). */
export function stripBlock(text: string, tag: "QUESTION" | "WATCH"): string {
  const b = findBlock(text, tag);
  return b ? `${text.slice(0, b.start).trimEnd()}\n${text.slice(b.end).trimStart()}`.trim() : text;
}
const WATCH_DEFAULT_MINUTES = 5;
const WATCH_MIN_MINUTES = 2;
const WATCH_MAX_MINUTES = 60;
const WATCH_DEFAULT_DAYS = 7;
const WATCH_MAX_DAYS = 14;
const WATCH_MAX_PRS = 10;
const WATCH_PROMPT_MAX = 8000;
const WATCH_DEFAULT_PROMPT = "Check each pull request: act on new review feedback, fix failing checks if the fix is yours to make, update a branch that is behind, and report each PR's status in a short table.";
const SCHEDULE_TOOLS = new Set(["CronCreate", "ScheduleWakeup", "Monitor"]);
/** A run in one of these can take a reply. */
const REPLYABLE = new Set(["waiting", "succeeded", "failed", "cancelled", "interrupted"]);
/** Finished for the purposes of stats and verdicts. */
const SETTLED = new Set(["waiting", "succeeded", "failed", "cancelled", "interrupted", "handedOff"]);

export const HEADLESS_RULES = `You are running headless inside the workspace dashboard (claude -p). The AskUserQuestion tool is not available and there is no terminal to type into.
Whenever you would call AskUserQuestion, or you otherwise need a decision from the user before you can continue (an approval gate, a choice between options, missing input), do NOT guess, do NOT skip the step, and do NOT treat silence as approval. Instead, end your turn with exactly one block in this format and then stop:
<<QUESTION>>
{"questions":[{"question":"<full question>","header":"<short label>","multiSelect":false,"options":[{"label":"<option>","description":"<what it means>"}]}]}
<</QUESTION>>
Put any explanation the user needs before the block. The user's answer arrives as your next message. Approval gates must always be surfaced this way, never bypassed. Skills that say to use AskUserQuestion mean this block here.

Background work does not survive here. This process exits the moment your turn ends, and everything it started in the background is killed with it; no task notification will re-invoke you after that.
So, overriding any skill or instruction that says otherwise (for example a code-review skill, or "run_in_background: true"):
- Never set run_in_background (on Bash or on the Agent tool), and never plan to "wait for a notification". Subagents are fine: call the Agent tool normally, in the foreground, and wait for its result.
- Run long commands in the foreground and wait for them, with a Bash timeout of up to 600000 ms. If one needs longer than 10 minutes, tell the user it has to continue in a terminal.
- A process that must keep running after your turn (e.g. dev servers) cannot be started from here. Say so and point to the dashboard's Apps page (it starts and stops the workspace apps) or a terminal.
- Never tell the user something is "running in the background" at the end of your turn; it will not be.
- Don't schedule recurring checks (CronCreate, /loop, ScheduleWakeup, Monitor): the schedule stops when your turn ends.
- To keep monitoring GitHub pull requests (a PR monitor, babysitting reviews or checks), do one check now, then end your turn with a watch block instead of a loop. The dashboard checks the PRs every few minutes and resumes this conversation only when something changes (a new review or comment, checks failing, the branch falling behind or conflicting, approval), sending you the changes followed by your prompt. It stops by itself once every PR is merged or closed.
<<WATCH>>
{"prs":["owner/repo#123"],"everyMinutes":5,"prompt":"<what to do on each wake-up: the monitoring cycle>"}
<</WATCH>>
  A watch stays on across turns. End a later turn with a new block to replace it, or with <<WATCH>>{"stop":true}<</WATCH>> to end it. For any other ongoing monitoring, do one check now and suggest a terminal.

Don't end on a to-do list for the user. If you finish with follow-up steps you could do yourself (commit, open a PR, deploy, publish, update the ticket), end with the question block offering to do them, recommended option first, instead of listing them as "next steps". Otherwise the dashboard shows the run as Done while work is still waiting.

The same goes for handing work back: if your turn ends with the user doing something and reporting back (test a change, reload a page, add a secret, check an email, try again), end with the question block too, e.g. "How did it go?" with options like "It worked", "It failed (I'll paste the error)" and "Still testing". End without a block only when the work is actually finished.`;

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
  queueGate: QueueGate;
  attachments: Attachments | null;
  private _cont = new Map<string, any>();
  private _paths = new Map<string, string>();
  /** list() parses every run file; kept until a write, a file added or removed, or LIST_TTL_MS. */
  private _listCache: { runs: RunMeta[]; names: string; at: number } | null = null;
  /** Events in each streamed run's file: the SSE id of its next live event. */
  private _counts = new Map<string, number>();

  constructor(ledgerDir: string, { onFinish, onTurnStart, onChange, queueGate, attachments }: { onFinish?: (meta: RunMeta) => void; onTurnStart?: (meta: RunMeta) => void; onChange?: (meta: RunMeta) => void; queueGate?: QueueGate; attachments?: Attachments } = {}) {
    this.runsDir = path.join(ledgerDir, "runs");
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.onFinish = onFinish || (() => {});
    this.onTurnStart = onTurnStart || (() => {});
    this.onChange = onChange || (() => {});
    this.queueGate = queueGate || (() => ({ blocker: null }));
    this.attachments = attachments || null;
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

  /** Send a reply: a new turn on the same session. Throws with a user-facing message. */
  reply(id: string, text: string, opts: ReplyOptions = {}): RunMeta {
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    text = String(text || "").trim();
    const ids = opts.attachments || [];
    if (!text && !ids.length) throw httpError(400, "Reply is empty.");
    if (text.length > REPLY_MAX) throw httpError(400, "Reply is too long.");
    if (this.live.has(id) || meta.status === "running") throw httpError(409, "Claude is still working on this run.");
    if (meta.status === "handedOff") throw httpError(409, "This run continued in a terminal; reply there.");
    if (!REPLYABLE.has(meta.status)) throw httpError(409, `Can't reply to a ${meta.status} run.`);
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
    if (meta.status === "handedOff") throw httpError(409, "This run continued in a terminal; reply there.");
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
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    if (!meta.queued || !meta.queued.length) throw httpError(409, "Nothing is queued.");
    // Sent while a question is open (auto-send), say so: Claude shouldn't read it as the answer.
    const text = (meta.status === "waiting" ? QUEUED_OVER_QUESTION + "\n\n" : "") + queuedText(meta.queued);
    const sent = this.reply(id, text, opts); // throws, leaving the queue as it was, if the run can't take a reply
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
    if (meta.status === "handedOff") throw httpError(409, "This run continued in a terminal (use Shift+Tab there).");
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
    const meta = this.get(id);
    if (!meta) throw httpError(404, "Unknown run");
    const live = this.live.get(id);
    if (live) {
      live.stopping = "handoff";
      killTree(live.child);
    }
    meta.status = "handedOff";
    meta.question = null;
    meta.queued = [];
    meta.queueBlocked = null;
    meta.handedOffAt = new Date().toISOString();
    endWatch(meta, "Continued in a terminal.");
    this._save(meta);
    return meta;
  }

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
    this._counts.set(id, events.length);
    res.write(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`);
    let set = this.subscribers.get(id);
    if (!set) this.subscribers.set(id, (set = new Set()));
    set.add(res);
    res.on("close", () => {
      set.delete(res);
      if (!set.size) { this.subscribers.delete(id); this._counts.delete(id); }
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
    fs.appendFileSync(this._eventsPath(meta.id), JSON.stringify(ev) + "\n");
    // Counted only while someone is subscribed; subscribe() counts the file again.
    const n = this._counts.get(meta.id);
    if (n === undefined) return;
    this._counts.set(meta.id, n + 1);
    this._broadcast(meta.id, "event", ev, n);
  }

  /** `files` are a reply's attachments (the first turn's are already in `prompt`). */
  private _turn(meta: RunMeta, prompt: string, files: Attachment[] = []) {
    const first = meta.turns === 0;
    meta.turns += 1;
    meta.status = "running";
    meta.turnStartedAt = new Date().toISOString();
    meta.question = null;
    meta.warning = null;
    meta.error = null;
    meta.effectivePermissionMode = null; // this turn's init sets it again
    this._cont.delete(meta.id); // the terminal-continuation cutoff moves with each dashboard turn
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
    // The run's attachments live outside a worktree's folder; allow reading them
    // (permission prompts are denied here, so without this a worktree run couldn't).
    const filesDir = this.attachments ? this.attachments.runDir(meta.id) : null;
    const addDirs = [...(filesDir && fs.existsSync(filesDir) ? [filesDir] : []), ...(meta.addDirs || []).filter((d) => fs.existsSync(d))];
    const turn: TurnInput = {
      first, sessionId: meta.sessionId, label: meta.label,
      // Agents that don't load Claude Code's skills get a workspace skill's instructions for `/name args`.
      prompt: (agent.id === "claude" ? (s: string) => s : (s: string) => expandSlash(s, meta.cwd))(first ? prompt : promptWithAttachments(prompt, files)),
      model: meta.model, effort: meta.effort, planMode: !!meta.planMode, permissionMode: meta.permissionMode,
      budgetUsd: agent.capabilities.costUsd ? meta.budgetUsd : null,
      rules: [agent.id === "claude" ? HEADLESS_RULES : AGENT_HEADLESS_RULES, isRoutedId(meta.model) ? LOCAL_MODEL_RULE : null, meta.extraPrompt || null].filter(Boolean).join("\n\n"),
      planRule: meta.planMode ? PLAN_MODE_RULE : null,
      addDirs,
    };
    const args = agent.turnArgs(turn);

    const child = agent.spawn(args, {
      cwd: meta.cwd,
      stdio: ["ignore", "pipe", "pipe"], // prompt is an argument; an open stdin can make the CLI wait forever
      windowsHide: true,
    }, turn);
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
      if (current) { meta.handedOffAt = current.handedOffAt; meta.verdict = current.verdict; meta.watch = current.watch; }

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
      else applyWatchBlock(meta, rawFinalText);
      this._save(meta);
      this.onFinish(meta);
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
    const file = this._transcriptPath(meta.sessionId);
    if (!file) return { events: [], lastActivityAt: null };

    const c = this._cont.get(id) || { offset: 0, rest: "", events: [] as RunEvent[], cutoff: Date.parse(meta.endedAt) };
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return { events: c.events, lastActivityAt: null }; }
    if (size > c.offset) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      fs.closeSync(fd);
      c.offset = size;
      const lines = (c.rest + buf.toString("utf-8")).split("\n");
      c.rest = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const ev = normaliseTranscriptEntry(e, c.cutoff);
        if (ev) c.events.push(ev);
      }
    }
    this._cont.set(id, c);
    const last = c.events.length ? c.events[c.events.length - 1].timestamp : null;
    if (c.events.length && !meta.continuedAt) {
      meta.continuedAt = c.events[0].timestamp;
      this._write(meta);
    }
    return { events: c.events, lastActivityAt: last };
  }

  private _transcriptPath(sessionId: string): string | null {
    if (this._paths.has(sessionId)) return this._paths.get(sessionId)!;
    const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
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
  | { prs: { repo: string; number: number }[]; everyMinutes: number; days: number; prompt: string }
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

/** Parse a <<WATCH>> block. Null when there's no marker; { error } when it can't be used. */
export function parseWatch(text: string): WatchBlock | null {
  const m = findBlock(text || "", "WATCH");
  if (!m) return null;
  const body = m.body.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let data: any = null;
  try { data = JSON.parse(body); } catch { return { error: "The watch block isn't valid JSON." }; }
  if (!data || typeof data !== "object") return { error: "The watch block isn't a JSON object." };
  if (data.stop === true) return { stop: true };
  const kind = data.kind || "github-pr";
  if (kind !== "github-pr") return { error: `Unknown watch kind "${kind}" (github-pr is supported).` };
  const raw = Array.isArray(data.prs) ? data.prs : data.pr ? [data.pr] : [];
  const prs: { repo: string; number: number }[] = [];
  for (const v of raw) {
    const pr = parseWatchedPr(v);
    if (!pr) return { error: `Can't read the pull request ${JSON.stringify(v)} (use "owner/name#123" or its URL).` };
    if (!prs.some((p) => p.repo.toLowerCase() === pr.repo.toLowerCase() && p.number === pr.number)) prs.push(pr);
  }
  if (!prs.length) return { error: "The watch block names no pull requests." };
  if (prs.length > WATCH_MAX_PRS) return { error: `Watch at most ${WATCH_MAX_PRS} pull requests at once.` };
  const clamp = (n: any, lo: number, hi: number, dflt: number) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : dflt);
  const prompt = String(data.prompt || "").trim().slice(0, WATCH_PROMPT_MAX) || WATCH_DEFAULT_PROMPT;
  return {
    prs,
    everyMinutes: clamp(data.everyMinutes, WATCH_MIN_MINUTES, WATCH_MAX_MINUTES, WATCH_DEFAULT_MINUTES),
    days: clamp(data.days, 1, WATCH_MAX_DAYS, WATCH_DEFAULT_DAYS),
    prompt,
  };
}

/**
 * Apply the turn's watch block, if any. A new block replaces the watch; PRs it
 * already watched keep what the last check saw, so replacing doesn't re-baseline them.
 * No block leaves a running watch as it is.
 */
export function applyWatchBlock(meta: RunMeta, text: string, now = new Date()) {
  const block = parseWatch(text);
  if (!block) return;
  if ("error" in block) {
    // A running watch carries on as it was; otherwise record a watch that never started, so the run says why.
    if (watchActive(meta)) { meta.watch!.error = `A new watch block was ignored: ${block.error}`; return; }
    meta.watch = blankWatch(now, [], WATCH_DEFAULT_MINUTES, "", now);
    meta.watch.endedAt = now.toISOString();
    meta.watch.endReason = `Couldn't start the watch: ${block.error}`;
    return;
  }
  if (!("prs" in block)) { endWatch(meta, "Claude ended the watch.", now); return; }
  const previous = watchActive(meta) ? meta.watch!.prs : [];
  const prs: WatchedPr[] = block.prs.map((p) => {
    const old = previous.find((o) => o.repo.toLowerCase() === p.repo.toLowerCase() && o.number === p.number);
    return { repo: p.repo, number: p.number, seen: old ? old.seen : null };
  });
  const wakes = watchActive(meta) ? meta.watch!.wakes : 0;
  meta.watch = blankWatch(now, prs, block.everyMinutes, block.prompt, new Date(now.getTime() + block.days * 86400000));
  meta.watch.wakes = wakes;
}

function blankWatch(now: Date, prs: WatchedPr[], everyMinutes: number, prompt: string, expires: Date): RunWatch {
  return {
    kind: "github-pr",
    prs,
    everyMinutes,
    prompt,
    startedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    nextCheckAt: now.toISOString(), // check right away: the first look records where things stand
    lastCheckAt: null,
    lastChangeAt: null,
    lastChange: null,
    wakes: 0,
    error: null,
    endedAt: null,
    endReason: null,
  };
}

/** When a run last did something: the newest of its start, current turn's start and last finish.
 *  A resumed turn keeps the previous turn's endedAt, so take the max rather than a fallback chain. ISO strings sort lexically. */
export function lastActivity(r: Pick<RunMeta, "startedAt" | "turnStartedAt" | "endedAt">): string {
  return [r.startedAt, r.turnStartedAt, r.endedAt].reduce<string>((max, t) => (t && t > max ? t : max), "");
}

/** Update counters from one event. For a result, returns whether it failed. */
function applyEvent(meta: RunMeta, ev: RunEvent, main: boolean, costBefore: number, roundTripsBefore: number): boolean | undefined {
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

/**
 * One transcript line -> an event the UI renders, or null. Keeps main-thread user
 * prompts, assistant turns and tool results newer than the cutoff.
 */
function normaliseTranscriptEntry(e: any, cutoff: number): RunEvent | null {
  if (!e || e.isSidechain || e.isMeta || !e.timestamp || !e.message) return null;
  if (Date.parse(e.timestamp) <= cutoff) return null;
  const base = { uuid: e.uuid, timestamp: e.timestamp };
  if (e.type === "assistant") {
    const blocks = (e.message.content || []).filter((b: any) => b.type === "text" || b.type === "tool_use");
    return blocks.length ? { ...base, type: "assistant", parent_tool_use_id: null, message: { content: blocks } } : null;
  }
  if (e.type !== "user") return null;
  const content = e.message.content;
  if (typeof content === "string") {
    if (/^<(command-|local-command|system-reminder)/.test(content.trim())) return null;
    return { ...base, type: "human", text: content };
  }
  if (!Array.isArray(content)) return null;
  if (content.some((b: any) => b.type === "tool_result")) return { ...base, type: "user", parent_tool_use_id: null, message: { content } };
  const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  return text ? { ...base, type: "human", text } : null;
}

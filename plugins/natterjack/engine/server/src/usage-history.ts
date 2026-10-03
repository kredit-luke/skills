/**
 * Token usage history, from Claude Code's own session transcripts on this
 * machine (~/.claude/projects/<project>/<session>.jsonl, plus subagent
 * transcripts beneath). Each assistant line carries message.model,
 * message.usage and a timestamp; the CLI writes one line per content block and
 * repeats the usage on each, so requests are deduplicated by message.id + requestId.
 *
 * Indexed incrementally: per file, only complete lines appended since the last
 * scan are read. The first scan of a few hundred MB takes seconds (async, so the
 * server stays responsive); later refreshes read only what's new.
 *
 * On a subscription tokens aren't billed; this is for seeing where usage goes
 * (by day, model and project), alongside the /usage percentages.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }
interface FileState { offset: number; rest: string; mtimeMs: number }

const SCAN_TTL_MS = 60 * 1000;
const empty = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });

export class UsageHistory {
  root: string;
  private files = new Map<string, FileState>();
  private seen = new Set<string>();
  /** "YYYY-MM-DD|model|project" -> counts */
  private buckets = new Map<string, TokenCounts>();
  /** "YYYY-MM-DD" -> session ids */
  private sessions = new Map<string, Set<string>>();
  /** requests by local hour of day, last 30 days */
  private hours = new Map<string, number[]>(); // day -> 24 counts
  private scannedAt = 0;
  private scanning: Promise<void> | null = null;
  private firstScanMs: number | null = null;

  constructor(root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects")) {
    this.root = root;
  }

  /** Scan if stale; resolves when the index is current. */
  refresh(force = false): Promise<void> {
    if (this.scanning) return this.scanning;
    if (!force && Date.now() - this.scannedAt < SCAN_TTL_MS) return Promise.resolve();
    const t0 = Date.now();
    this.scanning = this.scan()
      .then(() => { this.scannedAt = Date.now(); if (this.firstScanMs == null) this.firstScanMs = Date.now() - t0; })
      .finally(() => { this.scanning = null; });
    return this.scanning;
  }

  /** Aggregates for the last `days` days (local dates), for the Usage page. */
  async report(days = 30) {
    await this.refresh();
    const dates: string[] = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(localDate(d));
    }
    const inRange = new Set(dates);
    const byDay = new Map(dates.map((d) => [d, {} as Record<string, TokenCounts>]));
    const byModel: Record<string, TokenCounts> = {};
    const byProject: Record<string, TokenCounts & { models: Record<string, number> }> = {};
    const totals = empty();
    for (const [key, c] of this.buckets) {
      const [day, model, project] = key.split("|");
      if (!inRange.has(day)) continue;
      add((byDay.get(day)![model] = byDay.get(day)![model] || empty()), c);
      add((byModel[model] = byModel[model] || empty()), c);
      const p = (byProject[project] = byProject[project] || { ...empty(), models: {} });
      add(p, c);
      p.models[model] = (p.models[model] || 0) + total(c);
      add(totals, c);
    }
    const hours = new Array(24).fill(0);
    for (const d of dates) (this.hours.get(d) || []).forEach((n, h) => (hours[h] += n || 0));
    return {
      generatedAt: new Date().toISOString(),
      scannedAt: this.scannedAt ? new Date(this.scannedAt).toISOString() : null,
      firstScanMs: this.firstScanMs,
      files: this.files.size,
      days: dates.map((date) => ({ date, byModel: byDay.get(date)!, sessions: (this.sessions.get(date) || new Set()).size })),
      models: Object.entries(byModel).map(([model, c]) => ({ model, family: family(model), ...c })).sort((a, b) => total(b) - total(a)),
      projects: Object.entries(byProject).map(([project, c]) => ({ project, ...c })).sort((a, b) => total(b) - total(a)).slice(0, 15),
      hours,
      totals,
    };
  }

  // ------------------------------------------------------------ scanning

  private async scan() {
    for (const file of await listJsonl(this.root)) {
      let st: fs.Stats;
      try { st = await fs.promises.stat(file); } catch { continue; }
      const state = this.files.get(file) || { offset: 0, rest: "", mtimeMs: 0 };
      if (st.size < state.offset) { state.offset = 0; state.rest = ""; } // rewritten: start over
      if (st.size === state.offset) { this.files.set(file, state); continue; }
      let text: string;
      try {
        const fh = await fs.promises.open(file, "r");
        const buf = Buffer.alloc(st.size - state.offset);
        await fh.read(buf, 0, buf.length, state.offset);
        await fh.close();
        text = state.rest + buf.toString("utf-8");
      } catch { continue; }
      state.offset = st.size;
      state.mtimeMs = st.mtimeMs;
      const lines = text.split("\n");
      state.rest = lines.pop() || ""; // an incomplete last line is finished on a later scan
      const project = projectOf(this.root, file);
      for (const line of lines) {
        // Cheap filter before JSON.parse: most lines aren't assistant messages with usage.
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        this.ingest(e, project);
      }
      this.files.set(file, state);
      await new Promise((r) => setImmediate(r)); // let requests through between files
    }
  }

  private ingest(e: any, fallbackProject: string) {
    const m = e && e.type === "assistant" && e.message;
    if (!m || !m.usage || !m.model || m.model === "<synthetic>" || !e.timestamp) return;
    const id = `${m.id || ""}:${e.requestId || ""}`;
    if (id !== ":" && this.seen.has(id)) return;
    this.seen.add(id);
    const at = new Date(e.timestamp);
    if (isNaN(at.getTime())) return;
    const day = localDate(at);
    const project = e.cwd ? projectName(e.cwd) : fallbackProject;
    const key = `${day}|${m.model}|${project}`;
    const u = m.usage;
    const c = this.buckets.get(key) || empty();
    c.input += u.input_tokens || 0;
    c.output += u.output_tokens || 0;
    c.cacheRead += u.cache_read_input_tokens || 0;
    c.cacheWrite += u.cache_creation_input_tokens || 0;
    c.requests += 1;
    this.buckets.set(key, c);
    if (e.sessionId) {
      let s = this.sessions.get(day);
      if (!s) this.sessions.set(day, (s = new Set()));
      s.add(e.sessionId);
    }
    let h = this.hours.get(day);
    if (!h) this.hours.set(day, (h = new Array(24).fill(0)));
    h[at.getHours()]++;
  }
}

export function total(c: TokenCounts) { return c.input + c.output + c.cacheRead + c.cacheWrite; }
function add(a: TokenCounts, b: TokenCounts) {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; a.requests += b.requests;
}

/** Model family, for consistent chart colours: opus | sonnet | haiku | fable | other. */
export function family(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1].toLowerCase() : "other";
}

function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A readable project name from a cwd: the folder, or "worktrees/<name>" inside a worktree. */
export function projectName(cwd: string): string {
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  const w = parts.lastIndexOf("worktrees");
  if (w >= 0 && parts[w + 1]) return `worktrees/${parts[w + 1]}`;
  return parts[parts.length - 1] || cwd;
}

/** Fallback when a line has no cwd: the project folder's slug, shortened. */
function projectOf(root: string, file: string): string {
  const slug = path.relative(root, file).split(path.sep)[0] || "unknown";
  return slug.split("-").filter(Boolean).slice(-2).join("-");
}

async function listJsonl(dir: string, acc: string[] = []): Promise<string[]> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(full, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(full);
  }
  return acc;
}

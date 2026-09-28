/**
 * Subscription usage, read from Claude Code's own `/usage` command run
 * headless. It's a local command: no model call, no cost. The text is the
 * same report /usage prints in a terminal, parsed into meters + insights.
 *
 * Example lines parsed:
 *   Current session: 3% used · resets Sep 24, 6:59pm (America/New_York)
 *   Current week (all models): 5% used · resets Sep 28, 4:59am (America/New_York)
 *   Last 24h · 345 requests · 7 sessions
 *     81% of your usage was at >150k context
 */

import fs from "node:fs";
import { execFile } from "node:child_process";

const USAGE_TTL_MS = 2 * 60 * 1000;
// Built-in commands that drive the interactive terminal (model pickers, context
// management, session plumbing). They do nothing useful in a headless -p run.
const TERMINAL_ONLY = new Set([
  "clear", "compact", "autocompact", "config", "color", "context", "effort", "fast", "focus", "heapdump",
  "model", "output-style", "rename", "reload-plugins", "reload-skills", "agents", "list-agents", "advisor",
  "mcp", "import", "extra-usage", "usage-credits", "auto-mode-setup", "workflow-launch-exec",
  "design-consent", "design-revoke", "team-onboarding", "goal", "loop", "ultrareview",
]);
const METER_RE =/^(.+?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$/;

function parseUsage(text) {
  const meters = [];
  const insights = [];
  let plan = null;
  let current = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = METER_RE.exec(line.trim());
    if (m) {
      const label = m[1].trim();
      meters.push({
        label,
        kind: /session/i.test(label) ? "session" : /week/i.test(label) ? "week" : "other",
        pct: Number(m[2]),
        resets: m[3] ? m[3].replace(/\s*\([^)]*\)\s*$/, "") : null,
      });
      continue;
    }
    if (/^You are currently using/i.test(line)) { plan = line.trim(); continue; }
    if (/^Last \S+ ·/.test(line.trim())) {
      current = { title: line.trim(), items: [] };
      insights.push(current);
      continue;
    }
    if (current && /^\s+/.test(raw)) current.items.push(line.trim());
  }
  return { plan, meters, insights };
}

class Usage {
  cache: any;
  inflight: any;
  commands: any;
  snapFile: string | null;

  /** @param snapFile where each /usage reading is appended (JSONL), for the limits-over-time chart */
  constructor(snapFile: string | null = null) {
    this.cache = null;
    this.inflight = null;
    this.snapFile = snapFile;
  }

  /** Append a reading when a meter moved, or at least every 30 minutes. */
  _snapshot(u) {
    if (!this.snapFile || !u.meters.length) return;
    const meters = u.meters.map((m) => ({ kind: m.kind, label: m.label, pct: m.pct }));
    const last = this._lastSnap;
    const same = last && JSON.stringify(last.meters) === JSON.stringify(meters);
    if (same && Date.now() - last.at < 30 * 60 * 1000) return;
    this._lastSnap = { at: Date.now(), meters };
    try { fs.appendFileSync(this.snapFile, JSON.stringify({ at: new Date().toISOString(), meters }) + "\n"); } catch {}
  }
  _lastSnap: { at: number; meters: any[] } | null = null;

  /** Readings from the last `days` days: [{ at, meters: [{ kind, label, pct }] }]. */
  history(days = 7) {
    if (!this.snapFile) return [];
    const since = Date.now() - days * 86400000;
    try {
      return fs.readFileSync(this.snapFile, "utf-8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((s) => s && Date.parse(s.at) >= since);
    } catch {
      return [];
    }
  }

  invalidate() {
    if (this.cache) this.cache.fetchedAt = 0;
  }

  _fetch(): Promise<any> {
    return new Promise((resolve) => {
      // execFile (no shell) so "/usage" isn't path-mangled by Git Bash/MSYS.
      // stream-json + --verbose also yields the session's commands_changed event:
      // every slash command (project/plugin skills, built-ins, MCP prompts) with
      // descriptions and argument hints, which feeds the run box's autocomplete.
      execFile(
        "claude",
        ["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
        { timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          let text = "";
          let commands = null;
          for (const line of String(stdout || "").split("\n")) {
            if (!line.trim()) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === "result" && typeof ev.result === "string") text = ev.result;
            if (ev.type === "system" && ev.subtype === "commands_changed" && Array.isArray(ev.commands)) commands = ev.commands;
          }
          const parsed = parseUsage(text);
          resolve({
            ...parsed,
            raw: text,
            commands,
            error: !parsed.meters.length ? (err ? err.message.split("\n")[0] : "Could not read /usage output") : null,
            fetchedAt: Date.now(),
          });
        }
      );
    });
  }

  /** Cached report; never blocks once a first report exists. */
  async get(force = false) {
    const fresh = this.cache && Date.now() - this.cache.fetchedAt < USAGE_TTL_MS;
    if (!fresh || force) {
      if (!this.inflight) {
        this.inflight = this._fetch()
          .then((u) => {
            // Held separately: the usage report is polled every few seconds, the command list isn't.
            if (u.commands) this.commands = u.commands;
            delete u.commands;
            this._snapshot(u);
            if (u.meters.length || !this.cache) this.cache = u;
            else this.cache.fetchedAt = Date.now();
          })
          .finally(() => { this.inflight = null; });
      }
      if (!this.cache || force) await this.inflight;
    }
    return this.cache;
  }

  /** Synchronous read for launch guards; null until the first fetch lands. */
  peek() {
    return this.cache;
  }

  /**
   * Slash commands usable from a headless run, for autocomplete. Built-ins that
   * only make sense in the interactive terminal UI are dropped.
   */
  async listCommands() {
    if (!this.commands) await this.get(true).catch(() => {});
    return (this.commands || [])
      .filter((c) => c && c.name && !c.name.startsWith("__") && !(c.builtin && TERMINAL_ONLY.has(c.name)))
      .map((c) => ({
        name: c.name,
        description: String(c.description || "").replace(/\s*\((project|user|plugin)\)\s*$/i, "").trim(),
        argumentHint: c.argumentHint || "",
        aliases: c.aliases || [],
        source: c.builtin ? "built-in" : /\(MCP\)$/.test(c.name) ? "mcp" : c.name.includes(":") ? "plugin" : "skill",
      }));
  }
}

export { Usage, parseUsage };

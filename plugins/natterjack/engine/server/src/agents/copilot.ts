/**
 * GitHub Copilot CLI: `copilot -p <prompt> --output-format json` (JSONL). The dashboard
 * picks the session id (--session-id sets it for a new session and resumes it after), so
 * "Continue in terminal" (`copilot --resume <id>`) works from the first turn.
 *
 * Headless, nothing can approve a tool, so runs pass --allow-all-tools; plan mode adds
 * --deny-tool write (deny rules beat allow rules), so file edits are refused, plus the
 * plan rule in the prompt for everything else. There's no system-prompt flag: the
 * dashboard's rules ride at the top of the first prompt.
 *
 * Its events (user.message, assistant.message {content, toolRequests},
 * tool.execution_start / _complete, assistant.turn_end, result {sessionId, exitCode, usage})
 * become Claude-shaped run events; its tool names map onto the ones the run page draws
 * (view → Read, create → Write, edit → Edit, bash / powershell → Bash).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { RunEvent } from "../../../shared/api.ts";
import { spawnCli } from "../claude.ts";
import type { Agent, AgentCapabilities, AgentModel, AgentStatus, ParseState, TurnInput } from "./index.ts";
import { cached, clip, probeCli, withRules } from "./util.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The models `copilot help config` lists under `model`, plus Auto. */
export function parseCopilotModels(helpText: string): AgentModel[] {
  const at = helpText.search(/^\s*`model`:/m);
  const out: AgentModel[] = [{ id: "auto", label: "Auto", efforts: null }];
  if (at < 0) return out;
  for (const line of helpText.slice(at).split(/\r?\n/).slice(1)) {
    const m = /^\s*-\s*"([\w.-]+)"\s*$/.exec(line);
    if (!m) { if (out.length > 1) break; continue; }
    out.push({ id: m[1], label: m[1], efforts: null });
  }
  return out;
}

/** Copilot tool calls as the run page's tools. */
function asClaudeTool(name: string, args: any): { name: string; input: any } {
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "view": return { name: "Read", input: { file_path: a.path, ...(a.view_range ? { view_range: a.view_range } : {}) } };
    case "create": return { name: "Write", input: { file_path: a.path, content: a.file_text ?? "" } };
    case "edit": case "str_replace": case "str_replace_editor":
      return { name: "Edit", input: { file_path: a.path, old_string: a.old_str ?? a.old_string ?? "", new_string: a.new_str ?? a.new_string ?? "" } };
    case "bash": case "powershell": case "shell": return { name: "Bash", input: { command: a.command, description: a.description } };
    case "grep": case "rg": return { name: "Grep", input: { pattern: a.pattern, path: a.path } };
    case "glob": return { name: "Glob", input: { pattern: a.pattern, path: a.path } };
    case "web_fetch": return { name: "WebFetch", input: { url: a.url } };
    default: return { name, input: a };
  }
}

/** One Copilot JSONL line → run events. */
export function translateCopilot(e: any, state: ParseState): RunEvent[] {
  const d = e?.data || {};
  switch (e?.type) {
    case "session.tools_updated":
    case "assistant.message": {
      const out: RunEvent[] = [];
      if (!state.inited && d.model) { state.inited = true; out.push({ type: "system", subtype: "init", model: d.model, session_id: state.sessionId || null }); }
      if (e.type !== "assistant.message") return out;
      const content: any[] = [];
      if (typeof d.content === "string" && d.content.trim()) { content.push({ type: "text", text: d.content }); state.lastText = d.content; }
      for (const t of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
        const { name, input } = asClaudeTool(t.name, t.arguments);
        content.push({ type: "tool_use", id: t.toolCallId, name, input });
      }
      if (content.length) out.push({ type: "assistant", message: { role: "assistant", model: d.model, content }, parent_tool_use_id: null });
      return out;
    }
    case "tool.execution_complete": {
      const r = d.result || {};
      return [{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: d.toolCallId, content: clip(r.content ?? r.error ?? ""), is_error: d.success === false }] }, parent_tool_use_id: null }];
    }
    case "assistant.turn_end": state.turns = (state.turns || 0) + 1; return [];
    case "result": {
      const failed = Number(e.exitCode) !== 0;
      return [{
        type: "result", subtype: failed ? "error" : "success", is_error: failed, result: state.lastText || "",
        num_turns: state.turns || 0, session_id: e.sessionId, usage: e.usage || null,
        ...(e.usage && typeof e.usage.premiumRequests === "number" ? { premium_requests: e.usage.premiumRequests } : {}),
      }];
    }
    default: return [];
  }
}

export class CopilotAgent implements Agent {
  id = "copilot" as const;
  label = "Copilot";
  capabilities: AgentCapabilities = { planMode: true, costUsd: false, backgroundTasks: false, transcripts: false };

  private readonly probe = cached(5 * 60_000, async () => {
    const v = await probeCli("copilot", ["--version"]);
    if (!v.ok) return { installed: false, version: null, models: [] as AgentModel[] };
    const help = await probeCli("copilot", ["help", "config"], 30_000);
    return { installed: true, version: (/(\d+\.\d+\.\d+)/.exec(v.out) || [])[1] || null, models: parseCopilotModels(help.out) };
  });

  /** Signed in: a GitHub token in the environment, or a login in ~/.copilot/config.json. */
  private signedIn(): boolean {
    if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
    try {
      const home = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
      const text = fs.readFileSync(path.join(home, "config.json"), "utf-8").replace(/^\s*\/\/.*$/gm, "");
      const j = JSON.parse(text);
      return Array.isArray(j.loggedInUsers) && j.loggedInUsers.length > 0;
    } catch { return false; }
  }

  async status(force = false): Promise<AgentStatus> {
    const p = await this.probe(force);
    const signedIn = p.installed && this.signedIn();
    return {
      id: this.id, label: this.label, installed: p.installed, signedIn, version: p.version,
      problem: !p.installed ? "GitHub Copilot CLI isn't installed (winget install GitHub.Copilot, or npm i -g @github/copilot)." : !signedIn ? "Copilot isn't signed in: run `copilot login` in a terminal." : null,
      models: p.models, efforts: EFFORTS, defaultModel: "auto", defaultEffort: null, capabilities: this.capabilities,
    };
  }

  turnArgs(t: TurnInput): string[] {
    // The session remembers the first prompt's rules; later turns only need plan mode's, when it's on.
    const prompt = t.first ? withRules([t.rules, t.planRule].filter(Boolean).join("\n\n"), t.prompt) : t.planRule ? withRules(t.planRule, t.prompt) : t.prompt;
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--session-id", t.sessionId,
      "--no-ask-user", "--no-auto-update", "--no-color",
      "--allow-all-tools",
    ];
    if (t.planMode) args.push("--deny-tool", "write");
    if (t.model && t.model !== "auto") args.push("--model", t.model);
    if (t.effort) args.push("--effort", t.effort);
    for (const d of t.addDirs) args.push("--add-dir", d);
    return args;
  }

  spawn(args: string[], opts: SpawnOptions): ChildProcess {
    return spawnCli("copilot", args, opts);
  }

  parse(line: any, state: ParseState): RunEvent[] {
    return translateCopilot(line, state);
  }

  resumeCommand(sessionId: string): string {
    return `copilot --resume ${sessionId}`;
  }
}

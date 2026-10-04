/**
 * OpenAI Codex CLI: `codex exec --json <prompt>` (JSONL), resumed with
 * `codex exec resume --json <thread id> <prompt>`. Codex picks the thread id itself (its
 * first line, thread.started), so the run's session id is set from it on the first turn.
 *
 * Team instructions: Codex reads AGENTS.md only; a Natterjack workspace keeps them in
 * CLAUDE.md (Copilot reads both), so every Codex turn and the terminal resume command pass
 * project_doc_fallback_filenames=["CLAUDE.md"]: AGENTS.md still wins where there is one.
 *
 * Sandbox: workspace-write (edits inside the workspace, network on for git and package
 * managers); plan mode is read-only. There's no system-prompt flag: the dashboard's rules
 * ride at the top of the first prompt. The models (and the efforts each takes) come from
 * Codex's own cache, ~/.codex/models_cache.json.
 *
 * Its items (agent_message, command_execution, file_change, mcp_tool_call, web_search)
 * become Claude-shaped run events: a command is a Bash tool call and its output, a file
 * change an Edit per file (no diff: Codex only names the files), turn.completed the result.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { RunEvent } from "../../../shared/api.ts";
import { spawnCli } from "../claude.ts";
import type { Agent, AgentCapabilities, AgentModel, AgentStatus, ParseState, TurnInput } from "./index.ts";
import { cached, clip, probeCli, withRules } from "./util.ts";

const FALLBACK_EFFORTS = ["low", "medium", "high"];
/** Read the workspace's CLAUDE.md as project instructions when there's no AGENTS.md. */
const CLAUDE_MD_FALLBACK = "project_doc_fallback_filenames=['CLAUDE.md']"; // TOML literal strings: survives shells' quoting

/** Models from Codex's cache (the ones it lists), with the reasoning efforts each supports. */
export function parseCodexModels(cache: any): AgentModel[] {
  const list = Array.isArray(cache) ? cache : Array.isArray(cache?.models) ? cache.models : [];
  return list
    .filter((m: any) => m && typeof m.slug === "string" && (m.visibility === undefined || m.visibility === "list"))
    .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m: any) => ({
      id: m.slug, label: m.display_name || m.slug,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l: any) => l?.effort).filter((x: any) => typeof x === "string") : null,
    }));
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

const item = (e: any) => e?.item || {};

/** One Codex JSONL line → run events. */
export function translateCodex(e: any, state: ParseState): RunEvent[] {
  switch (e?.type) {
    case "thread.started":
      state.sessionId = e.thread_id;
      return [{ type: "system", subtype: "init", session_id: e.thread_id, model: state.model || null }];
    case "item.started": {
      const it = item(e);
      if (it.type === "command_execution") { state.started = { ...(state.started || {}), [it.id]: true }; return [toolUse(it.id, "Bash", { command: it.command })]; }
      if (it.type === "mcp_tool_call") { state.started = { ...(state.started || {}), [it.id]: true }; return [toolUse(it.id, `mcp__${it.server}__${it.tool}`, it.arguments || {})]; }
      return [];
    }
    case "item.completed": {
      const it = item(e);
      const started = !!state.started?.[it.id];
      switch (it.type) {
        case "agent_message":
          if (typeof it.text === "string" && it.text.trim()) { state.lastText = it.text; return [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: it.text }] }, parent_tool_use_id: null }]; }
          return [];
        case "command_execution":
          return [
            ...(started ? [] : [toolUse(it.id, "Bash", { command: it.command })]),
            toolResult(it.id, it.aggregated_output ?? "", it.exit_code != null && it.exit_code !== 0),
          ];
        case "file_change": {
          const changes: any[] = Array.isArray(it.changes) ? it.changes : [];
          const out: RunEvent[] = [];
          changes.forEach((c, i) => {
            const id = `${it.id}_${i}`;
            out.push(toolUse(id, c.kind === "add" ? "Write" : "Edit", { file_path: c.path, ...(c.kind === "add" ? { content: "" } : { old_string: "", new_string: "" }), change: c.kind }));
            out.push(toolResult(id, `${c.kind === "add" ? "Created" : c.kind === "delete" ? "Deleted" : "Updated"} ${c.path}`, it.status === "failed"));
          });
          return out;
        }
        case "mcp_tool_call":
          return [
            ...(started ? [] : [toolUse(it.id, `mcp__${it.server}__${it.tool}`, it.arguments || {})]),
            toolResult(it.id, it.result?.content ?? it.error?.message ?? it.result ?? "", it.status === "failed" || !!it.error),
          ];
        case "web_search":
          return [toolUse(it.id, "WebSearch", { query: it.query }), toolResult(it.id, "", false)];
        case "error":
          return [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Codex: ${it.message || "error"}` }] }, parent_tool_use_id: null }];
        default:
          return []; // reasoning, todo_list: not shown
      }
    }
    case "turn.completed":
      state.turns = (state.turns || 0) + 1;
      return [{ type: "result", subtype: "success", is_error: false, result: state.lastText || "", num_turns: state.turns, session_id: state.sessionId || null, usage: e.usage || null }];
    case "turn.failed":
      return [{ type: "result", subtype: "error", is_error: true, result: e.error?.message || "Codex failed.", num_turns: state.turns || 0, session_id: state.sessionId || null }];
    case "error":
      state.error = e.message || "Codex error";
      return [];
    default:
      return [];
  }
}

function toolUse(id: string, name: string, input: any): RunEvent {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null };
}
function toolResult(id: string, content: unknown, isError: boolean): RunEvent {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: clip(content), is_error: isError }] }, parent_tool_use_id: null };
}

export class CodexAgent implements Agent {
  id = "codex" as const;
  label = "Codex";
  capabilities: AgentCapabilities = { planMode: true, costUsd: false, backgroundTasks: false, transcripts: false };

  private readonly probe = cached(5 * 60_000, async () => {
    const v = await probeCli("codex", ["--version"]);
    if (!v.ok) return { installed: false, version: null, signedIn: false };
    const login = await probeCli("codex", ["login", "status"]);
    return { installed: true, version: (/(\d+\.\d+\.\d+)/.exec(v.out) || [])[1] || null, signedIn: login.ok && /logged in/i.test(login.out) && !/not logged in/i.test(login.out) };
  });

  private models(): AgentModel[] {
    try { return parseCodexModels(JSON.parse(fs.readFileSync(path.join(codexHome(), "models_cache.json"), "utf-8"))); } catch { return []; }
  }

  async status(force = false): Promise<AgentStatus> {
    const p = await this.probe(force);
    const models = this.models();
    const efforts = [...new Set(models.flatMap((m) => m.efforts || []))];
    return {
      id: this.id, label: this.label, installed: p.installed, signedIn: p.signedIn, version: p.version,
      problem: !p.installed ? "OpenAI Codex CLI isn't installed (npm i -g @openai/codex)." : !p.signedIn ? "Codex isn't signed in: run `codex login` in a terminal." : null,
      models, efforts: efforts.length ? efforts : FALLBACK_EFFORTS, defaultModel: models[0]?.id || null, defaultEffort: null, capabilities: this.capabilities,
    };
  }

  turnArgs(t: TurnInput): string[] {
    const sandbox = t.planMode ? "read-only" : "workspace-write";
    const prompt = t.first ? withRules([t.rules, t.planRule].filter(Boolean).join("\n\n"), t.prompt) : t.planRule ? withRules(t.planRule, t.prompt) : t.prompt;
    const opts = [
      "--json", "--skip-git-repo-check",
      ...(t.model ? ["-m", t.model] : []),
      ...(t.effort ? ["-c", `model_reasoning_effort="${t.effort}"`] : []),
      // git, gh and package managers need the network inside the sandbox.
      "-c", "sandbox_workspace_write.network_access=true",
      "-c", CLAUDE_MD_FALLBACK,
    ];
    if (t.first) return ["exec", ...opts, "-s", sandbox, ...t.addDirs.flatMap((d) => ["--add-dir", d]), prompt];
    // resume takes no --sandbox: set it through config.
    return ["exec", "resume", ...opts, "-c", `sandbox_mode="${sandbox}"`, t.sessionId, prompt];
  }

  spawn(args: string[], opts: SpawnOptions): ChildProcess {
    return spawnCli("codex", args, opts);
  }

  parse(line: any, state: ParseState): RunEvent[] {
    return translateCodex(line, state);
  }

  resumeCommand(sessionId: string): string {
    return `codex resume -c "${CLAUDE_MD_FALLBACK}" ${sessionId}`;
  }
}

/**
 * Claude Code: `claude -p --output-format stream-json`. Its events are the dashboard's run
 * events as they are, so parse() passes them through. The dashboard picks the session id
 * up front (--session-id), so "Continue in terminal" works from the first second.
 *
 * Besides Claude's own models it runs local and team open models (models/routes.ts): the
 * same CLI pointed at another Anthropic-compatible server for that turn. Those take no
 * effort or dollar budget, and need no Claude sign-in.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { RunEvent } from "../../../shared/api.ts";
import { claudeAuth, claudeEnv, claudeFile, spawnClaude } from "../claude.ts";
import type { Agent, AgentCapabilities, AgentStatus, ParseState, TurnInput } from "./index.ts";
import { cached, probe } from "./util.ts";
import { allRoutes, resumeCommand, routeOf, turnEnv } from "../models/routes.ts";

const MODELS = [
  { id: "opus", label: "Opus", efforts: null },
  { id: "sonnet", label: "Sonnet", efforts: null },
  { id: "haiku", label: "Haiku", efforts: null },
  { id: "fable", label: "Fable", efforts: null },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export class ClaudeAgent implements Agent {
  id = "claude" as const;
  label = "Claude";
  capabilities: AgentCapabilities = { planMode: true, costUsd: true, backgroundTasks: true, transcripts: true };

  private readonly version = cached(10 * 60_000, async () => {
    const r = await probe(claudeFile(), ["--version"]);
    return r.ok ? (/(\d+\.\d+\.\d+)/.exec(r.out) || [])[1] || null : null;
  });

  async status(force = false): Promise<AgentStatus> {
    const [auth, version] = await Promise.all([claudeAuth(force), this.version(force)]);
    return {
      id: this.id, label: this.label, installed: auth.installed, signedIn: auth.loggedIn, version,
      problem: !auth.installed ? "Claude Code isn't installed. Open the Machine page to install it." : !auth.loggedIn ? "Claude Code isn't signed in. Open the Machine page to sign in." : null,
      models: [...MODELS, ...allRoutes().map((r) => ({ id: r.id, label: r.label, efforts: [] }))], efforts: EFFORTS, defaultModel: "opus", defaultEffort: "medium", capabilities: this.capabilities,
    };
  }

  turnArgs(t: TurnInput): string[] {
    const args = [
      "-p", t.prompt,
      "--output-format", "stream-json",
      "--verbose",
      ...(t.first ? ["--session-id", t.sessionId, "--name", `dash: ${t.label}`.slice(0, 80)] : ["--resume", t.sessionId]),
      "--permission-mode", t.planMode ? "plan" : t.permissionMode,
      // Headless: nobody can answer a permission prompt, so anything that would ask is denied.
      "--permission-prompts", "none",
      "--append-system-prompt", [t.rules, t.planRule].filter(Boolean).join("\n\n"),
    ];
    // A local or team model: its name on that server (the backend comes from spawn's env). One
    // that's gone (launches check first) goes as it is, so it fails instead of running on Claude.
    const route = routeOf(t.model);
    if (t.model) args.push("--model", route ? route.model : t.model);
    if (t.effort && !route) args.push("--effort", t.effort);
    if (t.budgetUsd && !route) args.push("--max-budget-usd", String(t.budgetUsd));
    for (const d of t.addDirs) args.push("--add-dir", d);
    return args;
  }

  spawn(args: string[], opts: SpawnOptions, turn?: TurnInput): ChildProcess {
    // Claude's models: claudeEnv() as always (the person's own sign-in). A routed model: its server's.
    return spawnClaude(args, { ...opts, env: turn ? turnEnv(turn.model) : claudeEnv() });
  }

  parse(line: any, _state: ParseState): RunEvent[] {
    return line && typeof line === "object" ? [line] : [];
  }

  resumeCommand(sessionId: string, model?: string | null): string {
    return resumeCommand(sessionId, model);
  }
}

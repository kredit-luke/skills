/**
 * Model routes: which models besides Claude's a Claude Code run can use, and the environment
 * that points `claude` at them. A local or team model is Claude Code with another backend
 * (ANTHROPIC_BASE_URL at an Anthropic-compatible server: Ollama, vLLM, LiteLLM), so runs keep
 * their tools, skills, CLAUDE.md, plan mode and run page.
 *
 *   local/<ollama tag>            this computer's Ollama
 *   team/<endpoint id>/<model>    an endpoint in .claude/dashboard/models.json
 *
 * The backend is picked per turn from the turn's model. Only these models get the overrides;
 * a turn on opus, sonnet, haiku or fable starts with exactly claudeEnv(), so it runs on the
 * person's own Claude sign-in (their subscription, when they have one) as it always has.
 *
 * models/index.ts keeps the list current (what's downloaded, what models.json lists); this
 * file holds no I/O, so the agent adapters can read it without loading the config.
 */

import { claudeEnv } from "../claude.ts";

export interface Backend {
  /** "local", or "team/<endpoint id>". */
  id: string;
  label: string;
  baseUrl: string;
  /** The token to send; null for none (Ollama ignores it, but Claude Code needs one, so "ollama"). */
  token: string | null;
  /** How a terminal gets the token without printing it: an env var, or the personal token file. */
  tokenRef?: { env: string } | { file: string; key: string } | null;
}

export interface Route {
  /** What the run records and the Model select shows: "local/qwen3.8:27b". */
  id: string;
  label: string;
  /** The name the backend knows the model by (passed to --model). */
  model: string;
  backend: Backend;
  /** Supports tool calling (null: unknown; still offered). */
  tools: boolean | null;
  context: number | null;
}

/** "local/…" or "team/…": a model this file routes (whether or not it's available right now). */
export const ROUTED_RE = /^(local|team)\/[A-Za-z0-9._:\-/]{1,160}$/;
export const isRoutedId = (id: unknown): id is string => typeof id === "string" && ROUTED_RE.test(id);

let routes: Route[] = [];

export function setRoutes(list: Route[]): void { routes = list; }
export function allRoutes(): Route[] { return routes; }
export function routeOf(id: unknown): Route | null {
  return isRoutedId(id) ? routes.find((r) => r.id === id) || null : null;
}

/**
 * Variables that make Claude Code talk to something other than the Anthropic API (or pick a
 * cloud for it). A routed turn clears them all before setting its own, so a shell's Bedrock
 * or gateway settings can't send a local model's turn somewhere else.
 */
const PROVIDER_ENV = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL", "API_TIMEOUT_MS",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL",
];

/**
 * Added to a routed turn's rules. A local server answers one request at a time: subagents
 * started together queue behind each other (and evict each other's cached prompt), so each
 * waits minutes, and Claude Code gives up on them and retries.
 */
export const LOCAL_MODEL_RULE = `You are running on an open model served one request at a time. Do the searching and reading yourself with Grep, Glob and Read, one step at a time. Don't start subagents (the Agent tool): several at once queue behind each other and can time out.`;

/** The overrides a routed turn sets (also what a terminal resume sets). */
export function routeVars(r: Route): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: r.backend.baseUrl,
    ANTHROPIC_AUTH_TOKEN: r.backend.token || "ollama",
    ANTHROPIC_API_KEY: "",
    // Everything Claude Code would send to another model (subagents such as Explore, the small
    // background calls) goes to this one too: the backend has no Claude models to answer them.
    ANTHROPIC_MODEL: r.model,
    ANTHROPIC_SMALL_FAST_MODEL: r.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: r.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: r.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: r.model,
    CLAUDE_CODE_SUBAGENT_MODEL: r.model,
    // No telemetry or update checks to Anthropic from a turn that's meant to stay local.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // A request can wait in the server's queue, and a long prompt takes a while to read: 30 minutes, not 10.
    API_TIMEOUT_MS: "1800000",
  };
}

/**
 * The environment for one turn: claudeEnv() for Claude's own models (and anything that isn't
 * a known route), else claudeEnv() without any provider settings, plus this route's.
 */
export function turnEnv(model: string | null | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = claudeEnv(base);
  const r = routeOf(model);
  // Smart routing: the same environment (the person's own sign-in) with the router in front; it
  // passes Claude's requests on unchanged (to the gateway this env named, if any: the router was
  // started knowing it).
  const ex = r ? null : explorerFor(model);
  if (ex) return { ...env, ANTHROPIC_BASE_URL: ex.url };
  if (!r) return env;
  for (const k of PROVIDER_ENV) delete env[k];
  return { ...env, ...routeVars(r) };
}

// ---------------------------------------------------------------- smart routing (router.ts)

/**
 * Smart routing, when the person turned it on: Claude's turns get an "Explore" subagent on this
 * route's model (the --agents file). It takes the place of Claude Code's own Explore, so the
 * exploring Claude already chooses to hand off runs on the open model; telling Claude to delegate
 * isn't reliable (on a small task it searches itself), and taking its search tools away only
 * sends it to grep through Bash. The turn goes through the router at `url`, which sends the
 * explorer's requests to the model's server and everything else on to Anthropic unchanged.
 */
export interface Explorer { route: Route; agentsFile: string; url: string }
let explorer: Explorer | null = null;
export function setExplorer(e: Explorer | null): void { explorer = e; }
/** The explorer for a turn on `model`: only Claude's own models delegate (a routed turn is already local). */
export function explorerFor(model: string | null | undefined): Explorer | null {
  return explorer && !isRoutedId(model) ? explorer : null;
}

export const EXPLORER_NAME = "Explore";
export const EXPLORER_RULE = `The ${EXPLORER_NAME} subagent runs on a free open model here. For broad searching and reading (finding files, tracing where something is defined or used, surveying a module), use it with a focused question, one at a time, and build on what it reports; quick lookups you can do yourself. Do the planning, editing and final answer yourself.`;

/** The --agents file's content: the explorer, read-only, on the route's model. */
export function explorerAgents(r: Route): Record<string, unknown> {
  return {
    [EXPLORER_NAME]: {
      description: `Read-only code search and exploring on a free open model (${r.label}). Use it to find files, trace definitions and usages, and summarize code. Give it one focused question.`,
      prompt: "You search and read code to answer one question. Use Grep, Glob and Read, one step at a time; don't edit anything. Report what you found, with file paths and line numbers, briefly.",
      model: r.model,
      tools: ["Read", "Grep", "Glob"],
    },
  };
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * `claude --resume <id>` for a terminal, with the route's variables set first: PowerShell on
 * Windows (where openTerminal runs it), POSIX elsewhere. A team token is never printed: the
 * command reads it from its env var, or from the personal token file.
 */
export function resumeCommand(sessionId: string, model: string | null | undefined, platform: NodeJS.Platform = process.platform): string {
  const r = routeOf(model);
  const base = `claude --resume ${sessionId}`;
  if (!r) return base;
  const vars = routeVars(r);
  delete vars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  const ref = r.backend.tokenRef || null;
  const win = platform === "win32";
  const parts = Object.entries(vars).map(([k, v]) => {
    if (k === "ANTHROPIC_AUTH_TOKEN" && ref) {
      if ("env" in ref) return win ? `$env:${k}=$env:${ref.env}` : `export ${k}="$${ref.env}"`;
      return win ? `$env:${k}=(Get-Content -Raw ${psq(ref.file)} | ConvertFrom-Json).${psq(ref.key)}`
        : `export ${k}="$(node -p ${shq(`require(${JSON.stringify(ref.file)})[${JSON.stringify(ref.key)}]`)})"`;
    }
    return win ? `$env:${k}=${psq(v)}` : `export ${k}=${shq(v)}`;
  });
  return win ? `${parts.join("; ")}; ${base} --model ${psq(r.model)}` : `${parts.join("; ")}; ${base} --model ${shq(r.model)}`;
}

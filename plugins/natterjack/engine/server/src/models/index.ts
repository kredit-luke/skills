/**
 * The Models page: open models runs can use instead of Claude's, either on this computer
 * (Ollama) or hosted by the team (models.json `endpoints`). It keeps routes.ts current,
 * which is what puts them in the Model select and points a run's turns at them.
 *
 * Local: what's downloaded (`ollama list`), the recommended list (catalog.ts) with whether
 * each fits this computer (hardware.ts), and downloads with byte progress. Claude Code's
 * prompt alone is ~20k tokens and Ollama's default context is far smaller, so every model
 * downloaded here gets a twin with a 64k window (models.json `local.contextLength`): an
 * Ollama model `from` the original with num_ctx set, which shares its files and takes no
 * disk. Runs use the twin; one downloaded elsewhere gets it from "Prepare for runs". A model
 * whose own maximum is smaller gets that maximum; under 32k it's too small for Claude Code.
 * Claude Code talks to Ollama through its Anthropic-compatible API (/v1/messages), which older
 * Ollamas don't have: then the page offers an update and no local model is offered to runs.
 *
 * Team endpoints (models.json):
 *   { "endpoints": [{ "id": "gpu", "label": "Team GPU", "baseUrl": "https://llm.example.com",
 *       "token": "${TEAM_LLM_TOKEN}", "models": [{ "id": "qwen3.8:27b", "label": "Qwen3.8 27B", "tools": true }] }] }
 * baseUrl is an Anthropic-compatible server (Ollama, vLLM, or LiteLLM in front of anything).
 * The token comes from its env var, else from what the person saved on the Models page
 * (.claude/ledger/model-tokens.json, never committed, never sent back to the browser).
 * Without `models`, the endpoint's own /v1/models list is used.
 *
 * Hosted (hosted.ts): no local models (the container has no GPU); team endpoints only.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readConfigFile } from "../config.ts";
import { diskOf, hardware, type Hardware } from "../hardware.ts";
import { FIT_LABEL, RECOMMENDED, fitOf, type CatalogModel, type Fit } from "./catalog.ts";
import { Ollama, ollamaModelsDir, type OllamaModel, type OllamaShow } from "./ollama.ts";
import { setRoutes, type Backend, type Route } from "./routes.ts";

export const DEFAULT_CONTEXT = 65536;
/** Claude Code's own instructions and tools are ~20k tokens: below this there's no room to work. */
export const MIN_CONTEXT = 32768;
const GB = 1024 ** 3;
const TAG_RE = /^[a-z0-9][a-z0-9._\-/]{0,100}(:[A-Za-z0-9._\-]{1,60})?$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** "qwen3.8:27b" + 65536 → "qwen3.8:27b-ctx64k" (the twin runs use). */
export function twinName(tag: string, ctx: number): string {
  const [name, t] = tag.includes(":") ? tag.split(/:(.*)/s) : [tag, "latest"];
  return `${name}:${t}-ctx${Math.round(ctx / 1024)}k`;
}
export const isTwin = (name: string) => /-ctx\d+k$/.test(name);
/** The window a model's twin gets: the configured one, or the model's own maximum if that's smaller. */
export function contextFor(configured: number, contextMax: number | null | undefined): number {
  return contextMax && contextMax < configured ? contextMax : configured;
}
/** "qwen3.8:27b" and "qwen3.8:27b-ctx64k" name the same model; "ornith" is "ornith:latest". */
const full = (tag: string) => (tag.includes(":") ? tag : `${tag}:latest`);

export interface PullState { tag: string; status: string; completed: number; total: number; error: string | null; startedAt: number; done: boolean }
export interface EndpointTest { ok: boolean; ms: number | null; error: string | null; models: string[]; at: number }

interface EndpointCfg { id: string; label: string; baseUrl: string; token: string | null; models: { id: string; label: string; tools: boolean | null; context: number | null }[] | null }

/** models.json, normalized: bad entries are left out (validate.mjs says why). */
export function modelsConfig(): { contextLength: number; recommended: CatalogModel[]; endpoints: EndpointCfg[]; error: string | null; configured: boolean } {
  const { data, error } = readConfigFile("models.json");
  const local = (data && data.local) || {};
  const ctx = Number(local.contextLength);
  const hide = new Set(Array.isArray(local.hide) ? local.hide.map(String) : []);
  const extra: CatalogModel[] = (Array.isArray(local.recommended) ? local.recommended : [])
    .filter((m: any) => m && typeof m.tag === "string" && TAG_RE.test(m.tag))
    .map((m: any) => ({
      tag: m.tag, label: String(m.label || m.tag), params: String(m.params || ""), diskGb: Number(m.diskGb) || 0,
      context: Number(m.context) || 0, tools: m.tools !== false, goodFor: String(m.goodFor || ""), ...(m.notes ? { notes: String(m.notes) } : {}),
    }));
  const tags = new Set(extra.map((m) => m.tag));
  const recommended = [...extra, ...RECOMMENDED.filter((m) => !tags.has(m.tag))].filter((m) => !hide.has(m.tag));
  const endpoints: EndpointCfg[] = [];
  for (const e of Array.isArray(data?.endpoints) ? data.endpoints : []) {
    if (!e || !ID_RE.test(String(e.id || "")) || !/^https?:\/\/[^\s]+$/i.test(String(e.baseUrl || ""))) continue;
    if (endpoints.some((x) => x.id === e.id)) continue;
    endpoints.push({
      id: e.id, label: String(e.label || e.id), baseUrl: String(e.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, ""),
      token: typeof e.token === "string" && e.token ? e.token : null,
      models: Array.isArray(e.models)
        ? e.models.filter((m: any) => m && typeof m.id === "string" && /^[A-Za-z0-9._:\-/]{1,120}$/.test(m.id))
          .map((m: any) => ({ id: m.id, label: String(m.label || m.id), tools: typeof m.tools === "boolean" ? m.tools : null, context: Number(m.context) || null }))
        : null,
    });
  }
  return { contextLength: ctx >= 8192 && ctx <= 1048576 ? ctx : DEFAULT_CONTEXT, recommended, endpoints, error, configured: !!data };
}

export class Models {
  readonly ollama: Ollama;
  private pulls = new Map<string, PullState & { abort: AbortController }>();
  private shows = new Map<string, OllamaShow>();
  private tests = new Map<string, EndpointTest>();
  private discovered = new Map<string, string[]>();
  private cli: { at: number; installed: boolean; version: string | null } | null = null;
  private last: { at: number; running: string | null; messagesApi: boolean; list: OllamaModel[] } = { at: 0, running: null, messagesApi: false, list: [] };
  private notifyAt = 0;
  onChange: () => void = () => {};

  private readonly opts: { root: string; ledgerDir: string; hosted: boolean; ollama?: Ollama };

  constructor(opts: { root: string; ledgerDir: string; hosted: boolean; ollama?: Ollama }) {
    this.opts = opts;
    this.ollama = opts.ollama || new Ollama();
  }

  private get tokenFile() { return path.join(this.opts.ledgerDir, "model-tokens.json"); }
  private savedTokens(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.tokenFile, "utf-8")) || {}; } catch { return {}; }
  }

  /** An endpoint's token: its ${VAR} from the environment, else the one saved here, else a literal from models.json. */
  private tokenOf(e: EndpointCfg): { token: string | null; ref: Backend["tokenRef"]; source: "env" | "saved" | "config" | null; envVar: string | null } {
    const m = e.token ? /^\$\{([A-Z_][A-Z0-9_]*)\}$/i.exec(e.token) : null;
    const envVar = m ? m[1] : null;
    if (envVar && process.env[envVar]) return { token: process.env[envVar]!, ref: { env: envVar }, source: "env", envVar };
    const saved = this.savedTokens()[e.id];
    if (saved) return { token: saved, ref: { file: this.tokenFile, key: e.id }, source: "saved", envVar };
    if (e.token && !envVar) return { token: e.token, ref: null, source: "config", envVar };
    return { token: null, ref: null, source: null, envVar };
  }

  /** Save (or with "" clear) this person's token for an endpoint. */
  setToken(id: string, token: string): void {
    const cfg = modelsConfig();
    if (!cfg.endpoints.some((e) => e.id === id)) throw new Error(`No endpoint ${id} in models.json.`);
    const all = this.savedTokens();
    if (token) all[id] = token; else delete all[id];
    fs.mkdirSync(this.opts.ledgerDir, { recursive: true });
    fs.writeFileSync(this.tokenFile, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    this.refreshRoutes();
  }

  private ollamaCli(): Promise<{ installed: boolean; version: string | null }> {
    if (this.cli && Date.now() - this.cli.at < 30_000) return Promise.resolve(this.cli);
    return new Promise((resolve) => {
      execFile("ollama", ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" }, (err, out, errOut) => {
        const text = `${out || ""}${errOut || ""}`;
        this.cli = { at: Date.now(), installed: !err || /version/i.test(text), version: (/(\d+\.\d+\.\d+)/.exec(text) || [])[1] || null };
        resolve(this.cli);
      });
    });
  }

  /** What Ollama has now (null when it isn't running), and each model's capabilities. */
  async refresh(): Promise<void> {
    if (this.opts.hosted) { this.refreshRoutes(); return; }
    const running = await this.ollama.version();
    let list: OllamaModel[] = [];
    // Asked once per Ollama version (an update can add it).
    const messagesApi = running ? (this.last.running === running && this.last.messagesApi) || (await this.ollama.messagesApi()) : false;
    if (running) {
      try { list = await this.ollama.list(); } catch {}
      for (const m of list) {
        const key = `${m.name}@${m.digest}`;
        if (!this.shows.has(key)) {
          try { this.shows.set(key, await this.ollama.show(m.name)); } catch {}
        }
      }
    }
    this.last = { at: Date.now(), running, messagesApi, list };
    this.refreshRoutes();
  }

  private showOf(m: OllamaModel): OllamaShow | null { return this.shows.get(`${m.name}@${m.digest}`) || null; }

  /** A downloaded model's state for runs: its twin's name and window, and why runs can't use it (or null). */
  private localState(m: OllamaModel, configured: number): { twin: string; context: number; ready: boolean; problem: string | null } {
    const show = this.showOf(m);
    const context = contextFor(configured, show?.contextMax);
    const twin = twinName(m.name, context);
    const ready = this.last.list.some((x) => x.name === twin);
    const k = (n: number) => `${Math.round(n / 1024)}k`;
    const problem = show && !show.capabilities.includes("tools") ? "No tool calling, so runs can't use it."
      : context < MIN_CONTEXT ? `Its context window (${k(context)}) is too small for Claude Code, which needs ${k(MIN_CONTEXT)} or more.`
      : !ready ? `Needs a ${k(context)} context window before runs can use it.` : null;
    return { twin, context, ready, problem };
  }

  /** Local models runs can use (downloaded, with tools), and every team endpoint's models. */
  private refreshRoutes(): void {
    const cfg = modelsConfig();
    const routes: Route[] = [];
    // Local: models with tool calling and their twin, on an Ollama that speaks Anthropic's API.
    if (!this.opts.hosted && this.last.running && this.last.messagesApi) {
      const local: Backend = { id: "local", label: "Ollama", baseUrl: this.ollama.base, token: null };
      for (const m of this.last.list) {
        if (isTwin(m.name)) continue;
        const st = this.localState(m, cfg.contextLength);
        if (st.problem) continue;
        const rec = cfg.recommended.find((r) => full(r.tag) === full(m.name));
        routes.push({ id: `local/${m.name}`, label: `Local · ${rec?.label || m.name}`, model: st.twin, backend: local, tools: true, context: st.context });
      }
    }
    for (const e of cfg.endpoints) {
      const t = this.tokenOf(e);
      const backend: Backend = { id: `team/${e.id}`, label: e.label, baseUrl: e.baseUrl, token: t.token, tokenRef: t.ref };
      const models = e.models || (this.discovered.get(e.id) || []).map((id) => ({ id, label: id, tools: null, context: null }));
      for (const m of models) {
        if (m.tools === false) continue;
        routes.push({ id: `team/${e.id}/${m.id}`, label: `${e.label} · ${m.label}`, model: m.id, backend, tools: m.tools, context: m.context });
      }
    }
    setRoutes(routes);
  }

  private changed(force = false): void {
    if (!force && Date.now() - this.notifyAt < 500) return;
    this.notifyAt = Date.now();
    this.onChange();
  }

  /** Download a model, then make its 64k twin. Returns at once; progress shows in view(). */
  async pull(tag: string): Promise<PullState> {
    if (this.opts.hosted) throw new Error("Models can't be downloaded into a hosted dashboard.");
    tag = String(tag || "").trim();
    if (!TAG_RE.test(tag)) throw new Error(`"${tag}" isn't an Ollama model name (like qwen3.8:27b).`);
    if (!(await this.ollama.version())) throw new Error("Ollama isn't running. Install or start it, then try again.");
    const running = this.pulls.get(tag);
    if (running && !running.done) throw Object.assign(new Error(`${tag} is already downloading.`), { status: 409 });
    const abort = new AbortController();
    const st: PullState & { abort: AbortController } = { tag, status: "starting", completed: 0, total: 0, error: null, startedAt: Date.now(), done: false, abort };
    this.pulls.set(tag, st);
    this.changed(true);
    this.ollama.pull(tag, (p) => { st.status = p.status; st.completed = p.completed; st.total = p.total; this.changed(); }, abort.signal)
      .then(async () => {
        st.status = "preparing for runs";
        this.changed(true);
        await this.makeTwin(tag);
        st.status = "done";
      })
      .catch((e) => { st.error = abort.signal.aborted ? "Cancelled" : e.message; st.status = "failed"; })
      .finally(async () => {
        st.done = true;
        await this.refresh().catch(() => {});
        this.changed(true);
      });
    const { abort: _a, ...pub } = st;
    return pub;
  }

  cancel(tag: string): void {
    const st = this.pulls.get(tag);
    if (st && !st.done) st.abort.abort();
  }

  /** A model's twin with the window runs use (its own maximum if that's smaller); none when that's too small. */
  private async makeTwin(name: string): Promise<void> {
    const show = await this.ollama.show(name);
    const ctx = contextFor(modelsConfig().contextLength, show.contextMax);
    if (ctx < MIN_CONTEXT || !show.capabilities.includes("tools")) return;
    await this.ollama.derive(twinName(name, ctx), name, { num_ctx: ctx });
  }

  /** Make the twin for a model downloaded outside the dashboard. */
  async prepare(name: string): Promise<void> {
    if (!TAG_RE.test(name) || isTwin(name)) throw new Error("Pick a downloaded model.");
    await this.makeTwin(name);
    await this.refresh();
    this.changed(true);
  }

  /** Delete a model and its twin. */
  async remove(name: string): Promise<void> {
    if (this.opts.hosted) throw new Error("There are no local models in a hosted dashboard.");
    if (!TAG_RE.test(name)) throw new Error("Pick a downloaded model.");
    const twins = this.last.list.filter((m) => isTwin(m.name) && m.name.startsWith(`${full(name)}-ctx`)).map((m) => m.name);
    for (const t of twins) await this.ollama.remove(t).catch(() => {});
    await this.ollama.remove(name);
    this.pulls.delete(name);
    await this.refresh();
    this.changed(true);
  }

  /** Reach an endpoint: GET /v1/models with its token (also how one without a `models` list gets its models). */
  async test(id: string): Promise<EndpointTest> {
    const e = modelsConfig().endpoints.find((x) => x.id === id);
    if (!e) throw new Error(`No endpoint ${id} in models.json.`);
    const { token } = this.tokenOf(e);
    const started = Date.now();
    let result: EndpointTest;
    try {
      const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
      if (token) { headers["x-api-key"] = token; headers.authorization = `Bearer ${token}`; }
      const r = await fetch(`${e.baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(8000) });
      const body: any = await r.json().catch(() => null);
      if (r.status === 401 || r.status === 403) throw new Error(token ? "The endpoint refused the token." : "The endpoint needs a token.");
      if (!r.ok) throw new Error(`The endpoint answered ${r.status}.`);
      const models = (Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [])
        .map((m: any) => String(m?.id || m?.name || "")).filter((s: string) => /^[A-Za-z0-9._:\-/]{1,120}$/.test(s));
      result = { ok: true, ms: Date.now() - started, error: null, models, at: Date.now() };
      this.discovered.set(id, models);
    } catch (err) {
      const msg = (err as Error).name === "TimeoutError" ? "No answer in 8 seconds." : (err as Error).message;
      result = { ok: false, ms: null, error: /fetch failed/i.test(msg) ? `Couldn't reach ${e.baseUrl}.` : msg, models: [], at: Date.now() };
    }
    this.tests.set(id, result);
    this.refreshRoutes();
    this.changed(true);
    return result;
  }

  /** GET /api/models. */
  async view(force = false) {
    const cfg = modelsConfig();
    if (force || Date.now() - this.last.at > 3000) await this.refresh();
    const hosted = this.opts.hosted;
    const hw: Hardware = await hardware(this.opts.root);
    const dir = ollamaModelsDir();
    const disk = diskOf(dir);
    const gpu = hw.gpus.reduce<{ vram: number | null; unified: boolean }>((best, g) => (g.vramGb != null && g.vramGb > (best.vram || 0) ? { vram: g.vramGb, unified: !!g.unified } : best), { vram: null, unified: false });
    const installedNames = new Set(this.last.list.map((m) => full(m.name)));
    const pulls = [...this.pulls.values()].map(({ abort: _a, ...p }) => p);
    const fit = (diskGb: number, installed: boolean): { fit: Fit; fitLabel: string } => {
      const f = fitOf({ diskGb, vramGb: gpu.vram, unified: gpu.unified, memoryGb: hw.memoryGb, freeDiskGb: disk?.freeGb ?? null, installed });
      return { fit: f, fitLabel: FIT_LABEL[f] };
    };
    const cli = hosted ? { installed: false, version: null } : await this.ollamaCli();
    const installed = this.last.list.filter((m) => !isTwin(m.name)).map((m) => {
      const show = this.showOf(m);
      const st = this.localState(m, cfg.contextLength);
      const rec = cfg.recommended.find((r) => full(r.tag) === full(m.name));
      return {
        name: m.name, label: rec?.label || m.name, sizeGb: round1(m.sizeBytes / GB), params: m.params, quantization: m.quantization,
        tools: show ? show.capabilities.includes("tools") : null, capabilities: show?.capabilities || [], contextMax: show?.contextMax || null,
        context: st.context, ready: st.ready, problem: st.problem,
        /** Something "Prepare for runs" fixes (the twin is missing), rather than the model itself. */
        preparable: !st.ready && st.context >= MIN_CONTEXT && (!show || show.capabilities.includes("tools")),
        routeId: `local/${m.name}`, recommended: !!rec, ...fit(m.sizeBytes / GB, true),
      };
    });
    return {
      hosted,
      hardware: hw,
      modelsDir: disk ? { ...disk, path: dir } : null,
      contextLength: cfg.contextLength,
      ollama: {
        installed: cli.installed || !!this.last.running,
        running: !!this.last.running,
        /** Speaks Anthropic's Messages API, which Claude Code needs (older Ollamas don't). */
        messagesApi: !!this.last.messagesApi,
        version: this.last.running || cli.version,
        base: this.ollama.base,
      },
      usedGb: round1(installed.reduce((s, m) => s + m.sizeGb, 0)),
      recommended: hosted ? [] : cfg.recommended.map((m) => ({ ...m, installed: installedNames.has(full(m.tag)), ...fit(m.diskGb, installedNames.has(full(m.tag))) })),
      installed,
      pulls,
      endpoints: cfg.endpoints.map((e) => {
        const t = this.tokenOf(e);
        const models = e.models || (this.discovered.get(e.id) || []).map((id) => ({ id, label: id, tools: null, context: null }));
        return {
          id: e.id, label: e.label, baseUrl: e.baseUrl, tokenSource: t.source, tokenVar: t.envVar,
          needsToken: !!e.token && !t.token, discovered: !e.models,
          models: models.map((m) => ({ ...m, routeId: `team/${e.id}/${m.id}` })),
          test: this.tests.get(e.id) || null,
        };
      }),
      configured: cfg.configured,
      error: cfg.error,
    };
  }
}

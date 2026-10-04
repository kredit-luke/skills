// Local and team models (server/src/models/): the recommended list and whether a model fits,
// Ollama's API (against a fake Ollama), routes and the environment a turn runs with, models.json
// endpoints and their tokens. config.ts reads WORKSPACE_ROOT at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-models-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
const LEDGER = path.join(ROOT, ".claude", "ledger");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = LEDGER;
process.env.OLLAMA_MODELS = path.join(ROOT, "ollama-models");

const { fitOf, RECOMMENDED } = await import("../src/models/catalog.ts");
const { Ollama, ollamaBase, parseShow, pullStep } = await import("../src/models/ollama.ts");
const { Models, modelsConfig, twinName, isTwin } = await import("../src/models/index.ts");
const { setRoutes, routeOf, turnEnv, resumeCommand, isRoutedId } = await import("../src/models/routes.ts");
const { parseNvidiaSmi } = await import("../src/hardware.ts");
const { agentOf } = await import("../src/agents/index.ts");

const write = (name: string, data: unknown) => {
  const file = path.join(CFG, name);
  fs.writeFileSync(file, JSON.stringify(data));
  const t = new Date(Date.now() + Math.random() * 1000);
  fs.utimesSync(file, t, t);
};

test("recommended list: every entry is pullable and says whether it can call tools", () => {
  assert.ok(RECOMMENDED.length >= 5);
  for (const m of RECOMMENDED) {
    assert.match(m.tag, /^[a-z0-9][a-z0-9._\-]*:[A-Za-z0-9._\-]+$/, m.tag);
    assert.ok(m.diskGb > 0 && m.context > 0 && typeof m.tools === "boolean", m.tag);
  }
  assert.ok(RECOMMENDED.some((m) => !m.tools), "one without tool calling shows the difference");
});

test("fit: GPU, partly on the GPU, CPU, too big, not enough disk", () => {
  const base = { vramGb: 16, unified: false, memoryGb: 64, freeDiskGb: 500, installed: false };
  assert.equal(fitOf({ ...base, diskGb: 5.6 }), "gpu");
  assert.equal(fitOf({ ...base, diskGb: 18 }), "partial"); // 21.6 GB needed, 16 on the GPU
  assert.equal(fitOf({ ...base, vramGb: null, diskGb: 18 }), "cpu");
  assert.equal(fitOf({ ...base, vramGb: null, memoryGb: 16, diskGb: 18 }), "too-big");
  assert.equal(fitOf({ ...base, freeDiskGb: 10, diskGb: 18 }), "no-disk");
  assert.equal(fitOf({ ...base, freeDiskGb: 10, diskGb: 18, installed: true }), "partial", "downloaded already: disk doesn't matter");
  // Apple silicon: three quarters of RAM.
  assert.equal(fitOf({ ...base, vramGb: null, unified: true, memoryGb: 32, diskGb: 18 }), "gpu");
  assert.equal(fitOf({ ...base, vramGb: null, unified: true, memoryGb: 16, diskGb: 18 }), "too-big");
});

test("hardware: nvidia-smi's csv", () => {
  assert.deepEqual(parseNvidiaSmi("NVIDIA GeForce RTX 4090 Laptop GPU, 16376\r\nNVIDIA A100, 81920 MiB\n"), [
    { name: "NVIDIA GeForce RTX 4090 Laptop GPU", vramGb: 16 },
    { name: "NVIDIA A100", vramGb: 80 },
  ]);
  assert.deepEqual(parseNvidiaSmi(""), []);
});

test("ollama: OLLAMA_HOST forms, pull progress across layers, show", () => {
  assert.equal(ollamaBase({}), "http://127.0.0.1:11434");
  assert.equal(ollamaBase({ OLLAMA_HOST: "0.0.0.0" }), "http://127.0.0.1:11434");
  assert.equal(ollamaBase({ OLLAMA_HOST: "gpu-box:8080" }), "http://gpu-box:8080");
  assert.equal(ollamaBase({ OLLAMA_HOST: "https://ollama.example.com" }), "https://ollama.example.com");
  const layers = new Map();
  pullStep({ status: "pulling a", digest: "sha256:a", total: 100, completed: 50 }, layers);
  assert.deepEqual(pullStep({ status: "pulling b", digest: "sha256:b", total: 300, completed: 30 }, layers), { status: "pulling b", completed: 80, total: 400 });
  assert.deepEqual(pullStep({ status: "verifying sha256 digest" }, layers), { status: "verifying sha256 digest", completed: 80, total: 400 });
  assert.deepEqual(parseShow({ capabilities: ["completion", "tools"], model_info: { "qwen3.context_length": 262144 }, parameters: "temperature 0.6\nnum_ctx 65536" }),
    { capabilities: ["completion", "tools"], contextMax: 262144, numCtx: 65536 });
  assert.deepEqual(parseShow({}), { capabilities: [], contextMax: null, numCtx: null });
});

test("twins: the 64k copy runs use", () => {
  assert.equal(twinName("qwen3.8:27b", 65536), "qwen3.8:27b-ctx64k");
  assert.equal(twinName("ornith", 131072), "ornith:latest-ctx128k");
  assert.ok(isTwin("qwen3.8:27b-ctx64k") && !isTwin("qwen3.8:27b"));
});

// ---------------------------------------------------------------- routes and the turn's env

const localRoute = {
  id: "local/qwen3.8:27b", label: "Local · Qwen3.8 27B", model: "qwen3.8:27b-ctx64k", tools: true, context: 65536,
  backend: { id: "local", label: "Ollama", baseUrl: "http://127.0.0.1:11434", token: null },
};
const teamRoute = {
  id: "team/gpu/glm-5.3", label: "Team GPU · GLM", model: "glm-5.3", tools: true, context: null,
  backend: { id: "team/gpu", label: "Team GPU", baseUrl: "https://llm.example.com", token: "s3cret", tokenRef: { env: "TEAM_LLM_TOKEN" } },
};

test("billing guarantee: a turn on Claude's own models gets none of a local model's settings", () => {
  setRoutes([localRoute, teamRoute] as any);
  const shell = { PATH: "/bin", ANTHROPIC_BASE_URL: "https://gateway.corp", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDECODE: "1" };
  for (const model of ["opus", "sonnet", "haiku", "fable", null, "claude-opus-5-5", "local/not-downloaded"]) {
    const env = turnEnv(model, shell);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, String(model));
    assert.equal(env.ANTHROPIC_MODEL, undefined, String(model));
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined, String(model));
    // The person's own provider settings are theirs: untouched for Claude's models.
    assert.equal(env.ANTHROPIC_BASE_URL, "https://gateway.corp", String(model));
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1", String(model));
    assert.equal(env.CLAUDECODE, undefined, "session markers are still stripped");
  }
  // A local turn, then a Claude turn: each is built from the shell's env, so nothing carries over.
  const local = turnEnv("local/qwen3.8:27b", shell);
  assert.equal(local.ANTHROPIC_BASE_URL, "http://127.0.0.1:11434");
  assert.equal(local.ANTHROPIC_AUTH_TOKEN, "ollama");
  assert.equal(local.ANTHROPIC_API_KEY, "");
  assert.equal(local.CLAUDE_CODE_USE_BEDROCK, undefined, "a shell's Bedrock setting can't send a local turn to AWS");
  for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) assert.equal(local[k], "qwen3.8:27b-ctx64k", k);
  assert.equal(turnEnv("opus", shell).ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(turnEnv("team/gpu/glm-5.3", shell).ANTHROPIC_AUTH_TOKEN, "s3cret");
});

test("Claude agent: a routed model's turn uses the server's model name, no effort or dollar budget", () => {
  setRoutes([localRoute] as any);
  const a = agentOf("claude");
  const turn = { first: true, sessionId: "s", prompt: "p", label: "l", model: "local/qwen3.8:27b", effort: "high", planMode: false, permissionMode: "auto", budgetUsd: 5, rules: "", planRule: null, addDirs: [] };
  const args = a.turnArgs(turn);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "qwen3.8:27b-ctx64k"]);
  assert.ok(!args.includes("--effort") && !args.includes("--max-budget-usd"));
  // Gone since (deleted): the id as it is, which fails, rather than no --model (Claude's default model).
  assert.ok(a.turnArgs({ ...turn, model: "local/gone:1b" }).includes("local/gone:1b"));
  assert.ok(a.turnArgs({ ...turn, model: "opus" }).includes("--effort"));
  assert.ok(isRoutedId("team/gpu/x") && !isRoutedId("opus") && !isRoutedId("local/--bare x"));
});

test("resume in a terminal: the route's variables first; a team token is read, never printed", () => {
  setRoutes([localRoute, teamRoute] as any);
  assert.equal(resumeCommand("abc", "opus", "win32"), "claude --resume abc");
  const win = resumeCommand("abc", "local/qwen3.8:27b", "win32");
  assert.match(win, /^\$env:ANTHROPIC_BASE_URL='http:\/\/127\.0\.0\.1:11434'; /);
  assert.match(win, /claude --resume abc --model 'qwen3\.8:27b-ctx64k'$/);
  const sh = resumeCommand("abc", "team/gpu/glm-5.3", "darwin");
  assert.match(sh, /export ANTHROPIC_AUTH_TOKEN="\$TEAM_LLM_TOKEN"/);
  assert.doesNotMatch(sh, /s3cret/);
  assert.equal(agentOf("claude").resumeCommand("abc", null), "claude --resume abc");
});

// ---------------------------------------------------------------- Models against a fake Ollama

function fakeOllama() {
  const state = { old: false, models: [] as { name: string; size: number; digest: string; tools: boolean; ctx?: number }[], created: [] as any[], deleted: [] as string[] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      const send = (d: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
      if (req.url === "/api/version") return send({ version: state.old ? "0.13.5" : "0.21.0" });
      if (req.url === "/v1/messages") return state.old ? (res.writeHead(404), res.end("404 page not found")) : send({ type: "error" }, 400);
      if (req.url === "/api/tags") return send({ models: state.models.map((m) => ({ name: m.name, size: m.size, digest: m.digest, details: { parameter_size: "9B", quantization_level: "Q4_K_M" } })) });
      if (req.url === "/api/show") {
        const m = state.models.find((x) => x.name === json.model);
        return m ? send({ capabilities: m.tools ? ["completion", "tools"] : ["completion"], model_info: { "x.context_length": m.ctx || 262144 } }) : send({ error: "not found" }, 404);
      }
      if (req.url === "/api/pull") {
        if (json.model === "nope:1b") return send({ error: "pull model manifest: file does not exist" }, 500);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
        res.write(JSON.stringify({ status: "pulling a", digest: "sha256:a", total: 1000, completed: 500 }) + "\n");
        res.write(JSON.stringify({ status: "pulling a", digest: "sha256:a", total: 1000, completed: 1000 }) + "\n");
        res.write(JSON.stringify({ status: "success" }) + "\n");
        state.models.push({ name: json.model, size: 6 * 1024 ** 3, digest: "d-" + json.model, tools: !json.model.startsWith("deepseek") });
        return res.end();
      }
      if (req.url === "/api/create") {
        state.created.push(json);
        state.models.push({ name: json.model, size: 6 * 1024 ** 3, digest: "t-" + json.model, tools: true });
        return send({ status: "success" });
      }
      if (req.url === "/api/delete") {
        state.deleted.push(json.model);
        state.models = state.models.filter((m) => m.name !== json.model);
        return send({});
      }
      if (req.url === "/v1/models") {
        if (req.headers["x-api-key"] !== "tok-123") return send({ error: "unauthorized" }, 401);
        return send({ data: [{ id: "glm-5.3" }, { id: "qwen3.8:27b" }] });
      }
      send({ error: "unknown" }, 404);
    });
  });
  return new Promise<{ base: string; state: typeof state; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ base: `http://127.0.0.1:${port}`, state, close: () => server.close() });
    });
  });
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};

test("Models: download with progress, a 64k twin, a route for runs; delete takes both", async () => {
  const fake = await fakeOllama();
  try {
    const models = new Models({ root: ROOT, ledgerDir: LEDGER, hosted: false, ollama: new Ollama(fake.base) });
    let changes = 0;
    models.onChange = () => changes++;
    await models.refresh();
    assert.equal(routeOf("local/ornith:9b"), null);

    const st = await models.pull("ornith:9b");
    assert.equal(st.tag, "ornith:9b");
    await assert.rejects(models.pull("ornith:9b"), /already downloading/);
    await until(() => (models as any).pulls.get("ornith:9b").done);
    assert.ok(changes > 0);
    assert.deepEqual(fake.state.created, [{ model: "ornith:9b-ctx64k", from: "ornith:9b", parameters: { num_ctx: 65536 }, stream: false }]);

    const r = routeOf("local/ornith:9b");
    assert.ok(r);
    assert.equal(r!.model, "ornith:9b-ctx64k");
    assert.equal(r!.label, "Local · Ornith 9B");
    assert.equal(r!.backend.baseUrl, fake.base);

    const view = await models.view(true);
    assert.equal(view.ollama.running, true);
    assert.deepEqual(view.installed.map((i: any) => [i.name, i.ready, i.tools]), [["ornith:9b", true, true]], "the twin isn't listed on its own");
    assert.equal(view.usedGb, 6);
    assert.equal(view.recommended.find((x: any) => x.tag === "ornith:9b")!.installed, true);
    assert.equal(view.pulls[0].completed, 1000);

    // No tool calling: downloaded, listed, but not something a run can pick.
    await models.pull("deepseek-r1:14b");
    await until(() => (models as any).pulls.get("deepseek-r1:14b").done);
    assert.equal(routeOf("local/deepseek-r1:14b"), null);

    // A failed download says why.
    await models.pull("nope:1b");
    await until(() => (models as any).pulls.get("nope:1b").done);
    assert.match((models as any).pulls.get("nope:1b").error, /does not exist/);
    await assert.rejects(models.pull("--bad name"), /isn't an Ollama model name/);

    // Downloaded elsewhere: a 32k model gets a 32k twin from Prepare; an 8k one is too small for Claude Code.
    fake.state.models.push({ name: "qwen2.5:14b", size: 8 * 1024 ** 3, digest: "q", tools: true, ctx: 32768 }, { name: "tiny:8b", size: 4 * 1024 ** 3, digest: "t", tools: true, ctx: 8192 });
    let v = await models.view(true);
    const q = v.installed.find((i: any) => i.name === "qwen2.5:14b")!;
    assert.deepEqual([q.ready, q.preparable, q.context], [false, true, 32768]);
    assert.equal(routeOf("local/qwen2.5:14b"), null, "not prepared: not offered");
    const tiny = v.installed.find((i: any) => i.name === "tiny:8b")!;
    assert.equal(tiny.preparable, false);
    assert.match(tiny.problem, /too small for Claude Code/);
    await models.prepare("qwen2.5:14b");
    assert.equal(routeOf("local/qwen2.5:14b")?.model, "qwen2.5:14b-ctx32k");
    await models.prepare("tiny:8b");
    assert.ok(!fake.state.models.some((m) => m.name.startsWith("tiny:8b-ctx")), "no twin for a model that's too small");

    // An Ollama without the Anthropic API: models are listed but none is offered to runs.
    fake.state.old = true;
    v = await models.view(true);
    assert.equal(v.ollama.messagesApi, false);
    assert.equal(routeOf("local/ornith:9b"), null);
    fake.state.old = false;
    await models.view(true);
    assert.ok(routeOf("local/ornith:9b"));

    await models.remove("ornith:9b");
    assert.deepEqual(fake.state.deleted, ["ornith:9b-ctx64k", "ornith:9b"]);
    assert.equal(routeOf("local/ornith:9b"), null);
  } finally {
    fake.close();
  }
});

test("Models: Ollama not running means no local routes, and downloads say so", async () => {
  const models = new Models({ root: ROOT, ledgerDir: LEDGER, hosted: false, ollama: new Ollama("http://127.0.0.1:1") });
  await models.refresh();
  assert.deepEqual((await models.view()).installed, []);
  await assert.rejects(models.pull("ornith:9b"), /isn't running/);
});

test("team endpoints: models.json, ${VAR} or a saved token, /v1/models when no list is given", async () => {
  const fake = await fakeOllama();
  try {
    write("models.json", {
      local: { contextLength: 131072, hide: ["deepseek-r1:14b"] },
      endpoints: [
        { id: "gpu", label: "Team GPU", baseUrl: fake.base, token: "${TEAM_TOK_TEST}", models: [{ id: "glm-5.3", label: "GLM 5.3", tools: true }, { id: "chat-only", tools: false }] },
        { id: "auto", label: "Auto", baseUrl: fake.base + "/", token: "${AUTO_TOK_TEST}" },
        { id: "BAD id", baseUrl: "nope" },
      ],
    });
    const cfg = modelsConfig();
    assert.equal(cfg.contextLength, 131072);
    assert.ok(!cfg.recommended.some((m) => m.tag === "deepseek-r1:14b"));
    assert.deepEqual(cfg.endpoints.map((e) => e.id), ["gpu", "auto"]);

    const models = new Models({ root: ROOT, ledgerDir: LEDGER, hosted: true, ollama: new Ollama("http://127.0.0.1:1") });
    process.env.TEAM_TOK_TEST = "tok-123";
    await models.refresh();
    const gpu = routeOf("team/gpu/glm-5.3");
    assert.equal(gpu?.backend.token, "tok-123");
    assert.deepEqual(gpu?.backend.tokenRef, { env: "TEAM_TOK_TEST" });
    assert.equal(routeOf("team/gpu/chat-only"), null, "no tool calling: not offered");

    // No token yet for "auto": the test says so; a saved one works and stays out of the view.
    let view = await models.view();
    const auto = view.endpoints.find((e: any) => e.id === "auto")!;
    assert.equal(auto.needsToken, true);
    assert.equal((await models.test("auto")).error, "The endpoint needs a token.");
    models.setToken("auto", "tok-123");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(LEDGER, "model-tokens.json"), "utf-8")), { auto: "tok-123" });
    const t = await models.test("auto");
    assert.equal(t.ok, true);
    assert.deepEqual(t.models, ["glm-5.3", "qwen3.8:27b"]);
    assert.ok(routeOf("team/auto/qwen3.8:27b"), "discovered models become routes");
    assert.deepEqual(routeOf("team/auto/glm-5.3")?.backend.tokenRef, { file: path.join(LEDGER, "model-tokens.json"), key: "auto" });
    view = await models.view();
    assert.doesNotMatch(JSON.stringify(view), /tok-123/, "tokens never go to the browser");
    assert.equal(view.endpoints.find((e: any) => e.id === "auto")!.tokenSource, "saved");
    assert.deepEqual(view.recommended, [], "hosted: no local models");
    await assert.rejects(models.pull("ornith:9b"), /hosted/);
    assert.throws(() => models.setToken("nope", "x"), /No endpoint/);
  } finally {
    fake.close();
    delete process.env.TEAM_TOK_TEST;
    fs.rmSync(path.join(CFG, "models.json"), { force: true });
  }
});

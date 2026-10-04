// Smart routing (server/src/models/router.ts): Claude's requests pass through to Anthropic
// untouched (the person's own sign-in), the explorer's go to the open model's server without
// those credentials, one at a time and kept alive while they wait. Against a fake Anthropic
// and a fake Ollama.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { ModelRouter } = await import("../src/models/router.ts");
const { setRoutes, setExplorer, explorerFor, turnEnv, EXPLORER_RULE } = await import("../src/models/routes.ts");
const { agentOf } = await import("../src/agents/index.ts");

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() }));
  });
}
const readBody = (req: http.IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });

test("router: Claude's requests pass through untouched; the explorer's go to the open model, credentials off, one at a time", async () => {
  const seen: { anthropic: any[]; ollama: any[] } = { anthropic: [], ollama: [] };
  let inFlight = 0, maxInFlight = 0;
  const anthropic = await server(async (req, res) => {
    seen.anthropic.push({ url: req.url, auth: req.headers.authorization, beta: req.headers["anthropic-beta"], body: await readBody(req) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", model: "claude-opus-5-5" }));
  });
  const ollama = await server(async (req, res) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    seen.ollama.push({ url: req.url, auth: req.headers.authorization, key: req.headers["x-api-key"], body: JSON.parse(await readBody(req)) });
    await new Promise((r) => setTimeout(r, 150));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: message_start\ndata: {"type":"message_start"}\n\n');
    inFlight--;
  });
  const route = { id: "local/gemma4:12b", label: "Local · Gemma 4 12B", model: "gemma4:12b-ctx64k", tools: true, context: 65536, backend: { id: "local", label: "Ollama", baseUrl: ollama.url, token: null } };
  // A team endpoint serving the same model name: the explorer the person picked gets the requests, not the first match.
  const twin = { ...route, id: "team/gemma4:12b", backend: { id: "team", label: "Team", baseUrl: "http://127.0.0.1:9", token: "team-secret" } };
  setRoutes([twin, route]);
  setExplorer({ route, agentsFile: "/tmp/agents.json", url: "http://127.0.0.1:4555" });
  const router = new ModelRouter(anthropic.url, { pingMs: 50 });
  const url = await router.start();
  try {
    const oauth = { authorization: "Bearer sk-ant-oat01-secret", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" };
    // Claude's own request: byte for byte, credentials and all.
    const claudeBody = JSON.stringify({ model: "claude-opus-5-5", stream: false, messages: [] });
    const r1 = await fetch(`${url}/v1/messages?beta=true`, { method: "POST", headers: oauth, body: claudeBody });
    assert.equal((await r1.json()).model, "claude-opus-5-5");
    assert.deepEqual(seen.anthropic[0], { url: "/v1/messages?beta=true", auth: "Bearer sk-ant-oat01-secret", beta: "oauth-2025-04-20", body: claudeBody });

    // Two explorer requests at once: queued, one at a time; pinged while waiting; no Claude token on the way.
    const ex = (n: number) => fetch(`${url}/v1/messages?beta=true`, { method: "POST", headers: oauth, body: JSON.stringify({ model: "gemma4:12b-ctx64k", stream: true, n, messages: [] }) }).then((r) => r.text());
    const [a, b] = await Promise.all([ex(1), ex(2)]);
    assert.match(a + b, /message_start/);
    assert.match(b + a, /event: ping/, "the one that waited was kept alive");
    assert.equal(maxInFlight, 1);
    assert.equal(seen.ollama.length, 2);
    for (const o of seen.ollama) {
      assert.equal(o.auth, "Bearer ollama");
      assert.equal(o.key, "ollama");
      assert.doesNotMatch(JSON.stringify(o), /sk-ant/);
    }
    assert.equal(seen.anthropic.length, 1, "nothing of the explorer's reached Anthropic");

    // Ollama can't count tokens: estimated here.
    const c = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: oauth, body: JSON.stringify({ model: "gemma4:12b-ctx64k", messages: [{ role: "user", content: "x".repeat(400) }] }) });
    assert.ok((await c.json()).input_tokens > 100);
    assert.deepEqual({ local: router.stats.local, claude: router.stats.claude }, { local: 3, claude: 1 });
  } finally {
    router.stop(); anthropic.close(); ollama.close(); setExplorer(null);
  }
});

test("smart routing on: Claude turns get the explorer and the router, keep their sign-in; local turns don't delegate", () => {
  const route = { id: "local/gemma4:12b", label: "Local · Gemma 4 12B", model: "gemma4:12b-ctx64k", tools: true, context: 65536, backend: { id: "local", label: "Ollama", baseUrl: "http://127.0.0.1:11434", token: null } };
  setRoutes([route]);
  setExplorer({ route, agentsFile: "/tmp/agents.json", url: "http://127.0.0.1:4555" });
  try {
    const shell = { PATH: "/bin" };
    const opus = turnEnv("opus", shell);
    assert.equal(opus.ANTHROPIC_BASE_URL, "http://127.0.0.1:4555");
    assert.equal(opus.ANTHROPIC_AUTH_TOKEN, undefined, "no token: Claude Code sends the person's own sign-in");
    assert.equal(opus.ANTHROPIC_MODEL, undefined);
    assert.equal(explorerFor("local/gemma4:12b"), null, "a local turn is already local");
    assert.equal(turnEnv("local/gemma4:12b", shell).ANTHROPIC_BASE_URL, "http://127.0.0.1:11434");
    const t = { first: true, sessionId: "s", prompt: "p", label: "l", model: "opus", effort: null, planMode: false, permissionMode: "auto", budgetUsd: null, rules: "R", planRule: null, addDirs: [] };
    const args = agentOf("claude").turnArgs(t);
    assert.equal(args[args.indexOf("--agents") + 1], "/tmp/agents.json");
    assert.ok(args[args.indexOf("--append-system-prompt") + 1].includes(EXPLORER_RULE));
  } finally {
    setExplorer(null);
  }
  assert.equal(turnEnv("opus", { PATH: "/bin" }).ANTHROPIC_BASE_URL, undefined, "off: exactly as before");
  assert.ok(!agentOf("claude").turnArgs({ first: true, sessionId: "s", prompt: "p", label: "l", model: "opus", effort: null, planMode: false, permissionMode: "auto", budgetUsd: null, rules: "R", planRule: null, addDirs: [] }).includes("--agents"));
});

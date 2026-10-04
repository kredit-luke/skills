// A run on a local model, then a reply that moves it on to Opus: what each turn's `claude`
// got (its --model, its effort, the local-model rule, the backend in its environment), through
// the real RunManager. The fake claude records the environment it ran with; the command line is
// recorded where it's built (a Windows .cmd shim can't pass the multi-line rules through cmd.exe).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, drainable } from "../src/runs.ts";
import { setRoutes } from "../src/models/routes.ts";
import { agentOf } from "../src/agents/index.ts";
import type { RunMeta } from "../../shared/api.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-run-models-"));
const LOG = path.join(TMP, "turns.log");
const FAKE = `
import fs from "node:fs";
const a = process.argv.slice(2);
const val = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({
  model: val("--model"), effort: val("--effort"), rules: val("--append-system-prompt") || "",
  baseUrl: process.env.ANTHROPIC_BASE_URL || null, token: process.env.ANTHROPIC_AUTH_TOKEN || null,
}) + "\\n");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.5, num_turns: 1 }));
`;

before(() => {
  const bin = path.join(TMP, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "fake-claude.mjs"), FAKE);
  const file = process.platform === "win32" ? path.join(bin, "claude.cmd") : path.join(bin, "claude");
  if (process.platform === "win32") fs.writeFileSync(file, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, { mode: 0o755 });
  process.env.DASHBOARD_CLAUDE_BIN = file;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const turns = (): any[] => {
  try { return fs.readFileSync(LOG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

function settled(runs: RunManager, id: string, ms = 15000): Promise<RunMeta> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const m = runs.get(id);
      if (m && !runs.live.has(id) && m.status === "succeeded" && !drainable(m)) return resolve(m);
      if (Date.now() > end) return reject(new Error(`run ${id} still ${m && m.status}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("a local run explores on Ollama, then a reply continues it on Opus with the person's own sign-in", async () => {
  setRoutes([{
    id: "local/gemma4:12b", label: "Local · Gemma 4 12B", model: "gemma4:12b-ctx64k", tools: true, context: 65536,
    backend: { id: "local", label: "Ollama", baseUrl: "http://127.0.0.1:11434", token: null },
  }]);
  const claude = agentOf("claude");
  const built: string[][] = [];
  const turnArgs = claude.turnArgs.bind(claude);
  claude.turnArgs = (t) => { const a = turnArgs(t); built.push(a); return a; };
  const runs = new RunManager(path.join(TMP, "ledger"));
  const run = runs.start({ prompt: "find the adapter", cwd: TMP, model: "local/gemma4:12b", effort: null, agent: "claude" });
  let meta = await settled(runs, run.id);
  assert.equal(meta.costUsd, 0, "a local turn costs nothing");

  runs.reply(run.id, "now plan the change", { model: "opus", effort: "high" });
  meta = await settled(runs, run.id);
  assert.equal(meta.model, "opus");
  assert.equal(meta.effort, "high");
  assert.equal(meta.sessionId, run.sessionId, "the same session carries on");

  claude.turnArgs = turnArgs;
  const val = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
  const [localArgs, opusArgs] = built;
  const [localEnv, opusEnv] = turns();
  assert.deepEqual([val(localArgs, "--model"), val(localArgs, "--effort")], ["gemma4:12b-ctx64k", null]);
  assert.match(val(localArgs, "--append-system-prompt")!, /one request at a time/);
  assert.deepEqual([localEnv.baseUrl, localEnv.token], ["http://127.0.0.1:11434", "ollama"]);
  assert.deepEqual([val(opusArgs, "--model"), val(opusArgs, "--effort"), val(opusArgs, "--resume")], ["opus", "high", run.sessionId]);
  assert.doesNotMatch(val(opusArgs, "--append-system-prompt")!, /one request at a time/);
  assert.deepEqual([opusEnv.baseUrl, opusEnv.token], [null, null], "Opus: no local backend, no token: the normal Claude sign-in");
});

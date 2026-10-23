// A fake claude for tests that run real turns through RunManager (run-queue, remote-link-client).
// Each turn writes its prompt to a log and ends with a result. A prompt containing "slow" keeps
// the turn open for a moment, so messages can be queued while it works; "slow ask" ends the turn
// with a question. Not a test file itself (no .test.ts): node --test doesn't run it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drainable } from "../src/runs.ts";
import type { RunManager } from "../src/runs.ts";
import type { RunMeta } from "../../shared/api.ts";

/** A temp folder with the fake in it; install() points DASHBOARD_CLAUDE_BIN at it (call it in before()). */
export function fakeClaude(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const log = path.join(dir, "prompts.log");
  const script = `
import fs from "node:fs";
const a = process.argv.slice(2);
const prompt = a[a.indexOf("-p") + 1] || "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(prompt) + "\\n");
const result = prompt.includes("slow ask") ? 'Which one? <<QUESTION>>{"questions":[{"question":"Which?","header":"Pick","multiSelect":false,"options":[{"label":"A","description":""}]}]}<</QUESTION>>' : "done";
setTimeout(() => {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0, num_turns: 1 }));
  process.exit(0);
}, prompt.includes("slow") ? 700 : 10);
`;
  return {
    dir,
    install() {
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "fake-claude.mjs"), script);
      const file = process.platform === "win32" ? path.join(bin, "claude.cmd") : path.join(bin, "claude");
      if (process.platform === "win32") fs.writeFileSync(file, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
      else fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, { mode: 0o755 });
      process.env.DASHBOARD_CLAUDE_BIN = file;
    },
    /** Every prompt the fake was given, in order (one may stop at a newline: cmd.exe cuts arguments there). */
    prompts(): string[] {
      try { return fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
    },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** Resolves once the run is idle in one of `statuses` (a drain may start another turn first). */
export function settled(runs: RunManager, id: string, statuses = ["succeeded", "failed", "waiting", "cancelled"], ms = 15000): Promise<RunMeta> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const m = runs.get(id);
      if (m && !runs.live.has(id) && statuses.includes(m.status) && !drainable(m)) return resolve(m);
      if (Date.now() > end) return reject(new Error(`run ${id} still ${m && m.status}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

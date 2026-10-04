// Claude Code installed through npm on Windows is a .cmd shim. Through cmd.exe, an argument with
// a newline (the dashboard's rules) was cut there, and everything after it (--model, --effort)
// was lost; an npm shim's Node script is now run with this Node instead, arguments intact.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetClaudeResolution, resolveClaude, spawnClaude } from "../src/claude.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-shim-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} delete process.env.DASHBOARD_CLAUDE_BIN; resetClaudeResolution(); });

test("an npm .cmd shim runs its script with Node: multi-line and special-character arguments arrive whole", async () => {
  // The layout and wording npm writes for a package's bin.
  const script = path.join(TMP, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const cmd = path.join(TMP, "claude.cmd");
  fs.writeFileSync(cmd, '@ECHO off\r\nSETLOCAL\r\nnode  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  process.env.DASHBOARD_CLAUDE_BIN = cmd;
  resetClaudeResolution();
  assert.deepEqual(resolveClaude(), { file: cmd, shim: false, script });

  const args = ["-p", "fix it", "--append-system-prompt", "line one\nline two & 100% <ok> ^ !", "--model", "opus", "--effort", "high"];
  const child = spawnClaude(args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  await new Promise((r) => child.on("close", r));
  assert.deepEqual(JSON.parse(out), args);
});

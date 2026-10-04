// Agent adapters (server/src/agents/): each CLI's command line for a first turn, a resume
// and plan mode; its JSONL translated into the Claude-shaped run events the run page draws
// (lines below are shaped like real Copilot 1.0 / Codex 0.160 output); model lists; and
// how an npm .cmd shim is run without cmd.exe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { agentOf, isAgentId, withRules, AGENT_HEADLESS_RULES } = await import("../src/agents/index.ts");
const { translateCopilot, parseCopilotModels } = await import("../src/agents/copilot.ts");
const { translateCodex, parseCodexModels } = await import("../src/agents/codex.ts");
const { shimScript } = await import("../src/claude.ts");

const turn = (over: Record<string, unknown> = {}) => ({
  first: true, sessionId: "sess-1", prompt: "Fix the bug", label: "Fix", model: null, effort: null, planMode: false,
  permissionMode: "auto", budgetUsd: null, rules: "RULES", planRule: null, addDirs: [] as string[], ...over,
});

test("agentOf: unknown or missing ids are Claude (runs from before agents)", () => {
  assert.equal(agentOf(undefined).id, "claude");
  assert.equal(agentOf("nope").id, "claude");
  assert.equal(agentOf("codex").id, "codex");
  assert.ok(isAgentId("copilot") && !isAgentId("gpt"));
  assert.match(AGENT_HEADLESS_RULES, /<<QUESTION>>/);
  assert.doesNotMatch(AGENT_HEADLESS_RULES, /AskUserQuestion|run_in_background/, "no Claude tool names for other agents");
});

test("Claude: the same command line as before agents", () => {
  const a = agentOf("claude");
  assert.deepEqual(a.turnArgs(turn({ model: "opus", effort: "high", budgetUsd: 5, planRule: "PLAN", addDirs: ["/x"] })), [
    "-p", "Fix the bug", "--output-format", "stream-json", "--verbose", "--session-id", "sess-1", "--name", "dash: Fix",
    "--permission-mode", "auto", "--permission-prompts", "none", "--append-system-prompt", "RULES\n\nPLAN",
    "--model", "opus", "--effort", "high", "--max-budget-usd", "5", "--add-dir", "/x",
  ]);
  assert.deepEqual(a.turnArgs(turn({ first: false, planMode: true })).slice(5, 9), ["--resume", "sess-1", "--permission-mode", "plan"]);
  const ev = { type: "assistant", message: { content: [] } };
  assert.deepEqual(a.parse(ev, {}), [ev]);
  assert.equal(a.resumeCommand("abc"), "claude --resume abc");
});

test("Copilot: rules on the first prompt, the session id it resumes, plan mode denies writes", () => {
  const a = agentOf("copilot");
  const first = a.turnArgs(turn({ model: "claude-sonnet-5", effort: "high", addDirs: ["/kb"] }));
  assert.equal(first[0], "-p");
  assert.equal(first[1], withRules("RULES", "Fix the bug"));
  assert.ok(first[1].startsWith("<dashboard_instructions>\nRULES\n</dashboard_instructions>\n\nFix the bug"));
  for (const f of ["--output-format", "json", "--session-id", "sess-1", "--no-ask-user", "--allow-all-tools", "--model", "claude-sonnet-5", "--effort", "high", "--add-dir", "/kb"]) assert.ok(first.includes(f), f);
  assert.ok(!first.includes("--deny-tool"));
  const later = a.turnArgs(turn({ first: false, prompt: "And the test", planMode: true, planRule: "PLAN" }));
  assert.equal(later[1], withRules("PLAN", "And the test"), "later turns only carry plan mode's rule");
  assert.deepEqual(later.slice(later.indexOf("--deny-tool"), later.indexOf("--deny-tool") + 2), ["--deny-tool", "write"]);
  assert.ok(!a.turnArgs(turn({ model: "auto" })).includes("--model"), "Auto is Copilot's own default");
  assert.equal(a.resumeCommand("sess-1"), "copilot --resume sess-1");
});

test("Copilot events → run events: init, text, tool calls mapped to the run page's tools, results, the result", () => {
  const st: any = { sessionId: "sess-1" };
  const out = [
    { type: "session.tools_updated", data: { model: "claude-sonnet-5" }, ephemeral: true },
    { type: "user.message", data: { content: "Read a.txt" } },
    { type: "assistant.message", data: { model: "claude-sonnet-5", content: "", toolRequests: [{ toolCallId: "t1", name: "view", arguments: { path: "C:\\w\\a.txt" } }] } },
    { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "view" } },
    { type: "tool.execution_complete", data: { toolCallId: "t1", success: true, result: { content: "hello world\n" } } },
    { type: "assistant.turn_end", data: {} },
    { type: "assistant.message", data: { content: "", toolRequests: [
      { toolCallId: "t2", name: "create", arguments: { path: "b.txt", file_text: "done" } },
      { toolCallId: "t3", name: "edit", arguments: { path: "c.txt", old_str: "a", new_str: "b" } },
      { toolCallId: "t4", name: "powershell", arguments: { command: "git status" } },
    ] } },
    { type: "tool.execution_complete", data: { toolCallId: "t4", success: false, result: { content: "fatal: not a git repository" } } },
    { type: "assistant.message", data: { content: "Read a.txt and created b.txt.", toolRequests: [] } },
    { type: "assistant.turn_end", data: {} },
    { type: "result", sessionId: "sess-1", exitCode: 0, usage: { premiumRequests: 1 } },
  ].flatMap((e) => translateCopilot(e, st));
  assert.deepEqual(out[0], { type: "system", subtype: "init", model: "claude-sonnet-5", session_id: "sess-1" });
  assert.deepEqual(out[1].message.content[0], { type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:\\w\\a.txt" } });
  assert.deepEqual(out[2].message.content[0], { type: "tool_result", tool_use_id: "t1", content: "hello world\n", is_error: false });
  assert.deepEqual(out[3].message.content.map((c: any) => [c.name, c.input]), [
    ["Write", { file_path: "b.txt", content: "done" }],
    ["Edit", { file_path: "c.txt", old_string: "a", new_string: "b" }],
    ["Bash", { command: "git status", description: undefined }],
  ]);
  assert.equal(out[4].message.content[0].is_error, true);
  assert.deepEqual(out[5].message.content, [{ type: "text", text: "Read a.txt and created b.txt." }]);
  assert.deepEqual(out[6], { type: "result", subtype: "success", is_error: false, result: "Read a.txt and created b.txt.", num_turns: 2, session_id: "sess-1", usage: { premiumRequests: 1 }, premium_requests: 1 });
  assert.equal(translateCopilot({ type: "result", exitCode: 1 }, {})[0].is_error, true);
  assert.equal(out.length, 7, "streaming deltas, user echoes and turn markers are dropped");
});

test("Codex: exec for the first turn, exec resume after; plan mode is the read-only sandbox", () => {
  const a = agentOf("codex");
  const first = a.turnArgs(turn({ model: "gpt-6.1-sol", effort: "high", addDirs: ["/kb"] }));
  assert.deepEqual(first.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  for (const f of ["-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "sandbox_workspace_write.network_access=true", "-s", "workspace-write", "--add-dir", "/kb"]) assert.ok(first.includes(f), f);
  assert.ok(first.at(-1)!.startsWith("<dashboard_instructions>\nRULES"));
  const later = a.turnArgs(turn({ first: false, sessionId: "thread-9", prompt: "Next", planMode: true, planRule: "PLAN" }));
  assert.deepEqual(later.slice(0, 2), ["exec", "resume"]);
  assert.ok(later.includes('sandbox_mode="read-only"') && !later.includes("-s"), "resume takes the sandbox through config");
  assert.deepEqual(later.slice(-2), ["thread-9", withRules("PLAN", "Next")]);
  assert.equal(a.resumeCommand("thread-9"), `codex resume -c "project_doc_fallback_filenames=['CLAUDE.md']" thread-9`);
  assert.ok(first.includes("project_doc_fallback_filenames=['CLAUDE.md']"), "Codex reads the workspace's CLAUDE.md");
});

test("Codex events → run events: the thread id, commands as Bash, file changes, MCP calls, the result", () => {
  const st: any = { model: "gpt-6.1-sol" };
  const out = [
    { type: "thread.started", thread_id: "01a1044d-6787" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I'll read a.txt.\n" } },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "pwsh -Command 'Get-Content a.txt'", aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "pwsh -Command 'Get-Content a.txt'", aggregated_output: "hello world\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "item_2", type: "reasoning", text: "thinking" } },
    { type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "b.txt", kind: "add" }, { path: "c.txt", kind: "update" }], status: "completed" } },
    { type: "item.completed", item: { id: "item_4", type: "mcp_tool_call", server: "notion", tool: "search", arguments: { q: "refunds" }, result: { content: [{ type: "text", text: "2 pages" }] }, status: "completed" } },
    { type: "item.completed", item: { id: "item_5", type: "agent_message", text: "Done." } },
    { type: "turn.completed", usage: { input_tokens: 98700, output_tokens: 243 } },
  ].flatMap((e) => translateCodex(e, st));
  assert.deepEqual(out[0], { type: "system", subtype: "init", session_id: "01a1044d-6787", model: "gpt-6.1-sol" });
  assert.equal(out[1].message.content[0].text, "I'll read a.txt.\n");
  assert.deepEqual(out[2].message.content[0], { type: "tool_use", id: "item_1", name: "Bash", input: { command: "pwsh -Command 'Get-Content a.txt'" } });
  assert.deepEqual(out[3].message.content[0], { type: "tool_result", tool_use_id: "item_1", content: "hello world\n", is_error: false });
  assert.deepEqual([out[4].message.content[0].name, out[4].message.content[0].input.file_path], ["Write", "b.txt"]);
  assert.equal(out[5].message.content[0].content, "Created b.txt");
  assert.deepEqual([out[6].message.content[0].name, out[7].message.content[0].content], ["Edit", "Updated c.txt"]);
  assert.equal(out[8].message.content[0].name, "mcp__notion__search");
  assert.equal(out[10].message.content[0].text, "Done.");
  assert.deepEqual(out[11], { type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 1, session_id: "01a1044d-6787", usage: { input_tokens: 98700, output_tokens: 243 } });
  assert.equal(out.length, 12, "reasoning isn't shown");
  // A command that only completes (no started line) still shows its call.
  const solo = translateCodex({ type: "item.completed", item: { id: "x", type: "command_execution", command: "ls", aggregated_output: "", exit_code: 2 } }, {});
  assert.deepEqual(solo.map((e: any) => e.message.content[0].type), ["tool_use", "tool_result"]);
  assert.equal(solo[1].message.content[0].is_error, true);
  assert.equal(translateCodex({ type: "turn.failed", error: { message: "quota" } }, {})[0].is_error, true);
});

test("model lists: Copilot's from `copilot help config`, Codex's from its cache", () => {
  const help = "  `banner`: x\n\n  `model`: AI model to use for Copilot CLI; can be changed with /model command.\n    - \"claude-sonnet-5\"\n    - \"gpt-6.1-sol\"\n\n  `contextTier`: tier\n    - \"default\"\n";
  assert.deepEqual(parseCopilotModels(help).map((m: any) => m.id), ["auto", "claude-sonnet-5", "gpt-6.1-sol"]);
  assert.deepEqual(parseCopilotModels("no models here").map((m: any) => m.id), ["auto"]);
  const cache = [
    { slug: "gpt-6-luna", display_name: "GPT-6 Luna", priority: 3, visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", priority: 1, visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
    { slug: "internal", priority: 0, visibility: "hide" },
  ];
  assert.deepEqual(parseCodexModels(cache), [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "ultra"] },
    { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low"] },
  ]);
});

test("an npm .cmd shim runs its Node script directly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-shim-"));
  fs.mkdirSync(path.join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  fs.writeFileSync(path.join(dir, "codex.cmd"), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.equal(shimScript(path.join(dir, "codex.cmd")), path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js"));
  fs.writeFileSync(path.join(dir, "other.cmd"), "@echo off\r\nsomething.exe %*\r\n");
  assert.equal(shimScript(path.join(dir, "other.cmd")), null);
});

test("expandSlash: a workspace skill's instructions with the arguments, for agents that don't load skills", async () => {
  const { expandSlash, findSkill } = await import("../src/agents/skills.ts");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dash-skills-"));
  fs.mkdirSync(path.join(ws, ".claude", "skills", "Implement"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "skills", "Implement", "SKILL.md"), "---\nname: implement\ndescription: Do a ticket\n---\n# Implement\n\nFetch $ARGUMENTS from the tracker, branch, build, open a PR.\n");
  fs.mkdirSync(path.join(ws, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "commands", "standup.md"), "Summarise yesterday's commits.");
  const out = expandSlash("/implement ENG-12", ws);
  assert.match(out, /^Follow the workspace's "\/implement" skill below \(\.claude\/skills\/Implement\/SKILL\.md\), as if it had been invoked as `\/implement ENG-12`\./);
  assert.match(out, /<skill>\n# Implement\n\nFetch ENG-12 from the tracker/);
  assert.doesNotMatch(out, /description: Do a ticket/, "frontmatter is dropped");
  assert.match(expandSlash("/standup for the team", ws), /Summarise yesterday's commits\.\n<\/skill>\n\nArguments: for the team$/);
  assert.equal(expandSlash("/unknown thing", ws), "/unknown thing");
  assert.equal(expandSlash("Fix /implement", ws), "Fix /implement", "only a prompt that starts with the slash");
  assert.equal(expandSlash("/plugin:skill x", ws), "/plugin:skill x");
  assert.equal(findSkill(ws, "IMPLEMENT")?.rel, ".claude/skills/Implement/SKILL.md");
});

test("other agents' MCP servers: listings parsed without values, add commands per CLI, Claude names made portable", async () => {
  const { parseCopilotServers, parseCodexServers, addArgs, agentServerName, terminalCommand } = await import("../src/agents/mcp.ts");
  const copilot = parseCopilotServers({ mcpServers: {
    notion: { type: "http", url: "https://mcp.notion.com/mcp?token=x", source: "user", enabled: true },
    localtool: { type: "local", command: "npx", args: ["-y", "some-mcp", "--api-key=SECRET"], env: { API_KEY: "s3cret" }, source: "user", enabled: true },
    "team-docs": { type: "http", url: "https://docs.example.com/mcp", source: "workspace" },
    "github-mcp-server": { type: "http", url: "https://api.githubcopilot.com/mcp/readonly", headers: { "X-MCP-Host": "copilot-cli" }, source: "builtin", enabled: true },
  } });
  assert.deepEqual(copilot.map((s: any) => [s.name, s.source, s.transport, s.target, s.actions.join("|")]), [
    ["notion", "user", "http", "https://mcp.notion.com/mcp", "remove"],
    ["localtool", "user", "stdio", "npx -y some-mcp --api-key=•••", "remove"],
    ["team-docs", "workspace", "http", "https://docs.example.com/mcp", ""],
    ["github-mcp-server", "builtin", "http", "https://api.githubcopilot.com/mcp/readonly", ""],
  ]);
  assert.ok(!JSON.stringify(copilot).includes("s3cret") && !JSON.stringify(copilot).includes("SECRET"));
  const codex = parseCodexServers([
    { name: "localtool", enabled: true, transport: { type: "stdio", command: "npx", args: ["-y", "x"], env: { API_KEY: "s3cret" }, env_vars: ["OTHER"] }, auth_status: "unsupported" },
    { name: "notion", enabled: true, transport: { type: "streamable_http", url: "https://mcp.notion.com/mcp" }, auth_status: "not_logged_in" },
    { name: "off", enabled: false, transport: { type: "streamable_http", url: "https://x.dev/mcp" }, auth_status: "o_auth" },
  ]);
  assert.deepEqual(codex.map((s: any) => [s.name, s.transport, s.envKeys.join("+"), s.auth, s.actions.join("|"), s.enabled]), [
    ["localtool", "stdio", "API_KEY+OTHER", null, "remove", true],
    ["notion", "http", "", "not_logged_in", "remove|login", true],
    ["off", "http", "", "o_auth", "remove", false],
  ]);
  assert.ok(!JSON.stringify(codex).includes("s3cret"));
  assert.deepEqual(addArgs("copilot", "notion", { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer t" } }),
    ["mcp", "add", "--transport", "http", "notion", "https://mcp.notion.com/mcp", "--header", "Authorization: Bearer t"]);
  assert.deepEqual(addArgs("codex", "tool", { type: "stdio", command: "npx", args: ["-y", "x"], env: { K: "v" } }), ["mcp", "add", "tool", "--env", "K=v", "--", "npx", "-y", "x"]);
  assert.deepEqual(addArgs("codex", "notion", { type: "http", url: "https://mcp.notion.com/mcp" }), ["mcp", "add", "notion", "--url", "https://mcp.notion.com/mcp"]);
  assert.throws(() => addArgs("codex", "n", { type: "http", url: "https://x.dev", headers: { A: "b" } }), /OAuth/);
  assert.throws(() => addArgs("copilot", "bad name", { type: "http", url: "https://x.dev" }), /Name/);
  assert.equal(agentServerName("claude.ai Cloudflare Developer Platform"), "cloudflare-developer-platform");
  assert.equal(agentServerName("plugin:engineering:linear"), "linear");
  assert.equal(agentServerName("octopusdeploy"), "octopusdeploy");
  assert.match(terminalCommand("codex", ["mcp", "add", "notion", "--url", "https://mcp.notion.com/mcp"]), /^codex mcp add notion --url https:\/\/mcp\.notion\.com\/mcp$/);
});

test("an npm launcher that starts a native binary resolves to the binary (no console window flash)", async () => {
  const { nativeBinary } = await import("../src/claude.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-native-"));
  const pkg = path.join(root, "node_modules", "@openai", "codex");
  const bin = path.join(pkg, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(pkg, "bin", "codex.js"), "");
  fs.writeFileSync(path.join(bin, "codex.exe"), "");
  fs.writeFileSync(path.join(bin, "codex-helper.exe"), "");
  assert.equal(nativeBinary(path.join(pkg, "bin", "codex.js"), "codex"), path.join(bin, "codex.exe"));
  assert.equal(nativeBinary(path.join(pkg, "bin", "codex.js"), "other"), null);
});

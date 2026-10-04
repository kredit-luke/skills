import { test } from "node:test";
import assert from "node:assert/strict";
import { Usage, parseCommandsResponse } from "../src/usage.ts";

function line(o: object) { return JSON.stringify(o) + "\n"; }
const commands = [
  { name: "natterjack:add-adapter", description: "(natterjack) Add support for a tracker.", argumentHint: "<tracker>", aliases: ["add-adapter"] },
  { name: "worktree", description: "Make a worktree (project)", argumentHint: "<TICKET>" },
  { name: "compact", description: "Clear history but keep a summary", argumentHint: "", builtin: true },
  { name: "review", description: "Review a pull request", argumentHint: "", builtin: true },
  { name: "linear:issue (MCP)", description: "Get an issue", argumentHint: "" },
];

test("reads the command list from the initialize control_response", () => {
  const out = line({ type: "system", subtype: "hook_started" })
    + "not json\n"
    + line({ type: "control_response", response: { subtype: "success", request_id: "commands", response: { commands, agents: [] } } });
  assert.deepEqual(parseCommandsResponse(out), commands);
});

test("no control_response means no commands", () => {
  assert.equal(parseCommandsResponse(line({ type: "system", subtype: "init", slash_commands: ["a"] })), null);
  assert.equal(parseCommandsResponse(""), null);
});

test("lists commands for autocomplete: source tag stripped, terminal-only built-ins dropped", async () => {
  const usage = new Usage();
  usage.commands = commands;
  assert.deepEqual(await usage.listCommands(), [
    { name: "natterjack:add-adapter", description: "Add support for a tracker.", argumentHint: "<tracker>", aliases: ["add-adapter"], source: "plugin" },
    { name: "worktree", description: "Make a worktree", argumentHint: "<TICKET>", aliases: [], source: "skill" },
    { name: "review", description: "Review a pull request", argumentHint: "", aliases: [], source: "built-in" },
    { name: "linear:issue (MCP)", description: "Get an issue", argumentHint: "", aliases: [], source: "mcp" },
  ]);
});

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
  { name: "ticket-standards", description: "House rules for tickets. (claude.ai sync)", argumentHint: "", aliases: ["org-skills:ticket-standards"] },
  { name: "org-skills:skill-creator", description: "Create new skills. (claude.ai sync)", argumentHint: "" },
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
    { name: "ticket-standards", description: "House rules for tickets.", argumentHint: "", aliases: ["org-skills:ticket-standards"], source: "organization" },
    { name: "org-skills:skill-creator", description: "Create new skills.", argumentHint: "", aliases: [], source: "organization" },
  ]);
});

test("a stale list is served while a fresh one loads; forgetCommands makes the next call wait for it", async () => {
  const usage = new Usage();
  let fetches = 0;
  let release: (c: any[]) => void = () => {};
  usage._fetchCommands = () => { fetches++; return new Promise((r) => { release = r; }); };
  usage.commands = [commands[1]];
  usage.commandsAt = Date.now();
  assert.equal((await usage.listCommands()).length, 1);
  assert.equal(fetches, 0, "a fresh list isn't fetched again");

  usage.commandsAt = Date.now() - 11 * 60 * 1000;
  assert.equal((await usage.listCommands()).length, 1, "the stale list answers straight away");
  assert.equal(fetches, 1);
  release(commands);
  await usage._commandsInflight;
  assert.equal((await usage.listCommands()).length, 6);

  usage.forgetCommands();
  const next = usage.listCommands();
  assert.equal(fetches, 2);
  release([commands[0]]);
  assert.deepEqual((await next).map((c) => c.name), ["natterjack:add-adapter"]);
});

test("a fetch started before forgetCommands can't store its (signed-out) list", async () => {
  const usage = new Usage();
  const releases: ((c: any[]) => void)[] = [];
  usage._fetchCommands = () => new Promise((r) => { releases.push(r); });
  const before = usage.listCommands();
  usage.forgetCommands();
  const after = usage.listCommands();
  assert.equal(releases.length, 2, "forgetCommands lets a new fetch start");
  releases[0]([commands[1]]);
  await before;
  assert.equal(usage.commands, null, "the old fetch's list is dropped");
  releases[1]([commands[0]]);
  assert.deepEqual((await after).map((c) => c.name), ["natterjack:add-adapter"]);
});

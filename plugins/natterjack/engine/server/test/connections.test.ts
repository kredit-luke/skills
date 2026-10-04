// The Connections page: parsing `claude mcp list`, merging it with the config files
// (~/.claude.json via CLAUDE_CONFIG_DIR, .mcp.json, settings), connections.json, and the
// settings.local.json edits. config.ts reads WORKSPACE_ROOT at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-conn-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dash-conn-home-"));
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = path.join(ROOT, ".claude", "ledger");
process.env.CLAUDE_CONFIG_DIR = HOME;

const { parseMcpList, mcpState } = await import("../src/claude.ts");
const { Connections, checkConfig, configVars, mcpRule, readMcpConfig, needsAttention, targetOf, mcpHealth, readRequired } = await import("../src/connections.ts");

// Real output (Claude Code 2.x), noise lines included.
const LIST = [
  "Checking MCP server health…",
  "",
  "[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp (pre-upgrade storage or provider not round-tripping the value).",
  "claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected",
  "claude.ai Confirm: https://mcp.getconfirmed.org/mcp - ! Needs authentication",
  "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ⊘ Disabled for this project (re-enable via /mcp)",
  "plugin:engineering:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication",
  "plugin:productivity:asana: https://mcp.asana.com/v2/mcp (HTTP) - ✘ Failed to connect — Incompatible auth server: does not support dynamic client registration",
  "plugin:engineering:google calendar:  (HTTP) - - Not configured",
  "octopusdeploy: npx -y @octopusdeploy/mcp-server --api-key=SECRET - ✔ Connected",
  "shared-docs: https://docs.example.com/mcp (HTTP) - ⏸ Pending approval",
].join("\r\n");

test("parseMcpList: every server line, names with spaces and colons, transports, states; noise skipped", () => {
  const e = parseMcpList(LIST);
  assert.deepEqual(e.map((x) => x.name), [
    "claude.ai Linear", "claude.ai Confirm", "claude.ai Google Drive", "plugin:engineering:slack", "plugin:productivity:asana",
    "plugin:engineering:google calendar", "octopusdeploy", "shared-docs",
  ]);
  assert.deepEqual(e.map((x) => x.state), ["connected", "needs-auth", "disabled", "needs-auth", "failed", "not-configured", "connected", "pending"]);
  assert.equal(e[3].transport, "http");
  assert.equal(e[3].target, "https://mcp.slack.com/mcp");
  assert.equal(e[5].target, "");
  assert.equal(e[6].target, "npx -y @octopusdeploy/mcp-server --api-key=SECRET");
  assert.match(e[4].text, /^Failed to connect — Incompatible auth server/);
  assert.equal(mcpState("Connected"), "connected");
  assert.equal(mcpState("Failed to connect — Server rejected the configured Authorization header (HTTP 401). OAuth fallback is disabled when headers.Authorization is set."), "failed",
    "the server's own error text doesn't count");
  assert.equal(mcpState("Not connected"), "unknown");
});

test("mcpRule: the tool prefix Claude Code uses", () => {
  assert.equal(mcpRule("claude.ai Linear"), "mcp__claude_ai_Linear");
  assert.equal(mcpRule("plugin:engineering:slack"), "mcp__plugin_engineering_slack");
  assert.equal(mcpRule("my-server_2"), "mcp__my-server_2");
});

test("checkConfig and configVars: only what add-json takes, nothing that breaks a line", () => {
  assert.deepEqual(checkConfig({ type: "http", url: "https://x.dev/mcp", headers: { Authorization: "Bearer ${TOKEN}" }, extra: 1 }),
    { type: "http", url: "https://x.dev/mcp", headers: { Authorization: "Bearer ${TOKEN}" } });
  assert.deepEqual(checkConfig({ command: "npx", args: ["-y", "srv"], env: { API_KEY: "k" } }), { type: "stdio", command: "npx", args: ["-y", "srv"], env: { API_KEY: "k" } });
  assert.throws(() => checkConfig({ type: "http", url: "ftp://x" }), /https/);
  assert.throws(() => checkConfig({ type: "http", url: "https://x", headers: { A: "1\r\nB: 2" } }), /one line/);
  assert.throws(() => checkConfig({ type: "stdio", command: "" }), /command/);
  assert.throws(() => checkConfig({ type: "ws", url: "https://x" }), /Unknown transport/);
  assert.deepEqual(configVars({ type: "http", url: "https://${HOST}/mcp", headers: { A: "${TOKEN}", B: "${TOKEN}" } }), ["HOST", "TOKEN"]);
});

/** A fake `claude`: `mcp list` prints LIST; other commands are recorded and succeed. */
const calls: string[][] = [];
const fake = async (args: string[]) => {
  calls.push(args);
  return { ok: true, out: args[0] === "mcp" && args[1] === "list" ? LIST : "" };
};

/** Write a fixture file; config.ts caches by mtime, so move it forward each write. */
let bump = 10;
function write(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  const t = new Date(Date.now() + 1000 * bump++);
  fs.utimesSync(file, t, t);
}
const settingsFile = path.join(ROOT, ".claude", "settings.local.json");

test("readMcpConfig: scopes from ~/.claude.json and .mcp.json, project choices, allow rules; secret values never read out", () => {
  write(path.join(HOME, ".claude.json"), {
    mcpServers: { octopusdeploy: { command: "npx", args: ["-y", "@octopusdeploy/mcp-server", "--api-key=SECRET"], env: { OCTOPUS_KEY: "s3cret" } } },
    projects: { [ROOT.replace(/\\/g, "/")]: { mcpServers: { mine: { type: "http", url: "https://mine.dev/mcp?token=abc", headers: { Authorization: "Bearer x" } } }, disabledMcpjsonServers: ["nope"] } },
  });
  write(path.join(ROOT, ".mcp.json"), { mcpServers: { "shared-docs": { type: "http", url: "https://docs.example.com/mcp" }, nope: { type: "http", url: "https://n.dev" } } });
  write(settingsFile, { permissions: { allow: ["mcp__mine", "Bash(ls)"] } });
  const cfg = readMcpConfig(ROOT);
  const by = Object.fromEntries(cfg.servers.map((s) => [s.name, s]));
  assert.equal(by.octopusdeploy.scope, "user");
  assert.equal(by.octopusdeploy.target, "npx -y @octopusdeploy/mcp-server --api-key=•••");
  assert.deepEqual(by.octopusdeploy.envKeys, ["OCTOPUS_KEY"]);
  assert.equal(by.mine.scope, "local");
  assert.equal(by.mine.target, "https://mine.dev/mcp", "query strings (where tokens hide) are dropped");
  assert.deepEqual(by.mine.headerKeys, ["Authorization"]);
  assert.equal(by["shared-docs"].scope, "project");
  assert.ok(cfg.disabled.has("nope"));
  assert.ok(cfg.allowLocal.has("mcp__mine"));
  assert.ok(!JSON.stringify(cfg).includes("s3cret") && !JSON.stringify(cfg).includes("Bearer x"));
});

test("Connections.build: merged rows, approval, actions, connections.json requirements and the problem count", async () => {
  write(path.join(CFG, "connections.json"), { required: [
    { name: "claude.ai Linear", why: "Issues page" },
    { name: "shared-docs", why: "Specs" },
    { name: "notion", why: "Product docs", add: { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer ${NOTION_TOKEN}" } } },
    { name: "claude.ai Slack", why: "Standups" },
  ] });
  const conn = new Connections(ROOT, { run: fake });
  // Before any health check: config rows only, and required servers that can be added.
  let r = conn.build();
  assert.equal(r.checkedAt, null);
  assert.ok(r.connections.find((c) => c.name === "notion")?.missing);
  assert.ok(!r.connections.find((c) => c.name === "claude.ai Slack"), "a connector's absence isn't known until the CLI has listed");

  r = await conn.list({ wait: true });
  const by = Object.fromEntries(r.connections.map((c) => [c.name, c]));
  assert.equal(by["claude.ai Linear"].scope, "claude.ai");
  assert.equal(by["claude.ai Linear"].state, "connected");
  assert.deepEqual(by["claude.ai Linear"].required, { why: "Issues page", add: null, vars: [], alternatives: [] });
  assert.equal(by["shared-docs"].approval, "pending");
  assert.ok(by["shared-docs"].actions.includes("approve"));
  assert.equal(by.nope.approval, "rejected");
  assert.ok(by["claude.ai Confirm"].actions.includes("login"));
  assert.ok(by.mine.allowed);
  assert.ok(by.mine.actions.includes("remove") && by.octopusdeploy.actions.includes("remove"));
  assert.ok(!by["shared-docs"].actions.includes("remove"), "project servers are a shared file");
  assert.match(by["plugin:productivity:asana"].hint || "", /claude\.ai connector/);
  assert.ok(by["claude.ai Slack"].missing);
  assert.deepEqual(by.notion.required?.vars, ["NOTION_TOKEN"]);
  assert.equal(r.connections[0].required !== null, true, "required servers sort first");
  // Linear is fine; shared-docs pending, notion and Slack missing.
  assert.equal(r.problems, 3);
  assert.equal(r.connections.filter(needsAttention).length, 3);
});

test("approve and allow edit settings.local.json and keep everything else", async () => {
  write(settingsFile, { permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm:*)"] }, skillOverrides: { pr: "off" }, disabledMcpjsonServers: ["shared-docs", "other"] });
  const conn = new Connections(ROOT, { run: fake });
  await conn.approve("shared-docs");
  let s = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  assert.deepEqual(s.enabledMcpjsonServers, ["shared-docs"]);
  assert.deepEqual(s.disabledMcpjsonServers, ["other"]);
  assert.deepEqual(s.skillOverrides, { pr: "off" });
  await assert.rejects(conn.approve("octopusdeploy"), /\.mcp\.json/);

  conn.allow("claude.ai Linear", true);
  conn.allow("claude.ai Linear", true);
  s = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  assert.deepEqual(s.permissions, { allow: ["Bash(ls)", "mcp__claude_ai_Linear"], deny: ["Bash(rm:*)"] });
  conn.allow("claude.ai Linear", false);
  s = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  assert.deepEqual(s.permissions.allow, ["Bash(ls)"]);

  assert.throws(() => conn.allow("bad;name\n", true), /Invalid server name/);
  await assert.rejects(conn.add({ name: "-bad", scope: "local", config: { type: "http", url: "https://x" } }), /Name/);
  await assert.rejects(conn.add({ name: "notion", scope: "local", config: { type: "http", url: "https://x", headers: { A: "${NOTION_TOKEN}" } } }), /NOTION_TOKEN/);
  await assert.rejects(conn.remove("shared-docs"), /\.mcp\.json/);
});

test("add, remove and logout call the CLI with the right scope and arguments", async () => {
  const conn = new Connections(ROOT, { run: fake });
  calls.length = 0;
  await conn.add({ name: "notion", scope: "user", config: { type: "http", url: "https://mcp.notion.com/mcp" }, allow: true });
  assert.deepEqual(calls[0], ["mcp", "add-json", "notion", JSON.stringify({ type: "http", url: "https://mcp.notion.com/mcp" }), "-s", "user"]);
  assert.ok(JSON.parse(fs.readFileSync(settingsFile, "utf-8")).permissions.allow.includes("mcp__notion"));
  calls.length = 0;
  await conn.remove("mine");
  assert.deepEqual(calls[0], ["mcp", "remove", "mine", "-s", "local"]);
  calls.length = 0;
  await conn.logout("plugin:engineering:slack");
  assert.deepEqual(calls[0], ["mcp", "logout", "plugin:engineering:slack"]);
  const failing = new Connections(ROOT, { run: async () => ({ ok: false, out: "[mcp-sdk] noise\nNo MCP server found with name: zzz\n" }) });
  await assert.rejects(failing.logout("zzz"), /No MCP server found/);
});

test("targetOf: no URL credentials or query, secret flag values masked in both forms", () => {
  assert.equal(targetOf({ url: "https://user:pass@mcp.example.com/mcp?key=abc#x" }), "https://mcp.example.com/mcp");
  assert.equal(targetOf({ url: "https://token@mcp.example.com/mcp" }), "https://mcp.example.com/mcp");
  assert.equal(targetOf({ command: "npx", args: ["-y", "srv", "--api-key", "SECRET", "--token=abc", "--port", "80"] }), "npx -y srv --api-key ••• --token=••• --port 80");
  assert.equal(targetOf({ command: "srv", args: ["--auth", "--verbose"] }), "srv --auth --verbose", "a flag after a bare flag isn't a value");
});

test("mcpHealth: a forced check while one runs checks again afterwards", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-conn-h-"));
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = async () => { const i = ++n; if (i === 1) await gate; return { ok: true, out: `s${i}: https://x/mcp (HTTP) - ✔ Connected` }; };
  const first = mcpHealth(dir, false, run);
  const again = mcpHealth(dir, false, run);
  const forced = mcpHealth(dir, true, run);
  assert.equal(again, first, "an unforced call shares the running check");
  release();
  assert.equal((await first).entries[0].name, "s1");
  assert.equal((await forced).entries[0].name, "s2");
  assert.equal(n, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readRequired: an invalid add is reported, not dropped silently", () => {
  write(path.join(CFG, "connections.json"), { required: [{ name: "bad", add: { type: "http" } }, { name: "ok", add: { type: "http", url: "https://x/mcp" } }] });
  const r = readRequired();
  assert.match(r.error || "", /"bad" add:/);
  assert.equal(r.required.get("bad")?.add, null);
  assert.ok(r.required.get("ok")?.add);
});

test("remove and add: an unreadable settings.local.json stops them before the CLI runs", async () => {
  fs.writeFileSync(settingsFile, "{ not json");
  const conn = new Connections(ROOT, { run: fake });
  calls.length = 0;
  await assert.rejects(conn.remove("mine"), /isn't valid JSON/);
  await assert.rejects(conn.add({ name: "notion", scope: "user", config: { type: "http", url: "https://mcp.notion.com/mcp" }, allow: true }), /isn't valid JSON/);
  assert.equal(calls.filter((c) => c[1] === "remove" || c[1] === "add-json").length, 0);
  fs.rmSync(settingsFile);
});

test("a requirement is met by any of its alternatives, the connected one first", async () => {
  write(path.join(CFG, "connections.json"), { required: [
    { name: "claude.ai Confirm", why: "Docs", alternatives: ["octopusdeploy"] },
    { name: "claude.ai Nowhere", why: "Wiki", alternatives: ["also-nowhere"] },
  ] });
  const r = await new Connections(ROOT, { run: fake }).list({ wait: true });
  const by = Object.fromEntries(r.connections.map((c) => [c.name, c]));
  assert.equal(by.octopusdeploy.required?.why, "Docs", "the connected alternative carries it");
  assert.equal(by["claude.ai Confirm"].required, null, "not the signed-out one");
  assert.ok(by["claude.ai Nowhere"].missing, "none configured: the main name shows as missing");
  assert.deepEqual(by["claude.ai Nowhere"].required?.alternatives, ["also-nowhere"]);
  assert.equal(r.problems, 1);
});

// Signing in to an MCP server from the page (mcp-login.ts): finding the URL in the CLI's
// output, checking a pasted callback address, and typing it at the waiting CLI's prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { McpLogin, callbackTarget, findLoginUrl, scriptArgs, stripEscapes } = await import("../src/mcp-login.ts");

const AUTH = "https://mcp.notion.com/authorize?response_type=code&client_id=abc&code_challenge=x&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback&state=s1&scope=default";
// What the CLI prints on a pseudo-terminal (Claude Code 2.1): the URL wrapped in an OSC 8 hyperlink, \r\n line ends.
const OUT = [
  "Starting authentication for \"notion\"…",
  "Visit this URL to authorize:",
  `  \x1b]8;;${AUTH}\x07${AUTH}\x1b]8;;\x07`,
  "",
  "Waiting for authorization… (^C to cancel)",
  "Or paste the redirect URL here: ",
].join("\r\n");
const CLAUDE_AI = "https://claude.ai/api/organizations/org1/mcp/start-auth/mcpsrv_1?product_surface=sdk-cli";
const REJECTED = "http://localhost:3118/callback?code=x\r\nCouldn't complete authentication for \"notion\": Invalid authorization code format\r\n";

test("findLoginUrl: the authorization URL out of the hyperlink escapes, and its loopback callback", () => {
  assert.ok(!stripEscapes(OUT).includes("\x1b"));
  assert.deepEqual(findLoginUrl(OUT), { url: AUTH, callback: "http://localhost:3118/callback" });
  assert.deepEqual(findLoginUrl(`Visit this URL to authorize:\n  \x1b]8;;${CLAUDE_AI}\x07${CLAUDE_AI}\x1b]8;;\x07\n`), { url: CLAUDE_AI, callback: null });
  assert.equal(findLoginUrl("Starting authentication…"), null);
  // A redirect somewhere other than loopback is never offered for pasting.
  assert.equal(findLoginUrl("https://x.dev/authorize?redirect_uri=https%3A%2F%2Fevil.dev%2Fcb")!.callback, null);
});

test("callbackTarget: only the CLI's own port and path, on loopback, with a code", () => {
  const cb = "http://localhost:3118/callback";
  assert.equal(callbackTarget("http://localhost:3118/callback?code=abc&state=s1", cb).toString(), "http://localhost:3118/callback?code=abc&state=s1");
  assert.equal(callbackTarget("  http://127.0.0.1:3118/callback?error=access_denied ", cb).port, "3118");
  assert.throws(() => callbackTarget("not a url", cb), /whole address/);
  assert.throws(() => callbackTarget("http://localhost:9999/callback?code=a", cb), /3118\/callback/);
  assert.throws(() => callbackTarget("http://localhost:3118/other?code=a", cb), /isn't the address/);
  assert.throws(() => callbackTarget("http://evil.dev:3118/callback?code=a", cb), /isn't the address/);
  assert.throws(() => callbackTarget("http://localhost:3118/callback", cb), /no sign-in code/);
});

test("scriptArgs: the CLI under a pseudo-terminal, quoted for sh on Linux, as arguments on macOS", () => {
  assert.deepEqual(scriptArgs("linux", "/usr/bin/claude", ["mcp", "login", "it's mine", "--no-browser"]),
    ["script", ["-qfec", "'/usr/bin/claude' 'mcp' 'login' 'it'\\''s mine' '--no-browser'", "/dev/null"]]);
  assert.deepEqual(scriptArgs("darwin", "claude", ["mcp", "login", "x"]), ["script", ["-q", "/dev/null", "claude", "mcp", "login", "x"]]);
});

/** A fake `claude mcp login` on a pseudo-terminal: prints `out`; what's typed lands in `typed` and runs `onType`. */
function fakeCli(out: string, onType?: (cli: { exit: (code: number, said?: string) => void }) => void) {
  const spawned: string[][] = [];
  const typed: string[] = [];
  let child: any;
  const exit = (code: number, said = "") => {
    if (said) child.stdout.write(said);
    setTimeout(() => { child.exitCode = code; child.emit("close", code); }, 5);
  };
  const spawn = (args: string[]) => {
    spawned.push(args);
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on("data", (d: Buffer) => { typed.push(d.toString()); onType?.({ exit }); });
    child.exitCode = null;
    child.kill = () => { child.exitCode = 143; child.emit("close", 143); };
    setTimeout(() => child.stdout.write(out), 10);
    return child;
  };
  return { spawn, spawned, typed, exit };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("start → the URL; finish types the pasted address at the CLI's prompt and reports how it went", async () => {
  const cli = fakeCli(OUT, (c) => c.exit(0));
  const login = new McpLogin(".", { spawn: cli.spawn });
  const s = await login.start("notion");
  assert.deepEqual(cli.spawned[0], ["mcp", "login", "notion", "--no-browser"]);
  assert.equal(s.callback, "http://localhost:3118/callback");
  assert.equal(login.status("notion").pending, true);
  await assert.rejects(login.finish("notion", "http://localhost:1/callback?code=a"), /3118/);
  assert.deepEqual(cli.typed, [], "a wrong address is never typed");
  const r = await login.finish("notion", "http://localhost:3118/callback?code=abc&state=s1");
  assert.deepEqual(cli.typed, ["http://localhost:3118/callback?code=abc&state=s1\r"]);
  assert.deepEqual(r, { pending: false, done: true, ok: true, message: "Signed in to notion." });
  assert.equal(login.status("notion").pending, false, "finished sign-ins are dropped");
});

test("a rejected code comes back with the CLI's own reason", async () => {
  const cli = fakeCli(OUT, (c) => c.exit(1, REJECTED));
  const login = new McpLogin(".", { spawn: cli.spawn });
  await login.start("notion");
  const r = await login.finish("notion", "http://localhost:3118/callback?code=x");
  assert.equal(r.ok, false);
  assert.match(r.message, /Invalid authorization code format/);
});

test("locally the browser reaches the callback itself: status reports it finished", async () => {
  const cli = fakeCli(OUT);
  const login = new McpLogin(".", { spawn: cli.spawn });
  await login.start("notion");
  cli.exit(0);
  await tick();
  assert.deepEqual(login.status("notion"), { pending: false, done: true, ok: true, message: "Signed in to notion." });
});

test("claude.ai connectors: a claude.ai link, nothing to paste; a CLI that never prints a URL is an error", async () => {
  const cli = fakeCli(`Visit this URL to authorize:\n  ${CLAUDE_AI}\n\nOnce authorized on claude.ai, the connector will be available the next time you start Claude Code.\n`);
  const login = new McpLogin(".", { spawn: cli.spawn });
  const s = await login.start("claude.ai Confirm");
  assert.deepEqual(s, { url: CLAUDE_AI, callback: null });
  cli.exit(0);
  await tick();
  assert.match(login.status("claude.ai Confirm").message, /claude\.ai/);

  const bad = fakeCli("No MCP server found with name: nope\n");
  const login2 = new McpLogin(".", { spawn: bad.spawn });
  const started = login2.start("nope");
  setTimeout(() => bad.exit(1), 50);
  await assert.rejects(started, /No MCP server found/);
});

test("cancel kills the waiting CLI", async () => {
  const cli = fakeCli(OUT);
  const login = new McpLogin(".", { spawn: cli.spawn });
  await login.start("notion");
  login.cancel("notion");
  assert.equal(login.status("notion").pending, false);
});

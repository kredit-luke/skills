// Plugin skills in the skill list, the Implement terminal prompt, and terminal quoting.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-plugin-skills-"));
const ROOT = path.join(TMP, "workspace");
const CONFIG = path.join(TMP, "claude-config");
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = path.join(ROOT, ".claude", "ledger");

const { Deck } = await import("../src/deck.ts");
const { terminalArg } = await import("../src/machine.ts");
const { Search } = await import("../src/search.ts");

const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  // Cached by mtime: make sure a rewrite within the same tick is seen.
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(file, t, t);
};
const skill = (dir: string, name: string, extra = "") =>
  write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nBody`);

const LOCAL_SKILLS = path.join(ROOT, ".claude", "skills");
skill(LOCAL_SKILLS, "implement");
skill(LOCAL_SKILLS, "helper", "user-invocable: false\n");

const install = (name: string) => path.join(CONFIG, "plugins", "cache", "market", name, "1.0.0");
skill(path.join(install("flow"), "skills"), "implement", "argument-hint: <ticket>\n");
skill(path.join(install("flow"), "skills"), "tdd", "user-invocable: false\n");
skill(path.join(install("other"), "skills"), "thing");
skill(path.join(install("global"), "skills"), "everywhere");

// A second workspace, for the manifest, scope and real-path cases (its own enabled plugins).
const ROOT2 = path.join(TMP, "workspace2");
const LINK2 = path.join(TMP, "workspace2-link");
fs.mkdirSync(ROOT2, { recursive: true });
fs.symlinkSync(ROOT2, LINK2, "junction"); // a junction on Windows, a directory symlink elsewhere
// plugin.json `skills` as a path: a folder of skills, instead of skills/.
write(path.join(install("declared"), ".claude-plugin", "plugin.json"), { name: "declared", skills: "./custom/" });
skill(path.join(install("declared"), "custom"), "alpha");
skill(path.join(install("declared"), "skills"), "ignored");
// plugin.json `skills` as a list: a single skill folder and a folder of skills; a path leaving the plugin is ignored.
write(path.join(install("listed"), ".claude-plugin", "plugin.json"), { name: "listed", skills: ["./one", "./many", "../declared/custom"] });
write(path.join(install("listed"), "one", "SKILL.md"), "---\nname: solo\ndescription: One\n---\nSolo body");
skill(path.join(install("listed"), "many"), "beta");
// No plugin.json skills: the marketplace entry's (a strict:false entry) are used.
skill(install("loose"), "gamma");
skill(install("loose"), "delta");
skill(install("loose"), "undeclared");
write(path.join(CONFIG, "plugins", "marketplaces", "market", ".claude-plugin", "marketplace.json"), {
  name: "market", plugins: [{ name: "loose", source: "./loose", strict: false, skills: ["./gamma", "./delta"] }],
});
// Installed for the user, for this project and locally: the local install wins.
fs.mkdirSync(install("late"), { recursive: true }); // installed, no skills yet
for (const s of ["user", "project", "local"]) skill(path.join(install("scoped") + "-" + s, "skills"), s);
write(path.join(ROOT2, ".claude", "settings.json"), { enabledPlugins: { "declared@market": true, "listed@market": true, "loose@market": true, "scoped@market": true, "late@market": true } });

const INSTALLED = path.join(CONFIG, "plugins", "installed_plugins.json");
const installed = (otherProject: string) => ({
  version: 2,
  plugins: {
    "declared@market": [{ scope: "project", installPath: install("declared"), projectPath: LINK2 }], // recorded through a junction
    "listed@market": [{ scope: "user", installPath: install("listed") }],
    "loose@market": [{ scope: "user", installPath: install("loose") }],
    "scoped@market": ["user", "local", "project"].map((s) => ({ scope: s, installPath: install("scoped") + "-" + s, ...(s === "user" ? {} : { projectPath: ROOT2 }) })),
    "late@market": [{ scope: "user", installPath: install("late") }],
    "flow@market": [{ scope: "project", installPath: install("flow"), version: "1.0.0", projectPath: process.platform === "win32" ? ROOT.toUpperCase() : ROOT }], // Windows paths compare case-insensitively
    "other@market": [{ scope: "project", installPath: install("other"), version: "1.0.0", projectPath: otherProject }],
    "global@market": [{ scope: "user", installPath: install("global"), version: "1.0.0" }],
  },
});
write(INSTALLED, installed(path.join(TMP, "elsewhere")));
write(path.join(CONFIG, "settings.json"), { enabledPlugins: { "global@market": true, "flow@market": false } });
write(path.join(ROOT, ".claude", "settings.json"), { enabledPlugins: { "flow@market": true, "other@market": true } });

const deck = () => new Deck(ROOT, path.join(ROOT, ".claude", "ledger", "settings.json"));
const names = () => deck().skills().map((s) => s.name);

test("enabled plugins' skills follow the workspace's, namespaced; agent-only ones are left out", () => {
  assert.deepEqual(names(), ["implement", "flow:implement", "global:everywhere"]);
  const s = deck().skills().find((x) => x.name === "flow:implement")!;
  assert.deepEqual(s, { name: "flow:implement", description: "Does implement", argumentHint: "<ticket>", plugin: "flow" });
  assert.equal(deck().skills()[0].plugin, undefined, "a workspace skill has no plugin marker");
});

test("search offers the same skills, plugin ones by their namespaced name", () => {
  const search = new Search({ root: ROOT, memory: { list: () => ({ memories: [] }) }, issues: () => [], runs: () => [] });
  const docs = search._skills().filter(Boolean);
  assert.deepEqual(docs.map((d) => d.title).sort(), ["/flow:implement", "/global:everywhere", "/implement"]);
  const flow = docs.find((d) => d.extra.skill === "flow:implement");
  assert.equal(flow.rel, "flow/skills/implement/SKILL.md");
});

test("settings.local.json can turn a plugin off", () => {
  const local = path.join(ROOT, ".claude", "settings.local.json");
  write(local, { enabledPlugins: { "flow@market": false } });
  assert.deepEqual(names(), ["implement", "global:everywhere"]);
  fs.rmSync(local);
  assert.ok(names().includes("flow:implement"));
});

test("a plugin installed for another project is not listed; for this one it is", () => {
  assert.ok(!names().includes("other:thing"));
  write(INSTALLED, installed(ROOT + path.sep));
  assert.ok(names().includes("other:thing"));
  write(INSTALLED, installed(path.join(TMP, "elsewhere")));
});

test("broken or missing plugin files leave just the workspace's skills", () => {
  write(INSTALLED, "{ not json");
  assert.deepEqual(names(), ["implement"]);
  fs.rmSync(INSTALLED);
  assert.deepEqual(names(), ["implement"]);
  write(path.join(ROOT, ".claude", "settings.json"), "nope");
  write(INSTALLED, installed(path.join(TMP, "elsewhere")));
  assert.deepEqual(names(), ["implement", "global:everywhere"]);
  write(path.join(ROOT, ".claude", "settings.json"), { enabledPlugins: { "flow@market": true } });
});

test("implementPrompt renders the Implement preset with every option off, else /implement", () => {
  const cfg = path.join(ROOT, ".claude", "dashboard", "deck.json");
  assert.equal(deck().implementPrompt("ENG-1"), "/implement ENG-1", "no deck.json");
  write(cfg, { presets: [{ id: "implement", label: "Implement", prompt: "/flow:implement {ticket}", args: [{ name: "ticket", pattern: "^[A-Z]+-\\d+$" }],
    options: [{ name: "auto", append: " --auto", default: true }] }] });
  assert.equal(deck().implementPrompt("ENG-2"), "/flow:implement ENG-2", "a default-on option stays off in a terminal");
  assert.throws(() => deck().implementPrompt("bad id"), /doesn't look right/);
  write(cfg, { issues: { implementPreset: "build" }, presets: [] });
  assert.equal(deck().implementPrompt("ENG-3"), "/implement ENG-3", "the configured preset is missing");
});

test("terminalArg quotes one literal argument for PowerShell or sh", () => {
  assert.equal(terminalArg(`/x:implement it's "q"`, true), `'/x:implement it''s "q"'`);
  assert.equal(terminalArg(`/x:implement it's`, false), `'/x:implement it'\\''s'`);
});

test("terminalArg doubles PowerShell's curly single quotes too", () => {
  const [l, r, low, rev] = ["‘", "’", "‚", "‛"];
  assert.equal(terminalArg(`it${r}s ${l}x${r} ${low}y${rev}`, true), `'it${r}${r}s ${l}${l}x${r}${r} ${low}${low}y${rev}${rev}'`);
});

test("nativeArgSafe turns double quotes single on Windows, so PowerShell 5.1 can't split the argument", async () => {
  const { nativeArgSafe } = await import("../src/machine.ts");
  assert.equal(nativeArgSafe(`/x:implement "A & B" | c`, true), `/x:implement 'A & B' | c`);
  assert.equal(terminalArg(nativeArgSafe(`say "hi"`, true), true), `'say ''hi'''`);
  assert.equal(nativeArgSafe(`say "hi"`, false), `say "hi"`, "sh passes it through intact");
});

const names2 = () => new Deck(ROOT2, path.join(ROOT2, ".claude", "ledger", "settings.json")).skills().map((s) => s.name).sort();

test("plugin skill folders come from plugin.json, else the marketplace entry, else skills/; the most specific install wins", () => {
  assert.deepEqual(names2(), ["declared:alpha", "global:everywhere", "listed:beta", "listed:solo", "loose:delta", "loose:gamma", "scoped:local"]);
});

test("a project install recorded through a junction or symlink still matches the workspace", () => {
  assert.ok(names2().includes("declared:alpha"));
  const moved = installed(path.join(TMP, "elsewhere"));
  moved.plugins["declared@market"] = [{ scope: "project", installPath: install("declared"), projectPath: path.join(TMP, "elsewhere") }];
  write(INSTALLED, moved);
  assert.ok(!names2().includes("declared:alpha"));
  write(INSTALLED, installed(path.join(TMP, "elsewhere")));
  assert.ok(names2().includes("declared:alpha"));
});

test("a skills folder appearing in an installed plugin is noticed without a settings change", () => {
  assert.ok(!names2().some((n) => n.startsWith("late:")));
  skill(path.join(install("late"), "skills"), "fresh");
  assert.ok(names2().includes("late:fresh"));
});

test("expandSlash: /plugin:name expands an enabled plugin's skill, found from the main workspace", async () => {
  const { expandSlash } = await import("../src/agents/skills.ts");
  const worktree = path.join(TMP, "worktrees", "ENG-1"); // no settings of its own
  fs.mkdirSync(worktree, { recursive: true });
  write(path.join(install("flow"), "skills", "implement", "SKILL.md"), "---\nname: implement\n---\nBuild $ARGUMENTS end to end.");
  const file = path.join(install("flow"), "skills", "implement", "SKILL.md").split(path.sep).join("/");
  assert.equal(expandSlash("/flow:implement ENG-1", worktree, ROOT),
    `Follow the "/flow:implement" skill below (${file}), as if it had been invoked as \`/flow:implement ENG-1\`.\n\n<skill>\nBuild ENG-1 end to end.\n</skill>`);
  assert.match(expandSlash("/FLOW:Implement ENG-1", worktree, ROOT), /^Follow the/, "case-insensitive, like workspace skills");
  assert.equal(expandSlash("/flow:nope x", worktree, ROOT), "/flow:nope x", "an unknown plugin skill passes through");
  assert.equal(expandSlash("/other:thing x", worktree, ROOT), "/other:thing x", "a plugin not installed for this workspace passes through");
  assert.equal(expandSlash("/flow:implement ENG-1", worktree), "/flow:implement ENG-1", "the worktree alone has no plugins enabled");
});

test("RunManager expands /plugin:name for a non-Claude agent from its main workspace, not the run's folder", async () => {
  const { RunManager } = await import("../src/runs.ts");
  const { agentOf } = await import("../src/agents/index.ts");
  const { spawn } = await import("node:child_process");
  const codex = agentOf("codex");
  const turnArgs = codex.turnArgs.bind(codex);
  const spawnFn = codex.spawn.bind(codex);
  const prompts: string[] = [];
  codex.turnArgs = (t) => { prompts.push(t.prompt); return turnArgs(t); };
  codex.spawn = (_a, o) => spawn(process.execPath, ["-e", ""], o);
  try {
    const worktree = path.join(TMP, "worktrees", "ENG-2");
    fs.mkdirSync(worktree, { recursive: true });
    const runs = new RunManager(path.join(TMP, "run-ledger"), { workspaceRoot: ROOT });
    runs.start({ prompt: "/flow:implement ENG-2", cwd: worktree, model: null, effort: null, agent: "codex" });
    assert.match(prompts[0], /^Follow the "\/flow:implement" skill below/);
    assert.match(prompts[0], /Build ENG-2 end to end\./);
  } finally {
    codex.turnArgs = turnArgs;
    codex.spawn = spawnFn;
  }
});

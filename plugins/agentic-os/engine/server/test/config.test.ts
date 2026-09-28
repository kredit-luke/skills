// The config layer against a scratch workspace: every module reads
// WORKSPACE_ROOT/.claude/dashboard at import, so point it there before importing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-config-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = path.join(ROOT, ".claude", "ledger");
delete process.env.DASHBOARD_PORT;

const { workspaceConfig, dashboardPort, ticketRe, readConfigFile } = await import("../src/config.ts");
const { appsConfig } = await import("../src/apps.ts");
const { resolvedSpecs, requiredVersion } = await import("../src/machine.ts");
const { readLinks, saveLink, deleteLink } = await import("../src/links.ts");
const { docSources } = await import("../src/docs.ts");

const write = (name: string, data: unknown) => {
  const file = path.join(CFG, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  // Config is cached by mtime; make sure a rewrite within the same tick is seen.
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(file, t, t);
};

test("with no config at all, everything has a working default", () => {
  const ws = workspaceConfig();
  assert.equal(ws.name, path.basename(ROOT));
  assert.equal(ws.dashboard.port, 3333);
  assert.equal(ws.issues.kind, "none");
  assert.equal(appsConfig().configured, false);
  assert.deepEqual(Object.keys(appsConfig().apps), []);
  assert.equal(docSources().configured, false);
  assert.equal(resolvedSpecs(ROOT).configured, false);
  assert.deepEqual(readLinks(ROOT).categories, []);
});

test("dashboard port: --port, then DASHBOARD_PORT, then workspace.json, then 3333", () => {
  write("workspace.json", { name: "Acme", dashboard: { port: 4100 } });
  assert.equal(dashboardPort(["node", "main.ts"]), 4100);
  process.env.DASHBOARD_PORT = "4200";
  try {
    assert.equal(dashboardPort(["node", "main.ts"]), 4200);
    assert.equal(dashboardPort(["node", "main.ts", "--port", "4300"]), 4300);
  } finally {
    delete process.env.DASHBOARD_PORT;
  }
  assert.equal(workspaceConfig().name, "Acme");
});

test("a broken config file reports its error instead of throwing", () => {
  write("docs.json", "{ not json");
  const r = readConfigFile("docs.json");
  assert.equal(r.data, null);
  assert.match(r.error!, /docs\.json/);
  fs.unlinkSync(path.join(CFG, "docs.json"));
});

test("tracker defaults depend on the kind", () => {
  write("workspace.json", { issues: { kind: "github", repos: ["acme/api"] } });
  assert.equal(workspaceConfig().issues.label, "GitHub Issues");
  assert.deepEqual(workspaceConfig().issues.implementStates, ["Open"]);
  assert.ok(ticketRe().test("api#42"));
  write("workspace.json", { issues: { kind: "jira", site: "acme.atlassian.net" } });
  assert.deepEqual(workspaceConfig().issues.implementStates, ["To Do"]);
  assert.ok(ticketRe().test("ENG-7"));
});

test("ticket pattern comes from workspace.json (bad patterns fall back)", () => {
  write("workspace.json", { issues: { kind: "github", ticketPattern: "^#\\d+$" } });
  assert.ok(ticketRe().test("#12"));
  assert.ok(!ticketRe().test("ENG-12"));
  write("workspace.json", { issues: { ticketPattern: "([" } });
  assert.ok(ticketRe().test("ENG-12"));
});

test("apps.json: valid apps kept, unsafe ones dropped with a reason", () => {
  write("apps.json", {
    launcher: { script: "tools/run.js" },
    apps: {
      web: { name: "Web", dir: "web", port: 5173, launch: { cmd: "npm run dev" } },
      api: { name: "API", dir: "api", port: 8080, https: true, mainOnly: true, launch: { launcher: "run api", detached: true } },
      evil: { name: "Evil", dir: "../outside", launch: { cmd: "x" } },
      nolaunch: { name: "No launch", dir: "x" },
    },
    stacks: { all: { label: "All", apps: ["api", "web", "ghost"] } },
  });
  const cfg = appsConfig();
  assert.deepEqual(Object.keys(cfg.apps).sort(), ["api", "web"]);
  assert.match(cfg.error!, /evil/);
  assert.match(cfg.error!, /nolaunch/);
  assert.deepEqual(cfg.stacks.all.apps, ["api", "web"]); // unknown app ids are dropped
  assert.equal(cfg.defaultStack, "all");
  assert.equal(cfg.launcher!.script, path.resolve(ROOT, "tools/run.js"));
  assert.equal(cfg.launcher!.stop, "stop {app}");
  assert.deepEqual(cfg.groups, [{ id: "apps", label: "apps" }]); // a group no one declared gets its id as label
});

test("machine.json: catalog entries merge with overrides; when.exists filters", () => {
  fs.mkdirSync(path.join(ROOT, "svc"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "svc", ".nvmrc"), "v22.4.1\n");
  write("machine.json", {
    checks: [
      { use: "node", required: { file: "svc/.nvmrc", min: "20.0.0" }, apps: ["web"] },
      { use: "go", group: "Backend", optional: true },
      { use: "php", when: { exists: "not-cloned" } },
      { use: "no-such-tool" },
      { id: "my-flag", kind: "env-var", label: "MY_FLAG", name: "MY_FLAG" },
    ],
  });
  const { specs } = resolvedSpecs(ROOT);
  assert.deepEqual(specs.map((s) => s.id), ["node", "go", "my-flag"]);
  const go = specs.find((s) => s.id === "go");
  assert.equal(go.kind, "command");
  assert.equal(go.group, "Backend");
  assert.equal(go.optional, true);
  assert.ok(go.install.mac); // from the catalog
  assert.equal(requiredVersion(specs[0].required, ROOT), "22.4.1");
  assert.equal(requiredVersion({ file: "svc/.nvmrc", min: "24.0.0" }, ROOT), "24.0.0"); // the floor wins
  assert.equal(requiredVersion({ file: "missing", regex: "x(\\d)", default: "10" }, ROOT), "10");
});

test("links: add team + personal, move between them, edit in place, delete", () => {
  const teamFile = path.join(CFG, "links.json");
  write("links.json", { $comment: "keep me", categories: [{ title: "Apps", tiles: [{ title: "Admin", url: "https://admin.example" }] }] });

  let r = saveLink(ROOT, { scope: "personal", category: "Mine", tile: { title: "Notes", url: "https://notes.example" } });
  assert.deepEqual(r.categories.map((c) => c.title), ["Apps", "Mine"]);
  assert.equal(r.categories[1].tiles[0].scope, "personal");

  r = saveLink(ROOT, { scope: "team", category: "Apps", tile: { title: "API", links: [{ label: "Prod", url: "https://api.example" }] } });
  const api = r.categories[0].tiles.find((t) => t.title === "API")!;
  assert.deepEqual(api.ref, { scope: "team", category: "Apps", index: 1 });

  // Move the team tile to "just me".
  r = saveLink(ROOT, { scope: "personal", category: "Mine", tile: { title: "API", url: "https://api.example" }, original: { ref: api.ref, title: "API" } });
  assert.deepEqual(r.categories[0].tiles.map((t) => t.title), ["Admin"]);
  assert.deepEqual(r.categories[1].tiles.map((t) => t.title), ["Notes", "API"]);

  // A stale ref (the tile changed since the page loaded) is refused.
  assert.throws(() => saveLink(ROOT, { scope: "team", category: "Apps", tile: { title: "X", url: "https://x.example" }, original: { ref: { scope: "team", category: "Apps", index: 0 }, title: "Not Admin" } }), /changed/);

  // Unsafe links are refused.
  assert.throws(() => saveLink(ROOT, { scope: "team", category: "Apps", tile: { title: "X", url: "javascript:alert(1)" } }), /https/);

  // Edit in place: same scope and category keeps its position.
  r = saveLink(ROOT, { scope: "personal", category: "Mine", tile: { title: "Notes 2", url: "https://notes.example/2" }, original: { ref: { scope: "personal", category: "Mine", index: 0 }, title: "Notes" } });
  assert.deepEqual(r.categories[1].tiles.map((t) => t.title), ["Notes 2", "API"]);

  r = deleteLink(ROOT, { ref: { scope: "personal", category: "Mine", index: 0 }, title: "Notes 2" });
  r = deleteLink(ROOT, { ref: { scope: "personal", category: "Mine", index: 0 }, title: "API" });
  assert.deepEqual(r.categories.map((c) => c.title), ["Apps"]);

  // The team file keeps its other keys, and is back to what it was.
  const team = JSON.parse(fs.readFileSync(teamFile, "utf-8"));
  assert.equal(team.$comment, "keep me");
  assert.deepEqual(team.categories, [{ title: "Apps", tiles: [{ title: "Admin", url: "https://admin.example" }] }]);
});

test("worktrees.ports and the fallback / slotOffset app fields", () => {
  write("workspace.json", { worktrees: { ports: { base: 24000, slotSize: 1000 } } });
  assert.deepEqual(workspaceConfig().worktrees.ports, { base: 24000, slotSize: 1000 });
  for (const bad of [{ base: 0, slotSize: 10 }, { base: 24000 }, { base: 65000, slotSize: 1000 }, "x"]) {
    write("workspace.json", { worktrees: { ports: bad } });
    assert.equal(workspaceConfig().worktrees.ports, null, JSON.stringify(bad));
  }
  write("workspace.json", {});
  assert.equal(workspaceConfig().worktrees.ports, null, "off by default: the team's tooling allocates");

  write("apps.json", { apps: {
    api: { name: "API", dir: "api", fallback: "main", slotOffset: 3, launch: { cmd: "x" } },
    web: { name: "Web", dir: "web", fallback: "yes", launch: { cmd: "x" } },
  } });
  const cfg = appsConfig();
  assert.equal(cfg.apps.api.fallback, "main");
  assert.equal(cfg.apps.api.slotOffset, 3);
  assert.equal(cfg.apps.web.fallback, null);
  assert.equal(cfg.apps.web.slotOffset, null);
  assert.match(cfg.error, /fallback can only be "main"/);
  write("apps.json", {});
});

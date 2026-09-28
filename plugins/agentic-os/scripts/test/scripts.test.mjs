// node --test plugins/agentic-os/scripts/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contrast, mapToContract, parseColor, themeCss, tokensOnly } from "../extract-brand.mjs";
import { compareVersions, engineVersion, pluginVersion, releaseCheck } from "../lib.mjs";
import { scaffold } from "../scaffold.mjs";
import { upgrade } from "../upgrade.mjs";
import { validate } from "../validate.mjs";

test("compareVersions orders x.y.z numerically, a leading v is fine", () => {
  assert.ok(compareVersions("0.2.10", "0.2.9") > 0);
  assert.ok(compareVersions("v24.11.0", "24.15.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.deepEqual(["0.2.1", "0.10.0", "0.2.0"].sort(compareVersions), ["0.2.0", "0.2.1", "0.10.0"]);
});

test("releaseCheck: stale only when a newer release is out; unknown when offline", () => {
  const current = pluginVersion();
  assert.equal(releaseCheck("999.0.0").stale, true);
  assert.equal(releaseCheck(current).stale, false);
  assert.equal(releaseCheck(null).stale, false);
  assert.match(releaseCheck("999.0.0").update.join(" "), /claude plugin update agentic-os@/);
});

test("upgrade stops on a stale plugin or a downgrade instead of merging", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-upgrade-"));
  const lock = (version) => {
    fs.mkdirSync(path.join(root, ".claude", "dashboard"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "dashboard", "engine.json"), JSON.stringify({ version }));
  };

  lock(engineVersion());
  const stale = upgrade(root, { latest: "999.0.0", dry: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(upgrade(root, { latest: "999.0.0", allowStale: true, dry: true }).upToDate, true);
  assert.equal(upgrade(root, { latest: pluginVersion(), dry: true }).upToDate, true);

  lock("999.0.0");
  const down = upgrade(root, { latest: null, dry: true });
  assert.equal(down.ok, false);
  assert.equal(down.downgrade, true);
});

test("colors: parse hex/rgb/hsl, WCAG contrast", () => {
  assert.deepEqual(parseColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseColor("rgb(10, 20, 30)"), [10, 20, 30]);
  assert.deepEqual(parseColor("hsl(0, 100%, 50%)"), [255, 0, 0]);
  assert.equal(parseColor("var(--x)"), null);
  assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21);
});

test("tokensOnly: variables and @imports yes, element rules no", () => {
  assert.equal(tokensOnly(`/* c */ @import url("x.css"); :root { --a: #fff; } @font-face { font-family: X; src: url(x.woff2); }`), true);
  assert.equal(tokensOnly(`:root { --a: #fff; } body { margin: 0; }`), false);
});

test("mapping by name, hue fallback for status colors, no self-references", () => {
  const vars = {
    paper: "#FBFBFD", ink: "#0E1430", "navy-900": "#070E36", brand: "#0B1D6F", "navy-700": "#1A2C86",
    orange: "#25D55F", "orange-600": "#0B8A3C", risk: "#E03131", "on-navy": "#FFFFFF", "font-body": "'Plex', sans-serif", r: "14px",
  };
  const chosen = mapToContract(vars);
  assert.equal(chosen["brand-900"], "navy-900");
  assert.equal(chosen["brand-800"], "brand");
  assert.equal(chosen.ok, "orange"); // green by hue, the bright one
  assert.equal(chosen.risk, "risk");
  assert.equal(chosen.r, "r"); // radius, not taken for a color
  const { body, checks } = themeCss(vars, chosen, (n) => `var(--${n})`);
  assert.ok(!/--paper: var\(--paper\)/.test(body), "same-name tokens are left to the imported file");
  assert.match(body, /--brand-900: var\(--navy-900\);/);
  for (const c of checks.filter((c) => c.ratio !== null)) assert.ok(c.ok, `${c.label} ${c.ratio}`);
});

test("scaffold + validate on a scratch workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-test-"));
  fs.mkdirSync(path.join(root, "api"));
  fs.writeFileSync(path.join(root, ".gitignore"), "*\n!.gitignore\n");
  const plan = {
    workspace: { name: "Test", dashboard: { port: 3399 }, issues: { kind: "github", repos: ["t/api"] } },
    apps: { apps: { api: { name: "API", dir: "api", port: 8080, launch: { cmd: "go run ." } } } },
    machine: { checks: [{ use: "go" }, { use: "git" }] },
    skills: ["dashboard"],
    claudeMd: true,
  };
  const r = scaffold(root, plan);
  assert.ok(r.wrote.some((w) => w.startsWith("dashboard/")));
  assert.ok(fs.existsSync(path.join(root, "dashboard", "bin", "dashboard.mjs")));
  assert.ok(fs.existsSync(path.join(root, ".claude", "skills", "dashboard", "SKILL.md")));
  assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), /localhost:3399/);
  const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf-8");
  assert.match(gi, /!dashboard\/\*\*/); // allow-list style gets the allow lines
  assert.match(gi, /\.claude\/ledger\//);
  assert.deepEqual(validate(root).errors, []);

  // Existing config is kept unless --force.
  const again = scaffold(root, { ...plan, workspace: { name: "Changed" } });
  assert.ok(again.kept.includes(".claude/dashboard/workspace.json"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".claude", "dashboard", "workspace.json"), "utf-8")).name, "Test");

  // validate catches a clash with the dashboard's port and an unknown catalog entry.
  fs.writeFileSync(path.join(root, ".claude", "dashboard", "apps.json"), JSON.stringify({ apps: { api: { name: "API", dir: "api", port: 3399, launch: { cmd: "x" } } } }));
  fs.writeFileSync(path.join(root, ".claude", "dashboard", "machine.json"), JSON.stringify({ checks: [{ use: "nope" }] }));
  const errs = validate(root).errors.join("\n");
  assert.match(errs, /port 3399, which is the dashboard's/);
  assert.match(errs, /"nope" isn't in the catalog/);
});

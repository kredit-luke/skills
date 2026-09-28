// node --test plugins/agentic-os/scripts/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brandCandidates, contrast, isHashedBuild, mapToContract, parseColor, themeCss, tokensOnly, withoutVendorVars } from "../extract-brand.mjs";
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

  // Worktree slots and fallback: bad values, duplicate/oversized offsets, a slot port on main's.
  const cfg = path.join(root, ".claude", "dashboard");
  fs.writeFileSync(path.join(cfg, "machine.json"), JSON.stringify({ checks: [] }));
  fs.writeFileSync(path.join(cfg, "workspace.json"), JSON.stringify({ name: "Test", dashboard: { port: 3399 }, worktrees: { ports: { base: 8000, slotSize: 50 } } }));
  fs.writeFileSync(path.join(cfg, "apps.json"), JSON.stringify({ apps: {
    api: { name: "API", dir: "api", port: 8051, fallback: "main", slotOffset: 1, launch: { cmd: "x" } },
    web: { name: "Web", dir: "api", port: 5173, fallback: "yes", slotOffset: 1, launch: { cmd: "x" } },
    job: { name: "Job", dir: "api", fallback: "main", slotOffset: 80, launch: { cmd: "x" } },
  } }));
  let r2 = validate(root);
  const e2 = r2.errors.join("\n"), w2 = r2.warnings.join("\n");
  assert.match(e2, /apps\.web\.fallback can only be "main"/);
  assert.match(e2, /apps\.web and apps\.api both get slot offset 1/);
  assert.match(e2, /apps\.job: slot offset 80 is past worktrees\.ports\.slotSize \(50\)/);
  assert.match(w2, /apps\.job: fallback needs a port/);
  assert.match(w2, /apps\.api in worktree slot 1 would get port 8051, which apps\.api uses in main/);
  fs.writeFileSync(path.join(cfg, "workspace.json"), JSON.stringify({ name: "Test", worktrees: { ports: { base: "x" } } }));
  assert.match(validate(root).errors.join("\n"), /worktrees\.ports needs \{ base, slotSize \}/);
});

test("brand candidates: hashed build output and library variables don't outrank the real tokens", () => {
  assert.equal(isHashedBuild("server/public/styles-4DKUHBMG.css"), true);
  assert.equal(isHashedBuild("dist/main.3f9a1c2b.css"), true);
  assert.equal(isHashedBuild("src/styles/design-tokens.css"), false);
  assert.equal(isHashedBuild("theme/variables-override.css"), false);
  assert.deepEqual(Object.keys(withoutVendorVars({ "d2h-bg": "#fff", "mat-sys-primary": "#000", "brand-500": "#123456" })), ["brand-500"]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-brand-"));
  const lib = Array.from({ length: 40 }, (_, i) => `--d2h-c${i}: #${String(100000 + i)};`).join(" ");
  fs.mkdirSync(path.join(root, "app", "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "public", "styles-4DKUHBMG.css"), `:root { ${lib} --x1: #111; --x2: #222; --x3: #333; --x4: #444; }`);
  fs.mkdirSync(path.join(root, "app", "src", "styles"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "src", "styles", "_brand.css"), ":root { --brand-900: #082310; --brand-700: #104620; --cream: #fef6e7; --copper: #f2622a; --ink: #111; }");
  fs.writeFileSync(path.join(root, "app", "src", "styles", "vendor.css"), `:root { ${lib} }`); // only library variables
  const files = brandCandidates(root).map((c) => c.file);
  assert.equal(files[0], "app/src/styles/_brand.css");
  assert.ok(!files.includes("app/public/styles-4DKUHBMG.css"), files.join(", "));
  assert.ok(!files.includes("app/src/styles/vendor.css"), files.join(", "));
});

test("line endings: copyTree writes LF, engine-diff shows only real edits in a CRLF copy", async () => {
  const { copyTree } = await import("../lib.mjs");
  const { engineDiff } = await import("../engine-diff.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aos-eol-"));
  const from = path.join(tmp, "from");
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, "a.ts"), "one\r\ntwo\r\n");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a]);
  fs.writeFileSync(path.join(from, "logo.png"), png);
  copyTree(from, path.join(tmp, "to"));
  assert.equal(fs.readFileSync(path.join(tmp, "to", "a.ts"), "utf-8"), "one\ntwo\n");
  assert.deepEqual(fs.readFileSync(path.join(tmp, "to", "logo.png")), png, "binary files are copied as they are");

  // A workspace whose engine copy is CRLF, with one real edit.
  const base = path.join(tmp, "base");
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, "x.ts"), "a\nb\nc\n");
  fs.writeFileSync(path.join(base, "same.ts"), "keep\n");
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(path.join(ws, "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(ws, "dashboard", "x.ts"), "a\r\nB\r\nc\r\n");
  fs.writeFileSync(path.join(ws, "dashboard", "same.ts"), "keep\r\n");
  const r = engineDiff(ws, { base });
  assert.deepEqual(r.changed, ["x.ts"], "same.ts differs only in line endings");
  const lines = r.patch.split("\n").filter((l) => /^[-+][^-+]/.test(l));
  assert.deepEqual(lines, ["-b", "+B"]);
});

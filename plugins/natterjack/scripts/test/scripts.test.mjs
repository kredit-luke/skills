// node --test plugins/natterjack/scripts/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { brandCandidates, contrast, isHashedBuild, mapToContract, parseColor, themeCss, tokensOnly, withoutVendorVars } from "../extract-brand.mjs";
import { compareVersions, engineVersion, fetchEngine, latestRelease, normalizeRepo, pluginVersion, readRepos, releaseCheck } from "../lib.mjs";
import { listRepos } from "../discover.mjs";
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
  assert.match(releaseCheck("999.0.0").update.join(" "), /claude plugin update natterjack@/);
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
  assert.ok(r.wrote.some((w) => w.startsWith("natterjack/")), "new installs go in natterjack/");
  assert.ok(fs.existsSync(path.join(root, "natterjack", "bin", "dashboard.mjs")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".claude", "dashboard", "engine.json"), "utf-8")).dir, "natterjack");
  const skill = fs.readFileSync(path.join(root, ".claude", "skills", "natterjack", "SKILL.md"), "utf-8");
  assert.match(skill, /^name: natterjack$/m);
  assert.match(skill, /node natterjack\/bin\/dashboard\.mjs start/);
  assert.doesNotMatch(skill, /\{\{/);
  const md = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8");
  assert.match(md, /localhost:3399/);
  assert.match(md, /node natterjack\/bin\/dashboard\.mjs start --open/);
  assert.doesNotMatch(md, /\{\{/);
  assert.match(r.next[0], /^node natterjack\/bin\/dashboard\.mjs start/);
  const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf-8");
  assert.match(gi, /!natterjack\/\*\*/); // allow-list style gets the allow lines
  assert.match(gi, /^natterjack\/node_modules\/$/m);
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

  // Roles: a bad id and profile are errors; an output style that isn't built in or in .claude/output-styles/ is a warning.
  fs.mkdirSync(path.join(root, ".claude", "output-styles"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "output-styles", "product.md"), "---\nname: Product\nkeep-coding-instructions: true\n---\nPlain words.\n");
  // No name in the frontmatter: the style is "terse" (its file name), not the "name:" line in its body.
  fs.writeFileSync(path.join(root, ".claude", "output-styles", "terse.md"), "---\ndescription: Short\n---\nname: Body\n");
  fs.writeFileSync(path.join(cfg, "workspace.json"), JSON.stringify({ name: "Test", roles: {
    eng: { label: "Engineering" }, product: { profile: "reader", outputStyle: "Product" }, learn: { outputStyle: "Learning" },
    "bad id": {}, ops: { profile: "viewer", outputStyle: "Business" }, short: { outputStyle: "terse" }, body: { outputStyle: "Body" },
  } }));
  const r3 = validate(root);
  const e3 = r3.errors.join("\n"), w3 = r3.warnings.join("\n");
  assert.match(e3, /roles\."bad id": an id is letters/);
  assert.match(e3, /roles\.ops\.profile must be "developer" or "reader"/);
  assert.match(w3, /roles\.ops\.outputStyle "Business" isn't built in or in \.claude\/output-styles\//);
  assert.doesNotMatch(w3 + e3, /roles\.(product|learn|eng|short)\b/, "a team style by its frontmatter or file name, and a built-in one, are found");
  assert.match(w3, /roles\.body\.outputStyle "Body" isn't built in/, "a name: line in the body doesn't count");
});

test("repos.json: both field styles read the same; scaffold writes the standard names; validate flags bad entries", () => {
  // The standard (relativePath / remote), with a nested repo, as most hand-written files have it.
  assert.deepEqual(normalizeRepo({ name: "admin", layer: "bff", relativePath: "bff\\admin", remote: "https://x/admin.git" }), {
    name: "admin", relativePath: "bff/admin", remote: "https://x/admin.git", layer: "bff", defaultBranch: null, dependencies: [], snapshot: true,
  });
  // What scaffold used to write (directory / url).
  const old = normalizeRepo({ name: "API", url: "https://x/api.git", directory: "api" });
  assert.equal(old.relativePath, "api");
  assert.equal(old.remote, "https://x/api.git");
  assert.equal(normalizeRepo({ name: "x", relativePath: "../out" }), null);

  // discover finds a nested repo at its relativePath (it used to look for <name>/.git).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-repos-"));
  fs.mkdirSync(path.join(root, "bff", "admin", ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ repos: [
    { name: "admin", relativePath: "bff/admin", remote: "https://x/admin.git" },
    { name: "web", directory: "web", url: "https://x/web.git" },
  ] }));
  assert.deepEqual(readRepos(root).map((r) => r.relativePath), ["bff/admin", "web"]);
  const found = listRepos(root);
  const admin = found.find((r) => r.name === "admin");
  assert.equal(admin.dir, "bff/admin");
  assert.equal(admin.cloned, true);
  assert.equal(found.find((r) => r.name === "web").cloned, false);

  // scaffold normalizes whatever the plan used and points at the engine's schema.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "aos-repos-ws-"));
  scaffold(ws, { workspace: { name: "T" }, repos: [{ name: "API", url: "https://x/api.git", directory: "api", dependencies: [] }] });
  const written = JSON.parse(fs.readFileSync(path.join(ws, "repos.json"), "utf-8"));
  assert.equal(written.$schema, "./natterjack/shared/repos.schema.json");
  assert.ok(fs.existsSync(path.join(ws, "natterjack", "shared", "repos.schema.json")), "the schema ships with the engine");
  assert.deepEqual(written.repos, [{ name: "API", relativePath: "api", remote: "https://x/api.git" }]);

  // validate: old names are a warning; a path outside the workspace and a reused path are errors.
  fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({ repos: [
    { name: "API", directory: "api", url: "https://x/api.git" },
    { name: "evil", relativePath: "../outside" },
    { name: "twin", relativePath: "api", remote: "https://x/twin.git" },
    { name: "API", relativePath: "other", remote: "https://x/o.git" },
    { name: "local", relativePath: "local" },
  ] }));
  const v = validate(ws);
  const errs = v.errors.join("\n"), warns = v.warnings.join("\n");
  assert.match(errs, /"evil" needs a name and a relative path/);
  assert.match(errs, /"twin" and "API" both use api/);
  assert.match(errs, /the name "API" is used twice/);
  assert.match(warns, /"API" uses directory, url; the standard names are relativePath and remote/);
  assert.match(warns, /"local" isn't here and has no remote/);
  fs.writeFileSync(path.join(ws, "repos.json"), "{}");
  assert.match(validate(ws).errors.join("\n"), /repos\.json: needs a "repos" array/);

  // snapshot: the source must be an adapter the installed engine has, with its required settings.
  const snap = (snapshot) => { fs.writeFileSync(path.join(ws, "repos.json"), JSON.stringify({ snapshot, repos: [] })); return validate(ws).errors.join("\n"); };
  assert.match(snap({ source: "dropbox" }), /snapshot\.source "dropbox" has no adapter in this engine \(known: confluence, http, azure-blob, s3\)/);
  assert.match(snap({ source: "azure-blob", account: "acme" }), /needs "container"/);
  assert.match(snap({ source: "azure-blob", container: "snapshots" }), /needs "account" \(or "endpoint"\)/);
  assert.match(snap({ source: "azure-blob", account: "Acme_Code", container: "snapshots" }), /3-24 lowercase letters and digits/);
  assert.match(snap({ source: "s3", region: "us-east-1" }), /needs "bucket"/);
  assert.equal(snap({ source: "s3", bucket: "acme-code" }), "");
  assert.match(snap({ source: "confluence", site: "acme.atlassian.net" }), /needs "pageId"/);
  assert.match(snap({ source: "confluence", site: "acme.atlassian.net", pageId: "abc" }), /the number in the page's URL/);
  assert.match(snap({ source: "http", baseUrl: "https://x", auth: "token" }), /snapshot\.auth must be/);
  assert.match(snap({}), /snapshot needs a "source"/);
  assert.equal(snap({ source: "confluence", site: "acme.atlassian.net", pageId: "123" }), "");
  assert.equal(normalizeRepo({ name: "infra", snapshot: false }).snapshot, false);
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

test("infrastructure.json: scaffold writes it (also from the old plan key); validate reads an old reference.json with a warning", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "aos-infra-"));
  const cfg = path.join(ws, ".claude", "dashboard");
  scaffold(ws, { workspace: { name: "T" }, reference: { title: "Infra", file: "docs/infra.md" } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, "infrastructure.json"), "utf-8")).file, "docs/infra.md");
  assert.ok(!fs.existsSync(path.join(cfg, "reference.json")));
  assert.match(validate(ws).warnings.join("\n"), /infrastructure\.json: file "docs\/infra\.md" isn't in the workspace/);

  fs.renameSync(path.join(cfg, "infrastructure.json"), path.join(cfg, "reference.json"));
  const v = validate(ws).warnings.join("\n");
  assert.match(v, /reference\.json: rename it to infrastructure\.json/);
  assert.match(v, /reference\.json: file "docs\/infra\.md" isn't in the workspace/);
});

test("engineDirOf: engine.json dir, else dashboard/ (older workspaces)", async () => {
  const { engineDirOf, DEFAULT_ENGINE_DIR, LEGACY_ENGINE_DIR, reposSchema } = await import("../lib.mjs");
  assert.equal(DEFAULT_ENGINE_DIR, "natterjack");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-enginedir-"));
  assert.equal(engineDirOf(root), LEGACY_ENGINE_DIR, "no engine.json at all");
  const cfg = path.join(root, ".claude", "dashboard");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, "engine.json"), JSON.stringify({ version: "0.7.1" }));
  assert.equal(engineDirOf(root), "dashboard", "engine.json without dir: an install from before it was configurable");
  fs.writeFileSync(path.join(cfg, "engine.json"), JSON.stringify({ version: "0.8.0", dir: "tools\\ops/" }));
  assert.equal(engineDirOf(root), "tools/ops");
  for (const bad of ["../out", "/abs", "C:/x", ".claude/engine", "."]) {
    fs.writeFileSync(path.join(cfg, "engine.json"), JSON.stringify({ dir: bad }));
    assert.equal(engineDirOf(root), "dashboard", bad);
  }
  assert.match(validate(root).errors.join("\n"), /engine\.json: dir "\." must be a folder inside the workspace/);
  assert.equal(reposSchema("tools/ops"), "./tools/ops/shared/repos.schema.json");
});

test("scaffold into a nested engineDir: engine, engine.json, .gitignore, skill named after it; upgrade and validate follow it", async () => {
  const { ENGINE_DIR, copyTree, engineVersion: ev } = await import("../lib.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-nested-"));
  fs.writeFileSync(path.join(root, ".gitignore"), "*\n!.gitignore\n");
  const plan = { workspace: { name: "T", dashboard: { port: 3398 } }, engineDir: "tools/ops", skills: ["dashboard"], claudeMd: true, repos: [{ name: "api", relativePath: "api", remote: "https://x/api.git" }] };
  const r = scaffold(root, plan);
  assert.equal(r.engineDir, "tools/ops");
  assert.equal(r.skill, "ops");
  assert.ok(fs.existsSync(path.join(root, "tools", "ops", "server", "src", "main.ts")));
  assert.ok(!fs.existsSync(path.join(root, "natterjack")) && !fs.existsSync(path.join(root, "dashboard")));
  const lock = JSON.parse(fs.readFileSync(path.join(root, ".claude", "dashboard", "engine.json"), "utf-8"));
  assert.equal(lock.dir, "tools/ops");
  const gi = fs.readFileSync(path.join(root, ".gitignore"), "utf-8").split("\n");
  for (const l of ["!tools/", "!tools/ops/", "!tools/ops/**", "tools/ops/node_modules/", "tools/ops/dist/", "tools/ops/.angular/", ".claude/ledger/"]) assert.ok(gi.includes(l), l);
  assert.ok(gi.indexOf("!tools/") < gi.indexOf("!tools/ops/"), "the parent is let back in first");
  const skill = fs.readFileSync(path.join(root, ".claude", "skills", "ops", "SKILL.md"), "utf-8");
  assert.match(skill, /^---\nname: ops\n/);
  assert.match(skill, /after pulling updates to tools\/ops\//);
  assert.match(skill, /node tools\/ops\/bin\/dashboard\.mjs restart/);
  assert.ok(!fs.existsSync(path.join(root, ".claude", "skills", "dashboard")));
  assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), /Its code is `tools\/ops\/`/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "repos.json"), "utf-8")).$schema, "./tools/ops/shared/repos.schema.json");
  assert.deepEqual(validate(root).errors, []);

  // Run again without engineDir: it stays where it is (engine.json), nothing new appears.
  const again = scaffold(root, { workspace: { name: "T" } });
  assert.equal(again.engineDir, "tools/ops");
  assert.ok(again.kept.some((k) => k.startsWith("tools/ops/ (already installed")));
  assert.throws(() => scaffold(root, { workspace: { name: "T" }, engineDir: "natterjack" }), /already installed in tools\/ops\//);

  // An explicit skillName wins over the folder's name.
  const named = fs.mkdtempSync(path.join(os.tmpdir(), "aos-named-"));
  scaffold(named, { workspace: { name: "T" }, engineDir: "ops-console", skillName: "Console", skills: ["dashboard"] });
  assert.match(fs.readFileSync(path.join(named, ".claude", "skills", "console", "SKILL.md"), "utf-8"), /^name: console$/m);

  // upgrade merges into tools/ops/ and keeps dir in engine.json.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aos-nested-base-"));
  copyTree(ENGINE_DIR, base);
  const rel = path.join("bin", "snapshot.mjs");
  fs.appendFileSync(path.join(base, rel), "// old\n");
  fs.appendFileSync(path.join(root, "tools", "ops", rel), "// old\n");
  fs.writeFileSync(path.join(root, ".claude", "dashboard", "engine.json"), JSON.stringify({ ...lock, version: "0.0.1" }));
  const up = upgrade(root, { base, latest: null });
  assert.equal(up.ok, true);
  assert.equal(up.engineDir, "tools/ops");
  assert.deepEqual(up.updated, ["bin/snapshot.mjs"]);
  assert.equal(fs.readFileSync(path.join(root, "tools", "ops", rel), "utf-8"), fs.readFileSync(path.join(ENGINE_DIR, rel), "utf-8").replace(/\r\n/g, "\n"));
  assert.ok(up.next.includes("cd tools/ops && npm ci && npm test"));
  const after = JSON.parse(fs.readFileSync(path.join(root, ".claude", "dashboard", "engine.json"), "utf-8"));
  assert.equal(after.dir, "tools/ops");
  assert.equal(after.version, ev());
  assert.ok(!fs.existsSync(path.join(root, "dashboard")));
});

test("scaffold refuses an engineDir it can't use; an older workspace keeps dashboard/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-refuse-"));
  fs.mkdirSync(path.join(root, "natterjack", "src"), { recursive: true }); // the team's own folder
  fs.writeFileSync(path.join(root, "natterjack", "src", "index.ts"), "x");
  assert.throws(() => scaffold(root, { workspace: { name: "T" } }), /natterjack\/ is already in the workspace and isn't the engine/);
  for (const bad of ["../up", "/abs", ".claude/x", "C:\\x"]) assert.throws(() => scaffold(root, { workspace: { name: "T" }, engineDir: bad }), /must be a folder inside the workspace/, bad);
  assert.throws(() => scaffold(root, { workspace: { name: "T" }, engineDir: "api/tools", repos: [{ name: "api", relativePath: "api" }] }), /overlaps the repo "api"/);
  assert.ok(!fs.existsSync(path.join(root, ".claude", "dashboard", "engine.json")), "nothing written when it refuses");

  // A workspace set up before the folder was configurable: engine in dashboard/, engine.json without dir.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "aos-legacy-"));
  fs.mkdirSync(path.join(old, "dashboard", "server", "src"), { recursive: true });
  fs.writeFileSync(path.join(old, "dashboard", "server", "src", "main.ts"), "");
  fs.mkdirSync(path.join(old, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(old, ".claude", "dashboard", "engine.json"), JSON.stringify({ version: "0.7.1" }));
  const r = scaffold(old, { workspace: { name: "T" } }, { dry: true });
  assert.equal(r.engineDir, "dashboard");
  assert.ok(r.kept.some((k) => k.startsWith("dashboard/ (already installed")));
});

test("brand scans skip the engine, whatever its folder is called", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-skip-engine-"));
  const tokens = ":root { --brand-900: #082310; --brand-700: #104620; --cream: #fef6e7; --copper: #f2622a; --ink: #111; }";
  const eng = path.join(root, "tools", "ops");
  fs.mkdirSync(path.join(eng, "bin"), { recursive: true });
  fs.mkdirSync(path.join(eng, "server", "src"), { recursive: true });
  fs.mkdirSync(path.join(eng, "web", "public", "ds"), { recursive: true });
  fs.writeFileSync(path.join(eng, "bin", "dashboard.mjs"), "");
  fs.writeFileSync(path.join(eng, "server", "src", "main.ts"), "");
  fs.writeFileSync(path.join(eng, "web", "public", "ds", "tokens.css"), tokens);
  fs.mkdirSync(path.join(root, "app", "styles"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "styles", "brand.css"), tokens);
  assert.deepEqual(brandCandidates(root).map((c) => c.file), ["app/styles/brand.css"]);
});

test("brand scans still read a team's own folder called dashboard (only an engine is skipped)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-own-dashboard-"));
  fs.mkdirSync(path.join(root, "dashboard", "src", "styles"), { recursive: true });
  fs.writeFileSync(path.join(root, "dashboard", "src", "styles", "brand.css"), ":root { --brand-900: #082310; --brand-700: #104620; --cream: #fef6e7; --ink: #111; }");
  assert.deepEqual(brandCandidates(root).map((c) => c.file), ["dashboard/src/styles/brand.css"]);
});

test("releases before the rename: latestRelease and fetchEngine read agentic-os-v tags and plugins/agentic-os", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aos-releases-"));
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  const release = (plugin, version, tag) => {
    fs.rmSync(path.join(repo, "plugins"), { recursive: true, force: true });
    fs.mkdirSync(path.join(repo, "plugins", plugin, "engine"), { recursive: true });
    fs.writeFileSync(path.join(repo, "plugins", plugin, "engine", "ENGINE.json"), JSON.stringify({ version }));
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", version);
    git("tag", tag);
  };
  git("init", "-q");
  release("agentic-os", "0.6.0", "agentic-os-v0.6.0");
  release("natterjack", "0.9.0", "natterjack-v0.9.0");

  assert.equal(latestRelease(repo), "0.9.0", "the newest across both tag names");
  const old = fetchEngine("0.6.0", repo);
  assert.ok(old, "an agentic-os release is still a merge base");
  assert.equal(engineVersion(old), "0.6.0");
  assert.equal(engineVersion(fetchEngine("0.9.0", repo)), "0.9.0");
  assert.equal(fetchEngine("0.5.0", repo), null, "a version with no tag");
});

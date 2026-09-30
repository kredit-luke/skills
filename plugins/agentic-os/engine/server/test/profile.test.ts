// Roles and the reader profile: skillOverrides and outputStyle in settings.local.json (only
// ours are ever removed), and workspace.json roles / profiles.reader. config.ts reads
// WORKSPACE_ROOT at import.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-profile-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
const LEDGER = path.join(ROOT, ".claude", "ledger");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = LEDGER;

const { workspaceConfig } = await import("../src/config.ts");
const { readProfile, setRole, syncSkillOverrides } = await import("../src/profile.ts");
type Role = import("../src/config.ts").RoleConfig;

const role = (id: string, profile: "developer" | "reader", hiddenSkills: string[] = [], outputStyle: string | null = null): Role =>
  ({ id, label: id, description: "", profile, outputStyle, hiddenPages: [], hiddenSkills });
let bump = 10;
const writeWorkspace = (data: unknown) => {
  fs.writeFileSync(path.join(CFG, "workspace.json"), JSON.stringify(data));
  const t = new Date(Date.now() + 1000 * bump++);
  fs.utimesSync(path.join(CFG, "workspace.json"), t, t);
};

const settingsFile = path.join(ROOT, ".claude", "settings.local.json");
const settings = () => JSON.parse(fs.readFileSync(settingsFile, "utf-8"));

test("profiles.reader: Apps and Workspaces hidden by default, both lists configurable", () => {
  assert.deepEqual(workspaceConfig().profiles.reader, { hiddenPages: ["apps", "workspaces"], hiddenSkills: [] });
  fs.writeFileSync(path.join(CFG, "workspace.json"), JSON.stringify({ profiles: { reader: { hiddenPages: ["/apps", "machine"], hiddenSkills: ["run", 3, "pr"] } } }));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(CFG, "workspace.json"), t, t);
  assert.deepEqual(workspaceConfig().profiles.reader, { hiddenPages: ["apps", "machine"], hiddenSkills: ["run", "pr"] });
});

test("a reader role turns skills off in settings.local.json and a developer role takes back only ours", () => {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  // Someone's own settings: an env block, their own "pr" override, and another skill they hid.
  fs.writeFileSync(settingsFile, "\uFEFF" + JSON.stringify({ env: { A: "1" }, skillOverrides: { pr: "name-only", legacy: "off" } }));
  const dev = role("dev", "developer");
  let roles = [dev, role("rd", "reader", ["run", "pr", "worktree"])];
  assert.equal(readProfile(LEDGER, roles).chosen, false);
  assert.equal(readProfile(LEDGER, roles).profile, "developer");

  setRole(LEDGER, ROOT, { role: "rd" }, roles);
  let s = settings();
  assert.deepEqual(s.env, { A: "1" }, "the rest of the file is kept");
  assert.deepEqual(s.skillOverrides, { pr: "name-only", legacy: "off", run: "off", worktree: "off" }, "their own pr setting wins");
  const p = readProfile(LEDGER, roles);
  assert.equal(p.profile, "reader");
  assert.equal(p.roleChosen, true);
  assert.deepEqual(p.skillsOff.sort(), ["run", "worktree"]);

  // The team drops worktree from the list: it comes back on; run stays off.
  roles = [dev, role("rd", "reader", ["run", "pr"])];
  setRole(LEDGER, ROOT, { role: "rd" }, roles);
  assert.deepEqual(settings().skillOverrides, { pr: "name-only", legacy: "off", run: "off" });

  setRole(LEDGER, ROOT, { role: "dev" }, roles);
  s = settings();
  assert.deepEqual(s.skillOverrides, { pr: "name-only", legacy: "off" }, "only what the reader role added is removed");
  assert.deepEqual(readProfile(LEDGER, roles).skillsOff, []);
});

test("an override someone changed after we set it is theirs; a broken settings file is never overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-profile-b-"));
  const file = path.join(root, ".claude", "settings.local.json");
  const ours = syncSkillOverrides(root, ["run"], []);
  assert.deepEqual(ours, ["run"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { skillOverrides: { run: "off" } });
  // They switched it to name-only themselves: switching back to developer leaves it.
  fs.writeFileSync(file, JSON.stringify({ skillOverrides: { run: "name-only" } }));
  assert.deepEqual(syncSkillOverrides(root, [], ours), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { skillOverrides: { run: "name-only" } });
  // With nothing left, the key goes; unrelated keys stay.
  fs.writeFileSync(file, JSON.stringify({ model: "x", skillOverrides: { run: "off" } }));
  syncSkillOverrides(root, [], ["run"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { model: "x" });

  fs.writeFileSync(file, "{ broken");
  assert.throws(() => syncSkillOverrides(root, ["run"], []), /isn't valid JSON/);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ broken");
  assert.throws(() => syncSkillOverrides(root, ["bad name!"], []), /isn't valid JSON/, "still refuses before anything else");
});

test("workspace.json roles: in order, on their profile, adding to profiles.reader; none = Developer and Reader", () => {
  writeWorkspace({});
  assert.deepEqual(workspaceConfig().roles.map((r) => [r.id, r.profile]), [["developer", "developer"], ["reader", "reader"]]);
  assert.equal(workspaceConfig().rolesConfigured, false);
  assert.deepEqual(workspaceConfig().roles[1].hiddenPages, ["apps", "workspaces"]);

  writeWorkspace({
    profiles: { reader: { hiddenSkills: ["run"] } },
    roles: {
      engineering: { label: "Engineering" },
      product: { label: "Product", profile: "reader", outputStyle: "Product", hiddenSkills: ["pr", "run"], hiddenPages: ["/machine"] },
      "bad id!": { label: "x" },
      finance: { profile: "reader", description: "Invoices and payments" },
    },
  });
  const ws = workspaceConfig();
  assert.equal(ws.rolesConfigured, true);
  assert.deepEqual(ws.roles.map((r) => r.id), ["engineering", "product", "finance"]);
  const [eng, product, finance] = ws.roles;
  assert.deepEqual([eng.profile, eng.hiddenSkills, eng.hiddenPages, eng.outputStyle], ["developer", [], [], null], "developer is the default; profiles.reader isn't theirs");
  assert.deepEqual(product.hiddenSkills, ["run", "pr"], "profiles.reader's, then the role's own, once each");
  assert.deepEqual(product.hiddenPages, ["apps", "workspaces", "machine"]);
  assert.equal(product.outputStyle, "Product");
  assert.deepEqual([finance.label, finance.description, finance.hiddenSkills], ["finance", "Invoices and payments", ["run"]]);
  writeWorkspace({});
});

test("a role's output style goes into settings.local.json; the person's own style is never replaced", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-profile-style-"));
  const ledger = path.join(root, ".claude", "ledger");
  const file = path.join(root, ".claude", "settings.local.json");
  const read = () => JSON.parse(fs.readFileSync(file, "utf-8"));
  const roles = [role("eng", "developer"), role("product", "reader", [], "Product"), role("ops", "reader", [], "Business")];

  setRole(ledger, root, { role: "product" }, roles);
  assert.equal(read().outputStyle, "Product");
  setRole(ledger, root, { role: "ops" }, roles);
  assert.equal(read().outputStyle, "Business", "ours is swapped for the new role's");
  setRole(ledger, root, { role: "eng" }, roles);
  assert.equal("outputStyle" in read(), false, "a role without a style takes ours back");
  assert.equal(readProfile(ledger, roles).outputStyle, null);

  // Their own style: kept, and never taken back.
  fs.writeFileSync(file, JSON.stringify({ outputStyle: "Explanatory" }));
  setRole(ledger, root, { role: "product" }, roles);
  assert.equal(read().outputStyle, "Explanatory");
  assert.equal(readProfile(ledger, roles).outputStyle, null);
  setRole(ledger, root, { role: "eng" }, roles);
  assert.equal(read().outputStyle, "Explanatory");

  // Ours, then changed by them: theirs from then on.
  fs.writeFileSync(file, "{}");
  setRole(ledger, root, { role: "product" }, roles);
  fs.writeFileSync(file, JSON.stringify({ outputStyle: "Learning" }));
  setRole(ledger, root, { role: "eng" }, roles);
  assert.equal(read().outputStyle, "Learning");
});

test("a profile without a role still asks; an unknown role is refused; a role the team removed falls back to its profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-profile-role-"));
  const ledger = path.join(root, ".claude", "ledger");
  const roles = [role("eng", "developer"), role("product", "reader", ["run"]), role("ops", "reader")];

  // A first snapshot download: the first reader role's settings, but no role picked.
  let p = setRole(ledger, root, { profile: "reader" }, roles);
  assert.deepEqual([p.chosen, p.roleChosen, p.role, p.profile, p.current.id], [true, false, null, "reader", "product"]);
  assert.deepEqual(p.skillsOff, ["run"]);

  assert.throws(() => setRole(ledger, root, { role: "nope" }, roles), /no role "nope"/);

  p = setRole(ledger, root, { role: "ops" }, roles);
  assert.deepEqual([p.roleChosen, p.current.id], [true, "ops"]);
  assert.deepEqual(p.skillsOff, [], "product's skill comes back on");
  // The team renamed ops away: reader stays, and they're asked again.
  p = readProfile(ledger, [role("eng", "developer"), role("finance", "reader")]);
  assert.deepEqual([p.profile, p.current.id, p.roleChosen], ["reader", "finance", false]);

  // A profile.json from before roles: { profile: "reader" }.
  fs.writeFileSync(path.join(ledger, "profile.json"), JSON.stringify({ profile: "reader", chosenAt: null, skillsOff: [] }));
  p = readProfile(ledger, roles);
  assert.deepEqual([p.chosen, p.roleChosen, p.profile, p.current.id], [true, false, "reader", "product"]);
});

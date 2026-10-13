// The People page (people/): hosting.json checks, the directory adapters, the roster
// (people.json in the repo) and its commit, the Kubernetes rendering, and the reconcile + actions, all against
// a fake CLI runner (kubectl, gcloud, az, aws, git) and a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkHosting, readHosting } from "../src/people/config.ts";
import { makeDirectory, type Fetcher } from "../src/people/directory.ts";
import { Roster, describe } from "../src/people/roster.ts";
import { People, uniqueSlug } from "../src/people/index.ts";
import { parseJsonStream, type CliResult, type Runner } from "../src/people/cli.ts";

const ok = (stdout = ""): CliResult => ({ ok: true, code: 0, stdout, stderr: "" });
const bad = (stderr: string, code: number | string = 1): CliResult => ({ ok: false, code, stdout: "", stderr });

const HOSTING = {
  directory: { type: "google", domain: "acme.com", orgUnit: "/Product" },
  platform: { type: "kubernetes", context: "ctx", namespace: "dashboards", template: "hosting/person.yaml" },
  areas: { company: { secret: "nj-area-company" }, finance: { secret: "nj-area-finance" } },
  defaultProfile: "member",
  profiles: {
    member: { name: "Member", areas: ["company"], memory: "2Gi", maxConcurrentRuns: 3 },
    finance: { name: "Finance", areas: ["company", "finance"], memory: "1Gi", maxConcurrentRuns: 1 },
  },
};

/** What `kubectl create --dry-run=client -o json` makes of kubernetes-person.yaml (placeholders still in). */
function templateList(input: string) {
  const person = /dashboard-(\S+)/.exec(input)![1].replace(/[^\w]+$/, "");
  const email = /natterjack\/owner: "([^"]+)"/.exec(input)![1];
  return {
    kind: "List",
    items: [
      {
        apiVersion: "apps/v1", kind: "StatefulSet",
        metadata: { name: `dashboard-${person}`, labels: { app: "natterjack-dashboard" }, annotations: { "natterjack/owner": email } },
        spec: {
          replicas: 0, serviceName: `dashboard-${person}`,
          template: { metadata: { labels: { app: "natterjack-dashboard", person } }, spec: { containers: [{ name: "dashboard", image: "img:1", env: [{ name: "DASHBOARD_OWNER", value: email }], resources: { limits: { cpu: "1", memory: "2Gi" } } }] } },
          volumeClaimTemplates: [{ metadata: { name: "data" } }],
        },
      },
      { apiVersion: "v1", kind: "Service", metadata: { name: `dashboard-${person}` } },
    ],
  };
}

/** A fake world: a cluster, git around the workspace's people.json, a Google directory. */
function world(cfg = "") {
  const rosterFile = path.join(cfg, "people.json");
  const state = {
    statefulsets: [] as any[],
    /** people.json as last committed (null: never). */
    committed: null as string | null,
    commits: [] as string[][],
    calls: [] as string[],
    applies: [] as any[],
  };
  const run: Runner = async (name, args, opts = {}) => {
    const a = args.join(" ");
    state.calls.push(`${name} ${a}`);
    if (name === "git") {
      const cmd = args[2];
      const text = fs.existsSync(rosterFile) ? fs.readFileSync(rosterFile, "utf-8") : null;
      if (cmd === "config") return ok("eng@acme.com\n");
      if (cmd === "status") return ok(text !== null && text !== state.committed ? " M .claude/dashboard/people.json\n" : "");
      if (cmd === "show") return state.committed === null ? bad("fatal: path '.claude/dashboard/people.json' does not exist in 'HEAD'") : ok(state.committed);
      if (cmd === "add") return ok();
      if (cmd === "commit") { state.committed = text; state.commits.push(args.slice(3)); return ok(); }
    }
    if (name === "gcloud" && a.startsWith("auth application-default print-access-token")) return ok("tok\n");
    if (name === "kubectl") {
      const rest = args.slice(args.indexOf("dashboards") + 1);
      const r = rest.join(" ");
      if (r.startsWith("get statefulsets")) return ok(JSON.stringify({ items: state.statefulsets }));
      // Real kubectl (1.34) prints one pretty document per object, not a List.
      if (r.startsWith("create --dry-run=client")) return ok(templateList(opts.input!).items.map((o) => JSON.stringify(o, null, 4)).join("\n"));
      if (r.startsWith("apply")) {
        const list = JSON.parse(opts.input!);
        state.applies.push({ dryRun: r.includes("--dry-run=server"), list });
        if (!r.includes("--dry-run")) {
          for (const o of list.items.filter((x: any) => x.kind === "StatefulSet")) {
            state.statefulsets = state.statefulsets.filter((s) => s.metadata.name !== o.metadata.name).concat([{ ...o, status: {} }]);
          }
        }
        return ok("statefulset.apps/x configured\n");
      }
      if (r.startsWith("scale")) {
        const [, target, rep] = /statefulset\/(\S+) --replicas=(\d)/.exec(r)!;
        const s = state.statefulsets.find((x) => x.metadata.name === target)!;
        s.spec.replicas = Number(rep);
        return ok(`statefulset.apps/${target} scaled\n`);
      }
      if (r.startsWith("delete")) {
        const name = /statefulset\/(\S+)/.exec(r)![1];
        state.statefulsets = state.statefulsets.filter((s) => s.metadata.name !== name);
        return ok(`deleted ${r}\n`);
      }
    }
    return bad(`unexpected: ${name} ${a}`);
  };
  const users = [
    { primaryEmail: "Ana@acme.com", name: { fullName: "Ana Silva" } },
    { primaryEmail: "bo@acme.com", name: { fullName: "Bo Li" } },
    { primaryEmail: "cy@acme.com", name: { fullName: "Cy Old" }, suspended: true },
  ];
  const fetcher: Fetcher = async (url) => {
    state.calls.push(`fetch ${url}`);
    const u = new URL(url);
    const page = u.searchParams.get("pageToken");
    const body = page ? { users: users.slice(2) } : { users: users.slice(0, 2), nextPageToken: "p2" };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const roster = () => (fs.existsSync(rosterFile) ? JSON.parse(fs.readFileSync(rosterFile, "utf-8")) : null);
  return { state, run, fetcher, roster, rosterFile };
}

function workspace(hosting: object = HOSTING) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nj-people-"));
  const cfg = path.join(root, ".claude", "dashboard");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, "hosting.json"), JSON.stringify(hosting));
  fs.mkdirSync(path.join(root, "hosting"));
  fs.writeFileSync(path.join(root, "hosting", "person.yaml"), 'metadata:\n  name: dashboard-${PERSON}\n  annotations:\n    natterjack/owner: "${EMAIL}"\n');
  return { root, cfg };
}

// ------------------------------------------------------------------ config

test("hosting.json: missing is not configured; problems are named", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nj-people-"));
  assert.deepEqual(readHosting(root, path.join(root, "none")), { configured: false, config: null, problems: [] });
  const problems = checkHosting({ directory: { type: "okta" }, platform: { type: "ecs" }, profiles: { member: { areas: ["x"], memory: "lots" } } });
  for (const want of [/directory.type/, /platform.type/, /platform.template/, /area "x"/, /Kubernetes quantity/]) {
    assert.ok(problems.some((p) => want.test(p)), `${want}: ${problems.join(" | ")}`);
  }
  assert.deepEqual(checkHosting(HOSTING), []);
});

test("hosting.json: normalised paths and default profile", () => {
  const { root, cfg } = workspace();
  const { config } = readHosting(root, cfg);
  assert.equal(config!.platform.template, path.join(root, "hosting/person.yaml"));
  assert.equal(config!.defaultProfile, "member");
  assert.deepEqual(config!.profiles.map((p) => p.id), ["member", "finance"]);
});

// ------------------------------------------------------------------ directory

test("Google directory: pages through users, lowercases, marks suspended people inactive, scopes to the OU", async () => {
  const { run, fetcher, state } = world();
  const d = makeDirectory({ type: "google", domain: "acme.com", orgUnit: "/Product", department: null, adminUnit: null, project: null }, run, fetcher);
  const people = await d.list();
  assert.deepEqual(people.map((p) => [p.email, p.active]), [["ana@acme.com", true], ["bo@acme.com", true], ["cy@acme.com", false]]);
  const first = new URL(state.calls.find((c) => c.startsWith("fetch "))!.slice(6));
  assert.equal(first.searchParams.get("query"), "orgUnitPath='/Product'");
  assert.equal(first.searchParams.get("domain"), "acme.com");
});

test("Google directory: a token without the directory scope names the gcloud command to fix it", async () => {
  const run: Runner = async () => ok("tok");
  const fetcher: Fetcher = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '{"error":{"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}' });
  const d = makeDirectory({ type: "google", domain: "acme.com", orgUnit: null, department: null, adminUnit: null, project: null }, run, fetcher);
  await assert.rejects(d.list(), (e: any) => /can't read the Workspace directory/.test(e.message) && /application-default login --client-id-file=.* --scopes="https:.*admin\.directory\.user\.readonly/.test(e.fix));
});

test("Google directory: gcloud not installed", async () => {
  const run: Runner = async () => bad("spawn gcloud ENOENT", "ENOENT");
  const d = makeDirectory({ type: "google", domain: "acme.com", orgUnit: null, department: null, adminUnit: null, project: null }, run);
  await assert.rejects(d.list(), /gcloud\) isn't installed/);
});

test("Entra directory: only the domain's members (no guests), filtered by department, following nextLink", async () => {
  const calls: string[] = [];
  const run: Runner = async (name, args) => { calls.push(`${name} ${args.join(" ")}`); return ok("graph-token\n"); };
  const pages: Record<string, any> = {
    first: { value: [{ mail: "Ana@acme.com", displayName: "Ana", department: "Product", accountEnabled: true }, { userPrincipalName: "guest_x.com#EXT#@acme.com", department: "Product" }], "@odata.nextLink": "https://graph.microsoft.com/next" },
    next: { value: [{ mail: "bo@acme.com", department: "Sales" }, { mail: "cy@other.com", department: "Product" }, { mail: "di@acme.com", department: "product", accountEnabled: false }] },
  };
  const fetcher: Fetcher = async (url, init) => {
    assert.equal(init?.headers?.Authorization, "Bearer graph-token");
    const body = url.endsWith("/next") ? pages.next : pages.first;
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  const d = makeDirectory({ type: "entra", domain: "acme.com", orgUnit: null, department: "Product", adminUnit: null, project: null }, run, fetcher);
  assert.deepEqual((await d.list()).map((p) => [p.email, p.active]), [["ana@acme.com", true], ["di@acme.com", false]]);
  assert.match(calls[0], /az account get-access-token --resource-type ms-graph/);
});

// ------------------------------------------------------------------ roster

test("Roster: no file is an empty roster; writes are sorted, with a $comment, and git says what isn't committed", async () => {
  const { cfg } = workspace();
  const { run, state, roster } = world(cfg);
  const r = new Roster(path.dirname(path.dirname(cfg)), cfg, run);
  assert.equal(r.rel, ".claude/dashboard/people.json");
  assert.deepEqual(r.load(), { people: {} });
  assert.deepEqual(await r.status(), { file: ".claude/dashboard/people.json", uncommitted: false, changes: [] });
  const person = (profile: string) => ({ name: "x", slug: "x", profile, provisionedAt: "t", provisionedBy: "me" });
  r.update((d) => { d.people["zed@acme.com"] = person("member"); d.people["ana@acme.com"] = person("member"); return true; });
  assert.deepEqual(Object.keys(roster().people), ["ana@acme.com", "zed@acme.com"]);
  assert.match(roster().$comment, /People page/);
  assert.deepEqual((await r.status()).changes, ["Added ana@acme.com (member)", "Added zed@acme.com (member)"]);

  // Commit: people.json alone, and the message says what changed.
  await r.commit();
  assert.deepEqual(state.commits[0], ["--only", "-m", "chore(people): update the hosted dashboard roster (2 changes)", "-m", "- Added ana@acme.com (member)\n- Added zed@acme.com (member)", "--", ".claude/dashboard/people.json"]);
  assert.equal((await r.status()).uncommitted, false);
  r.update((d) => { d.people["ana@acme.com"].profile = "finance"; return true; });
  await r.commit();
  assert.deepEqual(state.commits[1].slice(0, 3), ["--only", "-m", "chore(people): changed ana@acme.com's profile to finance"]);
  // Nothing to do: no write, no commit.
  r.update(() => false);
  await r.commit();
  assert.equal(state.commits.length, 2);
});

test("Roster: a roster that exists but can't be read is an error, never an empty roster", () => {
  const { cfg } = workspace();
  const { run } = world(cfg);
  const r = new Roster(path.dirname(path.dirname(cfg)), cfg, run);
  fs.mkdirSync(r.file); // reading a folder fails with EISDIR, not ENOENT
  assert.throws(() => r.load(), /Couldn't read \.claude\/dashboard\/people\.json/);
  assert.throws(() => r.update(() => true), /Couldn't read/, "and nothing is written over it");
});

test("Roster: describe() lists who was added, removed, or changed profile", () => {
  const p = (profile: string) => ({ name: "", slug: "s", profile, provisionedAt: "", provisionedBy: "" });
  assert.deepEqual(describe({ people: { "a@x.io": p("m"), "b@x.io": p("m") } }, { people: { "a@x.io": p("f"), "c@x.io": p("m") } }),
    ["Changed a@x.io's profile to f", "Added c@x.io (m)", "Removed b@x.io"]);
  assert.deepEqual(describe({ people: { "a@x.io": p("m") } }, { people: { "a@x.io": { ...p("m"), name: "New" } } }), ["Updated people.json"]);
  assert.deepEqual(describe({ people: { "a@x.io": p("m") } }, { people: { "a@x.io": { ...p("m"), role: "finance" }, "c@x.io": { ...p("m"), role: "ops" } } }),
    ["Changed a@x.io's role to finance", "Added c@x.io (m, role ops)"]);
  assert.deepEqual(describe({ people: { "a@x.io": { ...p("m"), role: "finance" } } }, { people: { "a@x.io": p("m") } }), ["Let a@x.io pick their own role"]);
});

// ------------------------------------------------------------------ the page

test("uniqueSlug: from the email, suffixed when the roster or the cluster already uses it", () => {
  const doc = { version: 1 as const, people: { "x@acme.com": { name: "", slug: "ana", profile: "m", provisionedAt: "", provisionedBy: "" } }, log: [] };
  const cluster = new Map([["y@acme.com", { owner: "y@acme.com", name: "dashboard-ana-2", service: "", slug: null, replicas: 0, running: false, ready: false, profile: null, applied: null, claim: "data" }]]);
  assert.equal(uniqueSlug("Ana.Silva+x@acme.com", { ...doc, people: {} }, new Map()), "ana-silva-x");
  assert.equal(uniqueSlug("ana@acme.com", doc, cluster), "ana-3");
});

test("People: provision (preview, then for real) renders the profile, applies it and records it in the roster", async () => {
  const { root, cfg } = workspace();
  const { run, fetcher, state, roster } = world(cfg);
  const people = new People(root, { run, fetcher, configDir: cfg });

  let view = await people.view();
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.rows.map((r) => [r.email, r.state]), [["ana@acme.com", "not-set-up"], ["bo@acme.com", "not-set-up"]], "suspended and never set up: not listed");
  assert.equal(view.directory.count, 2);

  const preview = await people.act({ action: "provision", email: "ana@acme.com", profile: "finance", dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(state.statefulsets.length, 0, "a dry run changes nothing");
  assert.equal(roster(), null);
  const sts: any = preview.objects!.find((o: any) => o.kind === "StatefulSet");
  const c = sts.spec.template.spec.containers[0];
  assert.equal(sts.metadata.name, "dashboard-ana");
  assert.equal(sts.metadata.annotations["natterjack/owner"], "ana@acme.com");
  assert.equal(sts.metadata.annotations["natterjack/profile"], "finance");
  assert.deepEqual(c.resources.limits, { cpu: "1", memory: "1Gi" });
  assert.deepEqual(c.env.find((e: any) => e.name === "DASHBOARD_MAX_CONCURRENT_RUNS"), { name: "DASHBOARD_MAX_CONCURRENT_RUNS", value: "1" });
  assert.deepEqual(c.envFrom, [{ secretRef: { name: "nj-area-company" } }, { secretRef: { name: "nj-area-finance" } }]);
  assert.equal(sts.spec.replicas, 0, "the template's replicas: the router starts it");
  assert.ok(state.applies[0].dryRun);

  await people.act({ action: "provision", email: "ana@acme.com", profile: "finance" });
  const rec = roster();
  assert.equal(rec.people["ana@acme.com"].profile, "finance");
  assert.equal(rec.people["ana@acme.com"].name, "Ana Silva");
  assert.equal(rec.people["ana@acme.com"].provisionedBy, "eng@acme.com");

  view = await people.view();
  const ana = view.rows.find((r) => r.email === "ana@acme.com")!;
  assert.deepEqual([ana.state, ana.profile, ana.needsUpdate], ["stopped", "finance", false]);
  await assert.rejects(people.act({ action: "provision", email: "ana@acme.com" }), /already has a dashboard/);
  await assert.rejects(people.act({ action: "provision", email: "eve@evil.com" }), /Only acme.com addresses/);
});

test("People: changing a profile re-applies and keeps them running; a template change shows as needing an update", async () => {
  const { root, cfg } = workspace();
  const { run, fetcher, state, roster } = world(cfg);
  const people = new People(root, { run, fetcher, configDir: cfg });
  await people.act({ action: "provision", email: "bo@acme.com" });
  await people.act({ action: "start", email: "bo@acme.com" });
  await people.act({ action: "profile", email: "bo@acme.com", profile: "finance" });
  const sts = state.statefulsets[0];
  assert.equal(sts.spec.replicas, 1, "running stays running");
  assert.equal(sts.metadata.annotations["natterjack/profile"], "finance");
  assert.equal(roster().people["bo@acme.com"].profile, "finance");

  // Someone edits the finance profile in hosting.json: Bo's dashboard is now out of date.
  const changed = { ...HOSTING, profiles: { ...HOSTING.profiles, finance: { ...HOSTING.profiles.finance, memory: "3Gi" } } };
  fs.writeFileSync(path.join(cfg, "hosting.json"), JSON.stringify(changed));
  const bump = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(cfg, "hosting.json"), bump, bump);
  let bo = (await people.view()).rows.find((r) => r.email === "bo@acme.com")!;
  assert.equal(bo.needsUpdate, true);
  await people.act({ action: "update", email: "bo@acme.com" });
  bo = (await people.view()).rows.find((r) => r.email === "bo@acme.com")!;
  assert.equal(bo.needsUpdate, false);
});

const ROLES = [{ id: "finance", label: "Finance" }, { id: "product", label: "Product" }].map((r) => ({ ...r, description: "", profile: "reader" as const, outputStyle: null, hiddenPages: [], hiddenSkills: [] }));

test("People: a role assigned at set-up goes in the roster and reaches their dashboard as DASHBOARD_ROLE; changing it re-applies", async () => {
  const { root, cfg } = workspace();
  const { run, fetcher, state, roster } = world(cfg);
  const people = new People(root, { run, fetcher, configDir: cfg, roles: () => ROLES });
  const roleEnv = (o: any[]) => o.find((x) => x.kind === "StatefulSet").spec.template.spec.containers[0].env.find((e: any) => e.name === "DASHBOARD_ROLE");
  assert.deepEqual((await people.view()).roles, [{ id: "finance", label: "Finance" }, { id: "product", label: "Product" }]);

  const preview = await people.act({ action: "provision", email: "ana@acme.com", role: "finance", dryRun: true });
  assert.deepEqual(roleEnv(preview.objects!), { name: "DASHBOARD_ROLE", value: "finance" });
  await people.act({ action: "provision", email: "ana@acme.com", role: "finance" });
  assert.equal(roster().people["ana@acme.com"].role, "finance");
  assert.equal((await people.view()).rows.find((r) => r.email === "ana@acme.com")!.role, "finance");

  // Left to them (the default): no role in the roster, no DASHBOARD_ROLE.
  await people.act({ action: "provision", email: "bo@acme.com" });
  assert.equal("role" in roster().people["bo@acme.com"], false);
  assert.equal(roleEnv([state.statefulsets.find((s) => s.metadata.name === "dashboard-bo")]), undefined);

  await assert.rejects(people.act({ action: "provision", email: "cy@acme.com", role: "sales" }), /no role "sales" \(this workspace has finance, product\)/);
  await assert.rejects(people.act({ action: "role", email: "ana@acme.com", role: "sales" }), /no role "sales"/);
  assert.equal(roster().people["cy@acme.com"], undefined);

  // Changing it re-applies like a profile change, and a profile change keeps it.
  await people.act({ action: "start", email: "ana@acme.com" });
  await people.act({ action: "role", email: "ana@acme.com", role: "product" });
  let ana = state.statefulsets.find((s) => s.metadata.name === "dashboard-ana");
  assert.deepEqual(roleEnv([ana]), { name: "DASHBOARD_ROLE", value: "product" });
  assert.equal(ana.spec.replicas, 1, "running stays running");
  assert.equal(roster().people["ana@acme.com"].role, "product");
  await people.act({ action: "profile", email: "ana@acme.com", profile: "finance" });
  ana = state.statefulsets.find((s) => s.metadata.name === "dashboard-ana");
  assert.deepEqual(roleEnv([ana]), { name: "DASHBOARD_ROLE", value: "product" });
  // "" hands it back to them.
  await people.act({ action: "role", email: "ana@acme.com", role: "" });
  assert.equal(roleEnv([state.statefulsets.find((s) => s.metadata.name === "dashboard-ana")]), undefined);
  assert.equal("role" in roster().people["ana@acme.com"], false);
  assert.equal((await people.view()).rows.find((r) => r.email === "ana@acme.com")!.needsUpdate, false);

  // A workspace without roles has none to assign.
  const none = new People(root, { run, fetcher, configDir: cfg, roles: () => [] });
  await assert.rejects(none.act({ action: "role", email: "ana@acme.com", role: "finance" }), /no roles to assign/);
});

test("People: left, unmanaged and missing rows, and their actions", async () => {
  const { root, cfg } = workspace();
  const { run, fetcher, state, roster } = world(cfg);
  const people = new People(root, { run, fetcher, configDir: cfg });
  // Cy was set up, then suspended. Dee's dashboard was made by hand. Ed is in the roster but not on the cluster.
  await people.act({ action: "provision", email: "cy@acme.com" });
  state.statefulsets.push({ metadata: { name: "dashboard-dee", labels: { person: "dee" }, annotations: { "natterjack/owner": "dee@acme.com" } }, spec: { replicas: 1, serviceName: "dashboard-dee", volumeClaimTemplates: [{ metadata: { name: "data" } }] }, status: { readyReplicas: 1 } });
  const doc = roster();
  doc.people["ed@acme.com"] = { name: "Ed", slug: "ed", profile: "member", provisionedAt: "t", provisionedBy: "x" };
  fs.writeFileSync(path.join(cfg, "people.json"), JSON.stringify(doc));

  const states = Object.fromEntries((await people.view()).rows.map((r) => [r.email, r.state]));
  assert.equal(states["cy@acme.com"], "left");
  assert.equal(states["dee@acme.com"], "left", "not in the directory any more counts as left too");
  assert.equal(states["ed@acme.com"], "left");

  // With a manual directory nobody is "left": the roster and the cluster decide.
  fs.writeFileSync(path.join(cfg, "hosting.json"), JSON.stringify({ ...HOSTING, directory: { type: "manual" } }));
  const bump = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(cfg, "hosting.json"), bump, bump);
  const manual = Object.fromEntries((await people.view()).rows.map((r) => [r.email, r.state]));
  assert.deepEqual([manual["dee@acme.com"], manual["ed@acme.com"], manual["cy@acme.com"]], ["unmanaged", "missing", "stopped"]);

  await people.act({ action: "adopt", email: "dee@acme.com" });
  assert.equal(roster().people["dee@acme.com"].slug, "dee");
  await people.act({ action: "forget", email: "ed@acme.com" });
  assert.equal(roster().people["ed@acme.com"], undefined);

  const dry = await people.act({ action: "remove", email: "cy@acme.com", keepVolume: false, dryRun: true });
  assert.match(dry.output, /persistentvolumeclaim\/data-dashboard-cy-0/);
  await people.act({ action: "remove", email: "cy@acme.com", keepVolume: true });
  assert.ok(!state.statefulsets.some((s) => s.metadata.name === "dashboard-cy"));
  assert.ok(!state.calls.some((c) => c.includes("delete") && c.includes("persistentvolumeclaim")), "the volume was kept");
  assert.deepEqual(Object.keys(roster().people), ["dee@acme.com"]);
  // The page tells you what to commit; nothing's committed until you press Commit.
  const view = await people.view();
  assert.deepEqual(view.roster, { file: ".claude/dashboard/people.json", uncommitted: true, changes: ["Added dee@acme.com (member)"] });
  assert.equal(state.commits.length, 0);
  assert.equal((await people.commitRoster()).uncommitted, false);
  assert.equal(state.commits.length, 1);
});

test("People: a directory that can't be read still shows the roster and the cluster, with the error and its fix", async () => {
  const { root, cfg } = workspace();
  const { run: base, fetcher } = world(cfg);
  const run: Runner = async (name, args, opts) => (name === "gcloud" && args[0] === "auth" ? bad("ERROR: (gcloud.auth.application-default.print-access-token) Your default credentials were not found.") : base(name, args, opts));
  const people = new People(root, { run, fetcher, configDir: cfg });
  await people.act({ action: "provision", email: "bo@acme.com" });
  const view = await people.view(true);
  assert.equal(view.errors[0].source, "directory");
  assert.match(view.errors[0].fix!, /gcloud auth application-default login/);
  assert.deepEqual(view.rows.map((r) => [r.email, r.state, r.active]), [["bo@acme.com", "stopped", null]]);
});

// ------------------------------------------------------------------ Azure App Service

const APP_SERVICE = {
  ...HOSTING,
  platform: {
    type: "azure-app-service", resourceGroup: "dashboard-rg", template: "hosting/person.bicep", appName: "dash-{person}",
    parameters: { plan: "dashboard-asp", storageAccount: "confirmdashdata", registry: "confirmdashacr", image: "natterjack-dashboard:1", keyVault: "confirm-nj-kv", publicUrl: "https://natterjack.acme.com" },
  },
  areas: { company: { secret: "nj-area-company", env: "KNOWLEDGE_COMPANY_KEY" }, finance: { secret: "nj-area-finance", env: "KNOWLEDGE_FINANCE_KEY" } },
  profiles: {
    member: { name: "Member", areas: ["company"], maxConcurrentRuns: 3 },
    finance: { name: "Finance", areas: ["company", "finance"], maxConcurrentRuns: 1, parameters: { plan: "dashboard-asp-big" } },
  },
};

/** A fake `az` over a resource group of Web Apps (dash-luke set up by hand, as Confirm's was). */
function azWorld(cfg: string) {
  const { run: base, fetcher, roster } = world(cfg);
  const apps: Record<string, { state: string; tags: Record<string, string> }> = {
    "dash-luke": { state: "Running", tags: { owner: "luke@acme.com", purpose: "hosted-workspace-dashboard" } },
  };
  const resources: [string, string][] = [
    ["Microsoft.Web/serverFarms", "dashboard-asp"], ["Microsoft.Web/serverFarms", "dashboard-asp-big"], ["Microsoft.Storage/storageAccounts", "confirmdashdata"],
    ["Microsoft.ContainerRegistry/registries", "confirmdashacr"], ["Microsoft.KeyVault/vaults", "confirm-nj-kv"],
  ];
  const deployments: { whatIf: boolean; params: any; args: string[] }[] = [];
  const deleted: string[] = [];
  const run: Runner = async (name, args, opts) => {
    if (name !== "az") return base(name, args, opts);
    const a = args.join(" ");
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    if (a.startsWith("resource list")) return ok(JSON.stringify(resources.map(([type, name]) => ({ type, name }))));
    if (a.startsWith("webapp list")) return ok(JSON.stringify(Object.entries(apps).map(([n, x]) => ({ name: n, state: x.state, host: `${n}.azurewebsites.net`, tags: x.tags }))));
    if (a.startsWith("deployment group what-if") || a.startsWith("deployment group create")) {
      const params = Object.fromEntries(Object.entries<any>(JSON.parse(fs.readFileSync(arg("--parameters").slice(1), "utf-8")).parameters).map(([k, v]) => [k, v.value]));
      const whatIf = a.includes("what-if");
      deployments.push({ whatIf, params, args });
      if (whatIf) return ok(`\x1b[32mResource changes: 1 to create.\x1b[0m\n  + Microsoft.Web/sites/${params.appName}\n`);
      apps[params.appName] = { state: apps[params.appName]?.state || "Running", tags: { "natterjack-owner": params.email, "natterjack-person": params.person, "natterjack-profile": params.profile, "natterjack-applied": params.applied, "natterjack-share": params.appName, "natterjack-storage": params.storageAccount } };
      return ok("Succeeded\n");
    }
    if (a.startsWith("webapp start") || a.startsWith("webapp stop")) { apps[arg("--name")].state = a.startsWith("webapp start") ? "Running" : "Stopped"; return ok(); }
    if (a.startsWith("webapp delete")) { deleted.push(`app ${arg("--name")}`); delete apps[arg("--name")]; return ok(); }
    if (a.startsWith("storage share-rm delete")) { deleted.push(`share ${arg("--name")} in ${arg("--storage-account")}`); return ok(); }
    return bad(`unexpected: az ${a}`);
  };
  return { run, fetcher, roster, apps, deployments, deleted, resources };
}

function appServiceWorkspace() {
  const ws = workspace(APP_SERVICE);
  fs.writeFileSync(path.join(ws.root, "hosting", "person.bicep"), "param appName string\n");
  return ws;
}

function setHosting(cfg: string, hosting: object) {
  fs.writeFileSync(path.join(cfg, "hosting.json"), JSON.stringify(hosting));
  const bump = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(cfg, "hosting.json"), bump, bump);
}

test("hosting.json (App Service): needs a resource group, an appName with {person}, and env names for areas", () => {
  const problems = checkHosting({ ...APP_SERVICE, platform: { type: "azure-app-service", template: "x.bicep", appName: "dash" }, areas: { finance: { secret: "kv-fin" } } });
  for (const want of [/platform.resourceGroup/, /\{person\}/, /area "finance" needs "env".*KNOWLEDGE_FINANCE_KEY/]) assert.ok(problems.some((p) => want.test(p)), `${want}: ${problems.join(" | ")}`);
  assert.deepEqual(checkHosting(APP_SERVICE), []);
});

test("People (App Service): a hand-made Web App can be adopted; provision previews with what-if, then deploys", async () => {
  const { root, cfg } = appServiceWorkspace();
  const az = azWorld(cfg);
  const people = new People(root, { run: az.run, fetcher: az.fetcher, configDir: cfg });

  let view = await people.view();
  assert.deepEqual(view.errors, []);
  assert.equal(view.cluster, "resource group dashboard-rg");
  assert.equal(view.dataLabel, "file share");
  assert.equal(view.rows.find((r) => r.email === "luke@acme.com")!.state, "left", "not in the (fake) directory");

  setHosting(cfg, { ...APP_SERVICE, directory: { type: "manual" } });
  view = await people.view();
  const luke = view.rows.find((r) => r.email === "luke@acme.com")!;
  assert.deepEqual([luke.state, luke.slug], ["unmanaged", "luke"], "the slug comes from dash-{person}");

  await people.act({ action: "adopt", email: "luke@acme.com" });
  assert.equal(az.roster().people["luke@acme.com"].slug, "luke");
  view = await people.view();
  assert.deepEqual(view.rows.map((r) => [r.email, r.state, r.needsUpdate]), [["luke@acme.com", "running", true]], "adopted, but never deployed from the template");

  // Ana with the finance profile: what-if first (nothing changes), then the deployment.
  const preview = await people.act({ action: "provision", email: "ana@acme.com", profile: "finance", dryRun: true });
  assert.match(preview.output, /^Resource changes: 1 to create\./, "ANSI colours stripped");
  assert.equal(az.apps["dash-ana"], undefined);
  const p = az.deployments[0].params;
  assert.equal(p.appName, "dash-ana");
  assert.equal(p.email, "ana@acme.com");
  assert.equal(p.plan, "dashboard-asp-big", "the profile's parameters win over hosting.json's");
  assert.equal(p.storageAccount, "confirmdashdata");
  assert.equal(p.maxConcurrentRuns, 1);
  assert.equal("role" in p, false, "no role parameter unless one is assigned (older templates don't have it)");
  assert.deepEqual(p.areaSettings, [{ name: "KNOWLEDGE_COMPANY_KEY", secretName: "nj-area-company" }, { name: "KNOWLEDGE_FINANCE_KEY", secretName: "nj-area-finance" }]);
  assert.match(p.applied, /^[0-9a-f]{12}$/);
  assert.ok(az.deployments[0].whatIf);
  assert.ok(az.deployments[0].args.includes("dashboard-rg"));

  await people.act({ action: "provision", email: "ana@acme.com", profile: "finance" });
  assert.equal(az.apps["dash-ana"].tags["natterjack-owner"], "ana@acme.com");
  view = await people.view();
  const ana = view.rows.find((r) => r.email === "ana@acme.com")!;
  assert.deepEqual([ana.state, ana.profile, ana.needsUpdate], ["running", "finance", false]);

  // Updating Luke deploys onto his existing app (dash-luke), not a new one.
  await people.act({ action: "update", email: "luke@acme.com" });
  assert.equal(az.deployments.at(-1)!.params.appName, "dash-luke");
  assert.equal((await people.view()).rows.find((r) => r.email === "luke@acme.com")!.needsUpdate, false);
});

test("People (App Service): stop, start, and remove keeping or deleting the file share", async () => {
  const { root, cfg } = appServiceWorkspace();
  const az = azWorld(cfg);
  const people = new People(root, { run: az.run, fetcher: az.fetcher, configDir: cfg, roles: () => ROLES });
  await people.act({ action: "provision", email: "bo@acme.com", role: "finance" });
  assert.equal(az.deployments.at(-1)!.params.role, "finance", "the template turns it into DASHBOARD_ROLE");
  await people.act({ action: "stop", email: "bo@acme.com" });
  assert.equal(az.apps["dash-bo"].state, "Stopped");
  assert.equal((await people.view()).rows.find((r) => r.email === "bo@acme.com")!.state, "stopped");
  await people.act({ action: "start", email: "bo@acme.com" });
  assert.equal(az.apps["dash-bo"].state, "Running");

  const dry = await people.act({ action: "remove", email: "bo@acme.com", keepVolume: false, dryRun: true });
  assert.match(dry.output, /Web App dash-bo, file share dash-bo in confirmdashdata.*plan stays/);
  await people.act({ action: "remove", email: "bo@acme.com", keepVolume: false });
  assert.deepEqual(az.deleted, ["app dash-bo", "share dash-bo in confirmdashdata"]);
  assert.equal(az.roster().people["bo@acme.com"], undefined);
});

test("People (App Service): the file share is deleted from the account the app was deployed with, never a guessed one", async () => {
  const { root, cfg } = appServiceWorkspace();
  const hosting = { ...APP_SERVICE, profiles: { ...APP_SERVICE.profiles, finance: { ...APP_SERVICE.profiles.finance, parameters: { plan: "dashboard-asp-big", storageAccount: "financedata" } } } };
  setHosting(cfg, hosting);
  const az = azWorld(cfg);
  az.resources.push(["Microsoft.Storage/storageAccounts", "financedata"]);
  const people = new People(root, { run: az.run, fetcher: az.fetcher, configDir: cfg });

  await people.act({ action: "provision", email: "ana@acme.com", profile: "finance" });
  assert.equal(az.apps["dash-ana"].tags["natterjack-storage"], "financedata");
  await people.act({ action: "remove", email: "ana@acme.com", keepVolume: false });
  assert.deepEqual(az.deleted, ["app dash-ana", "share dash-ana in financedata"], "the profile's account, not hosting.json's");

  // dash-luke (set up by hand, no natterjack-storage tag) while a profile picks its own account: refuse rather than guess.
  await people.act({ action: "adopt", email: "luke@acme.com" });
  await assert.rejects(people.act({ action: "remove", email: "luke@acme.com", keepVolume: false, dryRun: true }), /Can't tell which storage account holds dash-luke's file share/);
  // Keeping the share needs no account.
  await people.act({ action: "remove", email: "luke@acme.com", keepVolume: true });
  assert.deepEqual(az.deleted.slice(2), ["app dash-luke"]);
});

test("People (App Service): a Key Vault (or plan, storage, registry) that doesn't exist yet stops the preview and the deployment before anything runs", async () => {
  const { root, cfg } = appServiceWorkspace();
  const az = azWorld(cfg);
  az.resources.splice(az.resources.findIndex(([t]) => t.endsWith("vaults")), 1);
  const people = new People(root, { run: az.run, fetcher: az.fetcher, configDir: cfg });
  for (const dryRun of [true, false]) {
    await assert.rejects(people.act({ action: "provision", email: "bo@acme.com", dryRun }), /Key Vault "confirm-nj-kv" \(keyVault\)\. Nothing was changed\./);
  }
  assert.equal(az.deployments.length, 0, "no what-if and no deployment ran");
  assert.equal(az.apps["dash-bo"], undefined);
});

test("parseJsonStream: kubectl's one-document-per-object output, braces inside strings, a List, and junk", () => {
  const two = `{\n    "kind": "StatefulSet",\n    "x": "a } { \\" quoted"\n}\n{\n    "kind": "Service"\n}\n`;
  assert.deepEqual(parseJsonStream(two, "t").map((d) => d.kind), ["StatefulSet", "Service"]);
  assert.equal(parseJsonStream(two, "t")[0].x, 'a } { " quoted');
  assert.deepEqual(parseJsonStream(`{"kind":"List","items":[{"kind":"Service"}]}`, "t")[0].items, [{ kind: "Service" }]);
  assert.throws(() => parseJsonStream("error: something went wrong", "t"), /didn't return JSON/);
  assert.throws(() => parseJsonStream(`{"kind": "StatefulSet"`, "t"), /didn't return JSON/);
  assert.throws(() => parseJsonStream("", "t"), /didn't return JSON/);
  assert.throws(() => parseJsonStream(`{} "unterminated`, "t"), /didn't return JSON/);
  assert.throws(() => parseJsonStream(`"ignored" {}`, "t"), /didn't return JSON/);
});

// Knowledge: the vault parser (frontmatter, links, tags, backlinks, freshness), the
// bucket adapters against a fake S3 / Azure server (deep listing, ETag-guarded writes),
// and the store flow (sync, save, conflicts, rename, delete, review, Claude access).
// config.ts reads WORKSPACE_ROOT and DASHBOARD_LEDGER_DIR at import.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dash-kb-"));
const CFG = path.join(ROOT, ".claude", "dashboard");
const LEDGER = path.join(ROOT, ".claude", "ledger");
fs.mkdirSync(CFG, { recursive: true });
process.env.WORKSPACE_ROOT = ROOT;
process.env.DASHBOARD_LEDGER_DIR = LEDGER;

const notes = await import("../src/knowledge/notes.ts");
const { createStore, StoreConflict } = await import("../src/knowledge/store.ts");
const { Knowledge } = await import("../src/knowledge/index.ts");

// ------------------------------------------------------------------ the vault parser

test("parseFrontmatter: scalars, [a, b] lists, block lists, quotes; first key wins; no frontmatter", () => {
  const fm = notes.parseFrontmatter("---\ntitle: \"Refunds\"\nowner: Dana\ntags: [billing, policy]\naliases:\n  - money back\n  - returns\nowner: Other\n---\n# Body\n");
  assert.deepEqual(fm.data, { title: "Refunds", owner: "Dana", tags: ["billing", "policy"], aliases: ["money back", "returns"] });
  assert.equal(fm.body, "# Body\n");
  assert.equal(notes.parseFrontmatter("# Just text").present, false);
  assert.deepEqual(notes.fmList({ tags: "a, b" }, "tags"), ["a", "b"]);
});

test("setFrontmatter: replaces a field (and its block list), adds one, or adds frontmatter", () => {
  assert.equal(notes.setFrontmatter("---\nowner: Dana\nreviewed: 2024-01-01\n---\nBody", "reviewed", "2026-10-03"), "---\nowner: Dana\nreviewed: 2026-10-03\n---\nBody");
  assert.equal(notes.setFrontmatter("---\nowner: Dana\n---\nBody", "reviewed", "2026-10-03"), "---\nowner: Dana\nreviewed: 2026-10-03\n---\nBody");
  assert.equal(notes.setFrontmatter("---\ntags:\n  - a\n  - b\nx: 1\n---\nB", "tags", "[c]"), "---\ntags: [c]\nx: 1\n---\nB");
  assert.equal(notes.setFrontmatter("Body", "reviewed", "2026-10-03"), "---\nreviewed: 2026-10-03\n---\n\nBody");
});

test("extractLinks and extractTags: wikilinks with alias and heading, .md links, nothing inside code", () => {
  const body = "See [[Refund policy|refunds]] and [[pricing#Tiers]] and [the plan](../plans/q4.md#goals).\n`[[not a link]]` #billing #2024 ## Heading\n```\n[[nope]] #nope\n```\n![[diagram.png]] [site](https://x.dev/a.md) #Team/Ops";
  assert.deepEqual(notes.extractLinks(body).map((l) => [l.target, l.heading, l.alias, l.wiki]), [
    ["Refund policy", null, "refunds", true], ["pricing", "Tiers", null, true], ["diagram.png", null, null, true], ["../plans/q4.md", "goals", "the plan", false],
  ]);
  assert.deepEqual(notes.extractTags(body, { tags: ["Policy"] }), ["billing", "policy", "team/ops"]);
});

test("resolveLink: paths, bare names (same folder first, then shortest), relative .md links", () => {
  const rels = ["Company/Mission.md", "Finance/Refund policy.md", "Finance/old/Refund policy.md", "Sales/pricing.md", "plans/q4.md", "Sales/notes/call.md"];
  const L = (target: string, wiki = true) => ({ target, heading: null, alias: null, wiki });
  assert.equal(notes.resolveLink(L("refund policy"), "Company/Mission.md", rels), "Finance/Refund policy.md");
  assert.equal(notes.resolveLink(L("Refund policy"), "Finance/old/x.md", rels), "Finance/old/Refund policy.md");
  assert.equal(notes.resolveLink(L("Sales/pricing"), "Company/Mission.md", rels), "Sales/pricing.md");
  assert.equal(notes.resolveLink(L("../../plans/q4.md", false), "Sales/notes/call.md", rels), "plans/q4.md");
  assert.equal(notes.resolveLink(L("Missing"), "Company/Mission.md", rels), null);
  assert.equal(notes.resolveLink(L(""), "Company/Mission.md", rels), "Company/Mission.md");
});

test("NotesIndex: titles, owners, backlinks, unresolved links, summaries; re-reads only what changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-vault-"));
  fs.mkdirSync(path.join(dir, "Company"));
  fs.mkdirSync(path.join(dir, ".obsidian"));
  fs.writeFileSync(path.join(dir, ".obsidian", "x.md"), "ignored");
  fs.writeFileSync(path.join(dir, "Company", "Mission.md"), "---\nowner: CEO\nreviewed: 2026-01-15\ntags: [company]\n---\n# Our mission\n\nWe make [[Goals|goals]] real. See [[Nowhere]].\n");
  fs.writeFileSync(path.join(dir, "Goals.md"), "Quarterly goals, linked from the [mission](Company/Mission.md). #okr\n");
  const idx = new notes.NotesIndex(dir);
  const list = idx.notes();
  const by = Object.fromEntries(list.map((n) => [n.rel, n]));
  assert.deepEqual(Object.keys(by), ["Company/Mission.md", "Goals.md"]);
  assert.equal(by["Company/Mission.md"].title, "Our mission");
  assert.equal(by["Company/Mission.md"].owner, "CEO");
  assert.equal(by["Company/Mission.md"].reviewed, "2026-01-15");
  assert.deepEqual(by["Company/Mission.md"].links, ["Goals.md"]);
  assert.deepEqual(by["Company/Mission.md"].unresolved, ["Nowhere"]);
  assert.deepEqual(by["Goals.md"].backlinks, ["Company/Mission.md"]);
  assert.deepEqual(by["Goals.md"].links, ["Company/Mission.md"]);
  assert.equal(by["Goals.md"].title, "Goals");
  assert.match(by["Goals.md"].summary, /^Quarterly goals, linked from the mission/);
  assert.equal(idx.notes(), list, "nothing changed: the same result");
});

test("freshness: reviewed date (else last change) against the interval", () => {
  const now = Date.parse("2026-10-03T00:00:00Z");
  assert.deepEqual(notes.freshness({ reviewed: "2026-01-01", updatedAt: "2026-09-30T00:00:00Z" }, 90, now), { since: "2026-01-01", dueAt: "2026-04-01", stale: true });
  assert.equal(notes.freshness({ reviewed: null, updatedAt: "2026-09-30T00:00:00Z" }, 90, now).stale, false);
  assert.equal(notes.freshness({ reviewed: "2020-01-01", updatedAt: null }, null, now).stale, false, "no interval, never stale");
});

// ------------------------------------------------------------------ a fake bucket (S3 and Azure dialects)

interface Obj { body: Buffer; etag: string; at: string }
function fakeBucket() {
  const objects = new Map<string, Obj>();
  const calls: string[] = [];
  const put = (name: string, body: Buffer) => { const o = { body, etag: crypto.createHash("md5").update(body).digest("hex") + objects.size, at: new Date().toISOString() }; objects.set(name, o); return o; };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const azure = u.pathname.startsWith("/azure/");
    if (!azure && !req.headers.authorization) { res.writeHead(403); return res.end(); }
    if (azure && !u.searchParams.get("sig")) { res.writeHead(403); return res.end(); }
    const parts = u.pathname.split("/").slice(2).map(decodeURIComponent); // drop "" and s3|azure
    const name = parts.slice(1).join("/"); // after the bucket / container
    calls.push(`${req.method} ${name || "(list)"}`);
    const xml = (s: string) => { res.writeHead(200, { "content-type": "application/xml" }); res.end(s); };
    if (req.method === "GET" && !name) {
      const prefix = u.searchParams.get("prefix") || "";
      const list = [...objects].filter(([k]) => k.startsWith(prefix));
      if (azure) return xml(`<EnumerationResults><Blobs>${list.map(([k, o]) => `<Blob><Name>${k.replace(/&/g, "&amp;")}</Name><Properties><Last-Modified>${new Date(o.at).toUTCString()}</Last-Modified><Etag>"${o.etag}"</Etag><Content-Length>${o.body.length}</Content-Length></Properties></Blob>`).join("")}</Blobs><NextMarker/></EnumerationResults>`);
      return xml(`<ListBucketResult><IsTruncated>false</IsTruncated>${list.map(([k, o]) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>${o.at}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size></Contents>`).join("")}</ListBucketResult>`);
    }
    const cur = objects.get(name);
    const ifMatch = String(req.headers["if-match"] || "").replace(/"/g, "");
    const ifNone = req.headers["if-none-match"] === "*";
    if (req.method === "GET" || req.method === "HEAD") {
      if (!cur) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { etag: `"${cur.etag}"` });
      return res.end(req.method === "GET" ? cur.body : undefined);
    }
    if (req.method === "PUT") {
      if ((ifMatch && (!cur || cur.etag !== ifMatch)) || (ifNone && cur)) { res.writeHead(412); return res.end(); }
      const o = put(name, body);
      res.writeHead(azure ? 201 : 200, { etag: `"${o.etag}"` });
      return res.end();
    }
    if (req.method === "DELETE") {
      if (ifMatch && cur && cur.etag !== ifMatch) { res.writeHead(412); return res.end(); }
      objects.delete(name);
      res.writeHead(azure ? 202 : 204);
      return res.end();
    }
    res.writeHead(405); res.end();
  });
  return { objects, calls, put, server };
}

const bucket = fakeBucket();
await new Promise<void>((r) => bucket.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(bucket.server.address() as any).port}`;
after(() => bucket.server.close());

for (const kind of ["s3", "azure-blob"] as const) {
  test(`${kind} store: deep listing, read, guarded writes, delete`, async () => {
    const cfg = kind === "s3" ? { type: "s3", bucket: "kbase", region: "us-east-1", endpoint: `${base}/s3`, prefix: "t1" } : { type: "azure-blob", account: "acct", container: "kbase", endpoint: `${base}/azure`, prefix: "t2" };
    const p = kind === "s3" ? "t1/" : "t2/";
    bucket.put(`${p}Finance/Refunds & returns.md`, Buffer.from("# Refunds"));
    bucket.put(`${p}top.md`, Buffer.from("top"));
    bucket.put(`${p}Finance/`, Buffer.from(""));
    bucket.put("other/x.md", Buffer.from("not ours"));
    const store = createStore(cfg, { key: `t-${kind}`, name: "T" }, LEDGER);
    assert.equal(store.status().connected, false);
    await assert.rejects(store.list(), /Connect first/);
    await store.connect(kind === "s3" ? "AKID:secret" : "?sv=1&sig=abc");
    assert.equal(store.status().connected, true);
    const list = await store.list();
    assert.deepEqual(list.map((o) => o.name).sort(), ["Finance/Refunds & returns.md", "top.md"]);
    const got = await store.get("Finance/Refunds & returns.md");
    assert.equal(got.body.toString(), "# Refunds");
    assert.equal(got.etag, list.find((o) => o.name === "Finance/Refunds & returns.md")!.etag);
    const tag = await store.put("Finance/Refunds & returns.md", Buffer.from("# Refunds v2"), { ifMatch: got.etag });
    await assert.rejects(store.put("Finance/Refunds & returns.md", Buffer.from("stale"), { ifMatch: got.etag }), StoreConflict);
    await assert.rejects(store.put("top.md", Buffer.from("x"), { ifNoneMatch: true }), StoreConflict);
    await store.put("new/note.md", Buffer.from("new"), { ifNoneMatch: true });
    await store.remove("new/note.md", undefined);
    assert.ok(!bucket.objects.has(`${p}new/note.md`));
    assert.equal((await store.get("Finance/Refunds & returns.md")).etag, tag);
    await assert.rejects(store.get("../escape.md"), /Invalid file name/);
    store.disconnect();
    assert.equal(store.status().connected, false);
  });
}

test("a store config that can't work says what's wrong", () => {
  assert.match(createStore({ type: "dropbox" }, { key: "x", name: "X" }, LEDGER).status().problem!, /s3, gcs or azure-blob/);
  assert.match(createStore({ type: "s3" }, { key: "x", name: "X" }, LEDGER).status().problem!, /bucket/);
  assert.equal(createStore({ type: "gcs", bucket: "acme-kb" }, { key: "x", name: "X" }, LEDGER).label, "Google Cloud Storage");
});

// ------------------------------------------------------------------ the store flow

let bump = 10;
function writeDocs(data: unknown) {
  const f = path.join(CFG, "docs.json");
  fs.writeFileSync(f, JSON.stringify(data));
  const t = new Date(Date.now() + 1000 * bump++);
  fs.utimesSync(f, t, t);
}

test("Knowledge: sync, notes with freshness, save with conflicts, rename, delete, mark reviewed, run access, Claude access", async () => {
  writeDocs({
    areas: [{ key: "finance", label: "Finance", owner: "CFO", reviewEvery: 90 }],
    sources: [{ key: "fin", name: "Finance notes", kind: "store", area: "finance", store: { type: "s3", bucket: "kbase", endpoint: `${base}/s3`, prefix: "fin" } }],
  });
  bucket.put("fin/Month-end close.md", Buffer.from("---\nowner: Dana\nreviewed: 2020-01-01\n---\n# Month-end close\n\nSteps, see [[Refunds]].\n"));
  bucket.put("fin/Policies/Refunds.md", Buffer.from("# Refunds\n\nWithin 30 days. #policy\n"));
  bucket.put("fin/Policies/chart.png", Buffer.from("png"));
  bucket.put("fin/.obsidian/workspace.json", Buffer.from("{}"));
  const kb = new Knowledge(ROOT, LEDGER);
  assert.equal(kb.storeStatus("fin").connected, false);
  await kb.connect("fin", "AKID:secret");
  const st = kb.storeStatus("fin");
  assert.equal(st.connected, true);
  assert.equal(st.files, 3, "notes and images; dot folders skipped");
  assert.ok(fs.existsSync(path.join(LEDGER, "knowledge", "fin", "files", "Policies", "chart.png")));
  const index = fs.readFileSync(path.join(LEDGER, "knowledge", "fin", "INDEX.md"), "utf-8");
  assert.match(index, /files\/Month-end close\.md: Month-end close \(owner: Dana\)/);
  assert.match(index, /files\/Policies\/Refunds\.md: Refunds \[#policy\]/);

  const list = kb.notesWithFreshness("fin");
  const close = list.find((n) => n.rel === "Month-end close.md")!;
  assert.equal(close.stale, true);
  assert.deepEqual(close.links, ["Policies/Refunds.md"]);
  assert.deepEqual(list.find((n) => n.rel === "Policies/Refunds.md")!.backlinks, ["Month-end close.md"]);
  assert.deepEqual(kb.staleCounts(), { fin: 1 });

  // Edit: the ETag from reading must still match.
  const note = kb.read("fin", "Policies/Refunds.md");
  assert.equal(note.editable, true);
  const saved = await kb.save("fin", "Policies/Refunds.md", "# Refunds\n\nWithin 60 days.\n", note.etag);
  assert.match(fs.readFileSync(path.join(LEDGER, "knowledge", "fin", "files", "Policies", "Refunds.md"), "utf-8"), /60 days/);
  bucket.put("fin/Policies/Refunds.md", Buffer.from("# Refunds\n\nSomeone else's edit.\n"));
  await assert.rejects(kb.save("fin", "Policies/Refunds.md", "mine", saved.etag), (e: any) => e.status === 409 && /changed by someone else/.test(e.message));
  await assert.rejects(kb.save("fin", "Month-end close", "dup", null), (e: any) => e.status === 409 && /already a note/.test(e.message));

  // New, rename, delete.
  await kb.save("fin", "Drafts/Budget", "# Budget 2027\n", null);
  assert.ok(bucket.objects.has("fin/Drafts/Budget.md"));
  const moved = await kb.rename("fin", "Drafts/Budget.md", "Budget 2027.md", kb.read("fin", "Drafts/Budget.md").etag);
  assert.ok(bucket.objects.has("fin/Budget 2027.md") && !bucket.objects.has("fin/Drafts/Budget.md"));
  assert.ok(!fs.existsSync(path.join(LEDGER, "knowledge", "fin", "files", "Drafts")), "empty folders go");
  await kb.remove("fin", "Budget 2027.md", moved.etag);
  assert.ok(!bucket.objects.has("fin/Budget 2027.md"));

  // Mark reviewed writes the frontmatter through the bucket.
  await kb.markReviewed("fin", "Month-end close.md", "2026-10-03");
  assert.match(bucket.objects.get("fin/Month-end close.md")!.body.toString(), /reviewed: 2026-10-03/);
  assert.equal(kb.notesWithFreshness("fin").find((n) => n.rel === "Month-end close.md")!.stale, false);

  // Deleted in the bucket by someone else: the next sync drops our copy.
  bucket.objects.delete("fin/Policies/chart.png");
  await kb.sync("fin", true);
  assert.ok(!fs.existsSync(path.join(LEDGER, "knowledge", "fin", "files", "Policies", "chart.png")));

  // Claude: a run gets the folder and a note; a person's sessions get additionalDirectories.
  const access = kb.runAccess(["fin"]);
  assert.deepEqual(access.addDirs, [path.join(LEDGER, "knowledge", "fin")]);
  assert.match(access.note!, /INDEX\.md lists every note/);
  kb.setClaudeAccess("fin", true);
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude", "settings.local.json"), "utf-8"));
  assert.deepEqual(settings.permissions.additionalDirectories, [path.join(LEDGER, "knowledge", "fin")]);
  assert.equal(kb.storeStatus("fin").claudeAccess, true);
  kb.setClaudeAccess("fin", false);
  assert.equal(kb.storeStatus("fin").claudeAccess, false);

  await assert.rejects(kb.save("fin", "../escape", "x", null), /Invalid file name/);
});

test("repo notes: read-only here, and Mark reviewed edits the file", async () => {
  fs.mkdirSync(path.join(ROOT, "handbook"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "handbook", "Onboarding.md"), "# Onboarding\n");
  writeDocs({ sources: [{ key: "hb", name: "Handbook", kind: "notes", dir: "handbook" }] });
  const kb = new Knowledge(ROOT, LEDGER);
  assert.equal(kb.read("hb", "Onboarding.md").editable, false);
  await assert.rejects(kb.save("hb", "Onboarding.md", "x", null), /edited in its repo/);
  await kb.markReviewed("hb", "Onboarding.md", "2026-10-03");
  assert.equal(fs.readFileSync(path.join(ROOT, "handbook", "Onboarding.md"), "utf-8"), "---\nreviewed: 2026-10-03\n---\n\n# Onboarding\n");
});

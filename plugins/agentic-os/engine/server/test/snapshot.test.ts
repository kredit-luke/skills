// Snapshots: the tar and zip extractors, publish → download → update through a source,
// installing a whole workspace, and the http and Confluence adapters against local fake
// servers (the object stores are in object-stores.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { extractTarGz, safeMemberPath } from "../src/tar.ts";
import { archiveName, buildSnapshot, carryOver, downloadStep, downloadTargets, dropManifestCache, INSTALLING, installWorkspace, isInstalling, planSnapshot, publishSnapshot, readStamp, snapshotStatus } from "../src/snapshot.ts";
import { extractZip } from "../src/zip.ts";
import { repoState, readRepos } from "../src/repos.ts";
import { createSource, snapshotSourceKinds } from "../src/snapshot-sources/index.ts";
import type { SnapshotFile, SnapshotSource } from "../src/snapshot-sources/index.ts";
import { ConfluenceSource } from "../src/snapshot-sources/confluence.ts";
import { installerName, renderInstaller } from "../src/installer.ts";
import { MANIFEST } from "../src/snapshot-sources/manifest.ts";

const scratch = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `dash-snap-${name}-`));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim();
const ctx = (dir: string) => ({ ledgerDir: dir, issues: { kind: "none" } });

function repo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "c");
  return git(dir, "rev-parse", "HEAD");
}

/** A tar header block for a crafted archive. */
function header(name: string, size: number, type = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257); h.write("00", 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const block = (text: string) => { const b = Buffer.alloc(Math.ceil(text.length / 512) * 512); b.write(text); return b; };
const tgz = (file: string, parts: Buffer[]) => fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));

test("tar: git archive output (nested, long pax names, empty files) extracts byte-for-byte", async () => {
  const src = scratch("tar-src");
  const long = "deep/" + "a".repeat(60) + "/" + "b".repeat(60) + "/file.txt";
  repo(src, { "README.md": "hello\n", "src/x/y.ts": "export const y = 1;\n", [long]: "long\n", "empty.txt": "", "bin.dat": "\x00\x01\x02\xff" });
  const archive = path.join(scratch("tar-a"), "r.tar.gz");
  git(src, "-c", "core.autocrlf=false", "archive", "--format=tar.gz", "-o", archive, "HEAD");
  const out = scratch("tar-out");
  const r = await extractTarGz(archive, out);
  assert.equal(r.files, 5);
  for (const f of ["README.md", "src/x/y.ts", long, "empty.txt", "bin.dat"]) assert.deepEqual(fs.readFileSync(path.join(out, f)), fs.readFileSync(path.join(src, f)), f);
  assert.ok(!fs.existsSync(path.join(out, "pax_global_header")), "git's global pax header isn't a file");
});

test("tar: an entry leaving the folder fails the extraction; links are skipped", async () => {
  for (const bad of ["../evil.txt", "/etc/evil", "a/../../evil", "C:/evil"]) assert.equal(safeMemberPath(bad), null, bad);
  const dir = scratch("tar-bad");
  const evil = path.join(dir, "evil.tar.gz");
  tgz(evil, [header("ok.txt", 2), block("ok"), header("../evil.txt", 4), block("evil")]);
  await assert.rejects(extractTarGz(evil, path.join(dir, "out")), /outside the target folder/);
  assert.ok(!fs.existsSync(path.join(dir, "evil.txt")));

  const links = path.join(dir, "links.tar.gz");
  const lh = header("link", 0, "2"); lh.write("/etc/passwd", 157, 100);
  let sum = 0; lh.write("        ", 148); for (const b of lh) sum += b; lh.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  tgz(links, [lh, header("real.txt", 3), block("yes")]);
  const r = await extractTarGz(links, path.join(dir, "out2"));
  assert.equal(r.skipped, 1);
  assert.equal(fs.readFileSync(path.join(dir, "out2", "real.txt"), "utf-8"), "yes");
  assert.ok(!fs.existsSync(path.join(dir, "out2", "link")));

  const corrupt = path.join(dir, "corrupt.tar.gz");
  const h = header("x.txt", 1); h[0] = 0x79; // checksum no longer matches
  tgz(corrupt, [h, block("x")]);
  await assert.rejects(extractTarGz(corrupt, path.join(dir, "out3")), /checksum/);
});

/** A source backed by a folder: upload copies in, download copies out; it remembers the order of uploads and removals. */
function folderSource(dir: string): SnapshotSource & { uploads: string[]; log: string[] } {
  fs.mkdirSync(dir, { recursive: true });
  const uploads: string[] = [];
  const log: string[] = [];
  return {
    kind: "folder", label: "Folder", maxFileBytes: null, uploads, log,
    remove: async (f) => { log.push(`remove ${f.name}`); fs.unlinkSync(path.join(dir, f.name)); },
    status: () => ({ connected: true, source: null, viewer: null }),
    connectHelp: () => null, connect: async () => ({ connected: true, source: null, viewer: null }), disconnect: () => ({ connected: true, source: null, viewer: null }),
    list: async () => fs.readdirSync(dir).map((n): SnapshotFile => ({ id: n, name: n, size: fs.statSync(path.join(dir, n)).size, updatedAt: null })),
    download: async (f, dest) => fs.copyFileSync(path.join(dir, f.name), dest),
    upload: async (name, src) => { uploads.push(name); log.push(`upload ${name}`); fs.copyFileSync(src, path.join(dir, name)); },
  };
}

/** An upstream repo (what origin has) and a clone of it at dest; returns the upstream's commit. */
function cloned(up: string, dest: string, files: Record<string, string>): string {
  const sha = repo(up, files);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync("git", ["clone", "-q", up, dest], { stdio: "pipe" });
  return sha;
}

test("publish → download → update: stamps, manifest last, left-out and foreign folders untouched", async () => {
  // Publisher side: a workspace (itself a clone) with two repos and one left out, all cloned from upstreams.
  const ups = scratch("ups");
  const reposJson = { snapshot: { source: "folder" }, repos: [
    { name: "api", relativePath: "svc/api" }, { name: "web" }, { name: "infra", snapshot: false },
  ] };
  const pub = path.join(scratch("pubroot"), "ws");
  cloned(path.join(ups, "ws"), pub, { "repos.json": JSON.stringify(reposJson), ".gitignore": "svc/\nweb/\ninfra/\n" });
  const shaApi1 = cloned(path.join(ups, "api"), path.join(pub, "svc", "api"), { "main.go": "v1\n" });
  cloned(path.join(ups, "web"), path.join(pub, "web"), { "index.html": "<h1>web</h1>\n" });
  cloned(path.join(ups, "infra"), path.join(pub, "infra"), { "secret.tf": "nope\n" });
  const store = folderSource(scratch("store"));
  const out1 = scratch("out1");
  const m1 = await buildSnapshot(pub, out1);
  assert.deepEqual(Object.keys(m1.repos).sort(), ["api", "web"], "infra is left out");
  assert.equal(m1.repos.api.sha, shaApi1);
  assert.ok(m1.workspace && /^workspace-[0-9a-f]{12}.zip$/.test(m1.workspace.file) && fs.existsSync(path.join(out1, m1.workspace.file)));
  assert.match(m1.repos.api.file, /^api-[0-9a-f]{12}.tar.gz$/, "archive names carry the commit");
  await publishSnapshot(store, out1, m1);
  assert.equal(store.uploads.at(-1), MANIFEST, "the manifest goes up last");

  // Reader side: the same repos.json, nothing cloned; a folder of someone else's where "web" would go.
  const rd = scratch("reader");
  fs.writeFileSync(path.join(rd, "repos.json"), JSON.stringify(reposJson));
  dropManifestCache();
  let st = await snapshotStatus(rd, store, true);
  assert.equal(st.builtAt, m1.builtAt);
  assert.deepEqual(st.repos.map((r) => [r.name, r.needsDownload]), [["api", true], ["web", true], ["infra", false]]);
  fs.mkdirSync(path.join(rd, "web"));
  fs.writeFileSync(path.join(rd, "web", "mine.txt"), "keep");
  const targets = await downloadTargets(rd, store, null);
  assert.deepEqual(targets.map((t) => t.repo.name), ["api"], "a folder with files and no stamp isn't ours");
  const lines: string[] = [];
  await downloadStep(rd, store, targets[0])((t) => lines.push(t));
  assert.equal(repoState(rd, "svc/api"), "snapshot");
  assert.equal(fs.readFileSync(path.join(rd, "svc", "api", "main.go"), "utf-8"), "v1\n");
  assert.equal(readStamp(path.join(rd, "svc", "api"))!.sha, shaApi1);
  assert.equal(fs.readFileSync(path.join(rd, "web", "mine.txt"), "utf-8"), "keep");
  assert.equal((await downloadTargets(rd, store, null)).length, 0, "up to date");

  // A new commit lands on origin and is published (fetched, not pulled): the copy is replaced as a whole.
  fs.writeFileSync(path.join(rd, "svc", "api", "scratch.txt"), "local edit");
  fs.writeFileSync(path.join(ups, "api", "main.go"), "v2\n");
  git(path.join(ups, "api"), "commit", "-qam", "v2");
  const out2 = scratch("out2");
  const m2 = await buildSnapshot(pub, out2);
  assert.equal(m2.repos.api.sha, git(path.join(ups, "api"), "rev-parse", "HEAD"));
  assert.notEqual(m2.repos.api.file, m1.repos.api.file, "a new commit is a new file, not an overwrite");
  store.log.length = 0;
  await publishSnapshot(store, out2, m2);
  // The old api archive goes only after the new manifest is up; unchanged files (web, workspace) stay.
  assert.deepEqual(store.log.filter((l) => l.startsWith("remove")), [`remove ${m1.repos.api.file}`]);
  assert.ok(store.log.indexOf(`upload ${MANIFEST}`) < store.log.indexOf(`remove ${m1.repos.api.file}`));
  assert.equal(m2.repos.web.file, m1.repos.web.file);
  st = await snapshotStatus(rd, store, true);
  assert.equal(st.repos.find((r) => r.name === "api")!.needsDownload, true);
  const [t2] = await downloadTargets(rd, store, ["api"]);
  await downloadStep(rd, store, t2)(() => {});
  assert.equal(fs.readFileSync(path.join(rd, "svc", "api", "main.go"), "utf-8"), "v2\n");
  assert.ok(!fs.existsSync(path.join(rd, "svc", "api", "scratch.txt")));
  assert.deepEqual(fs.readdirSync(path.join(rd, "svc")), ["api"], "no staging or old copies left behind");

  // A clone is never replaced, even when it's behind.
  const withClone = scratch("with-clone");
  fs.writeFileSync(path.join(withClone, "repos.json"), JSON.stringify(reposJson));
  fs.mkdirSync(path.join(withClone, "svc", "api", ".git"), { recursive: true });
  assert.deepEqual((await downloadTargets(withClone, store, null)).map((t) => t.repo.name), ["web"]);
});

test("publish refuses a file over the source's limit, and repos that aren't cloned", async () => {
  const pub = scratch("big");
  cloned(path.join(scratch("bigup"), "api"), path.join(pub, "api"), { "big.bin": "x".repeat(5000) });
  fs.writeFileSync(path.join(pub, "repos.json"), JSON.stringify({ repos: [{ name: "api" }, { name: "gone" }] }));
  await assert.rejects(buildSnapshot(pub, scratch("o")), /gone \(gone\): not cloned here/);
  fs.writeFileSync(path.join(pub, "repos.json"), JSON.stringify({ repos: [{ name: "api" }] }));
  const out = scratch("o2");
  const m = await buildSnapshot(pub, out, { workspace: false });
  const small = { ...folderSource(scratch("s")), maxFileBytes: 10 };
  await assert.rejects(publishSnapshot(small, out, m), /Over the Folder limit/);
  assert.deepEqual(small.uploads, [], "nothing goes up when one file is too big");
});

test("publish takes origin's default branch, never the clone's work branch or local changes", async () => {
  const ups = scratch("wb-up");
  const pub = scratch("wb");
  const shaMain = cloned(path.join(ups, "api"), path.join(pub, "api"), { "main.go": "released\n" });
  const dir = path.join(pub, "api");
  git(dir, "checkout", "-q", "-b", "feature/x");
  fs.writeFileSync(path.join(dir, "main.go"), "work in progress\n");
  git(dir, "commit", "-qam", "wip (not pushed)");
  fs.writeFileSync(path.join(dir, "main.go"), "uncommitted\n");
  // origin moved on after the clone: the plan fetches it.
  fs.writeFileSync(path.join(ups, "api", "NEW.md"), "new\n");
  git(path.join(ups, "api"), "add", ".");
  git(path.join(ups, "api"), "commit", "-qm", "released v2");
  const shaV2 = git(path.join(ups, "api"), "rev-parse", "HEAD");
  assert.notEqual(shaV2, shaMain);
  // A repo without an origin can't have a default branch to publish.
  repo(path.join(pub, "local-only"), { "x.txt": "x\n" });
  fs.writeFileSync(path.join(pub, "repos.json"), JSON.stringify({ repos: [{ name: "api" }, { name: "local-only" }, { name: "gone" }] }));

  await assert.rejects(planSnapshot(pub), /local-only \(local-only\): it has no origin remote/);
  const plan = await planSnapshot(pub, { allowMissing: true, workspace: false });
  assert.deepEqual(plan.repos.map((t) => [t.name, t.branch, t.sha, t.subject]), [["api", "main", shaV2, "released v2"]]);
  assert.deepEqual(plan.skipped, [{ name: "local-only", reason: "it has no origin remote" }, { name: "gone", reason: "not cloned here" }]);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "feature/x", "the clone's own checkout is left alone");

  const out = scratch("wb-out");
  const m = await buildSnapshot(pub, out, { plan });
  const x = scratch("wb-x");
  await extractTarGz(path.join(out, m.repos.api.file), x);
  assert.equal(fs.readFileSync(path.join(x, "main.go"), "utf-8"), "released\n");
  assert.ok(fs.existsSync(path.join(x, "NEW.md")));

  // A partial publish keeps the last published copy of what it skipped, when that file is still there.
  const previous = { version: 1 as const, builtAt: "2026-01-01T00:00:00Z", repos: { gone: { file: "gone.tar.gz", sha: "abc", size: 3, builtAt: "2026-01-01T00:00:00Z" }, "local-only": { file: "local-only.tar.gz", sha: "def", size: 3, builtAt: "2026-01-01T00:00:00Z" } }, workspace: null };
  const kept = carryOver(m, previous, [{ id: "1", name: "gone.tar.gz", size: 3, updatedAt: null }], ["gone", "local-only"]);
  assert.deepEqual(kept, ["gone"], "local-only's file isn't at the source any more");
  assert.equal(m.repos.gone.sha, "abc");
  const store = folderSource(scratch("wb-store"));
  await publishSnapshot(store, out, m);
  assert.deepEqual(store.uploads, [m.repos.api.file, MANIFEST], "a carried-over file isn't uploaded again");
});

async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("http source: files come from the manifest, the bearer key is checked on connect and sent on download", async () => {
  assert.deepEqual(snapshotSourceKinds().sort(), ["azure-blob", "confluence", "http", "s3"]);
  assert.throws(() => createSource({ source: "nope" }, ctx(scratch("x"))), /isn't supported \(known: confluence, http, azure-blob, s3\)/);
  const manifest = { version: 1, builtAt: "2026-01-01T00:00:00Z", repos: { api: { file: "api.tar.gz", sha: "abc", size: 3, builtAt: "2026-01-01T00:00:00Z" } }, workspace: null };
  const seen: (string | undefined)[] = [];
  const srv = await serve((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== "Bearer good") { res.writeHead(401); return res.end(); }
    if (req.url === "/code/snapshot-manifest.json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(manifest)); }
    if (req.url === "/code/api.tar.gz") { res.writeHead(200); return res.end("abc"); }
    res.writeHead(404); res.end();
  });
  try {
    const ledger = scratch("http-ledger");
    delete process.env.SNAPSHOT_HTTP_TOKEN;
    const s = createSource({ source: "http", baseUrl: `${srv.url}/code/`, auth: "bearer" }, ctx(ledger));
    assert.equal(s.status().connected, false);
    assert.equal(s.connectHelp()!.needsKey, true);
    await assert.rejects(s.connect("bad"), /refused \(HTTP 401\)/);
    assert.equal(s.status().connected, false, "a refused key isn't kept");
    await s.connect("good");
    assert.equal(s.status().connected, true);
    const files = await s.list();
    assert.deepEqual(files.map((f) => f.name), [MANIFEST, "api.tar.gz"]);
    const dest = path.join(scratch("http-dl"), "a");
    await s.download(files[1], dest);
    assert.equal(fs.readFileSync(dest, "utf-8"), "abc");
    assert.ok(seen.slice(1).every((a) => a === "Bearer good"));
    s.disconnect();
    assert.equal(s.status().connected, false);
  } finally { srv.close(); }
});

class LocalConfluence extends ConfluenceSource {
  base = "";
  protected origin() { return this.base; }
}

test("confluence source: lists pages of attachments, downloads through a cross-host redirect without our key, uploads multipart, prunes old versions", async () => {
  const media = await serve((req, res) => {
    // The media host must never see the Confluence credentials.
    if (req.headers.authorization) { res.writeHead(400); return res.end("leaked auth"); }
    res.writeHead(200); res.end("ARCHIVE");
  });
  const uploads: { url: string; body: string; token: string | undefined }[] = [];
  const deleted: string[] = [];
  const conf = await serve((req, res) => {
    const json = (d: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (req.headers.authorization !== `Basic ${Buffer.from("me@x.com:tokentokentoken").toString("base64")}`) { res.writeHead(401); return res.end(); }
    const u = req.url || "";
    if (req.method === "GET" && u === "/wiki/rest/api/content/42/child/attachment?limit=100&expand=version") {
      return json({ results: [{ id: "att1", title: "api.tar.gz", extensions: { fileSize: 7 }, version: { when: "2026-01-01" } }], _links: { next: "/rest/api/content/42/child/attachment?limit=100&expand=version&start=1" } });
    }
    if (req.method === "GET" && u.endsWith("&start=1")) return json({ results: [{ id: "att2", title: MANIFEST, extensions: { fileSize: 2 } }], _links: {} });
    if (req.method === "GET" && u === "/wiki/rest/api/content/42/child/attachment/att1/download") { res.writeHead(302, { Location: `${media.url}/file?token=signed` }); return res.end(); }
    if (req.method === "PUT" && u === "/wiki/rest/api/content/42/child/attachment") {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { uploads.push({ url: u, body, token: req.headers["x-atlassian-token"] as string }); json({ results: [] }); });
      return;
    }
    if (req.method === "GET" && /\/wiki\/rest\/api\/content\/att\d\/version\?limit=200$/.test(u)) return json({ results: u.includes("att1") ? [{ number: 3 }, { number: 2 }, { number: 1 }] : [{ number: 1 }] });
    if (req.method === "DELETE") { deleted.push(u); return json({}); }
    res.writeHead(404); res.end();
  });
  try {
    const ledger = scratch("conf-ledger");
    fs.writeFileSync(path.join(ledger, "confluence-api-token"), "me@x.com:tokentokentoken");
    const s = new LocalConfluence({ source: "confluence", site: "acme.atlassian.net", pageId: "42", maxFileMb: 5 }, ctx(ledger));
    s.base = conf.url;
    assert.equal(s.status().connected, true, "the Docs page's Confluence key is used");
    assert.equal(s.maxFileBytes, 5 * 1024 * 1024);
    const files = await s.list();
    assert.deepEqual(files.map((f) => [f.id, f.name, f.size]), [["att1", "api.tar.gz", 7], ["att2", MANIFEST, 2]]);
    const dest = path.join(scratch("conf-dl"), "api.tar.gz");
    await s.download(files[0], dest);
    assert.equal(fs.readFileSync(dest, "utf-8"), "ARCHIVE");

    const src = path.join(scratch("conf-up"), "web.tar.gz");
    fs.writeFileSync(src, "PAYLOAD");
    await s.upload("web.tar.gz", src);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].token, "nocheck");
    assert.match(uploads[0].body, /name="file"; filename="web.tar.gz"\r\nContent-Type: application\/octet-stream\r\n\r\nPAYLOAD\r\n--/);
    assert.match(uploads[0].body, /name="minorEdit"\r\n\r\ntrue/);

    assert.equal(await s.prune([MANIFEST]), 0, "only the named files are pruned");
    assert.deepEqual(deleted, []);
    assert.equal(await s.prune(["api.tar.gz", MANIFEST]), 2);
    assert.deepEqual(deleted, ["/wiki/rest/api/content/att1/version/2", "/wiki/rest/api/content/att1/version/1"], "only the old versions go");
    await s.remove(files[0]);
    assert.equal(deleted.at(-1), "/wiki/rest/api/content/att1", "remove deletes the attachment itself");

    const noPage = new LocalConfluence({ source: "confluence", site: "acme.atlassian.net" }, ctx(ledger));
    noPage.base = conf.url;
    await assert.rejects(noPage.list(), /needs "pageId"/);
  } finally { conf.close(); media.close(); }
});

test("repos.json snapshot config and per-repo opt-out are read; a snapshot folder has its own state", () => {
  const root = scratch("cfg");
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ snapshot: { source: " http ", baseUrl: "x" }, repos: [{ name: "a" }, { name: "b", snapshot: false }] }));
  const r = readRepos(root);
  assert.deepEqual(r.snapshot, { source: "http", baseUrl: "x" });
  assert.deepEqual(r.repos.map((x) => x.snapshot), [true, false]);
  fs.mkdirSync(path.join(root, "a"));
  fs.writeFileSync(path.join(root, "a", ".snapshot.json"), JSON.stringify({ sha: "1" }));
  assert.equal(repoState(root, "a"), "snapshot");
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ snapshot: { nope: 1 }, repos: [] }));
  assert.equal(readRepos(root).snapshot, null, "a snapshot block without a source is ignored");
});

test("the Windows installer: a .cmd that runs the PowerShell after its marker, with only the source filled in", () => {
  const text = renderInstaller({ name: "Acme", folder: "acme-workspace", source: { source: "confluence", site: "acme.atlassian.net", pageId: "123", maxFileMb: 50 }, sourceLabel: "Confluence", nodeMin: "24.15.0" });
  assert.ok(!/[^\r]\n/.test(text), "CRLF throughout (cmd.exe)");
  const lines = text.split("\r\n");
  assert.equal(lines[0], "@echo off");
  const marker = lines.indexOf("#>PS");
  assert.ok(marker > 0 && lines.slice(0, marker).some((l) => l.startsWith("powershell.exe -NoProfile -ExecutionPolicy Bypass")));
  assert.ok(!lines.slice(0, marker).some((l) => l === "#>PS"), "the header doesn't contain the marker itself");
  const ps = lines.slice(marker + 1).join("\n");
  const json = /ConvertFrom-Json @'\n([\s\S]*?)\n'@/.exec(ps)![1];
  assert.deepEqual(JSON.parse(json), { name: "Acme", folder: "acme-workspace", source: { source: "confluence", site: "acme.atlassian.net", pageId: "123" }, sourceLabel: "Confluence", nodeMin: "24.15.0" });
  assert.ok(!/^__AOS_CONFIG__$/m.test(ps), "the placeholder line is filled in");
  assert.equal(installerName("Acme Corp / Eng"), "Install-Acme-Corp-Eng.cmd");
  assert.throws(() => renderInstaller({ name: "Café", folder: "x", source: { source: "http", baseUrl: "https://x" }, sourceLabel: "Web", nodeMin: "24.0.0" }), /plain ASCII/);

  // The team's roles, asked for first; a label outside ASCII is escaped, and ConvertFrom-Json reads it back.
  const roles = [{ id: "eng", label: "Engineering", description: "", profile: "developer" }, { id: "fin", label: "Finanças", description: "Invoices", profile: "reader" }];
  const withRoles = renderInstaller({ name: "Acme", folder: "acme", source: { source: "http", baseUrl: "https://x" }, sourceLabel: "Web", nodeMin: "24.0.0", roles });
  assert.ok(!/[^\x00-\x7f]/.test(withRoles), "still ASCII");
  const cfg = JSON.parse(/ConvertFrom-Json @'\r\n([\s\S]*?)\r\n'@/.exec(withRoles)![1]);
  assert.deepEqual(cfg.roles, roles);
});

test("publish adds the built dashboard UI only when dashboard/ is exactly the published commit, and the installer for sources it can download from", async () => {
  const ups = scratch("ui-up");
  const pub = path.join(scratch("ui-root"), "ws");
  cloned(path.join(ups, "ws"), pub, {
    "repos.json": JSON.stringify({ snapshot: { source: "http", baseUrl: "https://files.acme.test/code" }, repos: [] }),
    ".gitignore": "dashboard/dist/\n",
    "dashboard/web/main.ts": "export {};\n",
  });
  const dist = path.join(pub, "dashboard", "dist", "browser");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<html></html>");
  const out = scratch("ui-out");
  const m = await buildSnapshot(pub, out, { installer: { name: "Acme", sourceLabel: "Web server" } });
  assert.ok(m.ui && fs.existsSync(path.join(out, m.ui.file)));
  const x = scratch("ui-x");
  await extractTarGz(path.join(out, m.ui.file), x);
  assert.equal(fs.readFileSync(path.join(x, "dist", "browser", "index.html"), "utf-8"), "<html></html>");
  assert.equal(JSON.parse(fs.readFileSync(path.join(x, "dist", ".prebuilt.json"), "utf-8")).sha, m.workspace!.sha);
  assert.ok(!fs.existsSync(path.join(pub, "dashboard", "dist", ".prebuilt.json")), "the publisher's own dist isn't marked");
  assert.equal(m.installer!.file, "Install-Acme.cmd");
  assert.ok(fs.readFileSync(path.join(out, m.installer!.file), "utf-8").includes('"baseUrl": "https://files.acme.test/code"'));
  const store = folderSource(scratch("ui-store"));
  await publishSnapshot(store, out, m);
  assert.match(store.uploads.at(-3)!, /^dashboard-ui-[0-9a-f]{12}.tar.gz$/);
  assert.deepEqual(store.uploads.slice(-2), ["Install-Acme.cmd", MANIFEST]);

  // An edit in dashboard/ (not in the published commit): the UI isn't that commit's, so it's left out.
  fs.writeFileSync(path.join(pub, "dashboard", "web", "main.ts"), "export const edited = 1;\n");
  const m2 = await buildSnapshot(pub, scratch("ui-out2"), {});
  assert.equal(m2.ui, null);
  assert.equal(m2.installer, null, "no installer without the installer option");
});

test("archive names carry the commit and stay distinct when a repo name had to be made file-safe", () => {
  const sha = "0123456789abcdef0123";
  assert.equal(archiveName("api", sha), "api-0123456789ab.tar.gz");
  const a = archiveName("api/core", sha), b = archiveName("api-core", sha);
  assert.notEqual(a, b, "api/core and api-core don't collide");
  assert.match(a, /^api-core-[0-9a-f]{6}-0123456789ab\.tar\.gz$/);
  assert.match(archiveName("ünïcode", sha), /-[0-9a-f]{6}-0123456789ab\.tar\.gz$/, "made file-safe, so tagged");
  assert.match(archiveName("日本", sha), /^repo-[0-9a-f]{6}-0123456789ab\.tar\.gz$/, "nothing file-safe left");
});

/** A zip with stored entries, for crafting archives git wouldn't write; `damage` flips a byte of that entry after its CRC is taken. */
function storedZip(file: string, entries: Record<string, string>, damage?: string) {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const n = Buffer.from(name), d = Buffer.from(text);
    const crc = zlib.crc32(d);
    if (name === damage) d[0] ^= 0x01;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt32LE(crc, 14); l.writeUInt32LE(d.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt32LE(crc, 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, d); centrals.push(c, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(entries).length, 8); e.writeUInt16LE(Object.keys(entries).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, e]));
}

test("zip: git archive output extracts byte-for-byte; an entry leaving the folder fails the extraction", async () => {
  const src = scratch("zip-src");
  repo(src, { "README.md": "hello\n", "src/x/y.ts": "export const y = 1;\n".repeat(200), "empty.txt": "", "bin.dat": "\x00\x01\x02\xff" });
  const archive = path.join(scratch("zip-a"), "w.zip");
  git(src, "-c", "core.autocrlf=false", "archive", "--format=zip", "-o", archive, "HEAD");
  const out = scratch("zip-out");
  const r = await extractZip(archive, out);
  assert.equal(r.files, 4);
  for (const f of ["README.md", "src/x/y.ts", "empty.txt", "bin.dat"]) assert.deepEqual(fs.readFileSync(path.join(out, f)), fs.readFileSync(path.join(src, f)), f);

  const dir = scratch("zip-bad");
  storedZip(path.join(dir, "evil.zip"), { "ok.txt": "ok", "../evil.txt": "evil" });
  await assert.rejects(extractZip(path.join(dir, "evil.zip"), path.join(dir, "out")), /outside the target folder/);
  assert.ok(!fs.existsSync(path.join(dir, "evil.txt")));
  storedZip(path.join(dir, "flipped.zip"), { "a.txt": "same size, one bit off" }, "a.txt");
  await assert.rejects(extractZip(path.join(dir, "flipped.zip"), path.join(dir, "out-crc")), /a\.txt fails its CRC-32 check/);
  storedZip(path.join(dir, "fine.zip"), { "a.txt": "intact" });
  assert.equal((await extractZip(path.join(dir, "fine.zip"), path.join(dir, "out-ok"))).files, 1);
  fs.writeFileSync(path.join(dir, "not.zip"), "plain text");
  await assert.rejects(extractZip(path.join(dir, "not.zip"), path.join(dir, "out2")), /Not a zip archive/);
});

test("install: a whole workspace from its snapshot with no git; update keeps the ledger; never over a clone", async () => {
  const ups = scratch("inst-up");
  const pub = path.join(scratch("inst-pub"), "ws");
  const reposJson = { snapshot: { source: "folder" }, repos: [{ name: "api" }] };
  cloned(path.join(ups, "ws"), pub, {
    "repos.json": JSON.stringify(reposJson), "CLAUDE.md": "v1\n", ".gitignore": "api/\ndashboard/dist/\n", "dashboard/web/main.ts": "export {};\n",
  });
  cloned(path.join(ups, "api"), path.join(pub, "api"), { "main.go": "v1\n" });
  fs.mkdirSync(path.join(pub, "dashboard", "dist", "browser"), { recursive: true });
  fs.writeFileSync(path.join(pub, "dashboard", "dist", "browser", "index.html"), "<html></html>");
  const store = folderSource(scratch("inst-store"));
  const out1 = scratch("inst-out1");
  const m1 = await buildSnapshot(pub, out1);
  assert.ok(m1.ui, "the publisher's built UI goes along");
  await publishSnapshot(store, out1, m1);

  const dir = path.join(scratch("inst-host"), "workspace");
  const r1 = await installWorkspace(store, dir, { repos: true });
  assert.deepEqual([r1.workspace, r1.sha, r1.ui, r1.repos], ["installed", m1.workspace!.sha, true, 1]);
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8"), "v1\n");
  assert.equal(readStamp(dir)!.sha, m1.workspace!.sha);
  assert.equal(fs.readFileSync(path.join(dir, "api", "main.go"), "utf-8"), "v1\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "dashboard", "dist", ".prebuilt.json"), "utf-8")).sha, m1.workspace!.sha);
  assert.ok(fs.statSync(path.join(dir, "dashboard", "dist", "browser", "index.html")).mtimeMs >= fs.statSync(path.join(dir, "dashboard", "web", "main.ts")).mtimeMs, "the UI is newer than its sources, so it isn't rebuilt");

  const r2 = await installWorkspace(store, dir, { repos: true });
  assert.deepEqual([r2.workspace, r2.ui, r2.repos], ["current", false, 0], "nothing to do");

  // A new workspace commit: the files are updated, the person's ledger and downloaded repos stay.
  fs.mkdirSync(path.join(dir, ".claude", "ledger"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "ledger", "mine.json"), "{}");
  fs.writeFileSync(path.join(ups, "ws", "CLAUDE.md"), "v2\n");
  git(path.join(ups, "ws"), "commit", "-qam", "v2");
  const out2 = scratch("inst-out2");
  const m2 = await buildSnapshot(pub, out2, { workspace: true });
  await publishSnapshot(store, out2, m2);
  const r3 = await installWorkspace(store, dir);
  assert.equal(r3.workspace, "updated");
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8"), "v2\n");
  assert.equal(fs.readFileSync(path.join(dir, ".claude", "ledger", "mine.json"), "utf-8"), "{}");
  assert.equal(repoState(dir, "api"), "snapshot");
  assert.equal(isInstalling(dir), false);

  // An install that stopped while copying: the stamp says "installing" and some files are there.
  // It's still ours to retry, and the retry finishes it with the real stamp.
  const broken = path.join(scratch("inst-broken"), "workspace");
  fs.mkdirSync(path.join(broken, "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(broken, ".snapshot.json"), JSON.stringify({ name: "workspace", sha: INSTALLING, builtAt: "", source: "folder" }, null, 2));
  fs.writeFileSync(path.join(broken, "half-copied.txt"), "x");
  assert.equal(isInstalling(broken), true);
  const r4 = await installWorkspace(store, broken);
  assert.equal(r4.workspace, "installed", "an unfinished install isn't an update");
  assert.equal(readStamp(broken)!.sha, m2.workspace!.sha);
  assert.equal(isInstalling(broken), false);
  assert.equal(fs.readFileSync(path.join(broken, "CLAUDE.md"), "utf-8"), "v2\n");

  // A download that fails (or an archive that won't extract) touches nothing: the live
  // folder keeps its stamp, so the hosted entrypoint still starts the previous version.
  assert.ok(m2.ui, "the second publish has a prebuilt UI too");
  const prebuiltSha = (d: string) => JSON.parse(fs.readFileSync(path.join(d, "dashboard", "dist", ".prebuilt.json"), "utf-8")).sha;
  const failing = (name: string): SnapshotSource => ({ ...store, download: async (f, d) => { if (f.name === name) throw new Error("network dropped"); return store.download(f, d); } });
  const before = readStamp(dir)!.sha;
  fs.writeFileSync(path.join(ups, "ws", "CLAUDE.md"), "v3\n");
  git(path.join(ups, "ws"), "commit", "-qam", "v3");
  const out3 = scratch("inst-out3");
  const m3 = await buildSnapshot(pub, out3, { workspace: true });
  await publishSnapshot(store, out3, m3);
  for (const name of [m3.workspace!.file, m3.ui!.file]) {
    await assert.rejects(installWorkspace(failing(name), dir), /network dropped/);
    assert.deepEqual([readStamp(dir)!.sha, isInstalling(dir), fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8")], [before, false, "v2\n"], `${name} failing leaves the old install whole`);
  }
  assert.equal((await installWorkspace(store, dir)).workspace, "updated");
  assert.deepEqual([readStamp(dir)!.sha, prebuiltSha(dir)], [m3.workspace!.sha, m3.workspace!.sha]);

  // Interrupted after files started going in (simulated: the copy of the UI throws): still
  // "installing", so it isn't started, and a retry finishes it.
  const flaky = path.join(scratch("inst-ui-fail"), "workspace");
  const realCp = fs.cpSync;
  (fs as any).cpSync = (src: string, dst: string, o: any) => { if (path.basename(dst) === ".dist-new") throw new Error("disk full"); return realCp(src, dst, o); };
  try { await assert.rejects(installWorkspace(store, flaky), /disk full/); }
  finally { (fs as any).cpSync = realCp; }
  assert.equal(isInstalling(flaky), true, "not stamped complete without its UI");
  assert.ok(fs.existsSync(path.join(flaky, "CLAUDE.md")), "the workspace files did go in");
  const r5 = await installWorkspace(store, flaky);
  assert.deepEqual([r5.workspace, r5.ui, isInstalling(flaky), prebuiltSha(flaky)], ["installed", true, false, m3.workspace!.sha]);
  assert.deepEqual(fs.readdirSync(path.join(flaky, "dashboard")).filter((n) => n.startsWith(".dist")), [], "no staging folders left behind");

  const clone = scratch("inst-clone");
  fs.mkdirSync(path.join(clone, ".git"));
  await assert.rejects(installWorkspace(store, clone), /a git clone; not installing over it/);
  const foreign = scratch("inst-foreign");
  fs.writeFileSync(path.join(foreign, "notes.txt"), "mine");
  await assert.rejects(installWorkspace(store, foreign), /a folder with other files/);
});

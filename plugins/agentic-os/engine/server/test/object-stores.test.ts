// The object-store snapshot sources (Azure Blob, S3) against local fake servers, and the
// SigV4 signer against AWS's published examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createSource } from "../src/snapshot-sources/index.ts";
import { EMPTY_SHA256, signV4 } from "../src/snapshot-sources/sigv4.ts";
import { decodeXml, elements, folderPrefix, text } from "../src/snapshot-sources/xml.ts";

const scratch = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `dash-os-${name}-`));
const ctx = (dir: string) => ({ ledgerDir: dir, issues: { kind: "none" } });

async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const body = (req: http.IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });

test("xml helpers: elements by name, entities decoded, prefixes as folders", () => {
  const xml = `<R><Blob><Name>a&amp;b.tar.gz</Name></Blob><Blob kind="x"><Name>c&#x2F;d</Name></Blob><Next/></R>`;
  assert.deepEqual(elements(xml, "Blob").map((b) => text(b, "Name")), ["a&b.tar.gz", "c/d"]);
  assert.equal(text(xml, "Missing"), null);
  assert.equal(decodeXml("&lt;&#65;&gt;"), "<A>");
  assert.deepEqual(["", "/", "code", "/code/", "a/b"].map(folderPrefix), ["", "", "code/", "code/", "a/b/"]);
});

test("sigv4: AWS's published S3 examples (GET Object with Range, ListObjects with a query)", () => {
  const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const now = new Date("2013-05-24T00:00:00Z");
  const get = signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { Range: "bytes=0-9" }, region: "us-east-1", service: "s3", credentials, payloadHash: EMPTY_SHA256, now });
  assert.equal(get.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(get["x-amz-date"], "20130524T000000Z");
  const list = signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"), region: "us-east-1", service: "s3", credentials, payloadHash: EMPTY_SHA256, now });
  assert.match(list.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});

test("azure-blob: SAS checked on connect, paged listing under the prefix, download, Put Blob, delete, prune old versions", async () => {
  const puts: { url: string; type: string | undefined; version: string | undefined; body: string }[] = [];
  const deletes: string[] = [];
  const blob = (name: string, size: number, extra = "") => `<Blob><Name>${name}</Name>${extra}<Properties><Last-Modified>Thu, 01 Jan 2026 00:00:00 GMT</Last-Modified><Content-Length>${size}</Content-Length></Properties></Blob>`;
  const srv = await serve(async (req, res) => {
    const u = new URL(req.url || "", "http://x");
    if (u.searchParams.get("sig") !== "good") { res.writeHead(403); return res.end("<Error><Message>AuthenticationFailed</Message></Error>"); }
    const xml = (s: string) => { res.writeHead(200, { "Content-Type": "application/xml" }); res.end(`<?xml version="1.0"?><EnumerationResults>${s}</EnumerationResults>`); };
    if (req.method === "GET" && u.pathname === "/acme/snapshots" && u.searchParams.get("comp") === "list") {
      assert.equal(u.searchParams.get("restype"), "container");
      assert.equal(u.searchParams.get("prefix"), "code/");
      if (u.searchParams.get("include") === "versions") {
        return xml(`<Blobs>${blob("code/api.tar.gz", 3, "<VersionId>v2</VersionId><IsCurrentVersion>true</IsCurrentVersion>")}${blob("code/api.tar.gz", 2, "<VersionId>v1</VersionId>")}${blob("code/other.bin", 1, "<VersionId>o1</VersionId>")}</Blobs><NextMarker/>`);
      }
      if (u.searchParams.get("maxresults") || !u.searchParams.get("marker")) return xml(`<Blobs>${blob("code/api.tar.gz", 3)}</Blobs><NextMarker>page2</NextMarker>`);
      return xml(`<Blobs>${blob("code/snapshot-manifest.json", 2)}${blob("code/deeper/x.bin", 9)}</Blobs><NextMarker/>`);
    }
    if (req.method === "GET" && u.pathname === "/acme/snapshots/code/api.tar.gz") { res.writeHead(200); return res.end("abc"); }
    if (req.method === "PUT") { puts.push({ url: u.pathname, type: req.headers["x-ms-blob-type"] as string, version: req.headers["x-ms-version"] as string, body: await body(req) }); res.writeHead(201); return res.end(); }
    if (req.method === "DELETE") { deletes.push(`${u.pathname}${u.searchParams.get("versionid") ? `@${u.searchParams.get("versionid")}` : ""}`); res.writeHead(202); return res.end(); }
    res.writeHead(404); res.end();
  });
  const saved = process.env.SNAPSHOT_AZURE_SAS;
  delete process.env.SNAPSHOT_AZURE_SAS;
  try {
    const ledger = scratch("az-ledger");
    assert.equal(createSource({ source: "azure-blob", account: "acme" }, ctx(ledger)).connectHelp()!.needsKey, false, "no container: settings first");
    const s = createSource({ source: "azure-blob", account: "acme", container: "snapshots", prefix: "/code", endpoint: `${srv.url}/acme` }, ctx(ledger));
    assert.equal(s.label, "Azure Blob Storage");
    assert.equal(s.status().connected, false);
    assert.equal(s.connectHelp()!.needsKey, true);
    await assert.rejects(s.connect("not a sas"), /isn't a SAS token/);
    await assert.rejects(s.connect("?sv=2023&sig=bad"), /refused \(HTTP 403\)/);
    assert.equal(s.status().connected, false, "a refused key isn't kept");
    await s.connect("https://acme.blob.core.windows.net/snapshots?sv=2023&sp=rl&sig=good");
    assert.deepEqual(s.status(), { connected: true, source: "file", viewer: null });
    assert.equal(fs.readFileSync(path.join(ledger, "snapshot-azure-sas"), "utf-8"), "sv=2023&sp=rl&sig=good", "only the query is kept");

    const files = await s.list();
    assert.deepEqual(files.map((f) => [f.name, f.size, f.updatedAt]), [["api.tar.gz", 3, "2026-01-01T00:00:00.000Z"], ["snapshot-manifest.json", 2, "2026-01-01T00:00:00.000Z"]], "both pages, deeper names left out");
    const dest = path.join(scratch("az-dl"), "a");
    await s.download(files[0], dest);
    assert.equal(fs.readFileSync(dest, "utf-8"), "abc");

    const src = path.join(scratch("az-up"), "f");
    fs.writeFileSync(src, "ARCHIVE");
    await s.upload!("new.tar.gz", src);
    assert.deepEqual(puts, [{ url: "/acme/snapshots/code/new.tar.gz", type: "BlockBlob", version: "2023-11-03", body: "ARCHIVE" }]);
    await s.remove!(files[0]);
    assert.equal(await s.prune!(["api.tar.gz"]), 1, "only the named file's old version");
    assert.deepEqual(deletes, ["/acme/snapshots/code/api.tar.gz", "/acme/snapshots/code/api.tar.gz@v1"]);

    process.env.SNAPSHOT_AZURE_SAS = "?sv=2023&sig=good";
    assert.equal(s.status().source, "env", "the environment wins (hosted containers)");
    s.disconnect();
    assert.equal(s.status().connected, true, "disconnect only removes the pasted key");
  } finally {
    if (saved === undefined) delete process.env.SNAPSHOT_AZURE_SAS; else process.env.SNAPSHOT_AZURE_SAS = saved;
    srv.close();
  }
});

/** The server side of SigV4: recompute the signature from what arrived. */
function verify(req: http.IncomingMessage, secret: string): boolean {
  const auth = String(req.headers.authorization || "");
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=[0-9a-f]{64}$/.exec(auth);
  if (!m) return false;
  const d = String(req.headers["x-amz-date"]);
  const now = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
  const headers: Record<string, string> = {};
  for (const h of m[3].split(";")) if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(h)) headers[h] = String(req.headers[h]);
  const again = signV4({ method: req.method!, url: new URL(req.url!, `http://${req.headers.host}`), headers, region: m[2], service: "s3", credentials: { accessKeyId: m[1], secretAccessKey: secret }, payloadHash: String(req.headers["x-amz-content-sha256"]), now });
  return again.authorization === auth;
}

test("s3: signed requests (path-style endpoint), paged ListObjectsV2, download, PutObject, delete, prune noncurrent versions, wrong region", async () => {
  const puts: { path: string; body: string; length: string | undefined }[] = [];
  const deletes: string[] = [];
  const srv = await serve(async (req, res) => {
    if (!verify(req, "SECRET/key+1")) { res.writeHead(403); return res.end("<Error><Code>SignatureDoesNotMatch</Code></Error>"); }
    const u = new URL(req.url || "", "http://x");
    const xml = (s: string) => { res.writeHead(200, { "Content-Type": "application/xml" }); res.end(`<?xml version="1.0"?><ListBucketResult>${s}</ListBucketResult>`); };
    if (u.pathname === "/moved/") { res.writeHead(301); return res.end("<Error><Code>PermanentRedirect</Code></Error>"); }
    if (req.method === "GET" && u.pathname === "/acme-code/" && u.searchParams.has("versions")) {
      return xml(`<Version><Key>snap/api.tar.gz</Key><VersionId>new</VersionId><IsLatest>true</IsLatest></Version><Version><Key>snap/api.tar.gz</Key><VersionId>old</VersionId><IsLatest>false</IsLatest></Version><Version><Key>snap/keep.txt</Key><VersionId>k1</VersionId><IsLatest>false</IsLatest></Version><IsTruncated>false</IsTruncated>`);
    }
    if (req.method === "GET" && u.pathname === "/acme-code/" && u.searchParams.get("list-type") === "2") {
      assert.equal(u.searchParams.get("prefix"), "snap/");
      if (u.searchParams.get("max-keys")) return xml(`<IsTruncated>false</IsTruncated>`);
      if (!u.searchParams.get("continuation-token")) return xml(`<Contents><Key>snap/api.tar.gz</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>3</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>tok/+=</NextContinuationToken>`);
      assert.equal(u.searchParams.get("continuation-token"), "tok/+=");
      return xml(`<Contents><Key>snap/snapshot-manifest.json</Key><Size>2</Size></Contents><Contents><Key>snap/sub/x</Key><Size>1</Size></Contents><IsTruncated>false</IsTruncated>`);
    }
    if (req.method === "GET" && u.pathname === "/acme-code/snap/api.tar.gz") { res.writeHead(200); return res.end("abc"); }
    if (req.method === "PUT") { puts.push({ path: u.pathname, body: await body(req), length: req.headers["content-length"] }); res.writeHead(200); return res.end(); }
    if (req.method === "DELETE") { deletes.push(`${u.pathname}${u.searchParams.get("versionId") ? `@${u.searchParams.get("versionId")}` : ""}`); res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end();
  });
  const saved = Object.fromEntries(["SNAPSHOT_S3_ACCESS_KEY_ID", "SNAPSHOT_S3_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    const ledger = scratch("s3-ledger");
    assert.match(createSource({ source: "s3", bucket: "acme-code", region: "Not A Region" }, ctx(ledger)).connectHelp()!.steps[0], /isn't a region name/);
    const s = createSource({ source: "s3", bucket: "acme-code", region: "auto", prefix: "snap", endpoint: srv.url }, ctx(ledger));
    assert.equal(s.label, "S3 (127.0.0.1)");
    assert.equal(s.status().connected, false);
    await assert.rejects(s.connect("no-colon"), /ACCESS_KEY_ID:SECRET_ACCESS_KEY/);
    await assert.rejects(s.connect("AKID:wrong"), /refused \(HTTP 403\)/);
    await s.connect("AKID:SECRET/key+1");
    assert.deepEqual(s.status(), { connected: true, source: "file", viewer: null });

    const files = await s.list();
    assert.deepEqual(files.map((f) => [f.name, f.size]), [["api.tar.gz", 3], ["snapshot-manifest.json", 2]]);
    const dest = path.join(scratch("s3-dl"), "a");
    await s.download(files[0], dest);
    assert.equal(fs.readFileSync(dest, "utf-8"), "abc");
    const src = path.join(scratch("s3-up"), "f");
    fs.writeFileSync(src, "ARCHIVE");
    await s.upload!("new.tar.gz", src);
    assert.deepEqual(puts, [{ path: "/acme-code/snap/new.tar.gz", body: "ARCHIVE", length: "7" }]);
    await s.remove!(files[0]);
    assert.equal(await s.prune!(["api.tar.gz"]), 1);
    assert.deepEqual(deletes, ["/acme-code/snap/api.tar.gz", "/acme-code/snap/api.tar.gz@old"]);

    const moved = createSource({ source: "s3", bucket: "moved", region: "us-east-1", endpoint: srv.url }, ctx(ledger));
    await assert.rejects(moved.list(), /isn't in region "us-east-1"/);

    process.env.AWS_ACCESS_KEY_ID = "AKID";
    process.env.AWS_SECRET_ACCESS_KEY = "SECRET/key+1";
    assert.equal(s.status().source, "env", "the environment wins (CI, hosted containers)");
    assert.equal((await s.list()).length, 2);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    srv.close();
  }
});

test("s3: AWS addresses are virtual-hosted, path-style for bucket names with dots", async () => {
  const urls: string[] = [];
  const s = createSource({ source: "s3", bucket: "acme-code", region: "eu-west-1" }, ctx(scratch("s3-aws")));
  const dotted = createSource({ source: "s3", bucket: "acme.code", region: "eu-west-1" }, ctx(scratch("s3-aws2")));
  for (const src of [s, dotted]) urls.push((src as any).url("a.tar.gz").toString());
  assert.deepEqual(urls, ["https://acme-code.s3.eu-west-1.amazonaws.com/a.tar.gz", "https://s3.eu-west-1.amazonaws.com/acme.code/a.tar.gz"]);
});

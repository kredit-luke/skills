import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Explore, decodeText, detectEol, encodeText, resolveSafe } from "../src/explore.ts";

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "explore-"));
  fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "repo", ".git", "config"), "x");
  fs.writeFileSync(path.join(root, "repo", "a.txt"), "hi");
  return root;
}

test("resolveSafe() keeps paths inside the root and out of .git", () => {
  const root = tmpRoot();
  assert.equal(resolveSafe(root, "repo/a.txt"), path.join(root, "repo", "a.txt"));
  assert.equal(resolveSafe(root, ""), path.resolve(root));
  const status = (rel: string) => { try { resolveSafe(root, rel); return 200; } catch (e) { return e.status; } };
  assert.equal(status("../etc/passwd"), 403);
  assert.equal(status("repo/../../x"), 403);
  assert.equal(status("repo\\..\\..\\x"), 403);
  assert.equal(status(path.join(root, "repo", "a.txt")), 403);
  assert.equal(status("C:/Windows"), 403);
  assert.equal(status("repo/.git/config"), 403);
  assert.equal(status("repo/.git"), 403);
  assert.equal(status("repo/missing.txt"), 404);
});

test("resolveSafe() refuses a link that points outside the root", () => {
  const root = tmpRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "explore-out-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  try {
    fs.symlinkSync(outside, path.join(root, "escape"), "junction");
  } catch {
    return; // no permission to create links on this machine
  }
  assert.throws(() => resolveSafe(root, "escape/secret.txt"), (e: any) => e.status === 403);
});

test("detectEol() reports the style and the dominant one", () => {
  assert.deepEqual(detectEol("a\nb\n"), { eol: "lf", dominant: "lf" });
  assert.deepEqual(detectEol("a\r\nb\r\n"), { eol: "crlf", dominant: "crlf" });
  assert.deepEqual(detectEol("a\r\nb\r\nc\n"), { eol: "mixed", dominant: "crlf" });
  assert.deepEqual(detectEol("a\nb\nc\r\n"), { eol: "mixed", dominant: "lf" });
  assert.deepEqual(detectEol("one line"), { eol: "none", dominant: "lf" });
});

test("decodeText() spots BOMs, binary and non-UTF-8", () => {
  assert.deepEqual(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), { content: "hi", bom: true, binary: false, utf8: true });
  assert.equal(decodeText(Buffer.from([0x89, 0x50, 0x00, 0x01])).binary, true);
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])).utf8, false); // latin-1 "café"
});

test("encodeText() writes the requested style and BOM", () => {
  assert.equal(encodeText("a\nb\n", "crlf", false).toString(), "a\r\nb\r\n");
  assert.equal(encodeText("a\r\nb", "lf", false).toString(), "a\nb");
  assert.deepEqual([...encodeText("x", "lf", true)], [0xef, 0xbb, 0xbf, 0x78]);
});

test("read → save round-trips a file's line endings, BOM and missing trailing newline", () => {
  const root = tmpRoot();
  const ex = new Explore(root);
  const cases: [string, Buffer][] = [
    ["lf.ts", Buffer.from("const a = 1;\nconst b = 2;\n")],
    ["crlf.cs", Buffer.from("class A\r\n{\r\n}\r\n")],
    ["bom.cs", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x\r\ny")])],
  ];
  for (const [name, bytes] of cases) {
    fs.writeFileSync(path.join(root, name), bytes);
    const f = ex.read(name);
    assert.ok(!f.content!.includes("\r"), "editor text is LF");
    ex.save({ path: name, content: f.content, eol: f.saveEol, bom: f.bom, baseMtimeMs: f.mtimeMs });
    assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
  }
  // An edit keeps the style of the lines around it.
  const f = ex.read("crlf.cs");
  ex.save({ path: "crlf.cs", content: f.content!.replace("{", "{\n  int x;"), eol: f.saveEol, bom: f.bom, baseMtimeMs: f.mtimeMs });
  assert.equal(fs.readFileSync(path.join(root, "crlf.cs"), "utf-8"), "class A\r\n{\r\n  int x;\r\n}\r\n");
});

test("save() refuses a stale mtime unless forced", () => {
  const root = tmpRoot();
  const ex = new Explore(root);
  const f = ex.read("repo/a.txt");
  assert.throws(() => ex.save({ path: "repo/a.txt", content: "new", eol: "lf", bom: false, baseMtimeMs: f.mtimeMs - 5000 }), (e: any) => e.status === 409);
  assert.equal(fs.readFileSync(path.join(root, "repo", "a.txt"), "utf-8"), "hi");
  ex.save({ path: "repo/a.txt", content: "new", eol: "lf", bom: false, baseMtimeMs: 0, force: true });
  assert.equal(fs.readFileSync(path.join(root, "repo", "a.txt"), "utf-8"), "new");
});

test("list() puts folders first, hides .git and flags heavy folders", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "repo", "node_modules"));
  fs.mkdirSync(path.join(root, "repo", "src"));
  fs.writeFileSync(path.join(root, "repo", "B.md"), "");
  const r = new Explore(root).list("repo");
  assert.equal(r.path, "repo");
  assert.deepEqual(r.entries.map((e) => e.name), ["node_modules", "src", "a.txt", "B.md"]);
  assert.equal(r.entries[0].heavy, true);
  assert.equal(r.entries[1].heavy, undefined);
});

test("read() won't open binary or huge files as text", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
  const f = new Explore(root).read("img.png");
  assert.equal(f.binary, true);
  assert.equal(f.content, null);
  assert.ok(f.readOnlyReason);
});

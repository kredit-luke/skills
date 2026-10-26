// Memory: the staleness flags and the MEMORY.md upkeep the page does without Claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Memory } from "../src/memory.ts";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-mem-ws-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "here.ts"), "");
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dash-mem-cfg-"));
  const mem = new Memory(root);
  fs.mkdirSync(mem.dir, { recursive: true });
  const write = (f, body) => fs.writeFileSync(path.join(mem.dir, f), `---\nname: ${f}\ndescription: d\n---\n${body}\n`);
  write("ok.md", "See `src/here.ts`.");
  write("gone.md", "See `src/gone.ts`.");
  write("unindexed.md", "Nothing.");
  fs.writeFileSync(path.join(mem.dir, "MEMORY.md"), "# Memory\r\n- [Ok](ok.md) — fine\r\n- [Gone](gone.md) — moved\r\n- [Deleted](deleted.md) — no file\r\n");
  return mem;
}

test("list flags missing paths, unindexed files and orphan index lines", () => {
  const mem = setup();
  const out = mem.list();
  const issues = Object.fromEntries(out.memories.map((m) => [m.file, m.issues]));
  assert.deepEqual(issues["ok.md"], []);
  assert.match(issues["gone.md"][0], /`src\/gone\.ts`, which no longer exists/);
  assert.match(issues["unindexed.md"][0], /Not listed in MEMORY\.md/);
  assert.equal(out.orphanIndexLines.length, 1);
});

test("pruneIndex drops only lines for missing files, keeping line endings", () => {
  const mem = setup();
  assert.deepEqual(mem.pruneIndex(), { ok: true, removed: 1 });
  assert.equal(fs.readFileSync(path.join(mem.dir, "MEMORY.md"), "utf-8"), "# Memory\r\n- [Ok](ok.md) — fine\r\n- [Gone](gone.md) — moved\r\n");
  assert.equal(mem.list().orphanIndexLines.length, 0);
  assert.deepEqual(mem.pruneIndex(), { ok: true, removed: 0 });
});

test("pruneIndex with no MEMORY.md is a no-op", () => {
  const mem = setup();
  fs.unlinkSync(path.join(mem.dir, "MEMORY.md"));
  assert.deepEqual(mem.pruneIndex(), { ok: true, removed: 0 });
});

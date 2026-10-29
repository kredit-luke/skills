// writeAtomic (atomic-write.ts): profile.json, the onboarding ledger and the Atlassian secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomic } from "../src/atomic-write.ts";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-atomic-"));
const temps = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

test("writes the file (making its folder), replaces an old one, and leaves no temp file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "a", "b.json");
  writeAtomic(file, "one\n");
  writeAtomic(file, "two\n");
  assert.equal(fs.readFileSync(file, "utf-8"), "two\n");
  assert.deepEqual(temps(path.dirname(file)), []);
});

test("mode: owner-only when asked", { skip: process.platform === "win32" }, () => {
  const file = path.join(tmpDir(), "secret");
  writeAtomic(file, "s\n", 0o600);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a failed write throws and removes its temp file", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "taken")); // rename and copy over a directory both fail
  assert.throws(() => writeAtomic(path.join(dir, "taken"), "x"));
  assert.deepEqual(temps(dir), []);
});

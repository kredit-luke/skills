import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Attachments, promptWithAttachments, safeName } from "../src/attachments.ts";
import { Deck } from "../src/deck.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-att-"));
const DAY = 24 * 3600 * 1000;

test("safeName keeps the extension and drops folders and odd characters", () => {
  assert.equal(safeName("C:\\Users\\me\\Screen Shot (2).PNG"), "Screen Shot _2_.png");
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName(".hidden"), "hidden"); // never a dot file
  assert.equal(safeName("..."), "file");
  assert.equal(safeName(""), "file");
});

test("promptWithAttachments lists each file's path after the prompt", () => {
  assert.equal(promptWithAttachments("Fix it", []), "Fix it");
  const p = promptWithAttachments("Fix it", [{ id: "a", name: "x.png", file: "a-x.png", size: 2048, kind: "image", path: "/l/x.png" }]);
  assert.match(p, /^Fix it\n\nAttached files\./);
  assert.match(p, /- \/l\/x\.png \(image, 2 KB\)/);
});

test("stage → claim moves the file into the run's folder; file() only serves what's there", () => {
  const a = new Attachments(tmp());
  const s = a.stage("shot.png", Buffer.from("png"));
  assert.deepEqual(a.check([s.id]), [s.id]);
  assert.throws(() => a.check(["000000000000"]), /missing/);
  assert.throws(() => a.check(["../x"]), /missing/);
  const [f] = a.claim("20260101000000-abcdef", [s.id]);
  assert.equal(f.name, "shot.png");
  assert.equal(f.kind, "image");
  assert.ok(fs.existsSync(f.path));
  assert.equal(a.file("20260101000000-abcdef", f.file), f.path);
  assert.equal(a.file("20260101000000-abcdef", "../" + f.file), null);
  assert.throws(() => a.check([s.id]), /missing/); // claimed: no longer staged
});

test("cleanup deletes a done run's files after keepDays, never a running or waiting one's", () => {
  const a = new Attachments(tmp());
  const now = Date.now();
  const runs: Record<string, any> = {
    old: { id: "old", status: "succeeded", startedAt: new Date(now - 30 * DAY).toISOString(), endedAt: new Date(now - 20 * DAY).toISOString() },
    recent: { id: "recent", status: "succeeded", startedAt: new Date(now - 2 * DAY).toISOString(), endedAt: new Date(now - DAY).toISOString() },
    asking: { id: "asking", status: "waiting", startedAt: new Date(now - 30 * DAY).toISOString(), endedAt: new Date(now - 20 * DAY).toISOString() },
  };
  for (const id of Object.keys(runs)) a.claim(id, [a.stage("f.txt", Buffer.from("x")).id]);
  const removed = a.cleanup((id) => runs[id] || null, () => false, 14, now);
  assert.deepEqual(removed, ["old"]);
  assert.ok(!fs.existsSync(a.runDir("old")));
  assert.ok(fs.existsSync(a.runDir("recent")));
  assert.ok(fs.existsSync(a.runDir("asking")));
  assert.deepEqual(a.cleanup((id) => runs[id] || null, () => false, 0, now + 365 * DAY), []); // 0 keeps them
});

test("personal settings override the team file key by key, and null goes back", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".claude", "dashboard"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "dashboard", "deck.json"), JSON.stringify({ limits: { maxConcurrentRuns: 3 }, defaults: { model: "opus", effort: "medium" } }));
  const deck = new Deck(root, path.join(root, "settings.json"));
  const allowed = { models: (m: string) => /^[a-z]+$/.test(m), efforts: ["low", "medium", "high"] };
  assert.equal(deck.config().limits.runBudget, false); // off unless someone turns it on
  deck.savePersonal({ limits: { maxConcurrentRuns: 5, runBudget: true }, defaults: { effort: "high" } }, allowed);
  const c = deck.config();
  assert.equal(c.limits.maxConcurrentRuns, 5);
  assert.equal(c.limits.runBudget, true);
  assert.equal(c.limits.pauseAtSessionPct, 90);
  assert.deepEqual(c.defaults, { model: "opus", effort: "high" });
  assert.equal(deck.teamConfig().limits.maxConcurrentRuns, 3);
  deck.savePersonal({ limits: { maxConcurrentRuns: null } }, allowed);
  assert.equal(deck.config().limits.maxConcurrentRuns, 3);
  assert.throws(() => deck.savePersonal({ limits: { maxConcurrentRuns: 0 } }, allowed), /1 to 10/);
  assert.throws(() => deck.savePersonal({ limits: { dailyBudgetUsd: 5 } }, allowed), /Unknown setting/);
  assert.throws(() => deck.savePersonal({ defaults: { effort: "turbo" } }, allowed), /Unknown effort/);
});

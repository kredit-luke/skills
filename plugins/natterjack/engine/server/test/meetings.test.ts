// meetings.json and the MeetingSource registry, against a scratch config folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Meetings, meetingsConfig, supportedSources } from "../src/meetings/index.ts";

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), "dash-meetings-"));
const write = (data: unknown) => {
  const file = path.join(CFG, "meetings.json");
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  // Config is cached by mtime; make sure a rewrite within the same tick is seen.
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(file, t, t);
};

test("no meetings.json: not configured, and no Meetings page", () => {
  const m = new Meetings(CFG);
  assert.equal(meetingsConfig(CFG), null);
  assert.equal(m.get(), null);
  assert.equal(m.boot(), null);
  assert.equal(m.status().configured, false);
});

test("roam: configured and coming soon; list and get say they aren't available yet", async () => {
  assert.deepEqual(supportedSources(), ["roam"]);
  write({ source: "roam" });
  const m = new Meetings(CFG);
  assert.deepEqual(m.boot(), { source: "roam", label: "Roam" });
  assert.deepEqual(m.status(), { source: "roam", label: "Roam", configured: true, supported: true, connected: false, comingSoon: true, message: "Roam meetings are coming soon." });
  await assert.rejects(m.get()!.listMeetings({}), /isn't available yet/);
  await assert.rejects(m.get()!.meeting("x"), /isn't available yet/);
  assert.equal(m.get()!.meetingUrl("x"), null);

  write({ source: "Roam", label: "Team calls" });
  assert.deepEqual(m.boot(), { source: "roam", label: "Team calls" });
});

test("an unknown source or a broken file: the page shows, saying what's wrong", () => {
  const m = new Meetings(CFG);
  write({ source: "zoom" });
  let s = m.status();
  assert.equal(s.configured, true);
  assert.equal(s.supported, false);
  assert.equal(s.comingSoon, false);
  assert.match(s.message, /"zoom" meetings aren't supported yet \(known: roam\)/);
  assert.deepEqual(m.boot(), { source: "zoom", label: "zoom" });

  write({ label: "Calls" });
  assert.match(m.status().message, /"source" names the meeting tool/);
  write("{ not json");
  s = m.status();
  assert.equal(s.supported, false);
  assert.match(s.message, /^meetings\.json: /);
});

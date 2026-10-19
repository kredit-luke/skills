// meetings.json and the MeetingSource registry, against a scratch config folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_REDIRECT_URI, Meetings, NoSource, meetingsConfig, supportedSources } from "../src/meetings/index.ts";
import { RoamError } from "../src/meetings/roam-api.ts";
import { NOT_CONNECTED } from "../src/meetings/roam-auth.ts";

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), "dash-meetings-"));
const LEDGER = fs.mkdtempSync(path.join(os.tmpdir(), "dash-meetings-ledger-"));
const CTX = { ledgerDir: LEDGER, hosted: false };
const write = (data: unknown) => {
  const file = path.join(CFG, "meetings.json");
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  // Config is cached by mtime; make sure a rewrite within the same tick is seen.
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(file, t, t);
};

test("no meetings.json: not configured, and no Meetings page", () => {
  const m = new Meetings(CFG, CTX);
  assert.equal(meetingsConfig(CFG), null);
  assert.equal(m.get(), null);
  assert.equal(m.boot(), null);
  assert.equal(m.status().configured, false);
});

test("roam: configured and not connected; sign-in follows clientId; reading says connect first", async () => {
  assert.deepEqual(supportedSources(), ["roam"]);
  write({ source: "roam" });
  const m = new Meetings(CFG, CTX);
  assert.deepEqual(m.boot(), { source: "roam", label: "Roam" });
  assert.deepEqual(m.status(), { source: "roam", label: "Roam", configured: true, supported: true, connected: false, viewer: null, via: null, signIn: false, signInProblem: null, message: "Connect your Roam account to see your meetings." });
  assert.ok(!("comingSoon" in m.status()), "nothing is coming soon any more");
  // No token stored: every read is "connect again" (401), without a call to Roam.
  await assert.rejects(m.get()!.listMeetings({}), (e: any) => e instanceof RoamError && e.code === NOT_CONNECTED);
  await assert.rejects(m.get()!.meeting("x"), (e: any) => e instanceof RoamError && e.code === NOT_CONNECTED);
  await assert.rejects(m.get()!.shareLink("x"), (e: any) => e instanceof RoamError && e.code === NOT_CONNECTED);

  write({ source: "roam", clientId: "abc-123" });
  assert.equal(m.status().signIn, true);
  assert.equal(m.status().connected, false);

  write({ source: "Roam", label: "Team calls" });
  assert.deepEqual(m.boot(), { source: "roam", label: "Team calls" });
  assert.equal(m.status().signIn, false);
});

test("an unknown source or a broken file: the page shows, saying what's wrong", async () => {
  const m = new Meetings(CFG, CTX);
  write({ source: "zoom" });
  let s = m.status();
  assert.equal(s.configured, true);
  assert.equal(s.supported, false);
  assert.equal(s.connected, false);
  assert.equal(s.signIn, false);
  assert.equal(s.viewer, null);
  assert.match(s.message, /"zoom" meetings aren't supported yet \(known: roam\)/);
  assert.deepEqual(m.boot(), { source: "zoom", label: "zoom" });
  await assert.rejects(m.get()!.listMeetings({}), /aren't supported yet/);
  await assert.rejects(m.get()!.connect("t"), /aren't supported yet/);
  assert.equal(await m.get()!.shareLink("x"), null);
  assert.equal(await m.get()!.transcript("x", new Map()), null);

  write({ label: "Calls" });
  assert.match(m.status().message, /"source" names the meeting tool/);
  write("{ not json");
  s = m.status();
  assert.equal(s.supported, false);
  assert.match(s.message, /^meetings\.json: /);
});

test("a known tool whose settings have an error is not supported: the page says it isn't available", () => {
  const m = new Meetings(CFG, CTX);
  write({ source: "roam" });
  const cfg = meetingsConfig(CFG)!;
  // Stand in for a roam config the engine refused: Meetings.get() falls back to a NoSource for it.
  m.current = { sig: JSON.stringify(cfg), source: new NoSource({ ...cfg, error: "meetings.json: something's wrong" }) };
  const s = m.status();
  assert.equal(s.source, "roam");
  assert.equal(s.configured, true);
  assert.equal(s.supported, false);
  assert.equal(s.connected, false);
  assert.equal(s.message, "meetings.json: something's wrong");
});

test("meetings.json: clientId and redirectUri, with the redirect defaulted", () => {
  write({ source: "roam" });
  assert.deepEqual(meetingsConfig(CFG), { source: "roam", label: "Roam", clientId: null, redirectUri: DEFAULT_REDIRECT_URI, error: null, signInProblem: null });
  assert.equal(DEFAULT_REDIRECT_URI, "http://localhost:31417/roam/callback");

  write({ source: "roam", clientId: " abc-123 ", redirectUri: "http://127.0.0.1:4000/cb" });
  assert.deepEqual(meetingsConfig(CFG), { source: "roam", label: "Roam", clientId: "abc-123", redirectUri: "http://127.0.0.1:4000/cb", error: null, signInProblem: null });
  write({ source: "roam", redirectUri: "http://[::1]:4000/cb" });
  assert.equal(meetingsConfig(CFG)!.signInProblem, null);
  // An explicit null, or a blank string, is the same as leaving the key out (for both keys).
  write({ source: "roam", clientId: null, redirectUri: null });
  assert.deepEqual(meetingsConfig(CFG), { source: "roam", label: "Roam", clientId: null, redirectUri: DEFAULT_REDIRECT_URI, error: null, signInProblem: null });
  write({ source: "roam", clientId: "  ", redirectUri: "" });
  assert.deepEqual(meetingsConfig(CFG), { source: "roam", label: "Roam", clientId: null, redirectUri: DEFAULT_REDIRECT_URI, error: null, signInProblem: null });
  write({ source: "roam", clientId: "", redirectUri: " " });
  assert.deepEqual(meetingsConfig(CFG), { source: "roam", label: "Roam", clientId: null, redirectUri: DEFAULT_REDIRECT_URI, error: null, signInProblem: null });

  const m = new Meetings(CFG, CTX);
  write({ source: "roam", clientId: "abc-123" });
  assert.equal(m.status().signIn, true);
  assert.equal(m.status().signInProblem, null);
});

test("meetings.json: a bad clientId or redirectUri turns sign-in off and says why; the source still works", () => {
  const m = new Meetings(CFG, CTX);
  const bad: [unknown, RegExp][] = [
    [{ clientId: 42 }, /"clientId" must be the OAuth app's client ID/],
    [{ redirectUri: 5 }, /"redirectUri" must be a string/],
    [{ redirectUri: "not a url" }, /"redirectUri" isn't a URL/],
    [{ redirectUri: "https://localhost:31417/roam/callback" }, /must start with http:\/\//],
    [{ redirectUri: "http://example.com:31417/roam/callback" }, /must be on localhost, 127\.0\.0\.1 or \[::1\]/],
    [{ redirectUri: "http://localhost/roam/callback" }, /needs an explicit port/],
    [{ redirectUri: "http://localhost:0/roam/callback" }, /needs a real port, not 0/],
    [{ redirectUri: "http://127.0.0.1:80/roam/callback" }, /can't use port 80/],
    [{ redirectUri: "http://localhost:80" }, /can't use port 80/],
  ];
  for (const [extra, re] of bad) {
    // A good clientId alongside: sign-in still goes off.
    write({ source: "roam", clientId: "abc-123", ...(extra as object) });
    const cfg = meetingsConfig(CFG)!;
    assert.equal(cfg.error, null, JSON.stringify(extra));
    assert.match(cfg.signInProblem || "", re, JSON.stringify(extra));
    const s = m.status();
    assert.equal(s.supported, true);
    assert.equal(s.signIn, false);
    assert.match(s.signInProblem || "", re);
    assert.equal(m.get()!.kind, "roam");
  }
});

// Tickets made from meetings (meetings/tickets.ts): the marker, what an Ask run reports in its
// outputs and how it's recorded, each tracker's search for the marker, and the merge the
// list and detail routes return (a failing or slow tracker leaves the recorded ones).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Meeting } from "../../shared/api.ts";
import { Attachments } from "../src/attachments.ts";
import type { IssueTracker, LinkedIssue, LinkedIssues } from "../src/issues/index.ts";
import { byMarker, hasMarker } from "../src/issues/markers.ts";
import { JiraTracker, adfText, linkedJql } from "../src/issues/jira.ts";
import { GitHubTracker, markerQueries } from "../src/issues/github.ts";
import { LinearTracker, linkedFilter } from "../src/issues/linear.ts";
import {
  MeetingTicketLinks, MeetingTickets, TICKETS_FILE, TICKET_CAPS, meetingMarker, mergeTickets, parseRunTickets, readRunTickets, recordRunTickets, trackerUrl,
} from "../src/meetings/tickets.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dash-meeting-tickets-"));
const UUID = "3f2a9c1e-77b0-4d8e-9a51-0c6b2f1d4e88";

test("meetingMarker: <source>-meeting-<id>, lowercase, the same for prompt and search", () => {
  assert.equal(meetingMarker("roam", UUID), `roam-meeting-${UUID}`);
  assert.equal(meetingMarker("Roam", "m_1"), "roam-meeting-m_1");
  assert.equal(meetingMarker("Some Tool!", "x"), "some-tool-meeting-x");
  assert.equal(meetingMarker("", "x"), "meeting-meeting-x");
});

test("hasMarker: the whole marker only, not a longer id that starts with it", () => {
  const m = "roam-meeting-abc";
  assert.ok(hasMarker("From Roam meeting: Sync, 2026-10-19 · ref roam-meeting-abc", m));
  assert.ok(hasMarker("ref roam-meeting-abc.", m));
  assert.ok(hasMarker("`roam-meeting-abc`", m));
  assert.ok(!hasMarker("ref roam-meeting-abcd", m));
  assert.ok(!hasMarker("ref xroam-meeting-abc", m));
  assert.ok(!hasMarker("ref roam-meeting-abc-2", m));
  assert.ok(hasMarker("ref roam-meeting-abcd and ref roam-meeting-abc", m), "a later exact one counts");
  assert.ok(!hasMarker("anything", ""));
  const a: LinkedIssue = { key: "ENG-1", url: "u", title: "t", state: "s" };
  const found = byMarker(["roam-meeting-a", "roam-meeting-b"], [{ issue: a, text: "ref roam-meeting-a ref roam-meeting-b" }, { issue: a, text: "ref roam-meeting-a" }]);
  assert.deepEqual(found.get("roam-meeting-a"), [a], "one per key");
  assert.deepEqual(found.get("roam-meeting-b"), [a]);
});

test("parseRunTickets: by string key, title optional, any url ignored; junk skipped; capped", () => {
  const ok = parseRunTickets([
    { key: "ENG-12", url: "https://acme.atlassian.net/browse/ENG-12", title: "Fix the  export\n" },
    { key: "ENG-12", url: "https://acme.atlassian.net/browse/ENG-12", title: "dupe" },
    { key: "api#4" },
    { key: "ENG-13", url: "javascript:alert(1)", title: "x" },
    { key: 15, url: "https://x.example" },
    { url: "https://x.example" },
    { key: "  " },
    { key: "K".repeat(TICKET_CAPS.key + 1) },
    "ENG-16", null, [1],
  ]);
  assert.deepEqual(ok, [
    { key: "ENG-12", title: "Fix the export" },
    { key: "api#4", title: "" },
    { key: "ENG-13", title: "x" },
  ]);
  assert.deepEqual(parseRunTickets({ key: "ENG-1" }), []);
  assert.deepEqual(parseRunTickets(null), []);
  const many = parseRunTickets(Array.from({ length: 80 }, (_, i) => ({ key: `E-${i}`, title: "t".repeat(1000) })));
  assert.equal(many.length, TICKET_CAPS.perFile);
  assert.equal(many[0].title.length, TICKET_CAPS.title);
});

test("readRunTickets: missing, garbled, too big and a BOM", () => {
  const dir = tmp();
  const f = path.join(dir, TICKETS_FILE);
  assert.deepEqual(readRunTickets(null), []);
  assert.deepEqual(readRunTickets(f), [], "missing");
  fs.writeFileSync(f, "[{\"key\": \"ENG-1\", ");
  assert.deepEqual(readRunTickets(f), [], "garbled");
  fs.writeFileSync(f, "﻿" + JSON.stringify([{ key: "ENG-1", url: "https://x.example/ENG-1", title: "One" }]));
  assert.deepEqual(readRunTickets(f), [{ key: "ENG-1", title: "One" }]);
  fs.writeFileSync(f, JSON.stringify([{ key: "ENG-1", url: "https://x.example/ENG-1", title: "x".repeat(TICKET_CAPS.fileBytes) }]));
  assert.deepEqual(readRunTickets(f), [], "too big");
});

test("recordRunTickets: a meetings run's file in its outputs is recorded against its meeting, merged by key", () => {
  const ledger = tmp();
  const files = new Attachments(ledger);
  const store = new MeetingTickets(ledger);
  const run = (id: string, list: unknown, meta: Partial<{ trigger: string; meetingId: string }> = {}) => {
    fs.writeFileSync(path.join(files.ensureOutputs(id), TICKETS_FILE), typeof list === "string" ? list : JSON.stringify(list));
    recordRunTickets(store, { id, trigger: "meetings", meetingId: UUID, ...meta }, files.output(id, TICKETS_FILE));
  };

  run("20261019120000-aaaaaa", [{ key: "ENG-1", url: "https://acme.atlassian.net/browse/ENG-1", title: "One" }, { key: "ENG-2", url: "https://acme.atlassian.net/browse/ENG-2", title: "Two" }]);
  let got = store.forMeeting(UUID);
  assert.deepEqual(got.map((t) => [t.key, t.title, t.runId]), [["ENG-1", "One", "20261019120000-aaaaaa"], ["ENG-2", "Two", "20261019120000-aaaaaa"]]);
  assert.ok(got.every((t) => !Number.isNaN(Date.parse(t.at))));
  const firstAt = got[0].at;

  // A later turn (or run) reporting ENG-1 again updates it in place, keeping when it was first seen; ENG-3 is added.
  run("20261019130000-bbbbbb", [{ key: "ENG-1", url: "https://acme.atlassian.net/browse/ENG-1", title: "One, renamed" }, { key: "ENG-3", url: "https://acme.atlassian.net/browse/ENG-3", title: "Three" }]);
  got = store.forMeeting(UUID);
  assert.deepEqual(got.map((t) => [t.key, t.title, t.runId]), [["ENG-1", "One, renamed", "20261019120000-aaaaaa"], ["ENG-2", "Two", "20261019120000-aaaaaa"], ["ENG-3", "Three", "20261019130000-bbbbbb"]]);
  assert.equal(got[0].at, firstAt);

  // Garbled, missing, no key, another trigger, no meeting: nothing changes, nothing throws.
  run("20261019140000-cccccc", "not json");
  run("20261019140000-dddddd", [{ url: "https://x.example/9" }]);
  run("20261019140000-eeeeee", [{ key: "ENG-8", url: "https://x.example/8" }], { trigger: "manual" });
  run("20261019140000-ffffff", [{ key: "ENG-7", url: "https://x.example/7" }], { meetingId: "../x" });
  recordRunTickets(store, { id: "20261019140000-000000", trigger: "meetings", meetingId: UUID }, files.output("20261019140000-000000", TICKETS_FILE));
  assert.equal(store.forMeeting(UUID).length, 3);
  assert.deepEqual(Object.keys(store.all()), [UUID]);
  assert.ok(!fs.readFileSync(store.file, "utf-8").includes("https://"), "a run's url isn't kept");

  // Written whole (no temp file left), and a broken ledger reads as empty rather than throwing.
  assert.deepEqual(fs.readdirSync(ledger).filter((f) => f.endsWith(".tmp")), []);
  fs.writeFileSync(path.join(ledger, TICKETS_FILE), "{broken");
  assert.deepEqual(store.forMeeting(UUID), []);
  run("20261019150000-aaaaaa", [{ key: "ENG-4", url: "https://x.example/4" }]);
  assert.deepEqual(store.forMeeting(UUID).map((t) => t.key), ["ENG-4"]);

  // An id like "__proto__" is just a key.
  store.record("__proto__", "r", [{ key: "P-1", title: "" }]);
  assert.deepEqual(store.forMeeting("__proto__").map((t) => t.key), ["P-1"]);
  assert.equal(({} as any)["P-1"], undefined);
});

test("MeetingTickets: a meeting keeps up to perMeeting tickets, all read back, the newest kept when trimmed", () => {
  const store = new MeetingTickets(tmp());
  const tickets = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ key: `E-${from + i}`, title: "" }));
  store.record("m1", "run-1", tickets(0, 60));
  assert.equal(store.forMeeting("m1").length, 60, "more than a file's 50 read back");
  store.record("m1", "run-2", tickets(60, 50));
  const got = store.forMeeting("m1").map((t) => t.key);
  assert.equal(got.length, TICKET_CAPS.perMeeting);
  assert.equal(got[0], "E-10");
  assert.equal(got.at(-1), "E-109");
  // A ledger edited past the cap: the newest are read.
  fs.writeFileSync(store.file, JSON.stringify({ m1: [...tickets(0, 120)] }));
  assert.deepEqual([store.forMeeting("m1")[0].key, store.forMeeting("m1").length], ["E-20", TICKET_CAPS.perMeeting]);
  // An older ledger with each run's url: still read, by key, the url dropped.
  fs.writeFileSync(store.file, JSON.stringify({ m1: [{ key: "E-1", url: "https://x.example/E-1", title: "One", runId: "r", at: "2026-10-19T00:00:00.000Z" }] }));
  assert.deepEqual(store.forMeeting("m1"), [{ key: "E-1", title: "One", runId: "r", at: "2026-10-19T00:00:00.000Z" }]);
});

test("issueUrl: Jira and Linear build links only for their keys", () => {
  const ledger = tmp();
  const jira = new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: [] } as any);
  const linear = new LinearTracker(ledger, { kind: "linear", org: "acme" } as any);
  const templated = new LinearTracker(ledger, { kind: "linear", urlTemplate: "https://lin.example/i/{id}" } as any);
  assert.equal(jira.issueUrl("ENG-12"), "https://acme.atlassian.net/browse/ENG-12");
  assert.equal(linear.issueUrl("ENG-12"), "https://linear.app/acme/issue/ENG-12");
  assert.equal(templated.issueUrl("ENG-12"), "https://lin.example/i/ENG-12");
  for (const bad of ["ENG-1/../../x", "ENG-1?jql=x", "ENG-1#x", "a.b-1", "1ENG-2", "ENG-", "ENG", "-1", "ENG-1 ", "api#4", "", "{id}"]) {
    assert.equal(jira.issueUrl(bad), null, `jira ${JSON.stringify(bad)}`);
    assert.equal(linear.issueUrl(bad), null, `linear ${JSON.stringify(bad)}`);
    assert.equal(templated.issueUrl(bad), null, `templated ${JSON.stringify(bad)}`);
  }
});

test("issueUrlTemplate: the boot payload's urlTemplate, with the {id} placeholder; GitHub has none", () => {
  const ledger = tmp();
  assert.equal(new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: [] } as any).issueUrlTemplate(), "https://acme.atlassian.net/browse/{id}");
  assert.equal(new JiraTracker(ledger, { kind: "jira", site: "", projects: [] } as any).issueUrlTemplate(), null);
  assert.equal(new LinearTracker(ledger, { kind: "linear", org: "acme" } as any).issueUrlTemplate(), "https://linear.app/acme/issue/{id}");
  assert.equal(new LinearTracker(ledger, { kind: "linear", urlTemplate: "https://lin.example/i/{id}" } as any).issueUrlTemplate(), "https://lin.example/i/{id}");
  assert.equal(new LinearTracker(ledger, { kind: "linear" } as any).issueUrlTemplate(), null);
  const gh: IssueTracker = new GitHubTracker({ kind: "github", repos: ["acme/web"] } as any);
  assert.equal(gh.issueUrlTemplate?.() ?? null, null);
});

test("trackerUrl: only links each tracker's issueUrl builds for its own ids; no tracker, no link", () => {
  const ledger = tmp();
  fs.writeFileSync(path.join(ledger, "jira-api-token"), "ada@acme.example:ATATT0123456789");
  const jira = new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: [] } as any);
  assert.equal(trackerUrl(jira, "ENG-12"), "https://acme.atlassian.net/browse/ENG-12");
  assert.equal(trackerUrl(jira, "eng_2-7"), "https://acme.atlassian.net/browse/eng_2-7");
  for (const bad of ["ENG-1/../../x", "ENG-1?jql=x", "ENG-1#x", "a.b-1", "1ENG-2", "ENG-", "ENG", "-1", "ENG-1 ", "api#4", "", "{id}"]) {
    assert.equal(trackerUrl(jira, bad), "", JSON.stringify(bad));
  }
  const linear = new LinearTracker(ledger, { kind: "linear", org: "acme" } as any);
  assert.equal(trackerUrl(linear, "ENG-3"), "https://linear.app/acme/issue/ENG-3");
  assert.equal(trackerUrl(linear, "ENG-3/x"), "");
  assert.equal(trackerUrl(linear, "{id}"), "");
  const gh = new GitHubTracker({ kind: "github", repos: ["acme/web"] } as any);
  assert.equal(trackerUrl(gh, "web#4"), "https://github.com/acme/web/issues/4");
  assert.equal(trackerUrl(gh, "api#4"), "");
  assert.equal(trackerUrl(null, "ENG-1"), "");
});

test("mergeTickets: one per key (or link); the tracker's title and link win and it counts as the tracker's", () => {
  const recorded = [
    { key: "ENG-1", url: "https://acme.atlassian.net/browse/ENG-1", title: "Old title" },
    { key: "#4", url: "https://github.com/acme/api/issues/4/", title: "Four" },
    { key: "ENG-2", url: "https://acme.atlassian.net/browse/ENG-2", title: "Two" },
  ];
  const found: LinkedIssue[] = [
    { key: "ENG-1", url: "https://acme.atlassian.net/browse/ENG-1", title: "New title", state: "Done" },
    { key: "api#4", url: "https://github.com/acme/api/issues/4", title: "Four (tracker)", state: "Open" },
    { key: "ENG-5", url: "https://acme.atlassian.net/browse/ENG-5", title: "Five", state: "To Do" },
  ];
  assert.deepEqual(mergeTickets(recorded, found), [
    { key: "ENG-1", url: "https://acme.atlassian.net/browse/ENG-1", title: "New title", source: "tracker" },
    { key: "api#4", url: "https://github.com/acme/api/issues/4", title: "Four (tracker)", source: "tracker" },
    { key: "ENG-2", url: "https://acme.atlassian.net/browse/ENG-2", title: "Two", source: "run" },
    { key: "ENG-5", url: "https://acme.atlassian.net/browse/ENG-5", title: "Five", source: "tracker" },
  ]);
  assert.deepEqual(mergeTickets([], []), []);
});

// ---- the merge the routes return

const meeting = (id: string): Meeting => ({ id, title: id, startedAt: "2026-10-19T15:00:00Z", endedAt: null, participantCount: 1, host: null, summary: null, actionItems: null, tickets: [] });

function fakeTracker(answer: (markers: string[]) => Promise<Map<string, LinkedIssue[]>>, connected = true) {
  const calls: string[][] = [];
  const t = {
    kind: "jira", cache: null,
    status: () => ({ connected, source: "file" as const, viewer: null }),
    issueUrl: (id: string) => `https://x.example/${id}`,
    linkedIssues: (markers: string[]) => { calls.push(markers); return answer(markers); },
  } as unknown as IssueTracker;
  return { t, calls };
}

test("MeetingTicketLinks: one tracker call per page, merged with the ledger; cached per marker set", async () => {
  const ledger = tmp();
  const store = new MeetingTickets(ledger);
  store.record("m1", "run-1", [{ key: "ENG-1", title: "Recorded" }]);
  const { t, calls } = fakeTracker(async (markers) => new Map([[markers[1], [{ key: "ENG-7", url: "https://x.example/ENG-7", title: "Found", state: "To Do" }]]]));
  const links = new MeetingTicketLinks(store);
  const out = await links.attach("roam", [meeting("m1"), meeting("m2"), meeting("m3")], t);
  assert.deepEqual(calls, [["roam-meeting-m1", "roam-meeting-m2", "roam-meeting-m3"]]);
  assert.deepEqual(out.map((m) => m.tickets), [
    [{ key: "ENG-1", url: "https://x.example/ENG-1", title: "Recorded", source: "run" }],
    [{ key: "ENG-7", url: "https://x.example/ENG-7", title: "Found", source: "tracker" }],
    [],
  ]);
  // The same page again within the minute: no second search. A detail on that page uses the page's search;
  // one that isn't on it is its own call.
  await links.attach("roam", [meeting("m1"), meeting("m2"), meeting("m3")], t);
  assert.equal(calls.length, 1);
  const [one] = await links.attach("roam", [meeting("m2")], t);
  assert.equal(calls.length, 1);
  assert.deepEqual(one.tickets, [{ key: "ENG-7", url: "https://x.example/ENG-7", title: "Found", source: "tracker" }]);
  await links.attach("roam", [meeting("m4")], t);
  assert.deepEqual(calls[1], ["roam-meeting-m4"]);
  // Expired: searched again.
  const quick = new MeetingTicketLinks(store, { ttlMs: 0 });
  await quick.attach("roam", [meeting("m1")], t);
  await quick.attach("roam", [meeting("m1")], t);
  assert.equal(calls.length, 4);
});

test("MeetingTicketLinks: a detail reuses the newest page search that covered it, never one that hit its result cap", async () => {
  const store = new MeetingTickets(tmp());
  let n = 0;
  let cap = false;
  const { t, calls } = fakeTracker(async (markers) => {
    n++;
    const found: LinkedIssues = new Map([[markers[0], [{ key: `ENG-${n}`, url: `https://x.example/ENG-${n}`, title: `Search ${n}`, state: "" }]]]);
    if (cap) found.truncated = true;
    return found;
  });
  const links = new MeetingTicketLinks(store);
  // Two pages that both hold m2 (a reload that shifted the list): the detail takes the later one.
  await links.attach("roam", [meeting("m2"), meeting("m1")], t);
  await new Promise((r) => setTimeout(r, 5));
  await links.attach("roam", [meeting("m2"), meeting("m3")], t);
  const [two] = await links.attach("roam", [meeting("m2")], t);
  assert.equal(calls.length, 2);
  assert.deepEqual(two.tickets.map((x) => x.key), ["ENG-2"]);

  // A page whose search hit the cap may have missed the detail's ticket: the detail searches on its own.
  const capped = new MeetingTicketLinks(store);
  cap = true;
  await capped.attach("roam", [meeting("m5"), meeting("m6")], t);
  cap = false;
  const [five] = await capped.attach("roam", [meeting("m5")], t);
  assert.deepEqual(calls.at(-1), ["roam-meeting-m5"]);
  assert.equal(calls.length, 4);
  assert.deepEqual(five.tickets.map((x) => x.key), ["ENG-4"]);
});

test("MeetingTicketLinks: a run's link is built by the tracker from the key, never taken as given", async () => {
  const ledgerDir = tmp();
  const store = new MeetingTickets(ledgerDir);
  // What a run's file says, url and all: only the key and title are kept.
  recordRunTickets(store, { id: "run-1", trigger: "meetings", meetingId: "m1" }, (() => {
    const f = path.join(ledgerDir, "run-file.json");
    fs.writeFileSync(f, JSON.stringify([
      { key: "ENG-1", url: "https://evil.example/phish", title: "Off-tracker link" },
      { key: "api#4", url: "https://evil.example/4", title: "Unknown to the tracker" },
    ]));
    return f;
  })());
  const ledger = tmp();
  fs.writeFileSync(path.join(ledger, "jira-api-token"), "ada@acme.example:ATATT0123456789");
  const jira = new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: [] } as any);
  (jira as any)._get = async () => ({ issues: [] });
  const [m] = await new MeetingTicketLinks(store).attach("roam", [meeting("m1")], jira);
  // "api#4" isn't a Jira key, so no link rather than one with a fragment in it.
  assert.deepEqual(m.tickets.map((x) => [x.key, x.url]), [["ENG-1", "https://acme.atlassian.net/browse/ENG-1"], ["api#4", ""]]);
  // GitHub knows only its repos: a key outside them gets no link. No tracker: no links.
  const gh = new GitHubTracker({ kind: "github", repos: ["acme/web"] } as any);
  gh.gh = async () => [];
  const [g] = await new MeetingTicketLinks(store).attach("roam", [meeting("m1")], gh);
  assert.deepEqual(g.tickets.map((x) => x.url), ["", ""]);
  const [n] = await new MeetingTicketLinks(store).attach("roam", [meeting("m1")], null);
  assert.deepEqual(n.tickets.map((x) => [x.key, x.url, x.title]), [["ENG-1", "", "Off-tracker link"], ["api#4", "", "Unknown to the tracker"]]);
});

test("MeetingTicketLinks: an id that isn't one never reaches the tracker; quotes never reach a GitHub query", async () => {
  const store = new MeetingTickets(tmp());
  const { t, calls } = fakeTracker(async () => new Map());
  const out = await new MeetingTicketLinks(store).attach("roam", [meeting("m1"), meeting('a" OR "b'), meeting("x".repeat(101))], t);
  assert.deepEqual(calls, [["roam-meeting-m1"]]);
  assert.deepEqual(out.map((m) => m.tickets), [[], [], []]);
  const none = fakeTracker(async () => new Map());
  await new MeetingTicketLinks(store).attach("roam", [meeting("../x")], none.t);
  assert.equal(none.calls.length, 0, "no valid id: no search");
  assert.deepEqual(markerQueries(['roam-meeting-a"b\\c', '""']), ['"roam-meeting-abc"']);
});

test("MeetingTicketLinks: no tracker, not connected, failing or slow: the recorded tickets only", async () => {
  const ledger = tmp();
  const store = new MeetingTickets(ledger);
  store.record("m1", "run-1", [{ key: "ENG-1", title: "Recorded" }]);
  const recordedOnly = [{ key: "ENG-1", url: "https://x.example/ENG-1", title: "Recorded", source: "run" }];
  // A fresh one per case: the fake trackers share a kind, so they'd share the cache.
  const links = () => new MeetingTicketLinks(store, { timeoutMs: 50 });

  // No tracker to build the link: the ticket without one.
  const unlinked = [{ ...recordedOnly[0], url: "" }];
  assert.deepEqual((await links().attach("roam", [meeting("m1")], null))[0].tickets, unlinked);
  // No linkedIssues (NoTracker) or not connected: never called.
  const none = { kind: "none", cache: null, status: () => ({ connected: false, source: null, viewer: null }), issueUrl: () => null } as unknown as IssueTracker;
  assert.deepEqual((await links().attach("roam", [meeting("m1")], none))[0].tickets, unlinked);
  const off = fakeTracker(async () => { throw new Error("should not be called"); }, false);
  assert.deepEqual((await links().attach("roam", [meeting("m1")], off.t))[0].tickets, recordedOnly);
  assert.equal(off.calls.length, 0);

  const warn = console.warn;
  console.warn = () => {};
  try {
    // Rejects: recorded only, and the failure isn't cached: the next load searches again.
    let fail = true;
    const bad = fakeTracker(async (markers) => {
      if (fail) throw new Error("boom");
      return new Map([[markers[0], [{ key: "ENG-3", url: "https://x.example/ENG-3", title: "Back", state: "" }]]]);
    });
    const badLinks = links();
    assert.deepEqual((await badLinks.attach("roam", [meeting("m1")], bad.t))[0].tickets, recordedOnly);
    fail = false;
    const again = await badLinks.attach("roam", [meeting("m1")], bad.t);
    assert.equal(bad.calls.length, 2);
    assert.deepEqual(again[0].tickets.map((x) => x.key), ["ENG-1", "ENG-3"]);
    // Throws synchronously (not a rejected promise): the same, never into the route.
    const sync = fakeTracker((() => { throw new Error("sync boom"); }) as any);
    const syncLinks = links();
    assert.deepEqual((await syncLinks.attach("roam", [meeting("m1")], sync.t))[0].tickets, recordedOnly);
    await syncLinks.attach("roam", [meeting("m1")], sync.t);
    assert.equal(sync.calls.length, 2, "not cached either");
  } finally { console.warn = warn; }

  // Slow: the page doesn't wait past the timeout; the search carries on and the next load uses it.
  let release!: () => void;
  const slow = fakeTracker((markers) => new Promise((resolve) => { release = () => resolve(new Map([[markers[0], [{ key: "ENG-9", url: "https://x.example/ENG-9", title: "Late", state: "" }]]])); }));
  const slowLinks = links();
  const started = Date.now();
  assert.deepEqual((await slowLinks.attach("roam", [meeting("m1")], slow.t))[0].tickets, recordedOnly);
  assert.ok(Date.now() - started < 2000);
  release();
  const later = await slowLinks.attach("roam", [meeting("m1")], slow.t);
  assert.equal(slow.calls.length, 1, "the cached search, not a new one");
  assert.deepEqual(later[0].tickets.map((x) => [x.key, x.source]), [["ENG-1", "run"], ["ENG-9", "tracker"]]);
});

// ---- each tracker's search

test("jira linkedIssues: one JQL text search in the configured projects, then only exact markers in the description", async () => {
  const ledger = tmp();
  fs.writeFileSync(path.join(ledger, "jira-api-token"), "ada@acme.example:ATATT0123456789");
  const jira = new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: ["ENG", "OPS"] } as any);
  const desc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "From Roam meeting: Sync, 2026-10-19 15:00 UTC · " }, { type: "text", text, marks: [{ type: "code" }] }] }] });
  const sent: any[] = [];
  (jira as any)._get = async (_cred: string, p: string, body: any) => {
    sent.push({ p, body });
    return { issues: [
      { key: "ENG-1", fields: { summary: "One", status: { name: "To Do" }, description: desc("ref roam-meeting-a1") } },
      { key: "ENG-2", fields: { summary: "Near miss", status: { name: "Done" }, description: desc("ref roam-meeting-a10") } },
      { key: "OPS-3", fields: { summary: "Three", status: { name: "Done" }, description: desc("ref roam-meeting-b2") } },
      { key: "OPS-4", fields: { summary: "No description", status: { name: "Done" } } },
    ] };
  };
  const found = await jira.linkedIssues(["roam-meeting-a1", "roam-meeting-b2", "roam-meeting-c3"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].p, "/rest/api/3/search/jql");
  assert.deepEqual(sent[0].body.fields, ["summary", "status", "description"]);
  assert.equal(sent[0].body.jql, 'project in ("ENG", "OPS") AND (text ~ "\\"roam-meeting-a1\\"" OR text ~ "\\"roam-meeting-b2\\"" OR text ~ "\\"roam-meeting-c3\\"") ORDER BY updated DESC');
  assert.deepEqual(found.get("roam-meeting-a1"), [{ key: "ENG-1", url: "https://acme.atlassian.net/browse/ENG-1", title: "One", state: "To Do" }]);
  assert.deepEqual(found.get("roam-meeting-b2"), [{ key: "OPS-3", url: "https://acme.atlassian.net/browse/OPS-3", title: "Three", state: "Done" }]);
  assert.equal(found.get("roam-meeting-c3"), undefined);
  assert.equal(found.truncated, undefined, "under the cap");
  // A full page (or a next page) means some may be missing.
  (jira as any)._get = async () => ({ issues: Array.from({ length: 100 }, (_, i) => ({ key: `ENG-${i}`, fields: { summary: "", description: desc("ref roam-meeting-a1") } })) });
  assert.equal((await jira.linkedIssues(["roam-meeting-a1"])).truncated, true);
  (jira as any)._get = async () => ({ issues: [], nextPageToken: "t" });
  assert.equal((await jira.linkedIssues(["roam-meeting-a1"])).truncated, true);
  // No projects configured: every project. A failure rejects.
  assert.equal(linkedJql(["m"], []), '(text ~ "\\"m\\"") ORDER BY updated DESC');
  (jira as any)._get = async () => { throw new Error("Jira returned HTTP 500"); };
  await assert.rejects(jira.linkedIssues(["roam-meeting-a1"]), /Jira returned HTTP 500/, "a failure rejects (the caller doesn't cache it)");
  assert.equal(adfText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }] }), "a\nb\n");
});

test("github linkedIssues: gh search issues on bodies, markers OR'd within GitHub's limits, across the configured repos; exact only", async () => {
  const gh = new GitHubTracker({ kind: "github", repos: ["acme/api", "acme/web"] } as any);
  const calls: string[][] = [];
  gh.gh = async (args) => {
    calls.push(args);
    return [
      { number: 4, title: "Four", url: "https://github.com/acme/api/issues/4", body: "From Roam meeting: Sync · ref roam-meeting-a1", state: "open", repository: { name: "api", nameWithOwner: "acme/api" } },
      { number: 5, title: "Near", url: "https://github.com/acme/web/issues/5", body: "ref roam-meeting-a1x", state: "closed", repository: { name: "web", nameWithOwner: "acme/web" } },
    ];
  };
  const found = await gh.linkedIssues(["roam-meeting-a1"]);
  assert.deepEqual(calls, [["search", "issues", '"roam-meeting-a1"', "--match", "body", "--repo", "acme/api", "--repo", "acme/web", "--limit", "100", "--json", "number,title,url,body,state,repository"]]);
  assert.deepEqual(found.get("roam-meeting-a1"), [{ key: "api#4", url: "https://github.com/acme/api/issues/4", title: "Four", state: "Open" }]);
  assert.ok(!found.truncated, "under the cap");
  // A full page means some may be missing.
  const full = gh.gh;
  gh.gh = async () => Array.from({ length: 100 }, (_, i) => ({ number: i, title: "", url: `https://github.com/acme/api/issues/${i}`, body: "ref roam-meeting-a1", state: "open", repository: { name: "api", nameWithOwner: "acme/api" } }));
  assert.equal((await gh.linkedIssues(["roam-meeting-a1"])).truncated, true);
  gh.gh = full;

  // Ten UUID markers: groups of at most six (five ORs) and 256 characters of terms.
  const many = Array.from({ length: 10 }, (_, i) => `roam-meeting-${UUID.slice(0, -2)}${String(i).padStart(2, "0")}`);
  const qs = markerQueries(many);
  assert.ok(qs.length > 1);
  for (const q of qs) {
    assert.ok(q.length <= 256, `${q.length}`);
    assert.ok(q.split(" OR ").length <= 6);
  }
  assert.deepEqual(qs.flatMap((q) => q.split(" OR ").map((s) => s.slice(1, -1))), many);
  assert.deepEqual(markerQueries(Array.from({ length: 8 }, (_, i) => `m${i}`)), ['"m0" OR "m1" OR "m2" OR "m3" OR "m4" OR "m5"', '"m6" OR "m7"']);
  calls.length = 0;
  await gh.linkedIssues(many);
  assert.equal(calls.length, qs.length);

  // gh failing (signed out): rejects. No repos: nothing run.
  gh.gh = async () => { throw new Error("gh: not logged in"); };
  await assert.rejects(gh.linkedIssues(["roam-meeting-a1"]), /gh: not logged in/, "a failure rejects (the caller doesn't cache it)");
  const none = new GitHubTracker({ kind: "github", repos: [] } as any);
  none.gh = async () => { throw new Error("should not run"); };
  assert.equal((await none.linkedIssues(["roam-meeting-a1"])).size, 0);
});

test("linear linkedIssues: a description-contains filter OR'd per marker, exact matches only", async () => {
  const ledger = tmp();
  fs.writeFileSync(path.join(ledger, "linear-api-key"), "lin_api_test");
  const saved = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  try {
    const linear = new LinearTracker(ledger, { kind: "linear", org: "acme" } as any);
    const sent: any[] = [];
    linear.gql = async (key, _q, variables: any) => {
      sent.push({ key, variables });
      return { issues: { nodes: [
        { identifier: "ENG-1", title: "One", url: "https://linear.app/acme/issue/ENG-1", description: "From Roam meeting: Sync · ref roam-meeting-a1", state: { name: "Todo" } },
        { identifier: "ENG-2", title: "Near", url: "https://linear.app/acme/issue/ENG-2", description: "ref roam-meeting-a1_2", state: { name: "Done" } },
      ] } };
    };
    const found = await linear.linkedIssues(["roam-meeting-a1", "roam-meeting-b2"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].key, "lin_api_test");
    assert.deepEqual(sent[0].variables.filter, { or: [{ description: { contains: "roam-meeting-a1" } }, { description: { contains: "roam-meeting-b2" } }] });
    assert.deepEqual(sent[0].variables.filter, linkedFilter(["roam-meeting-a1", "roam-meeting-b2"]));
    assert.deepEqual(found.get("roam-meeting-a1"), [{ key: "ENG-1", url: "https://linear.app/acme/issue/ENG-1", title: "One", state: "Todo" }]);
    assert.equal(found.get("roam-meeting-b2"), undefined);
    assert.ok(!found.truncated, "under the cap");
    // A full page means some may be missing.
    linear.gql = async () => ({ issues: { nodes: Array.from({ length: 100 }, (_, i) => ({ identifier: `ENG-${i}`, title: "", url: `https://linear.app/acme/issue/ENG-${i}`, description: "ref roam-meeting-a1", state: { name: "Todo" } })) } });
    assert.equal((await linear.linkedIssues(["roam-meeting-a1"])).truncated, true);
    linear.gql = async () => { throw new Error("Linear rejected the API key."); };
    await assert.rejects(linear.linkedIssues(["roam-meeting-a1"]), /Linear rejected the API key\./, "a failure rejects (the caller doesn't cache it)");
    // Not connected: no call.
    linear.disconnect();
    linear.gql = async () => { throw new Error("should not run"); };
    assert.equal((await linear.linkedIssues(["roam-meeting-a1"])).size, 0);
  } finally {
    if (saved !== undefined) process.env.LINEAR_API_KEY = saved;
  }
});

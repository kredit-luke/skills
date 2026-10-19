// Roam's API client: requests (headers, params, bodies), the error envelope, and the
// normalizers to shared/api.ts shapes. A stub fetcher stands in for Roam.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROAM_API, ROAM_VERSION, RoamApi, RoamError, roamError, toActionItem, toMeeting, toMeetingDetail, toMeetingPage,
  transcriptText, type RoamFetch,
} from "../src/meetings/roam-api.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fetcher that records each call and answers with `status`, `body` (JSON unless a string) and `headers`. */
function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetcher: RoamFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { calls, api: new RoamApi({ fetcher }) };
}

const LIST_ITEM = {
  id: "m1", title: "Planning", subtitle: "Weekly", start: "2026-10-19T15:00:00Z", participantCount: 4,
  hasVideo: true, videoStatus: "available",
  host: { type: "member", id: "p1", name: "Ada", email: "ada@example.com" },
};

test("list: Roam-Version and Bearer headers, expand + limit, and the cursor passes through", async () => {
  const { calls, api } = stub(200, { ok: true, meetings: [LIST_ITEM], nextCursor: "c2" });
  const page = await api.listMeetings("tok-1", "c1");
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.method, "GET");
  assert.equal(c.headers.Authorization, "Bearer tok-1");
  assert.equal(c.headers["Roam-Version"], ROAM_VERSION);
  assert.equal(ROAM_VERSION, "2026-08-25");
  const u = new URL(c.url);
  assert.equal(`${u.origin}${u.pathname}`, `${ROAM_API}/meeting.list`);
  assert.equal(u.searchParams.get("expand"), "summary,actionItems");
  assert.equal(u.searchParams.get("limit"), "10");
  assert.equal(u.searchParams.get("cursor"), "c1");
  assert.equal(c.body, undefined);
  assert.equal(page.nextCursor, "c2");
  assert.equal(page.meetings[0].id, "m1");

  // The first page sends no cursor at all; a last page has no nextCursor.
  const first = stub(200, { meetings: [] });
  assert.deepEqual(await first.api.listMeetings("t"), { meetings: [], nextCursor: null });
  assert.equal(new URL(first.calls[0].url).searchParams.has("cursor"), false);
});

test("info, transcript, shareLink, token.info and token.revoke: methods, params and bodies", async () => {
  let s = stub(200, { ...LIST_ITEM, end: "2026-10-19T15:30:00Z", participants: [], participantsOmitted: false });
  await s.api.meeting("t", "m1");
  let u = new URL(s.calls[0].url);
  assert.equal(u.pathname, "/v1/meeting.info");
  assert.equal(u.searchParams.get("id"), "m1");
  assert.equal(u.searchParams.get("maxParticipants"), "50");

  s = stub(200, { id: "m1", cues: [{ speakerId: "p1", text: "Hi", start: 0, end: 900 }] });
  assert.deepEqual(await s.api.transcript("t", "m1"), [{ speakerId: "p1", text: "Hi", start: 0, end: 900 }]);
  u = new URL(s.calls[0].url);
  assert.equal(u.pathname, "/v1/meeting.transcript");
  assert.equal(u.searchParams.get("id"), "m1");

  s = stub(200, { id: "m1", url: "https://ro.am/share/abc" });
  assert.equal(await s.api.shareLink("t", "m1"), "https://ro.am/share/abc");
  assert.equal(s.calls[0].method, "POST");
  assert.equal(s.calls[0].url, `${ROAM_API}/meeting.shareLink`);
  assert.equal(s.calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(s.calls[0].body!), { id: "m1" });
  // Only an https: link is handed to the browser.
  for (const url of ["javascript:alert(1)", "http://ro.am/share/abc", "data:text/html,x", "", 42]) {
    s = stub(200, { id: "m1", url });
    assert.equal(await s.api.shareLink("t", "m1"), null, String(url));
  }
  s = stub(200, { id: "m1", url: "HTTPS://ro.am/share/abc" });
  assert.equal(await s.api.shareLink("t", "m1"), "HTTPS://ro.am/share/abc");

  s = stub(200, { user: { id: "u1", name: "Ada Lovelace" }, clientId: "c", scopes: ["meetings:read", "user:read"], roam: {} });
  assert.deepEqual(await s.api.tokenInfo("t"), { viewer: "Ada Lovelace", scopes: ["meetings:read", "user:read"] });
  assert.equal(s.calls[0].method, "GET");
  assert.equal(s.calls[0].url, `${ROAM_API}/token.info`);

  // token.revoke: a POST with no body; Roam may answer with an empty body.
  s = stub(200, "");
  await s.api.revoke("t");
  assert.equal(s.calls[0].method, "POST");
  assert.equal(s.calls[0].url, `${ROAM_API}/token.revoke`);
  assert.equal(s.calls[0].body, undefined);
  assert.equal(s.calls[0].headers.Authorization, "Bearer t");
});

test("errors: each Roam code becomes a RoamError with status, code and a plain message", async () => {
  const cases: [number, unknown, Record<string, string>, string, RegExp, number | null][] = [
    [401, { ok: false, error: "invalid_token" }, {}, "invalid_token", /didn't accept the token/, null],
    [401, { ok: false, error: "token_revoked" }, {}, "token_revoked", /revoked access/, null],
    [401, { ok: false, error: "not_authed" }, {}, "not_authed", /No Roam token/, null],
    [403, { ok: false, error: "missing_scope", needed: ["meetings:read"], provided: ["user:read"] }, {}, "missing_scope", /meetings:read scope/, null],
    [429, { ok: false, error: "ratelimited" }, { "Retry-After": "7" }, "ratelimited", /try again in 7 seconds/, 7],
    [429, { ok: false, error: "ratelimited" }, {}, "ratelimited", /try again shortly/, null],
    [404, { ok: false, error: "transcript_pending" }, {}, "transcript_pending", /transcript_pending \(HTTP 404\)/, null],
    [502, "<html>bad gateway</html>", {}, "http_502", /http_502/, null],
  ];
  for (const [status, body, headers, code, message, retryAfter] of cases) {
    const { api } = stub(status, body, headers);
    await assert.rejects(api.listMeetings("t"), (e: RoamError) => {
      assert.ok(e instanceof RoamError, code);
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      assert.match(e.message, message);
      assert.equal(e.retryAfter, retryAfter);
      return true;
    });
  }
  // An { ok: false } envelope is an error even on a 200.
  const { api } = stub(200, { ok: false, error: "invalid_arguments" });
  await assert.rejects(api.meeting("t", "m"), { code: "invalid_arguments" });
  // missing_scope with several scopes names them all.
  assert.match(roamError(403, { error: "missing_scope", needed: ["a", "b"] }).message, /a or b scope/);
});

test("errors: Roam unreachable or too slow", async () => {
  const down = new RoamApi({ fetcher: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(down.tokenInfo("t"), { code: "unreachable", status: 0, message: /Couldn't reach Roam: ECONNREFUSED/ });
  const slow = new RoamApi({
    timeoutMs: 20,
    fetcher: (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
  });
  await assert.rejects(slow.tokenInfo("t"), { code: "unreachable", message: /didn't answer within/ });
});

test("errors: a 2xx whose body can't be read is unreachable, not an empty answer", async () => {
  const failingBody = (status: number, err: Error): RoamFetch => async () => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => { throw err; },
  });
  const reset = new RoamApi({ fetcher: failingBody(200, new Error("ECONNRESET")) });
  await assert.rejects(reset.listMeetings("t"), { code: "unreachable", status: 0, message: /Couldn't reach Roam: ECONNRESET/ });
  // The timeout firing during the body read reads as the timeout.
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const slowBody = new RoamApi({ fetcher: failingBody(200, timeout) });
  await assert.rejects(slowBody.tokenInfo("t"), { code: "unreachable", message: /didn't answer within 20 seconds/ });
  // An error status still says what it is without its body.
  const gone = new RoamApi({ fetcher: failingBody(503, new Error("ECONNRESET")) });
  await assert.rejects(gone.listMeetings("t"), { code: "http_503", status: 503 });
});

test("toMeeting: a list item without expand has null summary and action items", () => {
  assert.deepEqual(toMeeting(LIST_ITEM as any), {
    id: "m1", title: "Planning", startedAt: "2026-10-19T15:00:00Z", endedAt: null,
    participantCount: 4, host: { name: "Ada", type: "member" }, summary: null, actionItems: null, tickets: [],
  });
  // No host, no title.
  const bare = toMeeting({ id: "m2", start: "2026-10-18T09:00:00Z", participantCount: 1 } as any);
  assert.equal(bare.host, null);
  assert.equal(bare.title, "Untitled meeting");
});

test("toMeeting: a list item with expand carries the summary and action items; complete omitted = false", () => {
  const m = toMeeting({
    ...LIST_ITEM, summary: "## Decisions\n- Ship it",
    actionItems: [
      { id: "a1", title: "Write the ticket", description: "For the import job", suggestedAssigneeName: "Grace", assignedToMe: true },
      { title: "Book the room", complete: true },
    ],
  } as any);
  assert.equal(m.summary, "## Decisions\n- Ship it");
  assert.deepEqual(m.actionItems, [
    { text: "Write the ticket", description: "For the import job", complete: false, suggestedOwner: "Grace" },
    { text: "Book the room", description: null, complete: true, suggestedOwner: null },
  ]);
  assert.deepEqual(toActionItem({ title: "x" }), { text: "x", description: null, complete: false, suggestedOwner: null });
  // Expanded but Roam had no action items: an empty list, not null.
  assert.deepEqual(toMeeting({ ...LIST_ITEM, actionItems: [] } as any).actionItems, []);
});

test("toMeetingDetail: participants (emails dropped), end time and participantsOmitted", () => {
  const d = toMeetingDetail({
    ...LIST_ITEM, end: "2026-10-19T15:30:00Z", participantCount: 60,
    participants: [{ type: "member", id: "p1", name: "Ada", email: "ada@example.com" }, { type: "guest", id: "g1", name: "Visitor" }],
    participantsOmitted: true,
  } as any);
  assert.equal(d.endedAt, "2026-10-19T15:30:00Z");
  assert.deepEqual(d.participants, [{ id: "p1", name: "Ada", type: "member" }, { id: "g1", name: "Visitor", type: "guest" }]);
  assert.equal(d.participantsOmitted, true);
  const none = toMeetingDetail(LIST_ITEM as any);
  assert.deepEqual(none.participants, []);
  assert.equal(none.participantsOmitted, false);
  assert.deepEqual(toMeetingPage({}), { meetings: [], nextCursor: null });
});

test("transcriptText: consecutive cues from one speaker merge; unknown speakers are 'Speaker'", () => {
  const names = new Map([["p1", "Ada"], ["p2", "Grace"]]);
  const text = transcriptText([
    { speakerId: "p1", text: "Let's start.", start: 0, end: 1000 },
    { speakerId: "p1", text: " First item. ", start: 1000, end: 2000 },
    { speakerId: "p2", text: "Agreed.", start: 2100, end: 2600 },
    { speakerId: "x9", text: "Hello?", start: 3000, end: 3500 },
    { text: "", start: 3600, end: 3700 },
    { speakerId: "p1", text: "Next.", start: 4000, end: 4500 },
  ], names);
  assert.equal(text, "Ada: Let's start. First item.\n\nGrace: Agreed.\n\nSpeaker: Hello?\n\nAda: Next.");
  assert.equal(transcriptText([], names), "");
});

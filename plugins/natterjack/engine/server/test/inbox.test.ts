// inbox.ts: items from elsewhere in the dashboard (the Factory's notices) join the ledger's and the code host's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Inbox } from "../src/inbox.ts";

test("extra items join the Inbox, ranked with the rest; a failing source leaves the rest alone", async () => {
  const runs = { list: () => [] };
  const notice = { kind: "factory-gate-waiting", severity: "action", title: "ENG-1 waits for a person at the plan gate.", detail: "Factory · ENG-1", at: "2026-10-27T10:00:00Z", route: "/factory", query: { view: "tickets", ticket: "ENG-1" } };
  const inbox = new Inbox(runs, () => [notice]);
  inbox.cache = { items: [{ kind: "my-pr", severity: "info", title: "pr", detail: "", at: "2026-10-27T11:00:00Z" }], ciHealth: [], errors: [], host: "none", fetchedAt: Date.now() };
  const out = await inbox.get(false);
  assert.deepEqual(out.items.map((i: any) => i.kind), ["factory-gate-waiting", "my-pr"]);
  const broken = new Inbox(runs, () => { throw new Error("no"); });
  broken.cache = inbox.cache;
  assert.deepEqual((await broken.get(false)).items.map((i: any) => i.kind), ["my-pr"]);
});

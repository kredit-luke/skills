import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JiraTracker, adfToMarkdown, cleanQuery, jql } from "../src/issues/jira.ts";
import { repoList, searchArgs, stateOf } from "../src/issues/github.ts";

test("jira: JQL from projects and states, quoting names safely", () => {
  assert.equal(jql({ teams: [], states: ["To Do", "In Progress"] }, ["ENG", "Ops \"Team\""]),
    'project in ("ENG", "Ops \\"Team\\"") AND status in ("To Do", "In Progress") ORDER BY updated DESC');
  // No states configured: everything not done.
  assert.equal(jql({ teams: [], states: [] }, []), "statusCategory != Done ORDER BY updated DESC");
});

test("jira: Atlassian Document Format descriptions become markdown", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
      { type: "paragraph", content: [
        { type: "text", text: "Open " },
        { type: "text", text: "settings", marks: [{ type: "strong" }] },
        { type: "text", text: " then " },
        { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://x.example" } }] },
      ] },
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
      ] },
      { type: "codeBlock", content: [{ type: "text", text: "npm test" }] },
    ],
  };
  assert.equal(adfToMarkdown(doc), "## Steps\n\nOpen **settings** then [docs](https://x.example)\n\n- one\n- two\n\n```\nnpm test\n```");
  assert.equal(adfToMarkdown(null), "");
});

test("github: repos from config, only owner/name shapes", () => {
  assert.deepEqual(repoList({ repos: ["acme/api", "bad", "acme/web.site"] }), ["acme/api", "acme/web.site"]);
  assert.deepEqual(repoList({ repo: "acme/api" }), ["acme/api"]);
  assert.deepEqual(repoList({}), []);
});

test("github: board column from labels (first match wins), else Open/Closed", () => {
  const states = { "In progress": ["in progress", "wip"], "In review": ["review"] };
  assert.equal(stateOf(["bug", "WIP"], false, states), "In progress");
  assert.equal(stateOf(["review", "wip"], false, states), "In progress");
  assert.equal(stateOf(["bug"], false, states), "Open");
  assert.equal(stateOf(["wip"], true, states), "Closed");
});

test("a personal JQL filter is ANDed in, wrapped in parentheses; one that would break the board is refused", () => {
  assert.equal(jql({ teams: [], states: ["To Do"], query: "assignee = currentUser() OR reporter = currentUser()" }, ["ENG"]),
    'project in ("ENG") AND status in ("To Do") AND (assignee = currentUser() OR reporter = currentUser()) ORDER BY updated DESC');
  assert.equal(jql({ teams: [], states: [], query: "   " }, []), "statusCategory != Done ORDER BY updated DESC");
  assert.throws(() => cleanQuery("assignee = x ORDER BY created"), /ORDER BY/);
  assert.throws(() => cleanQuery("a = 1\nb = 2"), /one line/);
  assert.throws(() => cleanQuery("a = 1) OR (1 = 1"), /parentheses/);
  assert.equal(cleanQuery('summary ~ "(draft"'), 'summary ~ "(draft"', "parentheses inside quotes don't count");
});

test("a personal GitHub search becomes --search", () => {
  assert.deepEqual(searchArgs(""), []);
  assert.deepEqual(searchArgs(" assignee:@me label:bug "), ["--search", "assignee:@me label:bug"]);
  assert.throws(() => searchArgs("a\nb"), /one line/);
  assert.throws(() => searchArgs("x".repeat(300)), /256/);
});

test("the board filter is saved per person, cleared with null or an empty string", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Deck } = await import("../src/deck.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-deck-"));
  const deck = new Deck(dir, path.join(dir, "settings.json"));
  const allowed = { models: () => true, efforts: ["low"] };
  deck.savePersonal({ issues: { query: "  assignee = currentUser()  " } }, allowed);
  assert.deepEqual(deck.personal().issues, { query: "assignee = currentUser()" });
  assert.throws(() => deck.savePersonal({ issues: { query: "a\nb" } }, allowed), /one line/);
  deck.savePersonal({ issues: { query: "" } }, allowed);
  assert.deepEqual(deck.personal().issues, {});
});

test("jira key lookup: its own env vars, then its pasted key, then Confluence's key only for the same site", () => {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "dash-jira-"));
  after(() => fs.rmSync(ledger, { recursive: true, force: true }));
  for (const k of ["CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];
  const tracker = (sources: unknown) => {
    const t = new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: ["ENG"] } as any);
    t.docsSources = () => sources;
    return t;
  };
  const wiki = (url: string) => [{ key: "wiki", kind: "external", provider: "confluence", url }];

  // Only a Confluence key, on the same site: Issues is connected with it.
  fs.writeFileSync(path.join(ledger, "confluence-api-token"), "me@acme.com:wiki-token-456");
  const same = tracker(wiki("https://acme.atlassian.net/wiki"));
  assert.equal(same._cred(), "me@acme.com:wiki-token-456");
  assert.equal(same.status().connected, true);
  // Confluence on another site, or no Confluence source: not used.
  assert.equal(tracker(wiki("https://other.atlassian.net/wiki")).status().connected, false);
  assert.equal(tracker(undefined).status().connected, false);

  // A pasted Jira key wins over Confluence's; Jira env vars win over both.
  fs.writeFileSync(path.join(ledger, "jira-api-token"), "me@acme.com:jira-token-123");
  assert.equal(same._cred(), "me@acme.com:jira-token-123");
  process.env.JIRA_EMAIL = "env@acme.com";
  process.env.JIRA_API_TOKEN = "env-token-789";
  try { assert.equal(same._cred(), "env@acme.com:env-token-789"); }
  finally { delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; }

  same.disconnect();
  assert.equal(same._cred(), "me@acme.com:wiki-token-456", "disconnect drops only its own key");

  // A Confluence key from the env is still an env key: nothing for Disconnect to remove.
  fs.rmSync(path.join(ledger, "confluence-api-token"));
  process.env.CONFLUENCE_EMAIL = "env@acme.com";
  process.env.CONFLUENCE_API_TOKEN = "wiki-env-token";
  try { assert.deepEqual(same.status(), { connected: true, source: "env", viewer: null }); }
  finally { delete process.env.CONFLUENCE_EMAIL; delete process.env.CONFLUENCE_API_TOKEN; }
});

test("atlassian: a classic key stays on the site; a key the site refuses goes through the gateway and stays there", async () => {
  const { atlassianRequest } = await import("../src/atlassian.ts");
  const cloudId = async () => "abc-123";
  const refusedAtSite = (calls: string[]) => async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://acme.atlassian.net")) throw Object.assign(new Error("refused"), { status: 401 });
    return "ok";
  };

  const classic: string[] = [];
  assert.equal(await atlassianRequest("jira", "acme.atlassian.net", "me@acme.com:classic", "/rest/api/3/myself", async (u) => { classic.push(u); return "ok"; }, cloudId), "ok");
  assert.deepEqual(classic, ["https://acme.atlassian.net/rest/api/3/myself"]);

  const scoped: string[] = [];
  const send = refusedAtSite(scoped);
  await atlassianRequest("confluence", "acme.atlassian.net", "me@acme.com:scoped", "/wiki/rest/api/user/current", send, cloudId);
  await atlassianRequest("confluence", "acme.atlassian.net", "me@acme.com:scoped", "/wiki/rest/api/space", send, cloudId);
  assert.deepEqual(scoped, [
    "https://acme.atlassian.net/wiki/rest/api/user/current",
    "https://api.atlassian.com/ex/confluence/abc-123/wiki/rest/api/user/current",
    "https://api.atlassian.com/ex/confluence/abc-123/wiki/rest/api/space",
  ]);

  // Not a refused key (e.g. a 404): no retry through the gateway.
  const other: string[] = [];
  await assert.rejects(() => atlassianRequest("jira", "acme.atlassian.net", "me@acme.com:other", "/x", async (u) => { other.push(u); throw Object.assign(new Error("nope"), { status: 404 }); }, cloudId), /nope/);
  assert.equal(other.length, 1);
});

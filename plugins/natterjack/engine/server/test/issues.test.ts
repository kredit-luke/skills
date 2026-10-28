import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JiraTracker, adfToMarkdown, cleanQuery, jql } from "../src/issues/jira.ts";
import { GitHubTracker, repoForTeam, repoList, teamOfRepo, searchArgs, stateOf } from "../src/issues/github.ts";

test("jira: JQL from projects and states, quoting names safely", () => {
  assert.equal(jql({ teams: [], states: ["To Do", "In Progress"] }, ["ENG", "Ops \"Team\""]),
    'project in ("ENG", "Ops \\"Team\\"") AND status in ("To Do", "In Progress") ORDER BY updated DESC');
  // No states configured: everything not done.
  assert.equal(jql({ teams: [], states: [] }, []), "statusCategory != Done ORDER BY updated DESC");
  assert.equal(jql({ teams: [], states: ["Ready"], assigned: "me" }, []), 'status in ("Ready") AND assignee = currentUser() ORDER BY updated DESC');
  assert.equal(jql({ teams: [], states: [], assigned: "me-or-none" }, []), "statusCategory != Done AND (assignee = currentUser() OR assignee is EMPTY) ORDER BY updated DESC");
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

test("github: a team names a repo by owner/name or short name, in any case", () => {
  const repos = ["lhoezee/skills", "acme/api"];
  assert.equal(repoForTeam(repos, "lhoezee/skills"), "lhoezee/skills");
  assert.equal(repoForTeam(repos, "skills"), "lhoezee/skills");
  assert.equal(repoForTeam(repos, "ACME/Api"), "acme/api");
  assert.equal(repoForTeam(repos, "other/skills"), undefined, "a different owner isn't the same repo");
  assert.equal(repoForTeam(repos, "web"), undefined);
  assert.equal(repoForTeam(repos, " skills "), "lhoezee/skills", "trimmed");
});

test("github: two repos with one short name: the short name names neither, and their issues' team is owner/name", async () => {
  const repos = ["acme/api", "other/api", "acme/web"];
  assert.equal(repoForTeam(repos, "api"), undefined);
  assert.equal(repoForTeam(repos, "other/api"), "other/api");
  assert.equal(teamOfRepo(repos, "acme/api"), "acme/api");
  assert.equal(teamOfRepo(repos, "acme/web"), "web");
  const gh = new GitHubTracker({ kind: "github", repos } as any);
  assert.equal(gh.teamName("api"), null);
  assert.equal(gh.teamName("acme/api"), "acme/api");
  const listed: string[] = [];
  gh.gh = async (args) => {
    if (args[0] === "api") return { login: "me" };
    listed.push(args[args.indexOf("--repo") + 1]);
    return [{ number: 1, title: "A", url: "", labels: [], assignees: [], updatedAt: "2026-10-01T00:00:00Z" }];
  };
  const res = await gh.issues({ teams: ["api", "acme/api"], states: [] });
  assert.deepEqual(listed, ["acme/api"], "the ambiguous short name reads no repo");
  assert.deepEqual(res.issues.map((i) => i.team), ["acme/api"]);
});

test("github: issues.teams as owner/name still reads that repo, and teamName gives the short name", async () => {
  const gh = new GitHubTracker({ kind: "github", repos: ["lhoezee/skills", "acme/api"] } as any);
  const listed: string[] = [];
  gh.gh = async (args) => {
    if (args[0] === "api") return { login: "me" };
    listed.push(args[args.indexOf("--repo") + 1]);
    return [{ number: 103, title: "A", url: "https://github.com/lhoezee/skills/issues/103", labels: [], assignees: [], updatedAt: "2026-10-01T00:00:00Z" }];
  };
  const res = await gh.issues({ teams: ["lhoezee/skills"], states: [] });
  assert.deepEqual(listed, ["lhoezee/skills"]);
  assert.deepEqual(res.issues.map((i) => [i.id, i.team]), [["skills#103", "skills"]]);
  assert.equal(gh.teamName("LHOEZEE/skills"), "skills");
  assert.equal(gh.teamName("nope/skills"), null);
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

test("jira: the Flagged field is found by name, asked for on the board, and marks its issues flagged", async () => {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "dash-jira-"));
  after(() => fs.rmSync(ledger, { recursive: true, force: true }));
  for (const k of ["CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];
  fs.writeFileSync(path.join(ledger, "jira-api-token"), "me@acme.com:jira-token-123");
  const t = new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: ["ENG"] } as any);
  t.docsSources = () => undefined;
  const ALL = { teams: [], states: [] };
  let fieldList: () => any = () => { throw new Error("Jira returned HTTP 500"); };
  const asked: string[][] = [];
  (t as any)._get = async (_c: any, p: string, body?: any) => {
    if (p === "/rest/api/3/myself") return { displayName: "Me" };
    if (p === "/rest/api/3/field") return fieldList();
    asked.push(body.fields);
    return { issues: [
      { key: "ENG-1", fields: { summary: "a", customfield_10021: [{ value: "Impediment", id: "10019" }] } },
      { key: "ENG-2", fields: { summary: "b", customfield_10021: null } },
    ] };
  };

  // The field list failed: nothing is flagged, and the next refresh looks again.
  let r = await t.issues(ALL, true);
  assert.deepEqual(r.issues.map((i: any) => i.flagged), [false, false]);
  assert.ok(!asked[0].includes("customfield_10021"));

  fieldList = () => [{ id: "flagged", name: "Flagged", custom: false }, { id: "customfield_10021", name: "Flagged", custom: true }];
  r = await t.issues(ALL, true);
  assert.ok(asked[1].includes("customfield_10021"));
  assert.deepEqual(r.issues.map((i: any) => i.flagged), [true, false]);

  // A site without the field: looked up once, never flagged.
  const none = new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: [] } as any);
  let lookups = 0;
  (none as any)._get = async (_c: any, p: string) => (p === "/rest/api/3/field" ? (lookups++, []) : p === "/rest/api/3/myself" ? {} : { issues: [{ key: "ENG-3", fields: {} }] });
  await none.issues(ALL, true);
  assert.equal((await none.issues(ALL, true)).issues[0].flagged, false);
  assert.equal(lookups, 1);

  // Another person's key: the field list depends on their permissions, so it's read again.
  fs.writeFileSync(path.join(ledger, "jira-api-token"), "you@acme.com:jira-token-456");
  await none.issues(ALL, true);
  assert.equal(lookups, 2);

  // A lookup that finishes after the key changed isn't kept for the new key.
  const racing = new JiraTracker(ledger, { kind: "jira", site: "acme.atlassian.net", projects: [] } as any);
  racing.docsSources = () => undefined;
  const cred = racing._auth()!;
  (racing as any)._get = async () => {
    fs.writeFileSync(path.join(ledger, "jira-api-token"), "them@acme.com:jira-token-789");
    racing._auth();
    return [{ id: "customfield_10021", name: "Flagged", custom: true }];
  };
  assert.equal(await racing._flagField(cred), "customfield_10021");
  assert.equal(racing.flagField, undefined);
});

test("jira: an issue's epic is its parent one level up; a sub-task's story parent isn't an epic", () => {
  const t = new JiraTracker(os.tmpdir(), { kind: "jira", site: "acme.atlassian.net", projects: [] } as any);
  const parent = (level: number) => ({ key: "ENG-9", fields: { summary: "Big thing", issuetype: { name: "Epic", hierarchyLevel: level } } });
  assert.deepEqual(t.toIssue({ key: "ENG-1", fields: { parent: parent(1) } }).epic, { id: "ENG-9", title: "Big thing", url: "https://acme.atlassian.net/browse/ENG-9" });
  assert.equal(t.toIssue({ key: "ENG-2", fields: { parent: parent(0) } }).epic, null);
  assert.equal(t.toIssue({ key: "ENG-3", fields: {} }).epic, null);
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

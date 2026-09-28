import { test } from "node:test";
import assert from "node:assert/strict";
import { adfToMarkdown, cleanQuery, jql } from "../src/issues/jira.ts";
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

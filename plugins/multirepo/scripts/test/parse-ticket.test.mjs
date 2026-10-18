// parse-ticket.mjs: Jira (REST + ADF), Linear (MCP) and GitHub (gh --json) into one shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ALIGN_MARKER,
  PLAN_MARKER,
  adfToMarkdown,
  detectTracker,
  extractAcceptanceCriteria,
  parseTicket,
  toMarkdown,
  unwrap,
} from "../parse-ticket.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "parse-ticket.mjs");

const p = (...content) => ({ type: "paragraph", content });
const t = (text, marks) => ({ type: "text", text, ...(marks ? { marks } : {}) });
const doc = (...content) => ({ type: "doc", version: 1, content });

const jiraIssue = {
  key: "ENG-123",
  self: "https://acme.example.net/rest/api/3/issue/10001",
  names: { customfield_10050: "Acceptance Criteria", customfield_10016: "Story points" },
  fields: {
    summary: "Export invoices as CSV",
    issuetype: { name: "Story" },
    status: { name: "To Do" },
    priority: { name: "High" },
    assignee: { displayName: "Sam Dev" },
    labels: ["billing"],
    components: [{ name: "web" }],
    parent: { key: "ENG-100", fields: { summary: "Billing epic", status: { name: "In Progress" } } },
    description: doc(
      p(t("Users need a "), t("CSV", [{ type: "strong" }]), t(" export. See "), t("docs", [{ type: "link", attrs: { href: "https://example.com/d" } }])),
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("one"))] }, { type: "listItem", content: [p(t("two")), { type: "bulletList", content: [{ type: "listItem", content: [p(t("nested"))] }] }] }] },
      { type: "codeBlock", attrs: { language: "sql" }, content: [t("select 1;")] },
      p({ type: "mention", attrs: { id: "abc", text: "@Pat" } }, t(" please review"))
    ),
    customfield_10050: doc({ type: "orderedList", content: [{ type: "listItem", content: [p(t("A CSV downloads"))] }] }),
    customfield_10016: 3,
    issuelinks: [
      { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "ENG-124", fields: { summary: "Import", status: { name: "Done" } } } },
      { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "ENG-99", fields: { summary: "Schema", status: { name: "To Do" } } } },
    ],
    subtasks: [{ key: "ENG-125", fields: { summary: "Backend", status: { name: "To Do" } } }],
    comment: {
      comments: [
        { id: "1", author: { displayName: "Pat PM" }, created: "2026-01-02T10:00:00.000+0000", body: doc(p(t(PLAN_MARKER)), p(t("old plan"))) },
        { id: "2", author: { displayName: "Sam Dev" }, created: "2026-01-03T10:00:00.000+0000", body: doc(p(t("question?"))) },
        { id: "3", author: { displayName: "Sam Dev" }, created: "2026-01-04T10:00:00.000+0000", body: doc(p(t(PLAN_MARKER)), p(t("new plan"))) },
      ],
    },
  },
};

test("unwrap: spill wrapper, JSON strings, tool-result content", () => {
  const wrapped = [{ type: "text", text: JSON.stringify({ title: "x", body: "" }) }, { type: "text", text: "not json" }];
  assert.deepEqual(unwrap(wrapped), [{ title: "x", body: "" }]);
  assert.deepEqual(unwrap(JSON.stringify(wrapped)), [{ title: "x", body: "" }]);
  assert.deepEqual(unwrap({ content: wrapped }), [{ title: "x", body: "" }]);
  assert.deepEqual(unwrap("﻿{\"a\":1}"), [{ a: 1 }]);
});

test("adfToMarkdown: marks, links, nested lists, code, mentions, tables, tasks", () => {
  const md = adfToMarkdown(jiraIssue.fields.description);
  assert.match(md, /Users need a \*\*CSV\*\* export\. See \[docs\]\(https:\/\/example\.com\/d\)/);
  assert.match(md, /- one\n- two\n  - nested/);
  assert.match(md, /```sql\nselect 1;\n```/);
  assert.match(md, /@Pat please review/);
  const table = adfToMarkdown(
    doc({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [p(t("a"))] }, { type: "tableHeader", content: [p(t("b"))] }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [p(t("1"))] }, { type: "tableCell", content: [p(t("2|3"))] }] },
      ],
    })
  );
  assert.equal(table, "| a | b |\n| --- | --- |\n| 1 | 2\\|3 |");
  const tasks = adfToMarkdown(doc({ type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [t("done")] }, { type: "taskItem", attrs: { state: "TODO" }, content: [t("todo")] }] }));
  assert.equal(tasks, "- [x] done\n- [ ] todo");
  assert.equal(adfToMarkdown("plain"), "plain");
});

test("jira: fields, custom fields, AC field, links, subtasks, parent, newest plan comment", () => {
  const r = parseTicket([JSON.stringify([{ type: "text", text: JSON.stringify(jiraIssue) }])]);
  assert.equal(r.tracker, "jira");
  assert.equal(r.id, "ENG-123");
  assert.equal(r.url, "https://acme.example.net/browse/ENG-123");
  assert.equal(r.type, "Story");
  assert.equal(r.state, "To Do");
  assert.equal(r.priority, "High");
  assert.equal(r.assignee, "Sam Dev");
  assert.deepEqual(r.labels, ["billing"]);
  assert.deepEqual(r.components, ["web"]);
  assert.equal(r.acceptanceCriteria, "1. A CSV downloads");
  assert.deepEqual(r.customFields.find((c) => c.name === "Story points"), { id: "customfield_10016", name: "Story points", value: "3" });
  assert.deepEqual(r.links, [
    { type: "blocks", id: "ENG-124", title: "Import", state: "Done" },
    { type: "blocked by", id: "ENG-99", title: "Schema", state: "To Do" },
  ]);
  assert.deepEqual(r.subtasks, [{ id: "ENG-125", title: "Backend", state: "To Do" }]);
  assert.deepEqual(r.parent, { id: "ENG-100", title: "Billing epic", state: "In Progress" });
  assert.equal(r.comments.length, 3);
  assert.equal(r.comments[0].author, "Pat PM");
  assert.equal(r.planComment.id, "3");
  assert.match(r.planComment.body, /new plan/);
  assert.equal(r.alignComment, null);
});

test("jira: search-result wrapper and description AC section", () => {
  const issue = { key: "OPS-7", fields: { summary: "s", description: doc({ type: "heading", attrs: { level: 2 }, content: [t("Acceptance Criteria")] }, p(t("- works")), { type: "heading", attrs: { level: 2 }, content: [t("Notes")] }) } };
  const r = parseTicket({ issues: { nodes: [issue] } });
  assert.equal(r.id, "OPS-7");
  assert.equal(r.acceptanceCriteria, "- works");
});

test("linear: MCP issue plus a separate list_comments result, align + plan markers", () => {
  const issue = {
    id: "uuid-1",
    identifier: "ENG-42",
    title: "Retry webhooks",
    description: "Webhooks drop.\n\n## Acceptance criteria\n\n- retries 3 times\n- logs failures\n\n## Notes\n\nlater",
    url: "https://linear.app/acme/issue/ENG-42/retry-webhooks",
    status: "In Progress",
    priority: { value: 2, name: "High" },
    labels: ["Bug"],
    assignee: "Sam Dev",
    parent: { identifier: "ENG-40", title: "Reliability" },
    relations: { blocks: [{ identifier: "ENG-43", title: "Alerts" }], blockedBy: [], relatedTo: [{ identifier: "ENG-1", title: "Old" }] },
    children: [{ identifier: "ENG-44", title: "Sub", status: "Todo" }],
  };
  const comments = {
    comments: [
      { id: "c2", body: `${ALIGN_MARKER}\n# Aligned`, createdAt: "2026-02-02T00:00:00Z", author: { name: "Sam Dev" } },
      { id: "c1", body: "first", createdAt: "2026-02-01T00:00:00Z", user: { displayName: "Pat PM" } },
    ],
  };
  const r = parseTicket([JSON.stringify(issue), JSON.stringify([{ type: "text", text: JSON.stringify(comments) }])]);
  assert.equal(detectTracker(issue), "linear");
  assert.equal(r.tracker, "linear");
  assert.equal(r.id, "ENG-42");
  assert.equal(r.state, "In Progress");
  assert.equal(r.priority, "High");
  assert.deepEqual(r.labels, ["Bug"]);
  assert.equal(r.acceptanceCriteria, "- retries 3 times\n- logs failures");
  assert.deepEqual(r.links.map((l) => `${l.type} ${l.id}`), ["blocks ENG-43", "related to ENG-1"]);
  assert.deepEqual(r.subtasks, [{ id: "ENG-44", title: "Sub", state: "Todo" }]);
  assert.equal(r.parent.id, "ENG-40");
  assert.deepEqual(r.comments.map((c) => c.id), ["c1", "c2"]);
  assert.equal(r.comments[0].author, "Pat PM");
  assert.equal(r.alignComment.id, "c2");
  assert.equal(r.planComment, null);
  assert.equal(parseTicket({ ...issue, priority: 4 }).priority, "Low");
});

test("github: gh issue view --json, id from url, bold AC heading", () => {
  const issue = {
    title: "Dark mode",
    body: "Add a toggle.\n\n**Acceptance criteria**\n- [ ] toggle persists\n\n**Out of scope**\n- themes",
    state: "OPEN",
    url: "https://github.com/acme/web/issues/12",
    labels: [{ name: "enhancement", color: "fff" }],
    assignees: [{ login: "samdev", name: "" }],
    comments: [{ id: "IC_1", author: { login: "patpm" }, body: `${PLAN_MARKER}\nplan`, createdAt: "2026-03-01T00:00:00Z" }],
  };
  const r = parseTicket(JSON.stringify(issue));
  assert.equal(r.tracker, "github");
  assert.equal(r.id, "acme/web#12");
  assert.equal(r.state, "open");
  assert.deepEqual(r.labels, ["enhancement"]);
  assert.equal(r.assignee, "samdev");
  assert.equal(r.acceptanceCriteria, "- [ ] toggle persists");
  assert.equal(r.planComment.author, "patpm");
  const escaped = parseTicket({ ...issue, comments: [{ id: "x", body: "&lt;!-- GENERATED-BY-ALIGN-SKILL --&gt;\ndoc" }] });
  assert.equal(escaped.alignComment.id, "x");
});

test("extractAcceptanceCriteria: none → null", () => {
  assert.equal(extractAcceptanceCriteria("just text"), null);
  assert.equal(extractAcceptanceCriteria(""), null);
});

test("no ticket → throws", () => {
  assert.throws(() => parseTicket("[]"), /No ticket found/);
  assert.throws(() => parseTicket("nonsense"), /No ticket found/);
});

test("toMarkdown: readable sections", () => {
  const md = toMarkdown(parseTicket(jiraIssue));
  assert.match(md, /^# ENG-123: Export invoices as CSV/);
  assert.match(md, /- \*\*Plan comment:\*\* yes \(Sam Dev, 2026-01-04\)/);
  assert.match(md, /## Acceptance criteria\n\n1\. A CSV downloads/);
  assert.match(md, /- \*\*Story points:\*\* 3/);
  assert.match(md, /## Links\n\n- blocks: ENG-124: Import \[Done\]/);
  assert.match(md, /## Comments \(3\)/);
});

test("CLI: file and stdin, json and md, exit 1 on garbage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-ticket-"));
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify([{ type: "text", text: JSON.stringify(jiraIssue) }]));
  const json = JSON.parse(execFileSync(process.execPath, [script, file], { encoding: "utf-8" }));
  assert.equal(json.id, "ENG-123");
  const md = execFileSync(process.execPath, [script, "--format", "md"], { input: JSON.stringify(jiraIssue), encoding: "utf-8" });
  assert.match(md, /^# ENG-123/);
  assert.throws(() => execFileSync(process.execPath, [script, "-"], { input: "{}", encoding: "utf-8", stdio: "pipe" }), /No ticket found/);
});

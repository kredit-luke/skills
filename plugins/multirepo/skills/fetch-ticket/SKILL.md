---
name: fetch-ticket
description: Fetch an issue-tracker ticket (Linear, Jira or GitHub Issues) with everything that matters for building it (description, acceptance criteria, custom fields, linked/blocking issues, subtasks, parent, and every comment with author and date, including plans and alignment docs other skills posted) and show it as clean Markdown or one normalized JSON object. Use whenever the user wants to fetch, read, open, pull up, look at, summarize or "get the details of" a ticket or issue, e.g. "fetch ENG-123", "what does PROJ-42 say", "show me acme/web#12", "read the ticket", a pasted tracker URL, or when another skill (align, implement, submit-plan, commit, review) needs the ticket's content. Handles responses too large to show inline.
argument-hint: "<TICKET-ID or URL> [--json]"
---

# Fetch Ticket

Read one ticket completely, from whichever tracker the workspace uses, and turn it into a single normalized shape, so the skills downstream never deal with tracker quirks.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

## Input

```
/fetch-ticket ENG-123
/fetch-ticket https://<tracker>/.../ENG-123      # id taken from the URL
/fetch-ticket acme/web#12                         # GitHub Issues (or #12 in the current repo)
/fetch-ticket ENG-123 --json                      # the normalized JSON instead of Markdown
```

No id: use the one fetched or discussed earlier in this conversation, else the current branch's (`feature/ENG-123` → `ENG-123`; `.claude/dashboard/workspace.json` `issues.ticketPattern` is the format when set), else ask.

## 1. Pick the tracker

First match wins:

1. `.claude/dashboard/workspace.json` `issues.kind` (`linear`, `jira`, `github`), when set and not `none`. In a worktree without its own copy, read the source workspace's (`.worktree.json` `sourceWorkspace`).
2. The id's shape: `owner/repo#N` or `#N` → GitHub Issues. A URL's host settles it too.
3. What's connected: a Linear MCP (tools ending `get_issue`, `list_comments`), an Atlassian MCP (`getJiraIssue`), or the `gh` CLI. If more than one fits a `KEY-123` id, ask which.

Match MCP tools by name suffix; the server prefix differs per install. If nothing is reachable, say which connector is missing and stop.

## 2. Fetch, comments included

**Ask for the comments explicitly.** Plans (`<!-- GENERATED-BY-SUBMIT-PLAN-SKILL -->`) and alignment docs (`<!-- GENERATED-BY-ALIGN-SKILL -->`) live in comments; a default fetch often leaves comments out, and then they're invisible.

| Tracker | Fetch |
|---|---|
| Jira (Atlassian MCP) | `getJiraIssue` with `issueIdOrKey` and `fields: ["summary","issuetype","status","priority","parent","assignee","labels","components","description","issuelinks","subtasks","comment","*navigable"]` (plus `expand: "names"` if the tool takes it, so custom fields get readable names). `cloudId`: `workspace.json` `issues.site` when set, else discover it with the MCP's accessible-resources tool (ends `getAccessibleAtlassianResources`); never guess it. |
| Linear (MCP) | `get_issue` (with relations / children if the tool offers them), then `list_comments` for the issue, following pagination to the end. |
| GitHub Issues | `gh issue view <n> -R <owner>/<repo> --json number,title,body,state,labels,assignees,comments,url` |

## 3. Normalize

Pass every result through the parser, whether it came back inline or spilled to a file ("Output too large... saved to `<path>`"):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-ticket.mjs" <issue-result> [<comments-result> ...] [--format md]
```

Give it the saved file paths (or `-` / nothing to read stdin; for an inline result, write it to a temp file first). Several inputs are merged: the issue plus separately fetched comment lists. It auto-detects the tracker (`--tracker jira|linear|github` to override) and unwraps the spill format `[{ "type": "text", "text": "<json>" }]`. **Don't write ad-hoc scripts to dig through tracker JSON**: extend this parser instead.

Output (JSON by default):

```
{ id, tracker, title, url, state, type, labels[], assignee, priority,
  description,          // Markdown; Jira ADF flattened (lists, code, mentions, links, tables)
  acceptanceCriteria,   // a custom field named "Acceptance criteria", else that section of the description, else null
  links: [{ type, id, title, state }],   // "blocks", "blocked by", "related to", ...
  subtasks: [{ id, title, state }], parent, components[], customFields: [{ id, name, value }],
  comments: [{ id, author, created, body }],   // oldest first
  planComment, alignComment }   // newest comment with each marker, or null
```

`--format md` prints the same as readable Markdown.

## 4. Show it

Default: the Markdown form. Keep every comment, but if a plan or align comment is long, show its first lines and say it's there in full. Call out what matters for the work: unresolved `blocked by` links, open subtasks, an existing plan or alignment doc, and a missing acceptance-criteria section.

When another skill called this one, hand it the JSON and skip the display.

## Notes

- **Read-only.** This never edits the ticket, its status or its comments.
- **Exit 1** from the parser means no issue was found in what it was given: usually the wrong file, or an error response from the tracker. Show the tracker's error rather than retrying blindly.
- Images and attachments come through as `[attachment]`; open them separately if they matter.

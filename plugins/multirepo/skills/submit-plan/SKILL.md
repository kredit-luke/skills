---
name: submit-plan
description: Post an implementation plan from plan mode (~/.claude/plans/) to an issue-tracker ticket (Linear, Jira or GitHub Issues) as a tagged comment, updating that same comment on later submissions instead of adding duplicates. Use whenever the user wants to push, submit, sync, attach or update a ticket with a plan, e.g. "update the ticket with the plan", "send the plan to Linear", "put this plan on the Jira issue", "sync the plan to the ticket".
argument-hint: "[plan-name] [TICKET-ID] (both optional)"
---

# Submit Plan

Post a plan from `~/.claude/plans/` as a comment on a ticket. The comment carries a marker, so an implementation skill can find the plan later, and re-submitting updates the comment in place. A comment (rather than editing the description) keeps the human-written ticket clean and the machine-generated plan clearly separate.

The marker, always the comment's first line:

```
<!-- GENERATED-BY-SUBMIT-PLAN-SKILL -->
```

## Input

```
/submit-plan                          # newest matching plan, ticket detected
/submit-plan ENG-81                   # this ticket
/submit-plan fluffy-orbiting-allen    # this plan file (name, with or without .md)
/submit-plan fluffy-orbiting-allen ENG-81
```

A ticket id is `ENG-81`, `PROJ-123`, or `owner/repo#42` / `#42` for GitHub Issues; if the workspace has `.claude/dashboard/workspace.json`, `issues.ticketPattern` is its format. Without one, resolve it in this order: an id inside the plan file, a ticket fetched or discussed earlier in this conversation, the current branch name (`feature/ENG-81` → `ENG-81`), else ask.

## 1. Pick the tracker

First match wins:

1. `.claude/dashboard/workspace.json` `issues.kind` (`linear`, `jira`, `github`), when present and not `none`.
2. The id's shape: `owner/repo#N` or `#N` → GitHub Issues.
3. What's connected: a Linear MCP (tools ending `__get_issue`, `__list_comments`, `__save_comment` on a Linear server), an Atlassian/Jira MCP (`getJiraIssue`, `addCommentToJiraIssue`, `editJiraComment`...), or the `gh` CLI. If more than one fits a `KEY-123` id, ask which.

If none is reachable, say which connector is missing and stop.

## 2. Find the plan file

Plan files have random names (e.g. `woolly-marinating-meteor.md`). A plan name in the arguments wins. Otherwise:

1. List `~/.claude/plans/*.md`, newest first.
2. Read the first ~5 lines of the 3 newest.
3. Look for the ticket id (e.g. `# ENG-81:` or the id anywhere in the heading).
4. One match → use it. Several → ask which. None → show the 3 newest names with their first lines and ask.

Unless the match was exact (named plan, or the id in its heading), show the user its title and first lines and confirm before posting. Read the whole file: it's the comment body.

## 3. Find an existing plan comment

List **all** the ticket's comments (follow pagination to the end) and look for one containing the marker; keep its id.

| Tracker | List comments | Create | Update |
|---|---|---|---|
| Linear (MCP) | `list_comments` (`issueId`) | `save_comment` (`issueId`, `body`) | `save_comment` (`id`, `body`) |
| Jira (MCP) | the issue's comments via `getJiraIssue` / comment tools | `addCommentToJiraIssue` | `editJiraComment` (or the server's equivalent) |
| GitHub Issues | `gh api --paginate repos/<o>/<r>/issues/<n>/comments` (every page: a plan on a later one would otherwise be missed and duplicated) | `gh issue comment <n> -R <o>/<r> --body-file <file>` | `gh api -X PATCH repos/<o>/<r>/issues/comments/<id> -F body=@<file>` |

Tool names vary by server; match on the suffix. For `gh`, write the body to a temp file instead of passing it inline, so quoting can't break it.

## 4. Build the body

```
<!-- GENERATED-BY-SUBMIT-PLAN-SKILL -->
# Implementation Plan

<full plan file content>
```

**Include the whole plan, verbatim.** Don't summarize, truncate or rephrase: every heading, list, table and code block stays. Only demote headings one level so they nest under `# Implementation Plan` (and drop conversational filler like "Let me analyze..." if any slipped in). An implementing agent will read this comment as its spec.

Jira renders Markdown only through some connectors; if the server takes ADF or wiki markup, convert with whatever the tool offers rather than posting raw Markdown into a field that won't render it.

## 5. Post it

Update the existing comment when step 3 found one, else create a new one.

## 6. Confirm

Report the plan file used, whether it was a first submission or an update, and a link to the ticket.

```
Found plan: ~/.claude/plans/woolly-marinating-meteor.md (ENG-81: Redesign the dashboard)
Posted the plan as a comment on ENG-81 (first submission)
https://linear.app/<team>/issue/ENG-81
```

## Notes

- **Never edit the ticket description.** Rewriting it can break embedded images and attachments, and it mixes generated text into what people wrote.
- **Line numbers in the plan are approximate.** It's a snapshot; by implementation time other merges may have moved code. Whoever implements it should locate code by file path and surrounding symbols, not by line number alone.

## Errors

- **No plan files**: tell the user to make one in plan mode first.
- **Ticket not found**: report it and suggest checking the id.
- **No plan matches the id**: show the recent plans and ask.
- **Tracker error on comment**: report it and suggest retrying.

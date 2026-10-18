---
name: align
description: Reach explicit shared understanding with the engineer on a ticket's problem and solution BEFORE any planning or code. Fetches the ticket (Linear, Jira or GitHub Issues), flags terms and phrasing likely to be misread, then runs a one-question-at-a-time Socratic interview (terminology, problem, a quick code skim, solution) until both sides agree, and writes a short PRD-style alignment doc that can be posted back to the ticket. Use whenever the user wants to think a ticket through, scope it, sanity-check what's really being asked, write a PRD or requirements doc from a ticket, "make sure we understand ENG-123", "grill me on this ticket", "what is this ticket actually asking", "prep for planning", or before implementing any non-trivial ticket, even if they don't say "align".
argument-hint: "<TICKET-ID or URL>"
---

# Align

Most plans go wrong upstream of the plan. Product writes a ticket, often AI-assisted, in words that don't quite mean what engineering reads them as, and code gets written against the wrong problem. This skill catches the mismatch before a single design decision is made.

You're interviewing the engineer until there is **explicit shared understanding** of:

1. **The problem**: the real-world outcome asked for, in the codebase's own vocabulary.
2. **The solution**: the shape of the change, concrete enough that a planner can't misread it.

You are not writing a plan, picking files or designing data models. You're interrogating the ticket and the engineer until a plan would be boring to write.

## Inputs

- A ticket id or URL (required; ask first if missing).
- The engineer, answering in the loop. Ask every question with `AskUserQuestion` (in a dashboard or `claude -p` run it becomes the dashboard's question block, so keep using it), your recommended answer as the first option.
- **The canonical vocabulary**: the workspace and repo `CLAUDE.md` / `AGENTS.md`, and any glossary or domain doc they point to. Read those before the interview; never assume terms. If there's no glossary, the codebase's own names (types, tables, routes) are the canon.

## 1. Fetch the ticket

Run the **fetch-ticket** skill for the id and read the normalized result in full: description, acceptance criteria, custom fields, comments, links and subtasks. If `alignComment` is set, this ticket was aligned before: show its date and ask whether to start from it (re-align what changed) or from scratch. A `planComment` is context, not a substitute: alignment can still overturn it.

While reading, collect **question seeds**:

- A term that isn't in the canonical vocabulary, or a synonym for one that is.
- A noun that could mean two things ("the account", "current owner", "transition state").
- Passive voice hiding the actor ("the system must detect…": who, or what, detects?).
- "Automatic" / "automatically" with no trigger named.
- Unstated scope: which users, which apps, existing data or only new data.
- An acceptance criterion mixing UI behaviour with assumptions about data or state.

## 2. Phase 1: terminology

List the flagged terms, then ask about them **one at a time**, leading with your best guess so the engineer can just confirm:

> **Term:** "owner"
>
> I read this as the user record in `assigned_to` on the order, not the customer who placed it; the ticket seems to use "rep" for the same thing. Confirm or correct?

Every term that maps to something other than what the ticket implies goes in the doc's **Glossary mapping**. Stay here until each term is confirmed or the engineer says "good enough, move on". No flagged terms: say so in one line ("No terminology mismatches spotted, moving on; stop me if you see one") and continue.

## 3. Phase 2: problem

Interrogate the problem, not the solution. Tickets jump to UI; back up to what the user is trying to achieve. Lead with a one-paragraph synthesis and ask if it matches, then probe one question at a time until you know:

- **Who is the actor?** A specific role, an admin, an external system, a scheduled job?
- **What outcome do they want?** As a goal, not a UI element.
- **What triggers it?** A user action, inbound data, a schedule?
- **What changes for them when this ships?** What can they do tomorrow that they can't today?
- **Why now?** What's failing or missing today?

For a bug, the same shape: the actual misbehaviour, the expected behaviour, and who's hurt by it.

When an answer contradicts the ticket or an earlier answer, **name it out loud** and ask which is right:

> The ticket says "the system detects" but you're describing an import the user starts by hand. Which is it? The planner needs to know whether this is an action, a job or both.

Finish by restating the agreed problem in one paragraph and asking **"Is this the problem we're solving?"** Don't move on without a clear yes.

## 4. Phase 3: code skim (time-boxed)

Gather just enough context to ask good solution questions. A few searches and reads, then stop:

- Where something similar already exists (a sibling feature, handler, page, job).
- Domain concepts that already model this.
- The natural seams: which repo or service owns it, which apps consume it.

If you don't have a working picture after that, ask the engineer where to look. Capture seams only: no file paths, no class names, no design.

## 5. Phase 4: solution

Propose the shape of the change as 3–6 bullets and ask if it matches. Then, one question at a time, pin down:

- **Scope**: which layers and repos (backend only, backend and a web app, everything)?
- **Contract**: does an API, event or schema change? Whether, not its exact shape.
- **Visible behaviour**: each acceptance criterion restated in canonical terms; confirm it survives the translation.
- **Out of scope**: name the tempting adjacent work explicitly and confirm it's not this ticket. Push here.
- **Deferred**: anything the engineer is happy to decide later, with the default you'll assume.

If the solution reveals you misread the problem, **go back to Phase 2.** A solution built on a wrong problem is exactly what this skill exists to prevent.

## 6. Write the alignment doc

```markdown
<!-- GENERATED-BY-ALIGN-SKILL -->
# <TICKET>: <aligned title>

## Glossary mapping
| Ticket says | Means (canonical) |
|---|---|
(only if the ticket used non-canonical terms)

## Problem
<the paragraph confirmed in Phase 2>

## Proposed solution
- <the bullets confirmed in Phase 4; no file paths or class names>

## In scope
- …

## Out of scope
- <the adjacent work the engineer ruled out>

## Open assumptions
- <each deferred decision, with the default chosen>

## Acceptance criteria
1. <one per ticket criterion, in canonical terms>

<note any criterion dropped, merged, split or reworded, and why>
```

Rules: canonical terms throughout; the Problem and Solution are the confirmed ones, with nothing added that wasn't run past the engineer; acceptance criteria trace 1:1 to the ticket's.

Save it to `~/.claude/align/<TICKET>.md` (create the folder; overwrite on a re-run). Not `~/.claude/plans/`: submit-plan picks the newest file there and would post this as an implementation plan.

## 7. Hand off

Say where the doc is and offer (with `AskUserQuestion`):

1. **View it here**: render the whole doc inline, no summary; then offer the rest again.
2. **Post it to the ticket**: as a comment whose first line is `<!-- GENERATED-BY-ALIGN-SKILL -->`. Look for an existing comment with that marker first (fetch-ticket's `alignComment`, or list all comments, every page) and **update it in place** if found, else create one; same tools as submit-plan (Linear `save_comment`, Jira `addCommentToJiraIssue` / `editJiraComment`, GitHub `gh issue comment` / `gh api -X PATCH .../issues/comments/<id>` with a body file). Never use submit-plan for this, and never edit the ticket description. The plan and align markers mean different things and both can live on one ticket.
3. **Implement it**: the implement skill, which reads `~/.claude/align/<TICKET>.md` (or the align comment) as agreed context. Don't start it yourself; the engineer chooses.
4. **Keep iterating** on the doc.

The engineer drives; don't auto-advance.

## Style rules

- **One question per turn.** A wall of questions gets one wall of text that answers half of them.
- **Always recommend a default**, and say why you're asking ("the ticket says X and Y, which seem to conflict").
- **Translate, don't quote**: summaries use canonical terms.
- **Catch contradictions out loud.** It finds more bad assumptions than anything else here.
- **Resist drift into the plan.** File paths, class names, migrations, task breakdowns: downstream. This ends at "we agree what's being built and why".
- **Respect "good enough, move on"** at any phase. The job is to surface ambiguity, not to perform thoroughness.

## When to skip

- Problem unambiguous: Phase 2 collapses to the synthesis and a yes/no.
- Tiny ticket (typo, copy change, version bump): skip the skill and say so.
- Headless with nobody to answer: don't invent answers. Ask anyway (it becomes the dashboard's question block); if no answer can come, write the doc with every unresolved question under **Open assumptions**, marked unconfirmed, and say alignment is incomplete.

---
name: spec-check
description: Score a ticket's spec readiness (out of 100) the same way the software factory's spec gate does, with the team's thresholds and weights from the Natterjack Factory policy, and say what's missing. Works on a draft that isn't in the tracker yet, or on an existing ticket. Use when someone is writing or reviewing a ticket and wants to know if it's ready for an agent to build, e.g. "score this ticket", "is this spec ready", "will the factory take this", "check my draft before I create it", or when a ticket-writing skill asks for the score before creating the ticket.
argument-hint: "[TICKET-ID] (or a draft in the conversation)"
---

# Spec Check

The score the Factory's spec gate gives a ticket, before the Factory gets to it. This runs the same script `implement` runs at intake, with the same policy, so the number matches. It only reports: it never records anything on the Factory board and never blocks anything.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

## 1. Get the ticket

- **A draft** (in the conversation, or handed over by another skill): write `{ "title": "...", "description": "..." }` to a temp file. The description is the Markdown that will go into the ticket, headings included.
- **An existing ticket**: fetch it with `/multirepo:fetch-ticket <ID> --json` and save the JSON to a temp file.

## 2. Score it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/spec-check.mjs" <ticket.json> --root <workspace> [--overrides '<json>']
```

`--root` is the workspace folder (the one with `.claude/dashboard/factory.json`); it's where the team's `readyAt`, `needsWorkAt`, `minScore` and weights come from, and `repos.json` gives the repo names the "Affected areas" check looks for. Add `--json` for the raw result. Never pass `--ticket`: that records the score on the Factory board, which is `implement`'s job.

Then correct it the way `implement` does at intake, so the number matches: read each check's finding against the text, and where the text fooled it (criteria that look testable but contradict each other, a "?" that was answered later on), re-run with `--overrides '{"criteria":{"score":0.5,"reason":"AC 2 and 3 contradict"}}'`. A score of 0, 0.5 or 1, and always a reason; the script ignores an override without one.

## 3. Report

Lead with the number and the level, then one line per check that isn't met, saying what to add:

```
Spec readiness: 72/100 (needs work). The Factory takes tickets straight through at 80.
- How to verify: add the steps someone would follow to check it's done.
- Affected areas: name the app or service (e.g. `advisor-web`).
```

When it's at or above `readyAt`, say it's ready. When `minScore` is set and the score is below it, say unattended Factory runs will stop on it. Then offer to fill the gaps; don't rewrite the ticket unasked.

## Without a workspace

No `factory.json` within reach (no Natterjack workspace, or a chat with no files): say the score can't be checked here and that the Factory will score the ticket when it picks it up. Don't estimate a number by hand: a guessed score that disagrees with the Factory's is worse than none.

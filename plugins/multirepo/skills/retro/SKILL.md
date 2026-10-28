---
name: retro
description: The software factory's retro for a ticket whose PRs merged. Record what review caught, which of the plan's assumptions were wrong, and how the Approver's call held up (reverted? hotfixed?), on the Natterjack Factory board, and propose CLAUDE.md, skill or risk-rule tweaks as a follow-up for a person to accept. Use when the user asks for a retro, a post-merge review or "what did we learn" on a ticket, or from the Factory page's Run the retro.
argument-hint: "<TICKET>"
---

# Retro

The factory gets better only if what went wrong once is caught earlier next time. A retro looks back at one merged ticket and turns what happened into small, specific proposals. It **proposes**; it never edits CLAUDE.md, skills or the policy itself.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

```bash
F="${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs"
```

## Steps

1. **The record**: `node "$F" show --ticket <ID>`: its stages (the notes say what each found; `failures` on a row means it failed before passing), gates and who decided them, the Approver's assessments and ratings, its PRs, and the plan file. Every PR must be merged (`gh pr view <url> --json state,mergedAt`); if one isn't, say so and stop.
2. **What review caught**: each PR's review threads and reviews (`gh pr view <url> --comments`, `gh api repos/<o>/<r>/pulls/<n>/comments`): what the pipeline's reviewer, the security stage, QA, review bots and people found, and what was changed for it. Note anything found late (by a person, after the PR opened) that an earlier stage could have caught.
3. **Wrong assumptions**: read the plan's assumptions and compare them with what was built and what reviewers questioned. List only the ones that turned out wrong, and what was true.
4. **The Approver's call**: its last assessment (level, whether it approved alone) against what happened since the merge: a revert (`git log origin/<default> --grep "Revert" --since <merged>`), a hotfix touching the same files soon after, or a follow-up bug that names the ticket or PR. Say whether the call held up, in one sentence.
5. **Proposals**: 0-3 small, specific changes that would have caught a problem earlier: a line for a repo's CLAUDE.md, a step for a skill, a high-risk path, label or limit for the policy. Each says what it would have caught. None is fine.
6. **Record it**: `node "$F" retro --ticket <ID> --caught "<one>;<two>" --wrong "<one>" --approver "<held up / didn't: why>" --proposals "<one>;<two>"`. It shows on the ticket on the Factory page.
7. **Comment on the ticket** with the same, proposals included, so a person can accept them: by editing the file or policy themselves, or by asking for it.

Keep each item to one line. No blame: the point is what the process would change.
